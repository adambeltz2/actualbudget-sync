const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// getFinancialHealthData/getFinancialHealthHistory average income/spend
// over a rolling trailing-12-month window (capped to however much real
// budget history exists) -- these calls into @actual-app/api need a live
// server, stubbed at the module-resolution level, same technique as
// actualServicePagination.test.js.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

// now: 'YYYY-MM' treated as "this month" for currentMonthStr(). incomeSpendByMonth:
// { 'YYYY-MM': { income, spend } } in dollars for every month getBudgetMonths() lists.
function installFakeApi({ accountBalanceCents = 500000, availableMonths, incomeSpendByMonth }) {
  const fakeApi = {
    getAccounts: async () => [{ id: 'a1', closed: false }],
    getAccountBalance: async () => accountBalanceCents,
    getBudgetMonths: async () => availableMonths,
    getBudgetMonth: async (month) => {
      const figures = incomeSpendByMonth[month] || { income: 0, spend: 0 };
      return { totalIncome: Math.round(figures.income * 100), totalSpent: -Math.round(figures.spend * 100), categoryGroups: [] };
    },
    runQuery: async () => ({ data: [] })
  };
  const chain = {
    options: () => chain, filter: () => chain, groupBy: () => chain, select: () => chain, limit: () => chain, offset: () => chain, calculate: () => chain
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q: () => chain })
  };
}

// Builds the 'YYYY-MM' string `monthsAgo` calendar months before today.
function monthsAgoStr(monthsAgo) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

describe('getFinancialHealthData', () => {
  test('averages income/spend over the trailing 12 available months, excluding the current month', async () => {
    // 14 months of history exist (current month back through 13 months
    // ago); only the 12 immediately before the current month should feed
    // the average -- months 13 and 14 back, and the current month itself,
    // must NOT be included.
    const incomeSpendByMonth = {};
    const availableMonths = [];
    for (let i = 0; i <= 13; i++) {
      const m = monthsAgoStr(i);
      availableMonths.push(m);
      // Distinct spend per month (1000 + i) so an accidental inclusion of
      // month 13 (1013) or exclusion of a real in-window month is visible
      // in the resulting average rather than silently cancelling out.
      incomeSpendByMonth[m] = { income: 2000, spend: 1000 + i };
    }
    installFakeApi({ availableMonths, incomeSpendByMonth });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const result = await actualService.getFinancialHealthData({});
    // Months 1 through 12 back: spend = 1001..1012, average = 1006.5
    assert.equal(result.monthlyAvgSpend, 1006.5);
    assert.equal(result.monthlyIncome, 2000);
  });

  test('caps to whatever history exists when less than 12 months are available', async () => {
    const incomeSpendByMonth = {};
    const availableMonths = [];
    for (let i = 0; i <= 3; i++) {
      const m = monthsAgoStr(i);
      availableMonths.push(m);
      incomeSpendByMonth[m] = { income: 1000, spend: 500 };
    }
    installFakeApi({ availableMonths, incomeSpendByMonth });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const result = await actualService.getFinancialHealthData({});
    // Only months 1-3 back exist (current month excluded) -- averaging
    // over a full 12 would wrongly dilute this toward zero.
    assert.equal(result.monthlyAvgSpend, 500);
    assert.equal(result.monthlyIncome, 1000);
  });

  test('a brand-new install with no history at all does not throw or produce NaN', async () => {
    installFakeApi({ availableMonths: [], incomeSpendByMonth: {} });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const result = await actualService.getFinancialHealthData({});
    assert.equal(result.monthlyAvgSpend, 0);
    assert.equal(result.monthlyIncome, 0);
  });
});

describe('getFinancialHealthHistory', () => {
  test('each trend point averages its own trailing 12-month window, including fully-elapsed months in their own window', async () => {
    const incomeSpendByMonth = {};
    const availableMonths = [];
    for (let i = 0; i <= 13; i++) {
      const m = monthsAgoStr(i);
      availableMonths.push(m);
      incomeSpendByMonth[m] = { income: 2000, spend: 1000 };
    }
    installFakeApi({ availableMonths, incomeSpendByMonth });
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const history = await actualService.getFinancialHealthHistory({ months: 2 });
    assert.ok(history.length > 0);
    // Flat 1000/month spend and 2000/month income everywhere in range ->
    // every trend point's savings rate should land on the same number
    // regardless of window size, confirming the per-point average ran
    // without error across both a past month and (if present) the current
    // month's excluded-self window.
    history.forEach(point => assert.equal(point.savingsRatePct, 50));
  });
});
