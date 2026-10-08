const { logger } = require('./logger');
const actualService = require('./actualService');
const { sendReport } = require('./emailReport');
const { buildSummaryReportHtml } = require('./summaryReport');
const { computeMonthProgress } = require('./budgetSummary');
const { getConfig } = require('./config');

// No bank sync, no transaction fetch — reads whatever's already synced and
// emails a budget-to-date summary. Shares sendReport/the email template
// with the daily sync report, but is otherwise a separate, lighter flow
// (see src/syncJob.js for the sync+snapshot-diff version).
// `force` bypasses the enableEmail gate — used by the Settings page's "Send
// Test Email" button, which should work even before the feature (or email
// generally) has been turned on, same as the webhook test button does.
async function sendSummaryReport({ force = false } = {}) {
  const config = getConfig();
  if (!config.actualUrl || !config.actualPassword || !config.syncId) {
    logger.error('Missing Actual Budget configuration. Skipping Monthly Summary email.');
    return;
  }
  if (!force && !config.enableEmail) {
    logger.info('Email is disabled. Skipping Monthly Summary email.');
    return;
  }

  logger.info('Compiling Monthly Budget Summary email...');
  try {
    await actualService.ensureReady(config);
    const { totalBalance, budgetVsActual, netSavingsThisMonth, typicalMonthlyNet } = await actualService.getBudgetSummaryData();
    const { pctMonthElapsed } = computeMonthProgress();
    const typicalPaceNetSavings = typicalMonthlyNet * (pctMonthElapsed / 100);

    const { subject, html } = buildSummaryReportHtml({
      totalBalance, budgetVsActual, netSavingsThisMonth, typicalPaceNetSavings, publicUrl: config.publicUrl
    });
    await sendReport(config, { subject, html });
    logger.info('Monthly Budget Summary email successfully dispatched.');
  } catch (err) {
    logger.error('Monthly Budget Summary email failed: ' + err.message);
    throw err;
  }
}

module.exports = { sendSummaryReport };
