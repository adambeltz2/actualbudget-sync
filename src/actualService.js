const api = require('@actual-app/api');
const { q } = require('@actual-app/api');
const { logger } = require('./logger');

// Kept open across sync cycles instead of init()/shutdown() per run, so the
// downloaded budget stays queryable between syncs (needed by the data
// explorer/dashboard work planned in the backlog).
let initialized = false;
let currentFingerprint = null;

function fingerprint(config) {
  return `${config.actualUrl}|${config.syncId}|${config.actualPassword}`;
}

async function ensureReady(config) {
  const fp = fingerprint(config);
  if (initialized && fp === currentFingerprint) return;

  if (initialized) {
    logger.info('Actual Budget configuration changed; reinitializing data service...');
    await shutdown();
  }

  await api.init({ dataDir: '/data', serverURL: config.actualUrl, password: config.actualPassword });
  await api.downloadBudget(config.syncId);
  initialized = true;
  currentFingerprint = fp;
}

async function refreshBudget(config) {
  await ensureReady(config);
  await api.downloadBudget(config.syncId);
}

async function getAccounts({ includeClosed = false } = {}) {
  const all = await api.getAccounts();
  return includeClosed ? all : all.filter(a => !a.closed);
}

async function getAccountBalance(accountId) {
  const result = await api.runQuery(q('transactions').filter({ account: accountId }).calculate({ $sum: '$amount' }));
  return (result.data || 0) / 100;
}

async function getTransactionsForAccount(accountId, startDate, endDate) {
  return api.getTransactions(accountId, startDate, endDate);
}

async function runBankSync() {
  return api.runBankSync();
}

async function shutdown() {
  if (!initialized) return;
  await api.shutdown();
  initialized = false;
  currentFingerprint = null;
}

function isReady() {
  return initialized;
}

module.exports = {
  ensureReady, refreshBudget, getAccounts, getAccountBalance,
  getTransactionsForAccount, runBankSync, shutdown, isReady
};
