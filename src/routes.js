const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger, LOG_DIR } = require('./logger');
const { getConfig, saveConfig } = require('./config');
const { syncAndReport, isSyncRunning } = require('./syncJob');
const { applySchedule } = require('./scheduler');
const auth = require('./auth');
const actualService = require('./actualService');
const { sendWebhookReport } = require('./webhookReport');
const { sendSummaryReport } = require('./summaryJob');
const { buildZip } = require('./zipWriter');
const { buildMonteCarloPdf } = require('./monteCarloReport');
const { ALLOCATIONS } = require('./monteCarlo');
const { getContributionLimits } = require('./contributionLimits');

const router = express.Router();
const { requireAdmin } = auth;
const { version } = require('../package.json');

// Public (see PUBLIC_PATHS in auth.js) so the version shows in the footer
// even on the login page, before a session exists. `commit` is the short git
// SHA baked in at image build time (see Dockerfile/publish.yml) — package.json's
// version rarely changes, so it alone can't tell a user whether they've
// actually pulled the latest image; the commit can.
router.get('/api/version', (req, res) => {
  const commit = process.env.GIT_COMMIT ? process.env.GIT_COMMIT.slice(0, 7) : null;
  res.json({ version, commit });
});

// --- Config ---
// actualPassword/emailPass are never sent to the client as plaintext; the
// client only learns whether one is set, and a save only changes it when a
// new non-empty value is submitted (see POST handler below).
router.get('/api/config', (req, res) => {
  const { dashboardPasswordHash, sessionSecret, viewerPasswordHash, actualPassword, emailPass, webhookUrl, ...safeConfig } = getConfig();
  res.json({
    ...safeConfig,
    actualPasswordSet: !!actualPassword, emailPassSet: !!emailPass, webhookUrlSet: !!webhookUrl,
    viewerAccessEnabled: !!viewerPasswordHash,
    role: req.sessionRole
  });
});

router.post('/api/config', requireAdmin, (req, res) => {
  const current = getConfig();
  const updated = {
    ...current,
    ...req.body,
    actualPassword: req.body.actualPassword ? req.body.actualPassword : current.actualPassword,
    emailPass: req.body.emailPass ? req.body.emailPass : current.emailPass,
    webhookUrl: req.body.webhookUrl ? req.body.webhookUrl : current.webhookUrl,
    dashboardPasswordHash: current.dashboardPasswordHash,
    sessionSecret: current.sessionSecret,
    viewerPasswordHash: current.viewerPasswordHash,
    lastSyncAt: current.lastSyncAt,
    lastSyncStatus: current.lastSyncStatus,
    lastSyncError: current.lastSyncError
  };
  saveConfig(updated);
  applySchedule();
  logger.info('Configuration updated via Web Dashboard.');
  res.json({ success: true });
});

router.post('/api/config/test-connection', requireAdmin, async (req, res) => {
  const current = getConfig();
  const actualUrl = req.body.actualUrl || current.actualUrl;
  const actualPassword = req.body.actualPassword || current.actualPassword;
  const syncId = req.body.syncId || current.syncId;

  if (!actualUrl || !actualPassword || !syncId) {
    return res.status(400).json({ error: 'Server URL, password, and Sync ID are all required to test the connection.' });
  }

  try {
    const { accountCount } = await actualService.testConnection({ actualUrl, actualPassword, syncId });
    logger.info(`Connection test succeeded (${accountCount} account(s) found).`);
    res.json({ success: true, accountCount });
  } catch (err) {
    logger.warn('Connection test failed: ' + err.message);
    res.json({ success: false, error: err.message });
  }
});

// Exports the full config, including decrypted secrets — this is a backup
// file the user downloads and stores themselves, not something served to
// the browser UI at rest, so it intentionally differs from GET /api/config's
// redaction. The UI warns the user before download.
router.get('/api/config/export', requireAdmin, (req, res) => {
  const config = getConfig();
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="actualbudget-sync-config-backup.json"');
  res.send(JSON.stringify(config, null, 2));
});

router.post('/api/config/import', requireAdmin, (req, res) => {
  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'That file does not look like a valid config backup.' });
  }
  saveConfig(incoming);
  applySchedule();
  logger.info('Configuration restored from an imported backup.');
  res.json({ success: true });
});

