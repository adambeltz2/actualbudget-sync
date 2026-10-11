const cron = require('node-cron');
const { logger } = require('./logger');
const { getConfig } = require('./config');
const { syncAndReport } = require('./syncJob');
const { sendSummaryReport, sendWeeklySummaryReport } = require('./summaryJob');

let currentCronJobs = [];
let currentSummaryCronJob = null;
let currentWeeklySummaryCronJob = null;

// Multiple entries let the schedule picker express "these days, at these
// times" as one job per time slot (all sharing the same days-of-week
// field) rather than trying to cram independent hour:minute pairs into a
// single cron expression, where a comma-list in both fields would fire on
// every combination instead of just the pairs the user picked.
function applySchedule() {
  const config = getConfig();
  currentCronJobs.forEach(job => job.stop());
  currentCronJobs = [];

  const schedules = Array.isArray(config.cronSchedules) ? config.cronSchedules : [];
  for (const schedule of schedules) {
    if (!schedule) continue;
    if (!cron.validate(schedule)) {
      logger.warn(`Skipping invalid cron schedule: [${schedule}]`);
      continue;
    }
    const job = cron.schedule(schedule, syncAndReport, {
      scheduled: true, timezone: process.env.TIMEZONE || 'America/New_York'
    });
    currentCronJobs.push(job);
    logger.info(`Scheduled new cron job: [${schedule}]`);
  }

  if (currentSummaryCronJob) {
    currentSummaryCronJob.stop();
    currentSummaryCronJob = null;
  }
  if (config.enableSummaryEmail) {
    const day = Math.min(Math.max(parseInt(config.summaryEmailDayOfMonth, 10) || 15, 1), 28);
    const hour = Math.min(Math.max(parseInt(config.summaryEmailHour, 10) || 8, 0), 23);
    const summarySchedule = `0 ${hour} ${day} * *`;
    currentSummaryCronJob = cron.schedule(summarySchedule, () => {
      // Scheduled firing must never throw an unhandled rejection — errors
      // are already logged inside sendSummaryReport itself.
      sendSummaryReport().catch(() => {});
    }, { scheduled: true, timezone: process.env.TIMEZONE || 'America/New_York' });
    logger.info(`Scheduled Monthly Budget Summary email: [${summarySchedule}]`);
  }

  if (currentWeeklySummaryCronJob) {
    currentWeeklySummaryCronJob.stop();
    currentWeeklySummaryCronJob = null;
  }
  if (config.enableWeeklySummaryEmail) {
    const dayOfWeek = Math.min(Math.max(parseInt(config.weeklySummaryEmailDayOfWeek, 10) || 1, 0), 6);
    const hour = Math.min(Math.max(parseInt(config.weeklySummaryEmailHour, 10) || 8, 0), 23);
    const weeklySummarySchedule = `0 ${hour} * * ${dayOfWeek}`;
    currentWeeklySummaryCronJob = cron.schedule(weeklySummarySchedule, () => {
      sendWeeklySummaryReport().catch(() => {});
    }, { scheduled: true, timezone: process.env.TIMEZONE || 'America/New_York' });
    logger.info(`Scheduled Weekly Budget Summary email: [${weeklySummarySchedule}]`);
  }
}

module.exports = { applySchedule };
