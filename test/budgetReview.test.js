const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSustainability, computeUnassignedSpend, computeCategoryGrid, computeYearOverYearTrends,
  coefficientOfVariation
} = require('../src/budgetReview');

describe('computeSustainability', () => {
  const history = [
    { month: '2026-04', income: 9000, spend: 8000, net: 1000 },
    { month: '2026-05', income: 9000, spend: 9500, net: -500 },
    { month: '2026-06', income: 9000, spend: 9200, net: -200 },
    { month: '2026-07', income: 9000, spend: 8800, net: 200 },
    { month: '2026-08', income: 9000, spend: 9600, net: -600 },
    { month: '2026-09', income: 9000, spend: 9100, net: -100 }
  ];

  test('counts overspend months within the lookback window', () => {
    const result = computeSustainability(history, { lookbackMonths: 6 });
    assert.equal(result.overspendMonths, 4);
  });

  test('flags when overspend months meet the minimum threshold', () => {
    const result = computeSustainability(history, { lookbackMonths: 6, minOverspendMonths: 2 });
    assert.equal(result.isFlagged, true);
  });

  test('does not flag when under the threshold', () => {
    const result = computeSustainability(history, { lookbackMonths: 6, minOverspendMonths: 5 });
    assert.equal(result.isFlagged, false);
  });

  test('current streak counts only the unbroken run ending at the most recent month', () => {
    const result = computeSustainability(history, { lookbackMonths: 6 });
    // Aug (-600) and Sep (-100) are both negative and consecutive at the end -> streak 2
    assert.equal(result.currentStreak, 2);
  });

  test('streak resets to 0 when the most recent month is positive', () => {
    const allButLast = history.slice(0, -1).concat([{ month: '2026-09', income: 9000, spend: 8000, net: 1000 }]);
    const result = computeSustainability(allButLast, { lookbackMonths: 6 });
    assert.equal(result.currentStreak, 0);
  });

  test('respects a shorter lookback window than the full history', () => {
    const result = computeSustainability(history, { lookbackMonths: 2 });
    assert.equal(result.lookbackMonths, 2);
    assert.equal(result.overspendMonths, 2); // Aug, Sep
  });

  test('handles an empty history without dividing by zero', () => {
    const result = computeSustainability([], { lookbackMonths: 6 });
    assert.equal(result.avgNet, 0);
    assert.equal(result.isFlagged, false);
  });

  test('avgNet averages only the windowed months', () => {
    const result = computeSustainability(history, { lookbackMonths: 2 });
    assert.equal(result.avgNet, (-600 + -100) / 2);
  });
});

describe('computeUnassignedSpend', () => {
  const budgetVsActual = [
    { categoryId: 'c1', name: 'Groceries', groupName: 'Food', budgeted: 500, spent: 420, remaining: 80, pctUsed: 84, overBudget: false },
    { categoryId: 'c2', name: 'Cash/ATM', groupName: 'Misc', budgeted: 0, spent: 60, remaining: -60, pctUsed: 100, overBudget: true },
    { categoryId: 'c3', name: 'Medical', groupName: 'Health', budgeted: 0, spent: 800, remaining: -800, pctUsed: 100, overBudget: true },
    { categoryId: 'c4', name: 'Unused', groupName: 'Misc', budgeted: 0, spent: 0, remaining: 0, pctUsed: 0, overBudget: false }
  ];

  test('flags only categories with zero budget and real spend', () => {
    const result = computeUnassignedSpend(budgetVsActual);
    assert.deepEqual(result.categories.map(c => c.name), ['Medical', 'Cash/ATM']);
  });

  test('excludes a zero-budget category with zero spend', () => {
    const result = computeUnassignedSpend(budgetVsActual);
    assert.ok(!result.categories.some(c => c.name === 'Unused'));
  });

  test('excludes a category that has a real budget, even if small', () => {
    const result = computeUnassignedSpend(budgetVsActual);
    assert.ok(!result.categories.some(c => c.name === 'Groceries'));
  });

  test('sorts by spend, largest first', () => {
    const result = computeUnassignedSpend(budgetVsActual);
    assert.equal(result.categories[0].name, 'Medical');
  });

  test('total sums only the flagged categories', () => {
    const result = computeUnassignedSpend(budgetVsActual);
    assert.equal(result.total, 860);
  });

  test('handles an empty list', () => {
    const result = computeUnassignedSpend([]);
    assert.deepEqual(result.categories, []);
    assert.equal(result.total, 0);
  });
});

describe('coefficientOfVariation', () => {
  test('is 0 for a perfectly flat series', () => {
    assert.equal(coefficientOfVariation([100, 100, 100]), 0);
  });

  test('is high for a lumpy series (mostly 0, one big spike)', () => {
    const cv = coefficientOfVariation([0, 0, 0, 0, 0, 1200, 0, 0, 0, 0, 0, 0]);
    assert.ok(cv > 2);
  });

  test('is low for a steady series with small variation', () => {
    const cv = coefficientOfVariation([100, 105, 98, 102, 101, 99]);
    assert.ok(cv < 0.1);
  });

  test('returns 0 for an all-zero series instead of NaN', () => {
    assert.equal(coefficientOfVariation([0, 0, 0]), 0);
  });

  test('returns 0 for an empty series', () => {
    assert.equal(coefficientOfVariation([]), 0);
  });
});