router.post('/api/config/test-summary-email', requireAdmin, async (req, res) => {
  const current = getConfig();
  if (!current.actualUrl || !current.actualPassword || !current.syncId) {
    return res.status(400).json({ error: 'Actual Budget is not configured yet.' });
  }
  if (!current.emailUser || !current.smtpHost) {
    return res.status(400).json({ error: 'SMTP settings are required to send a test email.' });
  }
  try {
    await sendSummaryReport({ force: true });
    logger.info('Monthly Budget Summary test email sent.');
    res.json({ success: true });
  } catch (err) {
    logger.warn('Monthly Budget Summary test email failed: ' + err.message);
    res.json({ success: false, error: err.message });
  }
});

router.post('/api/config/test-webhook', requireAdmin, async (req, res) => {
  const current = getConfig();
  const webhookUrl = req.body.webhookUrl || current.webhookUrl;
  const webhookPlatform = req.body.webhookPlatform || current.webhookPlatform;

  if (!webhookUrl) {
    return res.status(400).json({ error: 'A webhook URL is required to send a test message.' });
  }

  try {
    await sendWebhookReport(
      { webhookUrl, webhookPlatform },
      { added: [], bankSyncIssue: null, totalBalance: 0, publicUrl: current.publicUrl }
    );
    logger.info('Webhook test message sent.');
    res.json({ success: true });
  } catch (err) {
    logger.warn('Webhook test failed: ' + err.message);
    res.json({ success: false, error: err.message });
  }
});

// --- Sync ---
router.post('/api/sync', requireAdmin, (req, res) => {
  logger.info('Manual sync triggered via Web Dashboard.');
  syncAndReport();
  res.json({ success: true, message: 'Sync started' });
});

router.get('/api/sync/status', (req, res) => {
  res.json({ syncing: isSyncRunning() });
});

// --- Live log streaming (SSE) ---
router.get('/api/logs/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendLogs = () => {
    const files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('sync-')).sort().reverse();
    if (files.length > 0) {
      const latestLog = fs.readFileSync(path.join(LOG_DIR, files[0]), 'utf8');
      res.write(`data: ${JSON.stringify(latestLog)}\n\n`);
    }
  };

  sendLogs();
  const interval = setInterval(sendLogs, 2000);
  req.on('close', () => { clearInterval(interval); res.end(); });
});

const VALID_SORTS = new Set(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']);
function parseSort(value) {
  return VALID_SORTS.has(value) ? value : 'date_desc';
}

// Repeated query keys (?accountId=a&accountId=b) parse as an array already;
// a single occurrence parses as a plain string — normalize both to an array,
// or undefined when absent, for buildTransactionFilters' $oneof filter.
function parseIdList(value) {
  if (value === undefined) return undefined;
  return [].concat(value);
}

// --- Data explorer (read-only) ---
function requireActualConfigured(req, res) {
  const config = getConfig();
  if (!config.actualUrl || !config.actualPassword || !config.syncId) {
    res.status(400).json({ error: 'Actual Budget is not configured yet.' });
    return null;
  }
  return config;
}

router.get('/api/data/accounts', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const accounts = await actualService.getAccounts({ includeClosed: req.query.includeClosed === 'true' });
    const withBalances = await Promise.all(accounts.map(async acc => ({
      ...acc,
      balance: await actualService.getAccountBalance(acc.id)
    })));
    res.json(withBalances);
  } catch (err) {
    logger.error('Data explorer accounts request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to load accounts.' });
  }
});

router.get('/api/data/categories', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    res.json(await actualService.getCategories());
  } catch (err) {
    logger.error('Data explorer categories request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to load categories.' });
  }
});

// Separate from /api/data/categories (which stays a flat list — several
// server-side functions already depend on that shape) so the Data
// Explorer's category filter can group its dropdown by Actual's own
// category groups without changing anything that already consumes the flat one.
router.get('/api/data/category-groups', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    res.json(await actualService.getCategoryGroups());
  } catch (err) {
    logger.error('Category groups request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to load category groups.' });
  }
});

router.get('/api/data/transactions', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const filters = {
      accountId: parseIdList(req.query.accountId),
      categoryId: parseIdList(req.query.categoryId),
      startDate: req.query.startDate || undefined,
      endDate: req.query.endDate || undefined,
      search: req.query.search || undefined
    };

    const sort = parseSort(req.query.sort);
    const [transactions, total] = await Promise.all([
      actualService.queryTransactions({ ...filters, limit, offset, sort }),
      actualService.countTransactions(filters)
    ]);

    res.json({ transactions, total, limit, offset });
  } catch (err) {
    logger.error('Data explorer transactions request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to load transactions.' });
  }
});

