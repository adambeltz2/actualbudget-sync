const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const util = require('util');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(info => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
  ),
  transports: [
    new winston.transports.DailyRotateFile({ filename: path.join(LOG_DIR, 'sync-%DATE%.log'), datePattern: 'YYYY-MM-DD', maxFiles: '14d' }),
    new winston.transports.Console()
  ]
});

// Actual's API logs via console.log/error internally; mirror it into winston so it shows up in the dashboard's log stream.
function captureConsole() {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;

  console.log = function (...args) {
    originalConsoleLog.apply(console, args);
    logger.info(util.format(...args));
  };
  console.error = function (...args) {
    originalConsoleError.apply(console, args);
    logger.error(util.format(...args));
  };
}

module.exports = { logger, captureConsole, LOG_DIR };
