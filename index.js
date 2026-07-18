const api = require('@actual-app/api');
const { q } = require('@actual-app/api');
const cron = require('node-cron');
const winston = require('winston');
require('winston-daily-rotate-file');
const nodemailer = require('nodemailer');
const _ = require('lodash');
const express = require('express');
const fs = require('fs');
const path = require('path');
const util = require('util');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Path inside the container that maps to your Mac's ./data folder
const CONFIG_PATH = '/data/config.json';
const LOG_DIR = path.join(__dirname, 'logs');

// --- PHASE 1: Logging & Deep Capture ---
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

// Intercept internal console.log from Actual API to show up in the Web UI
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

// --- PHASE 2: Configuration Management ---
function getConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      actualUrl: "", actualPassword: "", syncId: "",
      cronSchedule: "0 6,12 * * *", enableEmail: false,
      smtpHost: "", smtpPort: "465", emailUser: "", emailPass: "", emailTo: ""
    };
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function saveConfig(newConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
  applySchedule();
}

// --- PHASE 3: Express Web API ---
app.get('/api/config', (req, res) => res.json(getConfig()));

app.post('/api/config', (req, res) => {
  saveConfig(req.body);
  logger.info('Configuration updated via Web Dashboard.');
  res.json({ success: true });
});

app.post('/api/sync', (req, res) => {
  logger.info('Manual sync triggered via Web Dashboard.');
  syncAndReport();
  res.json({ success: true, message: 'Sync started' });
});

// SSE Route for Live Log Streaming
app.get('/api/logs/stream', (req, res) => {
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

// --- PHASE 4: Core Sync Logic ---
let isSyncing = false;

async function syncAndReport() {
  if (isSyncing) return logger.warn('Sync already in progress. Skipping...');
  isSyncing = true;
  
  const config = getConfig();
  if (!config.actualUrl || !config.actualPassword || !config.syncId) {
    logger.error('Missing Actual Budget configuration. Please setup via Dashboard.');
    isSyncing = false;
    return;
  }

  logger.info('Starting Actual Budget Sync Process');
  
  try {
    await api.init({ dataDir: '/data', serverURL: config.actualUrl, password: config.actualPassword });
    await api.downloadBudget(config.syncId);

    const allAccounts = await api.getAccounts();
    const accounts = allAccounts.filter(a => !a.closed);
    const accountMap = accounts.reduce((map, acc) => { map[acc.id] = acc.name; return map; }, {});

    const accountBalances = {};
    for (let acc of accounts) {
      const result = await api.runQuery(q('transactions').filter({ account: acc.id }).calculate({ $sum: '$amount' }));
      accountBalances[acc.id] = (result.data || 0) / 100;
    }

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const startDate = thirtyDaysAgo.toISOString().split('T')[0];
    const endDate = new Date().toISOString().split('T')[0];

    let oldTransactions = [];
    for (let acc of accounts) {
      const txs = await api.getTransactions(acc.id, startDate, endDate);
      oldTransactions.push(...txs);
    }

    logger.info('Triggering Bank Sync via Actual Budget API...');
    let bankSyncIssue = null;
    try { await api.runBankSync(); } 
    catch (syncErr) { 
      logger.warn(`Bank connection issue detected: ${syncErr.message}`);
      bankSyncIssue = syncErr.message; 
    }
    
    logger.info('Waiting 20 seconds for SimpleFIN data to process...');
    await new Promise(resolve => setTimeout(resolve, 20000));

    let newTransactions = [];
    for (let acc of accounts) {
      const txs = await api.getTransactions(acc.id, startDate, endDate);
      newTransactions.push(...txs);
    }

    const added = _.differenceBy(newTransactions, oldTransactions, 'id');

    if (config.enableEmail && (added.length > 0 || bankSyncIssue)) {
      logger.info('Compiling HTML email report...');
      
      const transporter = nodemailer.createTransport({
        host: config.smtpHost, port: parseInt(config.smtpPort), secure: parseInt(config.smtpPort) === 465,
        auth: { user: config.emailUser, pass: config.emailPass }
      });

      let emailSubject = 'Budget Sync: ' + added.length + ' New Transactions';
      if (bankSyncIssue) emailSubject = '⚠️ Budget Sync Alert: Connection Issues';

      const groupedTransactions = _.groupBy(added, 'account');

      let htmlBody = `<div style="font-family: sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
        <h2 style="border-bottom: 2px solid #eee; padding-bottom: 10px;">Actual Budget Sync Report</h2>`;

      if (bankSyncIssue) {
        htmlBody += `<div style="background-color: #fceceb; border-left: 4px solid #e74c3c; padding: 15px; margin-bottom: 25px;">
            <h4 style="margin: 0 0 5px 0; color: #c0392b;">⚠️ Action Required</h4>
            <p style="margin: 0;">${bankSyncIssue}</p></div>`;
      }

      htmlBody += `<table style="width: 100%; border-collapse: collapse; margin-bottom: 35px; font-size: 14px;">
        <tr style="background-color: #f8f9fa; text-align: left; border-bottom: 2px solid #e9ecef;">
          <th style="padding: 10px;">Account</th><th style="text-align: right; padding: 10px;">Balance</th>
        </tr>`;

      for (let acc of accounts) {
        const balance = accountBalances[acc.id];
        const balanceText = balance < 0 ? '-$' + Math.abs(balance).toFixed(2) : '$' + balance.toFixed(2);
        htmlBody += `<tr style="border-bottom: 1px solid #f1f3f5;">
          <td style="padding: 10px;">${acc.name}</td><td style="text-align: right; padding: 10px;">${balanceText}</td>
        </tr>`;
      }
      htmlBody += `</table>`;

      if (added.length > 0) {
        htmlBody += `<h3>New Transactions</h3>`;
        for (const accountId in groupedTransactions) {
          htmlBody += `<p><strong>${accountMap[accountId] || 'Unknown'}</strong></p><ul>`;
          groupedTransactions[accountId].forEach(t => {
            const amt = t.amount / 100;
            const amtText = amt < 0 ? '-$' + Math.abs(amt).toFixed(2) : '+$' + amt.toFixed(2);
            htmlBody += `<li>${t.date} | ${t.payee_name || 'Unknown'} | ${amtText}</li>`;
          });
          htmlBody += `</ul>`;
        }
      }

      htmlBody += `</div>`;

      await transporter.sendMail({
        from: config.emailUser, to: config.emailTo, subject: emailSubject, html: htmlBody 
      });
      logger.info('Email report successfully dispatched.');
    } else {
      logger.info('Sync completed. No emails required or enabled.');
    }

    await api.shutdown();
    logger.info('Sync Process Finished Cleanly');
  } catch (err) {
    logger.error('Critical script failure: ' + err.message);
  } finally {
    isSyncing = false;
  }
}

// --- PHASE 5: Scheduling Engine ---
let currentCronJob = null;
function applySchedule() {
  const config = getConfig();
  if (currentCronJob) currentCronJob.stop();
  if (config.cronSchedule) {
    currentCronJob = cron.schedule(config.cronSchedule, syncAndReport, {
      scheduled: true, timezone: process.env.TIMEZONE || "America/New_York"
    });
    logger.info(`Scheduled new cron job: [${config.cronSchedule}]`);
  }
}

// --- STARTUP ---
app.listen(3000, () => {
  logger.info('Web Dashboard listening on port 3000');
  
  // Apply schedule
  applySchedule();

  // Startup Sync Logic
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