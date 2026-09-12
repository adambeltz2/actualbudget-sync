const fs = require('fs');
const crypto = require('crypto');
const { encrypt, decrypt } = require('./secretCrypto');

// Path inside the container that maps to the host's ./data folder
const CONFIG_PATH = '/data/config.json';

// Encrypted at rest when CONFIG_ENCRYPTION_KEY is set (see secretCrypto.js).
const SECRET_FIELDS = ['actualPassword', 'emailPass'];

function defaultConfig() {
  return {
    actualUrl: '', actualPassword: '', syncId: '',
    cronSchedule: '0 6,12 * * *', enableEmail: false,
    smtpHost: '', smtpPort: '465', emailUser: '', emailPass: '', emailTo: '',
    publicUrl: '',
    dashboardPasswordHash: '', sessionSecret: crypto.randomBytes(32).toString('hex'),
    dashboardWidgets: { incomeVsSpend: true, incomeVsSpendYTD: true, spendByCategory: true, balanceTrend: true, budgetVsActual: true },
    emailSections: { balances: true, transactions: true, budgetVsActual: true },
    lastSyncAt: null, lastSyncStatus: null, lastSyncError: null
  };
}

function getConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const fresh = defaultConfig();
    saveConfig(fresh);
    return fresh;
  }

  const stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!stored.sessionSecret) {
    stored.sessionSecret = crypto.randomBytes(32).toString('hex');
    saveConfig(stored);
  }

  const merged = { ...defaultConfig(), ...stored };
  for (const field of SECRET_FIELDS) {
    merged[field] = decrypt(merged[field]);
  }
  return merged;
}

function saveConfig(newConfig) {
  const toWrite = { ...newConfig };
  for (const field of SECRET_FIELDS) {
    toWrite[field] = encrypt(toWrite[field]);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(toWrite, null, 2));
}

module.exports = { CONFIG_PATH, getConfig, saveConfig, defaultConfig };
