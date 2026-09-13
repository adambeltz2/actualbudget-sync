const api = require('@actual-app/api');
const { q } = require('@actual-app/api');
const { logger } = require('./logger');
const { buildSpendingInsights, buildBalanceProjection, monthsToReachTarget } = require('./insights');
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

// An explicit startDate/endDate pair (both "YYYY-MM-DD") takes precedence
// over `month` wherever both could apply, so the dashboard's period picker
// can drive these functions with either a single calendar month or one of
// the multi-month quick-range presets (Last 3/6 Months, Current/Prior Year).
function explicitDateRange(startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  return {
    monthStart: new Date(sy, sm - 1, sd),
    monthEnd: new Date(ey, em - 1, ed),
    startStr: startDate,
    endStr: endDate
  };
}

// Every "YYYY-MM" budget month a date range touches, inclusive of both ends
// — used to sum Actual's per-month budget data (getBudgetMonth) across a
// range wider than one calendar month, since Actual itself has no
// range-based budget query.
function monthsInRange(startDate, endDate) {
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = endDate.split('-').map(Number);
  const months = [];
  let y = sy, m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

async function getSpendByCategory({ month, startDate, endDate } = {}) {
  const { startStr, endStr } = (startDate && endDate) ? explicitDateRange(startDate, endDate) : monthDateRange(month);

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
async function getBalanceTrend({ month, startDate, endDate } = {}) {
  const { monthStart, monthEnd, startStr, endStr } = (startDate && endDate) ? explicitDateRange(startDate, endDate) : monthDateRange(month);
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

async function getIncomeVsSpend({ month, startDate, endDate } = {}) {
  const availableMonths = await getBudgetMonths();

  if (startDate && endDate) {
    const validMonths = monthsInRange(startDate, endDate).filter(m => availableMonths.includes(m));
    const budgetMonths = await Promise.all(validMonths.map(m => api.getBudgetMonth(m)));
    return {
      income: budgetMonths.reduce((sum, bm) => sum + bm.totalIncome, 0) / 100,
      spend: budgetMonths.reduce((sum, bm) => sum + Math.abs(bm.totalSpent), 0) / 100
    };
  }

  const targetMonth = month || currentMonthStr();
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

// Pure — split out from getMetricTransactions so "which transactions count
// toward this metric" is unit-testable without a live Actual server.
// Classifies by each transaction's own category.is_income flag rather than
// the transaction's sign, since a refund or correction can carry either
// sign within either bucket. Uncategorized transactions (which includes
// transfers — Actual never assigns those a category) are excluded, the same
// convention this app already uses for spend-by-category aggregation.
function classifyMetricTransactions(transactions, { onBudgetAccountIds, incomeCategoryIds, metric }) {
  return transactions.filter(t => {
    if (!onBudgetAccountIds.has(t.account)) return false;
    if (!t.category) return false;
    const isIncome = incomeCategoryIds.has(t.category);
    return metric === 'income' ? isIncome : !isIncome;
  });
}

// The underlying transactions behind a dashboard Income/Spend figure, so a
// user can verify the number themselves instead of trusting the budget
// engine's own total blindly. Mirrors the budget engine's own definition as
// closely as this app's query layer can: on-budget accounts only,
// categorized transactions only, split by each category's income/expense
// type rather than transaction sign.
async function getMetricTransactions({ metric, month, range, startDate, endDate } = {}) {
  let startStr, endStr;
  if (startDate && endDate) {
    startStr = startDate;
    endStr = endDate;
  } else if (range === 'ytd') {
    const now = new Date();
    startStr = `${now.getFullYear()}-01-01`;
    endStr = now.toISOString().split('T')[0];
  } else {
    ({ startStr, endStr } = monthDateRange(month));
  }

  const [accounts, categories, transactions] = await Promise.all([
    getAccounts(),
    getCategories(),
    queryAllTransactions({ startDate: startStr, endDate: endStr }, { sort: 'date_desc' })
  ]);
  const onBudgetAccountIds = new Set(accounts.filter(a => !a.offbudget).map(a => a.id));
  const incomeCategoryIds = new Set(categories.filter(c => c.is_income).map(c => c.id));
  const categoryName = Object.fromEntries(categories.map(c => [c.id, c.name]));
  const accountName = Object.fromEntries(accounts.map(a => [a.id, a.name]));

  const matching = classifyMetricTransactions(transactions, { onBudgetAccountIds, incomeCategoryIds, metric });
  const rows = matching.map(t => ({
    id: t.id,
    date: t.date,
    payee_name: t.payee_name,
    account: accountName[t.account] || 'Unknown',
    category: categoryName[t.category] || 'Uncategorized',
    amount: t.amount / 100
  }));
  const total = Math.abs(matching.reduce((sum, t) => sum + t.amount, 0) / 100);

  return { transactions: rows, total, count: rows.length, startDate: startStr, endDate: endStr };
}

// FIRE ("Financial Independence, Retire Early") progress: what fraction of
// your target nest egg (annual expenses × 100/withdrawal-rate — the
// standard "4% rule" is withdrawalRatePct=4, i.e. a 25x multiple) your
// current net worth represents, and how many months of compounding at your
// current savings pace would close the gap. There's no way to derive a
// FIRE target from Actual's data alone (it's a personal choice, not
// something transactions can tell you), so annualExpenses is a user-set
// override; left unset, it falls back to your trailing-12-month average
// spend annualized, the same "use real history instead of a guess"
// approach the rest of this app takes.
async function getFireProgress({ fireAnnualExpenses, fireWithdrawalRatePct = 4, annualReturnRatePct = 7 } = {}) {
  const accounts = await getAccounts();
  const balances = await Promise.all(accounts.map(async a => ({ id: a.id, balance: await getAccountBalance(a.id) })));
  const netWorth = balances.reduce((sum, b) => sum + b.balance, 0);

  const now = new Date();
  const recentMonths = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() - (i + 1), 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const monthlyFigures = await Promise.all(recentMonths.map(m => getIncomeVsSpend({ month: m })));
  const validMonths = monthlyFigures.filter(m => m.income > 0 || m.spend > 0);
  const avgMonthlyIncome = validMonths.length > 0 ? validMonths.reduce((sum, m) => sum + m.income, 0) / validMonths.length : 0;
  const avgMonthlySpend = validMonths.length > 0 ? validMonths.reduce((sum, m) => sum + m.spend, 0) / validMonths.length : 0;

  const autoAnnualExpenses = avgMonthlySpend * 12;
  const annualExpenses = fireAnnualExpenses > 0 ? fireAnnualExpenses : autoAnnualExpenses;
  const fireNumber = annualExpenses * (100 / fireWithdrawalRatePct);
  const pctReached = fireNumber > 0 ? Math.min((netWorth / fireNumber) * 100, 100) : 0;

  const monthlyContribution = avgMonthlyIncome - avgMonthlySpend;
  const monthsToFI = monthsToReachTarget({
    currentBalance: netWorth, monthlyContribution, annualReturnRate: annualReturnRatePct / 100, target: fireNumber
  });

  return {
    netWorth, fireNumber, annualExpenses, autoAnnualExpenses,
    usesCustomExpenses: fireAnnualExpenses > 0,
    fireWithdrawalRatePct, pctReached, monthlyContribution,
    yearsToFI: monthsToFI === null ? null : Math.floor(monthsToFI / 12),
    monthsRemainderToFI: monthsToFI === null ? null : monthsToFI % 12
  };
}

// A Spotify-Wrapped-style year-in-review, inspired by actualbudget/wrapped
// (a standalone tool that requires exporting and uploading your budget
// file) — built as a live view against the already-synced data instead,
// since this app is already connected. Income/expenses use the same
// on-budget, category-type classification as getMetricTransactions, for
// consistency with the rest of the app's numbers; the activity stats
// (top payees, busiest day/month, the heatmap) intentionally use every
// transaction in the year regardless of category or on-budget status,
// since those describe real account activity, not the budget totals.
async function getWrappedData({ year } = {}) {
  const y = year || new Date().getFullYear();
  const startStr = `${y}-01-01`;
  const endStr = `${y}-12-31`;

  const [accounts, categories, transactions] = await Promise.all([
    getAccounts(),
    getCategories(),
    queryAllTransactions({ startDate: startStr, endDate: endStr }, { sort: 'date_asc' })
  ]);
  const onBudgetAccountIds = new Set(accounts.filter(a => !a.offbudget).map(a => a.id));
  const incomeCategoryIds = new Set(categories.filter(c => c.is_income).map(c => c.id));
  const categoryName = Object.fromEntries(categories.map(c => [c.id, c.name]));

  const budgetTx = transactions.filter(t => onBudgetAccountIds.has(t.account) && t.category);
  const incomeTx = budgetTx.filter(t => incomeCategoryIds.has(t.category));
  const expenseTx = budgetTx.filter(t => !incomeCategoryIds.has(t.category));

  const income = incomeTx.reduce((sum, t) => sum + t.amount, 0) / 100;
  const expenses = Math.abs(expenseTx.reduce((sum, t) => sum + t.amount, 0)) / 100;

  const categoryTotals = new Map();
  for (const t of expenseTx) {
    const name = categoryName[t.category] || 'Uncategorized';
    categoryTotals.set(name, (categoryTotals.get(name) || 0) + Math.abs(t.amount) / 100);
  }
  const topCategories = [...categoryTotals.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const payeeTotals = new Map();
  for (const t of expenseTx) {
    const name = t.payee_name || 'Unknown';
    const existing = payeeTotals.get(name) || { total: 0, count: 0 };
    existing.total += Math.abs(t.amount) / 100;
    existing.count += 1;
    payeeTotals.set(name, existing);
  }
  const topPayees = [...payeeTotals.entries()]
    .map(([name, v]) => ({ name, total: v.total, count: v.count }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);

  const dayCounts = new Map();
  const monthCounts = new Map();
  for (const t of transactions) {
    dayCounts.set(t.date, (dayCounts.get(t.date) || 0) + 1);
    const month = t.date.slice(0, 7);
    monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
  }
  const dailyHeatmap = [...dayCounts.entries()].map(([date, count]) => ({ date, count }));
  const busiestDay = dailyHeatmap.reduce((best, d) => (!best || d.count > best.count) ? d : best, null);
  const busiestMonthEntry = [...monthCounts.entries()].reduce(
    (best, [month, count]) => (!best || count > best.count) ? { month, count } : best, null
  );

  return {
    year: y, income, expenses,
    topCategories, topPayees,
    totalTransactions: transactions.length,
    busiestDay, busiestMonth: busiestMonthEntry,
    dailyHeatmap
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

async function getBudgetVsActual({ month, startDate, endDate } = {}) {
  const availableMonths = await getBudgetMonths();

  if (startDate && endDate) {
    const validMonths = monthsInRange(startDate, endDate).filter(m => availableMonths.includes(m));
    if (validMonths.length === 0) return [];
    const budgetMonths = await Promise.all(validMonths.map(m => api.getBudgetMonth(m)));
    // Budgeted/spent are summed per category across every included month,
    // since Actual only exposes budget data one calendar month at a time.
    const merged = new Map();
    for (const bm of budgetMonths) {
      for (const group of bm.categoryGroups) {
        if (group.is_income || group.hidden) continue;
        for (const cat of group.categories) {
          if (cat.hidden) continue;
          const existing = merged.get(cat.id) || { id: cat.id, name: cat.name, budgeted: 0, spent: 0 };
          existing.budgeted += cat.budgeted || 0;
          existing.spent += cat.spent || 0;
          merged.set(cat.id, existing);
        }
      }
    }
    return [...merged.values()]
      .filter(cat => cat.budgeted || cat.spent)
      .map(summarizeBudgetCategory)
      .sort((a, b) => b.spent - a.spent);
  }

  const targetMonth = month || currentMonthStr();
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
// An optional accountIds filter scopes both the anchor balance and the
// transaction query to just those accounts, so the same reconstruction
// logic can produce a whole-net-worth series or a per-account-group one
// (e.g. just the accounts tagged as investments).
async function getDailyBalanceHistoryForDays(days, { accountIds } = {}) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days - 1));
  const startStr = startDate.toISOString().split('T')[0];

  const currentBalance = accountIds
    ? (await Promise.all(accountIds.map(id => getAccountBalance(id)))).reduce((sum, b) => sum + b, 0)
    : await getNetWorth();

  let query = q('transactions').options({ splits: 'none' }).filter({ date: { $gte: startStr } });
  if (accountIds) query = query.filter({ account: { $oneof: accountIds } });
  query = query.groupBy('date').select(['date', { total: { $sum: '$amount' } }]);
  const { data: dailyTotals } = await api.runQuery(query);

  const totalsByDate = new Map(dailyTotals.map(d => [d.date, d.total]));
  const totalInRangeCents = dailyTotals.reduce((sum, d) => sum + d.total, 0);

  let runningCents = Math.round(currentBalance * 100) - totalInRangeCents;
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

function monthlyFromDaily(dailyTrend) {
  const byMonth = new Map();
  for (const point of dailyTrend) {
    byMonth.set(point.date.slice(0, 7), point.balance);
  }
  return [...byMonth.entries()].map(([month, balance]) => ({ month, balance }));
}

// One balance snapshot per calendar month (the last available day in each),
// for projecting net worth forward via linear regression instead of
// guessing at a growth rate.
async function getMonthlyBalanceHistory({ months = 6 } = {}) {
  const dailyTrend = await getDailyBalanceHistoryForDays(months * 31);
  return monthlyFromDaily(dailyTrend);
}

// Same reconstruction, scoped to just the manually-tagged investment
// accounts, so the projection can compound only the balance actually
// invested instead of assuming a market return on cash sitting in checking.
async function getMonthlyBalanceHistoryForAccounts(accountIds, { months = 6 } = {}) {
  if (accountIds.length === 0) return [];
  const dailyTrend = await getDailyBalanceHistoryForDays(months * 31, { accountIds });
  return monthlyFromDaily(dailyTrend);
}

async function getFinancialInsights({ months = 6, annualReturnRatePct = 7, investmentAccountIds = [] } = {}) {
  const [categoryTrends, monthlyBalances, investmentMonthlyBalances] = await Promise.all([
    getCategorySpendTrend({ months }),
    getMonthlyBalanceHistory({ months }),
    getMonthlyBalanceHistoryForAccounts(investmentAccountIds, { months })
  ]);

  // liquid = total - investment at each matching month, so liquid +
  // investment always reconciles exactly to the total net worth series.
  const investmentByMonth = new Map(investmentMonthlyBalances.map(m => [m.month, m.balance]));
  const liquidMonthlyBalances = investmentMonthlyBalances.length > 0
    ? monthlyBalances.map(m => ({ month: m.month, balance: m.balance - (investmentByMonth.get(m.month) || 0) }))
    : [];

  return {
    spendingTrends: buildSpendingInsights(categoryTrends),
    balanceProjection: buildBalanceProjection(monthlyBalances, investmentMonthlyBalances, liquidMonthlyBalances, { annualReturnRate: annualReturnRatePct / 100 }),
    usesInvestmentTagging: investmentMonthlyBalances.length > 0
  };
}

// Combines account balances (which accounts count as liquid savings or
// investments is a user setting, not something Actual's data can tell us —
// it only has names and balances, no checking/savings/investment
// distinction) with recent income/spend to produce the Financial Health
// Check widget's data.
async function getFinancialHealthData({ emergencyFundAccountIds = [], investmentAccountIds = [], liabilityAccountIds = [], targetMonths = 6, targetSavingsPct = 20 } = {}) {
  const accounts = await getAccounts();
  const balances = await Promise.all(accounts.map(async a => ({ id: a.id, balance: await getAccountBalance(a.id) })));

  const liquidBalance = Math.max(
    balances.filter(b => emergencyFundAccountIds.includes(b.id)).reduce((sum, b) => sum + b.balance, 0),
    0
  );
  // Prefer explicit Liability Account tags when set; fall back to "any
  // account with a negative balance" for installs that haven't tagged yet.
  const debtTotal = (liabilityAccountIds.length > 0
    ? balances.filter(b => liabilityAccountIds.includes(b.id))
    : balances
  ).reduce((sum, b) => sum + (b.balance < 0 ? -b.balance : 0), 0);
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

// Reconstructs the Financial Health score for each of the last `months`
// calendar months, so the widget can show a trend instead of just today's
// snapshot — without persisting anything new. Actual already retains full
// transaction history, and this app already replays it backward to
// reconstruct a balance at any past date (getMonthlyBalanceHistory /
// getMonthlyBalanceHistoryForAccounts); a past month's income/spend is
// always directly queryable too. The one thing that ISN'T historical is
// which accounts are tagged — Actual has no "tagged starting on this date"
// concept, so today's Emergency Fund/Investment/Liability Account tags are
// applied to every past month's balances. That's an approximation ("what
// would my score have been if I'd tagged accounts the way I do today"), not
// a limitation worth building new persisted state to avoid. When no
// Liability Accounts are tagged, "debt" accounts for this trend fall back to
// whichever accounts have a negative balance today — an account that
// carried debt in the past but is paid off now won't show that old debt,
// the same approximation as above.
async function getFinancialHealthHistory({ emergencyFundAccountIds = [], liabilityAccountIds = [], targetMonths = 6, targetSavingsPct = 20, months = 6 } = {}) {
  const accounts = await getAccounts();
  const currentBalances = await Promise.all(accounts.map(async a => ({ id: a.id, balance: await getAccountBalance(a.id) })));
  const debtAccountIds = liabilityAccountIds.length > 0
    ? liabilityAccountIds
    : currentBalances.filter(b => b.balance < 0).map(b => b.id);

  const [totalHistory, liquidHistory, debtHistory] = await Promise.all([
    getMonthlyBalanceHistory({ months }),
    getMonthlyBalanceHistoryForAccounts(emergencyFundAccountIds, { months }),
    getMonthlyBalanceHistoryForAccounts(debtAccountIds, { months })
  ]);
  const liquidByMonth = new Map(liquidHistory.map(m => [m.month, m.balance]));
  const debtByMonth = new Map(debtHistory.map(m => [m.month, m.balance]));

  // totalHistory's month list is always populated (it doesn't depend on any
  // tagging), so it drives which months appear in the trend.
  const monthlyFigures = await Promise.all(totalHistory.map(m => getIncomeVsSpend({ month: m.month })));

  return totalHistory.map((m, i) => {
    const liquidBalance = Math.max(liquidByMonth.get(m.month) || 0, 0);
    const debtTotal = Math.max(-(debtByMonth.get(m.month) || 0), 0);
    const { income, spend } = monthlyFigures[i];

    const emergencyFund = computeEmergencyFund({ liquidBalance, monthlyAvgSpend: spend, targetMonths });
    const savingsRate = computeSavingsRate({ income, spend, targetPct: targetSavingsPct });
    const debtLoad = computeDebtLoad({ debtTotal, monthlyIncome: income });
    const { overall, label } = computeOverallScore({ emergencyFund, savingsRate, debtLoad });

    return { month: m.month, overall, label, emergencyFundMonths: emergencyFund.months, savingsRatePct: savingsRate.ratePct, debtTotal };
  });
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
  getCategorySpendTrend, getMonthlyBalanceHistory, getFinancialInsights, getFinancialHealthData, getFinancialHealthHistory,
  getMetricTransactions, getFireProgress, getWrappedData,
  testConnection,
  runBankSync, shutdown, isReady,
  // Exported for unit testing (pure functions, no @actual-app/api calls).
  buildTransactionFilters, SORT_ORDERS, summarizeBudgetCategory, resolvePayeeNames, monthDateRange, monthsInRange, classifyMetricTransactions
};
