const _ = require('lodash');
const { logger } = require('./logger');
const actualService = require('./actualService');
const { buildReportHtml, sendReport } = require('./emailReport');
const { getConfig, saveConfig } = require('./config');

let isSyncing = false;

// Re-reads config immediately before writing so a settings change made while
// a sync was running isn't clobbered by the stale copy syncAndReport started with.
function recordSyncResult(status, errorMessage = null) {
  const latest = getConfig();
  saveConfig({ ...latest, lastSyncAt: new Date().toISOString(), lastSyncStatus: status, lastSyncError: errorMessage });
}

async function syncAndReport() {
  if (isSyncing) {
    logger.warn('Sync already in progress. Skipping...');
    return;
  }
  isSyncing = true;

  const config = getConfig();
  if (!config.actualUrl || !config.actualPassword || !config.syncId) {
    logger.error('Missing Actual Budget configuration. Please setup via Dashboard.');
    isSyncing = false;
    return;
  }

  logger.info('Starting Actual Budget Sync Process');

  try {
    await actualService.ensureReady(config);
    await actualService.refreshBudget(config);

    const accounts = await actualService.getAccounts();
    const accountMap = accounts.reduce((map, acc) => { map[acc.id] = acc.name; return map; }, {});
    const categories = await actualService.getCategories();
    const categoryMap = categories.reduce((map, cat) => { map[cat.id] = cat.name; return map; }, {});

    const accountBalances = {};
    for (const acc of accounts) {
      accountBalances[acc.id] = await actualService.getAccountBalance(acc.id);
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];

    let oldTransactions = [];
    for (const acc of accounts) {
      oldTransactions.push(...await actualService.getTransactionsForAccount(acc.id, startDate, endDate));
    }

    logger.info('Triggering Bank Sync via Actual Budget API...');
    let bankSyncIssue = null;
    try {
      await actualService.runBankSync();
    } catch (syncErr) {
      logger.warn(`Bank connection issue detected: ${syncErr.message}`);
      bankSyncIssue = syncErr.message;
    }

    logger.info('Waiting 20 seconds for SimpleFIN data to process...');
    await new Promise(resolve => setTimeout(resolve, 20000));

    let newTransactions = [];
    for (const acc of accounts) {
      newTransactions.push(...await actualService.getTransactionsForAccount(acc.id, startDate, endDate));
    }

    const added = _.differenceBy(newTransactions, oldTransactions, 'id');

    if (config.enableEmail && (added.length > 0 || bankSyncIssue)) {
      logger.info('Compiling HTML email report...');
      const includeBudget = config.emailSections?.budgetVsActual !== false;
      const budgetVsActual = includeBudget ? await actualService.getBudgetVsActual() : [];
      const totalBalance = Object.values(accountBalances).reduce((sum, b) => sum + b, 0);
      const { subject, html } = buildReportHtml({
        accounts, accountBalances, accountMap, categoryMap, added, bankSyncIssue,
        totalBalance, budgetVsActual, publicUrl: config.publicUrl,
        sections: config.emailSections
      });
      await sendReport(config, { subject, html });
      logger.info('Email report successfully dispatched.');
    } else {
      logger.info('Sync completed. No emails required or enabled.');
    }

    recordSyncResult(bankSyncIssue ? 'warning' : 'success', bankSyncIssue);
    logger.info('Sync Process Finished Cleanly');
  } catch (err) {
    recordSyncResult('error', err.message);
    logger.error('Critical script failure: ' + err.message);
  } finally {
    isSyncing = false;
  }
}

function isSyncRunning() {
  return isSyncing;
}

module.exports = { syncAndReport, isSyncRunning };