router.get('/api/data/summary', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const month = /^\d{4}-\d{2}$/.test(req.query.month) ? req.query.month : undefined;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate) ? req.query.startDate : undefined;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate) ? req.query.endDate : undefined;
    const [incomeVsSpend, incomeVsSpendYTD, spendByCategory, balanceTrend, budgetVsActual] = await Promise.all([
      actualService.getIncomeVsSpend({ month, startDate, endDate }),
      actualService.getIncomeVsSpendYTD(),
      actualService.getSpendByCategory({ month, startDate, endDate }),
      actualService.getBalanceTrend({ month, startDate, endDate }),
      actualService.getBudgetVsActual({ month, startDate, endDate })
    ]);
    // Grouped under each category's parent group (e.g. "Food & Dining"
    // holding Groceries + Restaurants), same as the sync email's Spend vs
    // Budget section, so the two never disagree on how a group total is
    // computed.
    res.json({ incomeVsSpend, incomeVsSpendYTD, spendByCategory, balanceTrend, budgetVsActual: actualService.groupBudgetCategoriesByParent(budgetVsActual) });
  } catch (err) {
    logger.error('Dashboard summary request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to load dashboard summary.' });
  }
});

router.get('/api/data/insights', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 3), 24);
    const annualReturnRatePct = req.query.annualReturnPct !== undefined
      ? Math.min(Math.max(parseFloat(req.query.annualReturnPct), -20), 30)
      : (config.insightsAnnualReturnPct ?? 7);
    const insights = await actualService.getFinancialInsights({ months, annualReturnRatePct, investmentAccountIds: config.investmentAccountIds || [] });
    res.json(insights);
  } catch (err) {
    logger.error('Financial insights request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute financial insights.' });
  }
});

router.get('/api/data/financial-health', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const targetMonths = req.query.targetMonths !== undefined
      ? Math.min(Math.max(parseInt(req.query.targetMonths, 10) || 6, 1), 24)
      : (config.financialHealthTargetMonths ?? 6);
    const targetSavingsPct = req.query.targetSavingsPct !== undefined
      ? Math.min(Math.max(parseFloat(req.query.targetSavingsPct), 0), 100)
      : (config.financialHealthTargetSavingsPct ?? 20);
    const health = await actualService.getFinancialHealthData({
      emergencyFundAccountIds: config.emergencyFundAccountIds || [],
      investmentAccountIds: config.investmentAccountIds || [],
      liabilityAccountIds: config.liabilityAccountIds || [],
      targetMonths, targetSavingsPct
    });
    res.json(health);
  } catch (err) {
    logger.error('Financial health request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute financial health.' });
  }
});

router.get('/api/data/financial-health/history', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const targetMonths = req.query.targetMonths !== undefined
      ? Math.min(Math.max(parseInt(req.query.targetMonths, 10) || 6, 1), 24)
      : (config.financialHealthTargetMonths ?? 6);
    const targetSavingsPct = req.query.targetSavingsPct !== undefined
      ? Math.min(Math.max(parseFloat(req.query.targetSavingsPct), 0), 100)
      : (config.financialHealthTargetSavingsPct ?? 20);
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 3), 24);
    const history = await actualService.getFinancialHealthHistory({
      emergencyFundAccountIds: config.emergencyFundAccountIds || [],
      liabilityAccountIds: config.liabilityAccountIds || [],
      targetMonths, targetSavingsPct, months
    });
    res.json(history);
  } catch (err) {
    logger.error('Financial health history request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute financial health history.' });
  }
});

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Backs the "click a dashboard number to see the underlying transactions"
// drill-down — lets a user verify the Income/Spend figures independently
// instead of just trusting the budget engine's total.
router.get('/api/data/metric-transactions', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const metric = req.query.metric === 'income' ? 'income' : 'spend';
    const range = req.query.range === 'ytd' ? 'ytd' : undefined;
    const month = req.query.month || undefined;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate) ? req.query.startDate : undefined;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate) ? req.query.endDate : undefined;
    const result = await actualService.getMetricTransactions({ metric, month, range, startDate, endDate });
    res.json(result);
  } catch (err) {
    logger.error('Metric transactions request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute metric transactions.' });
  }
});

