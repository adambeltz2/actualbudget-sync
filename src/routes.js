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

const router = express.Router();
const { requireAdmin } = auth;

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

router.get('/api/data/transactions', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const filters = {
      accountId: req.query.accountId || undefined,
      categoryId: req.query.categoryId || undefined,
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
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const [incomeVsSpend, incomeVsSpendYTD, spendByCategory, balanceTrend, budgetVsActual] = await Promise.all([
      actualService.getIncomeVsSpend(),
      actualService.getIncomeVsSpendYTD(),
      actualService.getSpendByCategory({ days }),
      actualService.getBalanceTrend({ days }),
      actualService.getBudgetVsActual()
    ]);
    res.json({ incomeVsSpend, incomeVsSpendYTD, spendByCategory, balanceTrend, budgetVsActual });
  } catch (err) {
    logger.error('Dashboard summary request failed: ' + err.message);
    res.status(500).json({ error: 'Failed to load dashboard summary.' });
  }
});

function csvEscape(value) {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

router.get('/api/data/transactions/export', async (req, res) => {
  const config = requireActualConfigured(req, res);
  if (!config) return;
  try {
    await actualService.ensureReady(config);

    const filters = {
      accountId: req.query.accountId || undefined,
      categoryId: req.query.categoryId || undefined,
      startDate: req.query.startDate || undefined,
      endDate: req.query.endDate || undefined,
      search: req.query.search || undefined
    };

    const sort = parseSort(req.query.sort);
    const [transactions, accounts, categories] = await Promise.all([
      actualService.queryTransactions({ ...filters, limit: 5000, offset: 0, sort }),
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
