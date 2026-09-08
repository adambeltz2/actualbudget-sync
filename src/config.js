const fs = require('fs');
const crypto = require('crypto');

// Path inside the container that maps to the host's ./data folder
const CONFIG_PATH = '/data/config.json';

function defaultConfig() {
  return {
    actualUrl: '', actualPassword: '', syncId: '',
    cronSchedule: '0 6,12 * * *', enableEmail: false,
    smtpHost: '', smtpPort: '465', emailUser: '', emailPass: '', emailTo: '',
    dashboardPasswordHash: '', sessionSecret: crypto.randomBytes(32).toString('hex')
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
  return { ...defaultConfig(), ...stored };
}

function saveConfig(newConfig) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));
}

module.exports = { CONFIG_PATH, getConfig, saveConfig, defaultConfig };
