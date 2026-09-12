const api = require('@actual-app/api');
const { q } = require('@actual-app/api');
const { logger } = require('./logger');
const { buildSpendingInsights, buildBalanceProjection } = require('./insights');
const { computeEmergencyFund, computeSavingsRate, computeDebtLoad, computeOverallScore, buildRecommendations, computeNetWorthBreakdown } = require('./financialHealth');

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

async function getPayees() {
  return api.getPayees();
}

// A bare `select('*')`/`getTransactions()` does not include payee_name —
// only the raw `payee` id — because payee_name isn't part of the underlying
// transactions view in @actual-app/api; it has to be resolved the same way
// this module already resolves account/category names elsewhere. Pure and
// exported for unit testing.
function resolvePayeeNames(transactions, payees) {
  const payeeName = Object.fromEntries(payees.map(p => [p.id, p.name]));
  return transactions.map(t => ({ ...t, payee_name: t.payee_name || payeeName[t.payee] || null }));
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
  const [{ data }, payees] = await Promise.all([api.runQuery(query), getPayees()]);
  return resolvePayeeNames(data, payees);
}

// Used by CSV export, which needs every matching transaction rather than one
// page — pages through in batches instead of a single arbitrarily large
// limit, so it keeps working correctly as a budget grows past whatever that
// number was. maxRows is a sanity backstop against a runaway loop on a
// filter that somehow never shrinks, not a real-world ceiling.
async function queryAllTransactions(filterArgs = {}, { sort = 'date_desc', pageSize = 1000, maxRows = 100000 } = {}) {
  let query = q('transactions').options({ splits: 'none' }).select('*');
  for (const filter of buildTransactionFilters(filterArgs)) {
    query = query.filter(filter);
  }
  query = query.orderBy(SORT_ORDERS[sort] || SORT_ORDERS.date_desc);

  const all = [];
  let offset = 0;
  while (all.length < maxRows) {
    const { data } = await api.runQuery(query.limit(pageSize).offset(offset));
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  const payees = await getPayees();
  return resolvePayeeNames(all, payees);
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

function currentMonthStr() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

// Calendar-month bounds for a "YYYY-MM" string, clamped to today when the
// requested month is the current one — budgets live in monthly buckets, not
// rolling day windows, so "This Month"/"Last Month" replace what used to be
// an arbitrary "last N days" picker.
function monthDateRange(month) {
  const targetMonth = month || currentMonthStr();
  const [year, mo] = targetMonth.split('-').map(Number);
  const monthStart = new Date(year, mo - 1, 1);
  const naturalMonthEnd = new Date(year, mo, 0);
  const today = new Date();
  const monthEnd = (targetMonth === currentMonthStr() && naturalMonthEnd > today) ? today : naturalMonthEnd;
  return {
    monthStart, monthEnd,
    startStr: monthStart.toISOString().split('T')[0],
    endStr: monthEnd.toISOString().split('T')[0]
  };
}

async function getSpendByCategory({ month } = {}) {
  const { startStr, endStr } = monthDateRange(month);

  const query = q('transactions').options({ splits: 'none' })
    .filter({ date: { $gte: startStr, $lte: endStr } })
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
// reconstructed by walking backward from the current net worth. When the
// requested month isn't the current one, the anchor is rolled back further
// first — to net worth as of that month's own end — by subtracting
// everything that happened after it.
async function getBalanceTrend({ month } = {}) {
  const { monthStart, monthEnd, startStr, endStr } = monthDateRange(month);
  const currentNetWorth = await getNetWorth();

  const { data: afterTotal } = await api.runQuery(
    q('transactions').options({ splits: 'none' }).filter({ date: { $gt: endStr } }).calculate({ $sum: '$amount' })
  );
  const netWorthAtMonthEndCents = Math.round(currentNetWorth * 100) - (afterTotal || 0);

  const { data: dailyTotals } = await api.runQuery(
    q('transactions').options({ splits: 'none' })
      .filter({ date: { $gte: startStr, $lte: endStr } })
      .groupBy('date')
      .select(['date', { total: { $sum: '$amount' } }])
  );

  const totalsByDate = new Map(dailyTotals.map(d => [d.date, d.total]));
  const totalInRangeCents = dailyTotals.reduce((sum, d) => sum + d.total, 0);

  const numDays = Math.round((monthEnd - monthStart) / 86400000) + 1;
  let runningCents = netWorthAtMonthEndCents - totalInRangeCents;
  const trend = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(monthStart);
    d.setDate(d.getDate() + i);
    const dayStr = d.toISOString().split('T')[0];
    runningCents += totalsByDate.get(dayStr) || 0;
    trend.push({ date: dayStr, balance: runningCents / 100 });
  }
  return trend;
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

// Per-category monthly spend for the last `months` calendar months (oldest
// first), used to detect trends like "groceries are creeping up". One query
// per month (rather than a single multi-key groupBy, which the query builder
// doesn't support cleanly) — fine at the "6 months" scale this is meant for.
async function getCategorySpendTrend({ months = 6 } = {}) {
  const categories = await getCategories();
  const categoryName = Object.fromEntries(categories.map(c => [c.id, c.name]));

  const now = new Date();
  const monthRanges = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const start = d.toISOString().slice(0, 10);
    const end = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
    monthRanges.push({ month: d.toISOString().slice(0, 7), start, end });
  }

  const perMonth = await Promise.all(monthRanges.map(async ({ month, start, end }) => {
    const query = q('transactions').options({ splits: 'none' })
      .filter({ date: { $gte: start, $lte: end } })
      .filter({ amount: { $lt: 0 } })
      .filter({ category: { $ne: null } })
      .groupBy('category')
      .select(['category', { total: { $sum: '$amount' } }]);
    const { data } = await api.runQuery(query);
    return { month, totals: Object.fromEntries(data.map(row => [row.category, Math.abs(row.total) / 100])) };
  }));

  const trends = [];
  for (const [categoryId, name] of Object.entries(categoryName)) {
    const monthlyTotals = perMonth.map(({ month, totals }) => ({ month, total: totals[categoryId] || 0 }));
    if (monthlyTotals.every(m => m.total === 0)) continue;
    trends.push({ categoryId, name, monthlyTotals });
  }
  return trends;
}

// Rolling-window daily balance reconstruction ending today. Used internally
// by getMonthlyBalanceHistory, which needs one continuous multi-month series
// for the Financial Insights projection rather than a single calendar
// month's worth of days (what the dashboard's getBalanceTrend now returns).
async function getDailyBalanceHistoryForDays(days) {
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

// One balance snapshot per calendar month (the last available day in each),
// for projecting net worth forward via linear regression instead of
// guessing at a growth rate.
async function getMonthlyBalanceHistory({ months = 6 } = {}) {
  const dailyTrend = await getDailyBalanceHistoryForDays(months * 31);
  const byMonth = new Map();
  for (const point of dailyTrend) {
    byMonth.set(point.date.slice(0, 7), point.balance);
  }
  return [...byMonth.entries()].map(([month, balance]) => ({ month, balance }));
}

async function getFinancialInsights({ months = 6, annualReturnRatePct = 7 } = {}) {
  const [categoryTrends, monthlyBalances] = await Promise.all([
    getCategorySpendTrend({ months }),
    getMonthlyBalanceHistory({ months })
  ]);

  return {
    spendingTrends: buildSpendingInsights(categoryTrends),
    balanceProjection: buildBalanceProjection(monthlyBalances, { annualReturnRate: annualReturnRatePct / 100 })
  };
}

// Combines account balances (which accounts count as liquid savings or
// investments is a user setting, not something Actual's data can tell us —
// it only has names and balances, no checking/savings/investment
// distinction) with recent income/spend to produce the Financial Health
// Check widget's data.
async function getFinancialHealthData({ emergencyFundAccountIds = [], investmentAccountIds = [], targetMonths = 6, targetSavingsPct = 20 } = {}) {
  const accounts = await getAccounts();
  const balances = await Promise.all(accounts.map(async a => ({ id: a.id, balance: await getAccountBalance(a.id) })));

  const liquidBalance = Math.max(
    balances.filter(b => emergencyFundAccountIds.includes(b.id)).reduce((sum, b) => sum + b.balance, 0),
    0
  );
  const debtTotal = balances.reduce((sum, b) => sum + (b.balance < 0 ? -b.balance : 0), 0);
  const netWorth = balances.reduce((sum, b) => sum + b.balance, 0);
  const investmentBalance = balances.filter(b => investmentAccountIds.includes(b.id)).reduce((sum, b) => sum + b.balance, 0);
  const netWorthBreakdown = computeNetWorthBreakdown({ netWorth, investmentBalance, debtTotal });

  // Averaged over the last 3 complete calendar months (excluding the
  // current, possibly-partial month) so checking this on the 2nd of the
  // month doesn't make the emergency fund look artificially huge.
  const now = new Date();
  const recentMonths = [1, 2, 3].map(i => {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const monthlyFigures = await Promise.all(recentMonths.map(m => getIncomeVsSpend({ month: m })));
  const monthlyIncome = monthlyFigures.reduce((sum, m) => sum + m.income, 0) / monthlyFigures.length;
  const monthlyAvgSpend = monthlyFigures.reduce((sum, m) => sum + m.spend, 0) / monthlyFigures.length;

  const emergencyFund = computeEmergencyFund({ liquidBalance, monthlyAvgSpend, targetMonths });
  const savingsRate = computeSavingsRate({ income: monthlyIncome, spend: monthlyAvgSpend, targetPct: targetSavingsPct });
  const debtLoad = computeDebtLoad({ debtTotal, monthlyIncome });
  const { overall, label } = computeOverallScore({ emergencyFund, savingsRate, debtLoad });
  const recommendations = buildRecommendations({ emergencyFund, savingsRate, debtLoad });

  return { overall, label, emergencyFund, savingsRate, debtLoad, recommendations, liquidBalance, monthlyIncome, monthlyAvgSpend, netWorthBreakdown };
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
  getTransactionsForAccount, getCategories, getPayees, queryTransactions, queryAllTransactions,
  countTransactions, getNetWorth, getSpendByCategory, getBalanceTrend,
  getBudgetMonths, getIncomeVsSpend, getIncomeVsSpendYTD, getBudgetVsActual,
  getCategorySpendTrend, getMonthlyBalanceHistory, getFinancialInsights, getFinancialHealthData,
  testConnection,
  runBankSync, shutdown, isReady,
  // Exported for unit testing (pure functions, no @actual-app/api calls).
  buildTransactionFilters, SORT_ORDERS, summarizeBudgetCategory, resolvePayeeNames, monthDateRange
};
