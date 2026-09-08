const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger, LOG_DIR } = require('./logger');
const { getConfig, saveConfig } = require('./config');
const { syncAndReport, isSyncRunning } = require('./syncJob');
const { applySchedule } = require('./scheduler');
const auth = require('./auth');
const actualService = require('./actualService');

const router = express.Router();

// --- Config ---
// actualPassword/emailPass are never sent to the client as plaintext; the
// client only learns whether one is set, and a save only changes it when a
// new non-empty value is submitted (see POST handler below).
router.get('/api/config', (req, res) => {
  const { dashboardPasswordHash, sessionSecret, actualPassword, emailPass, ...safeConfig } = getConfig();
  res.json({ ...safeConfig, actualPasswordSet: !!actualPassword, emailPassSet: !!emailPass });
});

router.post('/api/config', (req, res) => {
  const current = getConfig();
  const updated = {
    ...current,
    ...req.body,
    actualPassword: req.body.actualPassword ? req.body.actualPassword : current.actualPassword,
    emailPass: req.body.emailPass ? req.body.emailPass : current.emailPass,
    dashboardPasswordHash: current.dashboardPasswordHash,
    sessionSecret: current.sessionSecret
  };
  saveConfig(updated);
  applySchedule();
  logger.info('Configuration updated via Web Dashboard.');
  res.json({ success: true });
});

// --- Sync ---
router.post('/api/sync', (req, res) => {
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
    const [netWorth, spendByCategory, balanceTrend] = await Promise.all([
      actualService.getNetWorth(),
      actualService.getSpendByCategory({ days }),
      actualService.getBalanceTrend({ days })
    ]);
    res.json({ netWorth, spendByCategory, balanceTrend });
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
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });

  const config = getConfig();

  if (!config.dashboardPasswordHash) {
    config.dashboardPasswordHash = auth.hashPassword(password);
    saveConfig(config);
    logger.info('Dashboard password configured for the first time.');
  } else if (!auth.verifyPassword(password, config.dashboardPasswordHash)) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const expiresAt = Date.now() + auth.SESSION_TTL_MS;
  const token = auth.signSession(config.sessionSecret, expiresAt);
  const secureFlag = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(auth.SESSION_TTL_MS / 1000)}${secureFlag}`);
  res.json({ success: true });
});

router.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${auth.SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  res.json({ success: true });
});

module.exports = router;