router.get('/api/data/metric-transactions/export', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const metric = req.query.metric === 'income' ? 'income' : 'spend';
    const range = req.query.range === 'ytd' ? 'ytd' : undefined;
    const month = req.query.month || undefined;
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.startDate) ? req.query.startDate : undefined;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(req.query.endDate) ? req.query.endDate : undefined;
    const { transactions } = await actualService.getMetricTransactions({ metric, month, range, startDate, endDate });

    const rows = [['Date', 'Account', 'Category', 'Payee', 'Amount']];
    for (const t of transactions) {
      rows.push([t.date, t.account, t.category, t.payee_name || '', t.amount.toFixed(2)]);
    }
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${metric}-transactions.csv"`);
    res.send(csv);
  } catch (err) {
    logger.error('Metric transactions CSV export failed: ' + err.message);
    res.status(500).json({ error: 'Failed to export metric transactions.' });
  }
});

router.get('/api/data/fire-progress', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const fireAnnualExpenses = req.query.fireAnnualExpenses !== undefined
      ? parseFloat(req.query.fireAnnualExpenses) || 0
      : (config.fireAnnualExpenses || 0);
    const fireWithdrawalRatePct = req.query.fireWithdrawalRatePct !== undefined
      ? Math.min(Math.max(parseFloat(req.query.fireWithdrawalRatePct), 1), 20)
      : (config.fireWithdrawalRatePct ?? 4);
    const targetRetirementAge = req.query.targetRetirementAge !== undefined
      ? parseFloat(req.query.targetRetirementAge) || null
      : (config.fireTargetRetirementAge || null);
    const progress = await actualService.getFireProgress({
      fireAnnualExpenses, fireWithdrawalRatePct,
      annualReturnRatePct: config.insightsAnnualReturnPct ?? 7,
      birthdate: config.fireBirthdate || null,
      ssClaimingChoice: config.ssClaimingChoice || null,
      ssAge62MonthlyBenefit: config.ssAge62MonthlyBenefit,
      ssFraAgeYears: config.ssFraAgeYears, ssFraAgeMonths: config.ssFraAgeMonths,
      ssFraMonthlyBenefit: config.ssFraMonthlyBenefit,
      ssAge70MonthlyBenefit: config.ssAge70MonthlyBenefit,
      targetRetirementAge
    });
    res.json(progress);
  } catch (err) {
    logger.error('FIRE progress request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute FIRE progress.' });
  }
});

// Backs the Retirement Modeling page — same target-age goal-seek as
// fire-progress, but with an adjustable monthly contribution scenario, so
// query params (not just config) drive every input: none of this is meant
// to overwrite the Dashboard FIRE widget's own saved settings.
router.get('/api/data/retirement-model', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const fireAnnualExpenses = req.query.fireAnnualExpenses !== undefined
      ? parseFloat(req.query.fireAnnualExpenses) || 0
      : (config.fireAnnualExpenses || 0);
    const fireWithdrawalRatePct = req.query.fireWithdrawalRatePct !== undefined
      ? Math.min(Math.max(parseFloat(req.query.fireWithdrawalRatePct), 1), 20)
      : (config.fireWithdrawalRatePct ?? 4);
    const annualReturnRatePct = req.query.annualReturnRatePct !== undefined
      ? Math.min(Math.max(parseFloat(req.query.annualReturnRatePct), -20), 30)
      : (config.insightsAnnualReturnPct ?? 7);
    const targetRetirementAge = req.query.targetRetirementAge !== undefined
      ? parseFloat(req.query.targetRetirementAge) || null
      : null;
    const modeledMonthlyContribution = req.query.modeledMonthlyContribution !== undefined && req.query.modeledMonthlyContribution !== ''
      ? parseFloat(req.query.modeledMonthlyContribution)
      : null;
    const model = await actualService.getRetirementModel({
      targetRetirementAge, modeledMonthlyContribution: Number.isFinite(modeledMonthlyContribution) ? modeledMonthlyContribution : null,
      fireAnnualExpenses, fireWithdrawalRatePct, annualReturnRatePct,
      birthdate: config.fireBirthdate || null,
      ssClaimingChoice: config.ssClaimingChoice || null,
      ssAge62MonthlyBenefit: config.ssAge62MonthlyBenefit,
      ssFraAgeYears: config.ssFraAgeYears, ssFraAgeMonths: config.ssFraAgeMonths,
      ssFraMonthlyBenefit: config.ssFraMonthlyBenefit,
      ssAge70MonthlyBenefit: config.ssAge70MonthlyBenefit
    });
    res.json(model);
  } catch (err) {
    logger.error('Retirement model request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute the retirement model.' });
  }
});

