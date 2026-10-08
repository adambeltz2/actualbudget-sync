const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { computeMonthProgress, computeCategoriesToWatch } = require('../src/budgetSummary');

describe('computeMonthProgress', () => {
  test('computes day/days/pct for a 31-day month', () => {
    const p = computeMonthProgress(new Date(2026, 9, 18)); // Oct 18, 2026 (month is 0-indexed)
    assert.equal(p.dayOfMonth, 18);
    assert.equal(p.daysInMonth, 31);
    assert.equal(p.pctMonthElapsed, Math.round((18 / 31) * 100));
    assert.equal(p.monthLabel, 'October 2026');
  });

  test('handles February in a leap year', () => {
    const p = computeMonthProgress(new Date(2028, 1, 29)); // Feb 29, 2028 is a leap day
    assert.equal(p.daysInMonth, 29);
  });

  test('handles February in a non-leap year', () => {
    const p = computeMonthProgress(new Date(2026, 1, 15));
    assert.equal(p.daysInMonth, 28);
  });

  test('100% on the last day of the month', () => {
    const p = computeMonthProgress(new Date(2026, 3, 30)); // April has 30 days
    assert.equal(p.pctMonthElapsed, 100);
  });
});

describe('computeCategoriesToWatch', () => {
  const budgetVsActual = [
    { name: 'Dining Out', budgeted: 300, spent: 420, pctUsed: 140, remaining: -120, overBudget: true },
    { name: 'Groceries', budgeted: 400, spent: 220, pctUsed: 55, remaining: 180, overBudget: false },
    { name: 'Shopping', budgeted: 250, spent: 310, pctUsed: 124, remaining: -60, overBudget: true },
    { name: 'Rent', budgeted: 1500, spent: 1500, pctUsed: 100, remaining: 0, overBudget: false },
    { name: 'No Budget Set', budgeted: 0, spent: 50, pctUsed: 0, remaining: -50, overBudget: false }
  ];

  test('ranks by dollar amount ahead of pace, not by percentage', () => {
    const watch = computeCategoriesToWatch(budgetVsActual, 58);
    // At 58% through the month: Dining Out expected ~$174, spent $420 -> +$246 ahead
    // Shopping expected ~$145, spent $310 -> +$165 ahead
    // Rent expected ~$870, spent $1500 -> +$630 ahead (biggest dollar gap despite being "on budget" at 100%)
    assert.deepEqual(watch.map(c => c.name), ['Rent', 'Dining Out', 'Shopping']);
  });

  test('excludes categories with no budget set, to avoid a divide-by-zero-flavored false flag', () => {
    const watch = computeCategoriesToWatch(budgetVsActual, 58);
    assert.ok(!watch.some(c => c.name === 'No Budget Set'));
  });

  test('excludes categories under the minAheadBy dollar threshold', () => {
    const watch = computeCategoriesToWatch(budgetVsActual, 58, { minAheadBy: 1000 });
    assert.deepEqual(watch, []);
  });

  test('respects the limit', () => {
    const watch = computeCategoriesToWatch(budgetVsActual, 58, { limit: 1 });
    assert.equal(watch.length, 1);
    assert.equal(watch[0].name, 'Rent');
  });

  test('returns an empty list when 0% of the month has elapsed', () => {
    assert.deepEqual(computeCategoriesToWatch(budgetVsActual, 0), []);
  });

  test('projectedTotal extrapolates current spend rate to month end', () => {
    const watch = computeCategoriesToWatch(budgetVsActual, 50, { minAheadBy: 0 });
    const diningOut = watch.find(c => c.name === 'Dining Out');
    assert.equal(diningOut.projectedTotal, 840); // $420 spent at 50% through -> $840 by month end
  });
});
