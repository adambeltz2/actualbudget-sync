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

async function getNetWorth() {
  const accounts = await getAccounts();
  const balances = await Promise.all(accounts.map(a => getAccountBalance(a.id)));
  return balances.reduce((sum, b) => sum + b, 0);
}

async function getSpendByCategory({ days = 30 } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startStr = startDate.toISOString().split('T')[0];

  const query = q('transactions').options({ splits: 'none' })
    .filter({ date: { $gte: startStr } })
    .filter({ amount: { $lt: 0 } })
    .filter({ category: { $ne: null } })
    .groupBy('category')
    .select(['category', { total: { $sum: '$amount' } }]);
  const { data } = await api.runQuery(query);

  const categories = await getCategories();
  const categoryName = Object.fromEntries(categories.map(c => [c.id, c.name]));

  return data
    .map(row => ({ categoryId: row.category, name: categoryName[row.category] || 'Unknown', total: Math.abs(row.total) / 100 }))
    .sort((a, b) => b.total - a.total);
}

// Actual only exposes the current balance, not a history, so the trend is
// reconstructed by walking backward from the current net worth using each
// day's transaction total.
async function getBalanceTrend({ days = 30 } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startStr = startDate.toISOString().split('T')[0];

  const currentNetWorth = await getNetWorth();

  const query = q('transactions').options({ splits: 'none' })
    .filter({ date: { $gte: startStr } })
    .groupBy('date')
    .select(['date', { total: { $sum: '$amount' } }]);
  const { data: dailyTotals } = await api.runQuery(query);

  const totalsByDate = new Map(dailyTotals.map(d => [d.date, d.total]));
  const totalInRangeCents = dailyTotals.reduce((sum, d) => sum + d.total, 0);

  let runningCents = Math.round(currentNetWorth * 100) - totalInRangeCents;
  const trend = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    const dayStr = d.toISOString().split('T')[0];
    runningCents += totalsByDate.get(dayStr) || 0;
    trend.push({ date: dayStr, balance: runningCents / 100 });
  }
  return trend;
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
  countTransactions, getNetWorth, getSpendByCategory, getBalanceTrend,
  runBankSync, shutdown, isReady
};