const MONTE_CARLO_ALLOCATIONS = new Set(['conservative', 'moderate', 'aggressive']);

// Shared by the JSON, .zip, and .pdf Monte Carlo endpoints so all three
// read the exact same scenario out of the same query string.
function parseMonteCarloParams(req, config) {
  const retireAge = parseFloat(req.query.retireAge);
  const allocation = MONTE_CARLO_ALLOCATIONS.has(req.query.allocation) ? req.query.allocation : 'moderate';
  const inflationPct = req.query.inflationPct !== undefined ? Math.min(Math.max(parseFloat(req.query.inflationPct), 0), 15) : 3.0;
  const withdrawalRatePct = req.query.withdrawalRatePct !== undefined ? Math.min(Math.max(parseFloat(req.query.withdrawalRatePct), 1), 20) : 3.8;
  const includeSocialSecurity = req.query.includeSocialSecurity === 'true';
  // Three separate contribution fields (401k/employer plan, IRA, taxable/
  // other) rather than one lump sum — each has its own IRS limit, and the
  // breakdown is worth keeping for the export/PDF even though the
  // simulation itself still pools them into one combined annual flow.
  // Omitting all three (first load) keeps the "use my real current savings
  // pace" default; providing any of them switches to an explicit scenario,
  // treating the other, unset fields as 0 rather than falling back to the
  // real pace for just that slice.
  const contribFieldsProvided = ['contribution401k', 'contributionIra', 'contributionOther'].some(
    k => req.query[k] !== undefined && req.query[k] !== ''
  );
  const contribution401k = Math.max(0, parseFloat(req.query.contribution401k) || 0);
  const contributionIra = Math.max(0, parseFloat(req.query.contributionIra) || 0);
  const contributionOther = Math.max(0, parseFloat(req.query.contributionOther) || 0);
  const annualContribution = contribFieldsProvided ? (contribution401k + contributionIra + contributionOther) : null;
  const glidepath = req.query.glidepath === 'true';
  const pensionMonthly = req.query.pensionMonthly !== undefined ? Math.max(0, parseFloat(req.query.pensionMonthly) || 0) : 0;
  const oneTimeExpense = req.query.oneTimeExpense !== undefined ? Math.max(0, parseFloat(req.query.oneTimeExpense) || 0) : 0;
  const survivor = req.query.survivor === 'true';
  // 10,000 paths is the headline number shown on the page; capped here so a
  // crafted request can't force an arbitrarily expensive simulation.
  const paths = req.query.paths !== undefined ? Math.min(Math.max(parseInt(req.query.paths, 10) || 2000, 200), 10000) : 2000;

  return {
    retireAge: Number.isFinite(retireAge) ? retireAge : 55,
    allocation, inflationPct, withdrawalRatePct, includeSocialSecurity,
    annualContribution: Number.isFinite(annualContribution) ? annualContribution : null,
    contribution401k, contributionIra, contributionOther,
    glidepath, pensionMonthly, oneTimeExpense, survivor, paths,
    fireAnnualExpenses: config.fireAnnualExpenses || 0,
    fireWithdrawalRatePct: config.fireWithdrawalRatePct ?? 4,
    birthdate: config.fireBirthdate || null,
    ssClaimingChoice: config.ssClaimingChoice || null,
    ssAge62MonthlyBenefit: config.ssAge62MonthlyBenefit,
    ssFraAgeYears: config.ssFraAgeYears, ssFraAgeMonths: config.ssFraAgeMonths,
    ssFraMonthlyBenefit: config.ssFraMonthlyBenefit,
    ssAge70MonthlyBenefit: config.ssAge70MonthlyBenefit
  };
}

router.get('/api/data/monte-carlo', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const params = parseMonteCarloParams(req, config);
    const projection = await actualService.getMonteCarloProjection(params);
    if (projection.hasBirthdate) {
      projection.contributionLimits = getContributionLimits(projection.currentAge);
      projection.contributionBreakdown = {
        contribution401k: params.contribution401k, contributionIra: params.contributionIra, contributionOther: params.contributionOther
      };
    }
    res.json(projection);
  } catch (err) {
    logger.error('Monte Carlo projection request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to run the Monte Carlo simulation.' });
  }
});