describe('computeCategoryGrid', () => {
  function trend(id, name, group, totals) {
    return { categoryId: id, name, groupName: group, monthlyTotals: totals.map((total, i) => ({ month: `m${i}`, total })) };
  }

  test('averages only the trailing window, not the full history', () => {
    // 14 months of history, trailingMonths: 12 -> last 12 used for avg
    const totals = [999, 999, ...Array(12).fill(100)];
    const trends = [trend('c1', 'Groceries', 'Food', totals)];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 12 });
    assert.equal(rows[0].avg, 100);
  });

  test('year-ago average comes from whatever is left before the trailing window', () => {
    const totals = [380, 410, ...Array(12).fill(400)]; // 2 prior-year months + 12 trailing
    const trends = [trend('c1', 'Groceries', 'Food', totals)];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 12 });
    assert.equal(rows[0].yearAgoAvg, 395); // (380+410)/2
    assert.equal(rows[0].yearAgoMonthsAvailable, 2);
  });

  test('yearAgoAvg is null, not 0, when there is no history before the trailing window', () => {
    const totals = Array(12).fill(100); // exactly 12 months total, nothing prior
    const trends = [trend('c1', 'Groceries', 'Food', totals)];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 12 });
    assert.equal(rows[0].yearAgoAvg, null);
    assert.equal(rows[0].yoyChange, null);
  });

  test('gap is average spend minus the live budgeted amount', () => {
    const trends = [trend('c1', 'Groceries', 'Food', [400, 420])];
    const budgeted = new Map([['c1', 450]]);
    const rows = computeCategoryGrid(trends, budgeted, { trailingMonths: 2 });
    assert.equal(rows[0].gap, 410 - 450);
  });

  test('a category missing from the budgeted map defaults to $0 budgeted', () => {
    const trends = [trend('c1', 'Groceries', 'Food', [400, 420])];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 2 });
    assert.equal(rows[0].budget, 0);
  });

  test('flags a lumpy category (high coefficient of variation) distinctly from a steady one', () => {
    const trends = [trend('c1', 'Annual Premium', 'Bills', [0, 0, 0, 0, 0, 1200, 0, 0, 0, 0, 0, 0])];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 12 });
    assert.equal(rows[0].isLumpy, true);
  });

  test('a steady category is not flagged as lumpy', () => {
    const trends = [trend('c1', 'Groceries', 'Food', [400, 410, 395, 405])];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 4 });
    assert.equal(rows[0].isLumpy, false);
  });

  test('sorts by group name then category name', () => {
    const trends = [
      trend('c1', 'Groceries', 'Food', [100]),
      trend('c2', 'Gifts', 'Misc', [50])
    ];
    const rows = computeCategoryGrid(trends, new Map(), { trailingMonths: 1 });
    assert.deepEqual(rows.map(r => r.name), ['Groceries', 'Gifts']); // Food < Misc
  });
});

describe('computeYearOverYearTrends', () => {
  function trend(id, name, group, monthTotals) {
    return { categoryId: id, name, groupName: group, monthlyTotals: Object.entries(monthTotals).map(([month, total]) => ({ month, total })) };
  }

  test('pulls this-year and last-year values by matching month strings', () => {
    const trends = [trend('c1', 'Groceries', 'Food', { '2025-01': 300, '2025-02': 310, '2026-01': 350, '2026-02': 360 })];
    const rows = computeYearOverYearTrends(trends, ['2026-01', '2026-02'], ['2025-01', '2025-02']);
    assert.deepEqual(rows[0].thisYear, [350, 360]);
    assert.deepEqual(rows[0].lastYear, [300, 310]);
  });

  test('a month missing from history reads as 0, not undefined', () => {
    const trends = [trend('c1', 'Groceries', 'Food', { '2026-01': 350 })];
    const rows = computeYearOverYearTrends(trends, ['2026-01', '2026-02'], ['2025-01', '2025-02']);
    assert.deepEqual(rows[0].thisYear, [350, 0]);
    assert.deepEqual(rows[0].lastYear, [0, 0]);
  });

  test('drops a category with zero spend in both windows', () => {
    const trends = [trend('c1', 'Unused', 'Misc', { '2025-01': 0, '2026-01': 0 })];
    const rows = computeYearOverYearTrends(trends, ['2026-01'], ['2025-01']);
    assert.deepEqual(rows, []);
  });

  test('yoyChange is totalThis minus totalLast', () => {
    const trends = [trend('c1', 'Groceries', 'Food', { '2025-01': 300, '2026-01': 350 })];
    const rows = computeYearOverYearTrends(trends, ['2026-01'], ['2025-01']);
    assert.equal(rows[0].yoyChange, 50);
  });

  test('sorts by the magnitude of change, largest swing first regardless of direction', () => {
    const trends = [
      trend('c1', 'Small Up', 'Misc', { '2025-01': 100, '2026-01': 110 }),
      trend('c2', 'Big Down', 'Misc', { '2025-01': 500, '2026-01': 100 })
    ];
    const rows = computeYearOverYearTrends(trends, ['2026-01'], ['2025-01']);
    assert.equal(rows[0].name, 'Big Down');
  });
});
