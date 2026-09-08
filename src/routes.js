const express = require('express');
const fs = require('fs');
const path = require('path');
const { logger, LOG_DIR } = require('./logger');
const { getConfig, saveConfig } = require('./config');
const { syncAndReport } = require('./syncJob');
const { applySchedule } = require('./scheduler');
const auth = require('./auth');

const router = express.Router();

// --- Config ---
router.get('/api/config', (req, res) => {
  const { dashboardPasswordHash, sessionSecret, ...safeConfig } = getConfig();
  res.json(safeConfig);
});

router.post('/api/config', (req, res) => {
  const current = getConfig();
  const updated = {
    ...current,
    ...req.body,
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