router.get('/api/data/monte-carlo/compare', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const params = parseMonteCarloParams(req, config);
    const compare = await actualService.getMonteCarloCompare({ ...params, paths: Math.min(params.paths, 1500) });
    res.json(compare);
  } catch (err) {
    logger.error('Monte Carlo compare request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute the comparison table.' });
  }
});

router.get('/api/data/monte-carlo/export', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const params = parseMonteCarloParams(req, config);
    const projection = await actualService.getMonteCarloProjection(params);
    if (!projection.hasBirthdate) {
      res.status(400).json({ error: 'Set your birthdate in Settings before exporting a Monte Carlo report.' });
      return;
    }
    const { result } = projection;

    const assumptions = {
      generatedAt: new Date().toISOString(),
      retireAge: result.retireAge, endAge: result.endAge,
      allocation: params.allocation, inflationPct: params.inflationPct, withdrawalRatePct: params.withdrawalRatePct,
      includeSocialSecurity: params.includeSocialSecurity, socialSecurity: projection.socialSecurity,
      ssStartAge: result.ssStartAge,
      annualContribution: params.annualContribution != null ? params.annualContribution : Math.max(0, (projection.monthlyContribution || 0) * 12),
      contribution401k: params.contribution401k, contributionIra: params.contributionIra, contributionOther: params.contributionOther,
      contributionLimits: getContributionLimits(projection.currentAge),
      glidepath: params.glidepath, pensionMonthly: params.pensionMonthly,
      oneTimeExpense: params.oneTimeExpense, expenseAge: result.expenseAge,
      survivor: params.survivor, paths: result.paths,
      netWorth: projection.netWorth, currentAge: projection.currentAge,
      successPct: result.successPct, longevityAge: result.longevityAge,
      medianBalanceAtRetirement: result.medianBalanceAtRetirement,
      medianEndingBalance: result.medianEndingBalance,
      safeWithdrawalAmount: result.safeWithdrawalAmount
    };

    const csvRows = [['Age', 'P10', 'P25', 'P50', 'P75', 'P90']];
    for (let i = 0; i < result.ages.length; i++) {
      csvRows.push([
        result.ages[i],
        Math.round(result.bands.p10[i]), Math.round(result.bands.p25[i]), Math.round(result.bands.p50[i]),
        Math.round(result.bands.p75[i]), Math.round(result.bands.p90[i])
      ]);
    }
    const percentilesCsv = csvRows.map(row => row.map(csvEscape).join(',')).join('\n');

    const zip = buildZip([
      { name: 'assumptions.json', data: JSON.stringify(assumptions, null, 2) },
      { name: 'monte-carlo-percentiles.csv', data: percentilesCsv }
    ]);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Retirement-Analysis-${new Date().toISOString().slice(0, 10)}.zip"`);
    res.send(zip);
  } catch (err) {
    logger.error('Monte Carlo export failed: ' + err.message);
    res.status(500).json({ error: 'Failed to build the export.' });
  }
});

router.get('/api/data/monte-carlo/pdf', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const params = parseMonteCarloParams(req, config);
    const projection = await actualService.getMonteCarloProjection(params);
    if (!projection.hasBirthdate) {
      res.status(400).json({ error: 'Set your birthdate in Settings before generating a Monte Carlo report.' });
      return;
    }
    const mix = ALLOCATIONS[params.allocation] || ALLOCATIONS.moderate;
    const pdf = await buildMonteCarloPdf({
      result: projection.result,
      scenario: { allocationMean: mix.mean, allocationVol: mix.vol, inflationPct: params.inflationPct, withdrawalRatePct: params.withdrawalRatePct }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Retirement-Analysis-${new Date().toISOString().slice(0, 10)}.pdf"`);
    res.send(pdf);
  } catch (err) {
    logger.error('Monte Carlo PDF generation failed: ' + err.message);
    res.status(500).json({ error: 'Failed to generate the PDF report.' });
  }
});

router.get('/api/data/conscious-spending', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const month = req.query.month || undefined;
    const data = await actualService.getConsciousSpendingMonth({
      month, categoryClassification: config.categoryClassification || {}, takeHomePayOverride: config.takeHomePayOverride,
      monthly401kContribution: config.monthly401kContribution || 0
    });
    res.json(data);
  } catch (err) {
    logger.error('Conscious Spending month request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute the Conscious Spending Plan.' });
  }
});

