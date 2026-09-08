const express = require('express');
const path = require('path');
const { logger, captureConsole } = require('./src/logger');
captureConsole();

const { requireAuth } = require('./src/auth');
const routes = require('./src/routes');
const { applySchedule } = require('./src/scheduler');
const { syncAndReport } = require('./src/syncJob');
const { getConfig } = require('./src/config');
const actualService = require('./src/actualService');

const app = express();
app.use(express.json());

// Unauthenticated so Docker/Compose can probe it without credentials.
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

app.use(requireAuth);
app.use(express.static(path.join(__dirname, 'public')));
app.use(routes);

const server = app.listen(3000, () => {
  logger.info('Web Dashboard listening on port 3000');

  applySchedule();

  setTimeout(async () => {
    const config = getConfig();
    if (config.actualUrl && config.actualPassword && config.syncId) {
      logger.info('Configuration found on startup. Triggering initial sync...');
      await syncAndReport();
    } else {
      logger.info('Configuration incomplete. Skipping automatic startup sync.');
    }
  }, 10000);
});

async function gracefulShutdown(signal) {
  logger.info(`Received ${signal}, shutting down...`);
  server.close();
  await actualService.shutdown();
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
