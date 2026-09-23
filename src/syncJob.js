const _ = require('lodash');
const { logger } = require('./logger');
const actualService = require('./actualService');
const { buildReportHtml, sendReport } = require('./emailReport');
const { sendWebhookReport } = require('./webhookReport');
const { getConfig, saveConfig } = require('./config');

let isSyncing = false;

// Re-reads config immediately before writing so a settings change made while
// a sync was running isn't clobbered by the stale copy syncAndReport started with.
function recordSyncResult(status, errorMessage = null, accountErrors = []) {
  const latest = getConfig();
  saveConfig({ ...latest, lastSyncAt: new Date().toISOString(), lastSyncStatus: status, lastSyncError: errorMessage, lastSyncAccountErrors: accountErrors });
}

const BANK_SYNC_STATUS_LABELS = {
  'reauth-required': 'Needs reconnecting — the bank login has expired',
  'attention-required': 'Needs attention in Actual Budget',
  'rate-limit-exceeded': 'Rate limited by the bank provider — will retry next sync',
  'timed-out': 'Timed out while syncing',
  'account-missing': 'Account missing from the linked institution',
  failed: 'Failed to sync'
};

function describeBankSyncStatus(status) {
  return BANK_SYNC_STATUS_LABELS[status] || 'Failed to sync';
}

async function syncAndReport({ isStartup = false } = {}) {
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
    try {
      await actualService.runBankSync();
    } catch (syncErr) {
      logger.warn(`Bank connection issue detected: ${syncErr.message}`);
    }

    // bank_sync_status is persisted per-account before runBankSync() throws
    // (or resolves), so this reflects every account that was attempted —
    // not just the one runBankSync()'s own error happened to name.
    const bankSyncStatuses = await actualService.getBankSyncStatuses();
    const accountSyncErrors = bankSyncStatuses
      .filter(a => a.bank_sync_status && a.bank_sync_status !== 'ok')
      .map(a => ({ accountId: a.id, accountName: a.name, status: a.bank_sync_status, label: describeBankSyncStatus(a.bank_sync_status) }));
    const bankSyncIssue = accountSyncErrors.length === 0 ? null
      : accountSyncErrors.length === 1 ? `${accountSyncErrors[0].accountName}: ${accountSyncErrors[0].label}`
      : `${accountSyncErrors.length} accounts had sync issues: ${accountSyncErrors.map(e => e.accountName).join(', ')}.`;

    logger.info('Waiting 20 seconds for SimpleFIN data to process...');
    await new Promise(resolve => setTimeout(resolve, 20000));

    let newTransactions = [];
    for (const acc of accounts) {
      newTransactions.push(...await actualService.getTransactionsForAccount(acc.id, startDate, endDate));
    }

    // getTransactionsForAccount doesn't include payee_name (only the raw
    // payee id) — resolved here, once, rather than per-account inside the
    // fetch loops above, and only for the transactions actually reported.
    const rawAdded = _.differenceBy(newTransactions, oldTransactions, 'id');
    const payees = await actualService.getPayees();
    const added = actualService.resolvePayeeNames(rawAdded, payees);
    const totalBalance = Object.values(accountBalances).reduce((sum, b) => sum + b, 0);
    const hasReportableChange = added.length > 0 || bankSyncIssue;
    const forceEmail = isStartup && config.emailOnRestart;

    if (config.enableEmail && (hasReportableChange || forceEmail)) {
      logger.info('Compiling HTML email report...');
      const includeBudget = config.emailSections?.budgetVsActual !== false;
      const includeTransactions = config.emailSections?.transactions !== false;
      const [budgetVsActual, uncategorizedTransactions] = await Promise.all([
        includeBudget ? actualService.getBudgetVsActual() : Promise.resolve([]),
        includeTransactions ? actualService.getUncategorizedTransactions() : Promise.resolve([])
      ]);
      const { subject, html } = buildReportHtml({
        accounts, accountBalances, accountMap, categoryMap, added, bankSyncIssue, accountSyncErrors,
        totalBalance, budgetVsActual, uncategorizedTransactions, publicUrl: config.publicUrl,
        sections: config.emailSections, liabilityAccountIds: config.liabilityAccountIds || []
      });
      await sendReport(config, { subject, html });
      logger.info('Email report successfully dispatched.');
    } else {
      logger.info('Sync completed. No emails required or enabled.');
    }

    if (config.webhookEnabled && config.webhookUrl && hasReportableChange) {
      try {
        await sendWebhookReport(config, { added, bankSyncIssue, totalBalance, publicUrl: config.publicUrl });
        logger.info('Webhook report successfully dispatched.');
      } catch (webhookErr) {
        logger.warn('Webhook report failed to send: ' + webhookErr.message);
      }
    }

    recordSyncResult(bankSyncIssue ? 'warning' : 'success', bankSyncIssue, accountSyncErrors);
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
