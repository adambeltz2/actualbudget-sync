const cron = require('node-cron');
const { logger } = require('./logger');
const { getConfig } = require('./config');
const { syncAndReport } = require('./syncJob');

let currentCronJob = null;

function applySchedule() {
  const config = getConfig();
  if (currentCronJob) currentCronJob.stop();
  if (config.cronSchedule) {
    currentCronJob = cron.schedule(config.cronSchedule, syncAndReport, {
      scheduled: true, timezone: process.env.TIMEZONE || 'America/New_York'
    });
    logger.info(`Scheduled new cron job: [${config.cronSchedule}]`);
  }
}

module.exports = { applySchedule };
