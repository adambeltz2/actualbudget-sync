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
  const cents = await api.getAccountBalance(accountId);
  return cents / 100;
}

async function getTransactionsForAccount(accountId, startDate, endDate) {
  return api.getTransactions(accountId, startDate, endDate);
}

async function getCategories() {
  return api.getCategories();
}

function buildTransactionFilters({ accountId, categoryId, startDate, endDate, search } = {}) {
  const filters = [];
  if (accountId) filters.push({ account: accountId });
  if (categoryId) filters.push({ category: categoryId });
  if (startDate) filters.push({ date: { $gte: startDate } });
  if (endDate) filters.push({ date: { $lte: endDate } });
  if (search) filters.push({ payee_name: { $like: `%${search}%` } });
  return filters;
}

async function queryTransactions({ limit = 50, offset = 0, ...filterArgs } = {}) {
  let query = q('transactions').options({ splits: 'none' }).select('*').orderBy({ date: 'desc' });
  for (const filter of buildTransactionFilters(filterArgs)) {
    query = query.filter(filter);
  }
  query = query.limit(limit).offset(offset);
  const { data } = await api.runQuery(query);
  return data;
}

async function countTransactions(filterArgs = {}) {
  let query = q('transactions').options({ splits: 'none' });
  for (const filter of buildTransactionFilters(filterArgs)) {
    query = query.filter(filter);
  }
  const { data } = await api.runQuery(query.calculate({ $count: '*' }));
  return data || 0;
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
  getTransactionsForAccount, getCategories, queryTransactions,
  countTransactions, runBankSync, shutdown, isReady
};
