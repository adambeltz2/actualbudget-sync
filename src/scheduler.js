const cron = require('node-cron');
const { logger } = require('./logger');
const { getConfig } = require('./config');
const { syncAndReport } = require('./syncJob');

let currentCronJobs = [];

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
}

module.exports = { applySchedule };
