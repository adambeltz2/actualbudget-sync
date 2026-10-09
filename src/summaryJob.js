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
// frequency ('monthly' | 'weekly') only changes the label/subject via
// buildSummaryReportHtml — it's the same month-to-date snapshot, scheduled
// independently (see scheduler.js, which runs the weekly and monthly cron
// jobs as separate, independently-toggleable schedules, not a replacement
// of one by the other).
async function sendSummaryEmail({ force = false, frequency = 'monthly' } = {}) {
  const label = frequency === 'weekly' ? 'Weekly' : 'Monthly';
  const config = getConfig();
  if (!config.actualUrl || !config.actualPassword || !config.syncId) {
    logger.error(`Missing Actual Budget configuration. Skipping ${label} Summary email.`);
    return;
  }
  if (!force && !config.enableEmail) {
    logger.info(`Email is disabled. Skipping ${label} Summary email.`);
    return;
  }

  logger.info(`Compiling ${label} Budget Summary email...`);
  try {
    await actualService.ensureReady(config);
    const { totalBalance, budgetVsActual, netSavingsThisMonth, typicalMonthlyNet } = await actualService.getBudgetSummaryData();
    const { pctMonthElapsed } = computeMonthProgress();
    const typicalPaceNetSavings = typicalMonthlyNet * (pctMonthElapsed / 100);

    const { subject, html } = buildSummaryReportHtml({
      totalBalance, budgetVsActual, netSavingsThisMonth, typicalPaceNetSavings, publicUrl: config.publicUrl, frequency
    });
    await sendReport(config, { subject, html });
    logger.info(`${label} Budget Summary email successfully dispatched.`);
  } catch (err) {
    logger.error(`${label} Budget Summary email failed: ` + err.message);
    throw err;
  }
}

function sendSummaryReport(opts) { return sendSummaryEmail({ ...opts, frequency: 'monthly' }); }
function sendWeeklySummaryReport(opts) { return sendSummaryEmail({ ...opts, frequency: 'weekly' }); }

module.exports = { sendSummaryReport, sendWeeklySummaryReport };