router.get('/api/data/conscious-spending/year', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const data = await actualService.getConsciousSpendingYear({
      year, categoryClassification: config.categoryClassification || {}, takeHomePayOverride: config.takeHomePayOverride,
      monthly401kContribution: config.monthly401kContribution || 0
    });
    res.json(data);
  } catch (err) {
    logger.error('Conscious Spending year request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute the yearly Conscious Spending view.' });
  }
});

router.get('/api/data/wrapped', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const year = req.query.year ? parseInt(req.query.year, 10) : undefined;
    const wrapped = await actualService.getWrappedData({ year });
    res.json(wrapped);
  } catch (err) {
    logger.error('Wrapped request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute your Wrapped.' });
  }
});

router.get('/api/data/trends', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 3), 24);
    const trends = await actualService.getTrendsData({ months });
    res.json(trends);
  } catch (err) {
    logger.error('Trends request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute trends.' });
  }
});

router.get('/api/data/networth', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 3), 24);
    const history = await actualService.getNetWorthHistory({ liabilityAccountIds: config.liabilityAccountIds || [], months });
    res.json({ history });
  } catch (err) {
    logger.error('Net worth request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to compute net worth history.' });
  }
});

router.get('/api/data/transactions/export', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);

    const filters = {
      accountId: parseIdList(req.query.accountId),
      categoryId: parseIdList(req.query.categoryId),
      startDate: req.query.startDate || undefined,
      endDate: req.query.endDate || undefined,
      search: req.query.search || undefined
    };

    const sort = parseSort(req.query.sort);
    const [transactions, accounts, categories] = await Promise.all([
      actualService.queryAllTransactions(filters, { sort }),
      actualService.getAccounts({ includeClosed: true }),
      actualService.getCategories()
    ]);
    const accountName = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const categoryName = Object.fromEntries(categories.map(c => [c.id, c.name]));

    const rows = [['Date', 'Account', 'Category', 'Payee', 'Amount']];
    for (const t of transactions) {
      rows.push([
        t.date,
        accountName[t.account] || 'Unknown',
        categoryName[t.category] || '',
        t.payee_name || '',
        (t.amount / 100).toFixed(2)
      ]);
    }
    const csv = rows.map(row => row.map(csvEscape).join(',')).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="transactions.csv"');
    res.send(csv);
  } catch (err) {
    logger.error('CSV export failed: ' + err.message);
    res.status(500).json({ error: 'Failed to export transactions.' });
  }
});

// --- Auth ---
router.get('/api/auth/status', (req, res) => {
  const config = getConfig();
  res.json({ configured: !!config.dashboardPasswordHash });
});

router.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (auth.isLoginLocked(ip)) {
    const minutes = Math.ceil(auth.loginLockRemainingMs(ip) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }

  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });

  const config = getConfig();
  let role = 'admin';

  if (!config.dashboardPasswordHash) {
    config.dashboardPasswordHash = auth.hashPassword(password);
    saveConfig(config);
    logger.info('Dashboard password configured for the first time.');
  } else if (auth.verifyPassword(password, config.dashboardPasswordHash)) {
    role = 'admin';
  } else if (config.viewerPasswordHash && auth.verifyPassword(password, config.viewerPasswordHash)) {
    role = 'viewer';
  } else {
    auth.recordLoginFailure(ip);
    logger.warn(`Failed dashboard login attempt from ${ip}.`);
    return res.status(401).json({ error: 'Invalid password' });
  }

  auth.recordLoginSuccess(ip);
  const expiresAt = Date.now() + auth.SESSION_TTL_MS;
  const token = auth.signSession(config.sessionSecret, expiresAt, role);
  const secureFlag = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}${secureFlag}`);
  res.json({ success: true, role });
});

router.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ success: true });
});

router.get('/api/auth/session', (req, res) => {
  res.json({ role: req.sessionRole });
});

// Sets or clears (empty password) the read-only viewer login. Kept separate
// from POST /api/config so it always requires re-entering a value rather
// than round-tripping a hash through the settings form.
router.post('/api/auth/viewer-password', requireAdmin, (req, res) => {
  const { password } = req.body || {};
  const current = getConfig();
  current.viewerPasswordHash = password ? auth.hashPassword(password) : '';
  saveConfig(current);
  logger.info(password ? 'Read-only viewer access enabled.' : 'Read-only viewer access disabled.');
  res.json({ success: true, enabled: !!password });
});

module.exports = router;
