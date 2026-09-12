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

// Used by the dashboard's "Test Connection" button. Reuses ensureReady, so a
// failed test only tears down the shared session temporarily — the next real
// call (a scheduled sync or a dashboard load) re-initializes from the saved
// config's own fingerprint and self-heals.
async function testConnection(candidateConfig) {
  await ensureReady(candidateConfig);
  const accounts = await getAccounts({ includeClosed: true });
  return { accountCount: accounts.length };
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

const SORT_ORDERS = {
  date_desc: { date: 'desc' },
  date_asc: { date: 'asc' },
  amount_desc: { amount: 'desc' },
  amount_asc: { amount: 'asc' }
};

async function queryTransactions({ limit = 50, offset = 0, sort = 'date_desc', ...filterArgs } = {}) {
  let query = q('transactions').options({ splits: 'none' }).select('*');
  for (const filter of buildTransactionFilters(filterArgs)) {
    query = query.filter(filter);
  }
  query = query.orderBy(SORT_ORDERS[sort] || SORT_ORDERS.date_desc).limit(limit).offset(offset);
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

function currentMonthStr() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

async function getBudgetMonths() {
  return api.getBudgetMonths();
}

async function getIncomeVsSpend({ month } = {}) {
  const targetMonth = month || currentMonthStr();
  const availableMonths = await getBudgetMonths();
  if (!availableMonths.includes(targetMonth)) {
    return { month: targetMonth, income: 0, spend: 0 };
  }
  const budgetMonth = await api.getBudgetMonth(targetMonth);
  return {
    month: targetMonth,
    income: budgetMonth.totalIncome / 100,
    spend: Math.abs(budgetMonth.totalSpent) / 100
  };
}

async function getIncomeVsSpendYTD() {
  const now = new Date();
  const year = now.getFullYear();
  const monthsSoFar = [];
  for (let m = 1; m <= now.getMonth() + 1; m++) {
    monthsSoFar.push(`${year}-${String(m).padStart(2, '0')}`);
  }

  const availableMonths = await getBudgetMonths();
  const validMonths = monthsSoFar.filter(m => availableMonths.includes(m));
  const budgetMonths = await Promise.all(validMonths.map(m => api.getBudgetMonth(m)));

  return {
    income: budgetMonths.reduce((sum, bm) => sum + bm.totalIncome, 0) / 100,
    spend: budgetMonths.reduce((sum, bm) => sum + Math.abs(bm.totalSpent), 0) / 100,
    monthsIncluded: validMonths.length
  };
}

// Pure — takes one category object from getBudgetMonth()'s categoryGroups
// (amounts still in cents, spend as a negative sum like transaction amounts)
// and derives the display-ready stats. Exported for unit testing.
function summarizeBudgetCategory(cat) {
  const budgeted = (cat.budgeted || 0) / 100;
  const spent = Math.abs(cat.spent || 0) / 100;
  const overBudget = budgeted > 0 ? spent > budgeted : spent > 0;
  const pctUsed = budgeted > 0 ? Math.round((spent / budgeted) * 100) : (spent > 0 ? 100 : 0);
  return {
    categoryId: cat.id,
    name: cat.name,
    budgeted,
    spent,
    remaining: budgeted - spent,
    pctUsed,
    overBudget
  };
}

async function getBudgetVsActual({ month } = {}) {
  const targetMonth = month || currentMonthStr();
  const availableMonths = await getBudgetMonths();
  if (!availableMonths.includes(targetMonth)) return [];

  const budgetMonth = await api.getBudgetMonth(targetMonth);
  const categories = [];
  for (const group of budgetMonth.categoryGroups) {
    if (group.is_income || group.hidden) continue;
    for (const cat of group.categories) {
      if (cat.hidden) continue;
      if (!cat.budgeted && !cat.spent) continue;
      categories.push(summarizeBudgetCategory(cat));
    }
  }
  return categories.sort((a, b) => b.spent - a.spent);
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
  getBudgetMonths, getIncomeVsSpend, getIncomeVsSpendYTD, getBudgetVsActual,
  testConnection,
  runBankSync, shutdown, isReady,
  // Exported for unit testing (pure functions, no @actual-app/api calls).
  buildTransactionFilters, SORT_ORDERS, summarizeBudgetCategory
};
