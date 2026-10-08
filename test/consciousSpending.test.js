const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { inRange, isSafeDirection, classifyBucket, computeMonthBuckets, computeYearSummary } = require('../src/consciousSpending');

describe('inRange', () => {
  test('bounded bucket: true only inside [lo, hi]', () => {
    assert.equal(inRange('fixed', 49.9), false);
    assert.equal(inRange('fixed', 50), true);
    assert.equal(inRange('fixed', 55), true);
    assert.equal(inRange('fixed', 60), true);
    assert.equal(inRange('fixed', 60.1), false);
  });
  test('open-ended bucket: true at or above the floor, no ceiling', () => {
    assert.equal(inRange('investments', 9.9), false);
    assert.equal(inRange('investments', 10), true);
    assert.equal(inRange('investments', 50), true);
  });
});

describe('isSafeDirection', () => {
  test('Fixed Costs: under the floor is safe (warnDir over)', () => {
    assert.equal(isSafeDirection('fixed', 40), true);
    assert.equal(isSafeDirection('fixed', 65), false);
  });
  test('Investments: open-ended bucket is never "safe" out of range (only the under side exists)', () => {
    assert.equal(isSafeDirection('investments', 5), false);
  });
  test('Savings: above the ceiling is safe (warnDir under)', () => {
    assert.equal(isSafeDirection('savings', 15), true);
    assert.equal(isSafeDirection('savings', 3), false);
  });
  test('Guilt-Free: under the floor is safe (warnDir over)', () => {
    assert.equal(isSafeDirection('guiltfree', 10), true);
    assert.equal(isSafeDirection('guiltfree', 40), false);
  });
});

describe('classifyBucket', () => {
  test('in range is always On Target', () => {
    assert.equal(classifyBucket('fixed', 55).status, 'on-target');
    assert.equal(classifyBucket('savings', 7).status, 'on-target');
  });
  test('Fixed Costs under the floor reads as the safe "Below Target" status, not a warning', () => {
    const cls = classifyBucket('fixed', 30);
    assert.equal(cls.status, 'above-target');
    assert.equal(cls.label, 'Below Target');
  });
  test('Fixed Costs over the ceiling is a real warning', () => {
    const cls = classifyBucket('fixed', 65);
    assert.equal(cls.status, 'over-target');
  });
  test('Investments above its floor is On Target — an open-ended bucket has no ceiling to exceed', () => {
    const cls = classifyBucket('investments', 15);
    assert.equal(cls.status, 'on-target');
  });
  test('Investments under its floor is a real warning', () => {
    assert.equal(classifyBucket('investments', 5).status, 'under-target');
  });
});

describe('computeMonthBuckets', () => {
  const budgetVsActual = [
    { categoryId: 'c1', name: 'Rent', groupName: 'Housing', budgeted: 2800, spent: 2800, remaining: 0, pctUsed: 100, overBudget: false },
    { categoryId: 'c2', name: 'Utilities', groupName: 'Housing', budgeted: 250, spent: 240, remaining: 10, pctUsed: 96, overBudget: false },
    { categoryId: 'c3', name: '401(k)', groupName: 'Savings', budgeted: 450, spent: 450, remaining: 0, pctUsed: 100, overBudget: false },
    { categoryId: 'c4', name: 'Emergency Fund', groupName: 'Savings', budgeted: 200, spent: 200, remaining: 0, pctUsed: 100, overBudget: false },
    { categoryId: 'c5', name: 'Dining Out', groupName: 'Fun', budgeted: 300, spent: 420, remaining: -120, pctUsed: 140, overBudget: true },
    { categoryId: 'c6', name: 'Gifts', groupName: 'Other', budgeted: 100, spent: 145, remaining: -45, pctUsed: 145, overBudget: true }
  ];
  const classification = { c1: 'fixed', c2: 'fixed', c3: 'investments', c4: 'savings', c5: 'guiltfree' };
  // c6 (Gifts) intentionally left unclassified.

  test('sums spend per bucket from only its classified categories', () => {
    const result = computeMonthBuckets(budgetVsActual, classification, 6200);
    assert.equal(result.buckets.fixed.spent, 3040);
    assert.equal(result.buckets.investments.spent, 450);
    assert.equal(result.buckets.savings.spent, 200);
    assert.equal(result.buckets.guiltfree.spent, 420);
  });

  test('computes each bucket pct against take-home pay', () => {
    const result = computeMonthBuckets(budgetVsActual, classification, 6200);
    assert.ok(Math.abs(result.buckets.fixed.pct - (3040 / 6200 * 100)) < 1e-9);
  });

  test('an unclassified category is excluded from every bucket and appears under unclassified', () => {
    const result = computeMonthBuckets(budgetVsActual, classification, 6200);
    assert.equal(result.unclassified.spent, 145);
    assert.deepEqual(result.unclassified.categories.map(c => c.name), ['Gifts']);
    assert.ok(!result.buckets.fixed.categories.some(c => c.name === 'Gifts'));
  });

  test('classifiedSpent and classifiedPct exclude unclassified spend', () => {
    const result = computeMonthBuckets(budgetVsActual, classification, 6200);
    assert.equal(result.classifiedSpent, 3040 + 450 + 200 + 420);
  });

  test('a bucket with no categories assigned has 0 spend and 0%, not NaN', () => {
    const result = computeMonthBuckets([], {}, 6200);
    assert.equal(result.buckets.fixed.spent, 0);
    assert.equal(result.buckets.fixed.pct, 0);
  });

  test('zero take-home pay never divides by zero into NaN or Infinity', () => {
    const result = computeMonthBuckets(budgetVsActual, classification, 0);
    assert.equal(result.buckets.fixed.pct, 0);
    assert.equal(result.unclassified.pct, 0);
    assert.ok(Number.isFinite(result.buckets.fixed.pct));
  });

  test('categories within a bucket are sorted by spend, highest first', () => {
    const result = computeMonthBuckets(budgetVsActual, classification, 6200);
    assert.deepEqual(result.buckets.fixed.categories.map(c => c.name), ['Rent', 'Utilities']);
  });

  test('handles an empty budgetVsActual gracefully', () => {
    const result = computeMonthBuckets(undefined, {}, 6200);
    assert.equal(result.unclassified.spent, 0);
  });
});

describe('computeYearSummary', () => {
  function monthResult(fixedPct) {
    return { buckets: { fixed: { pct: fixedPct }, investments: { pct: 11 }, savings: { pct: 6 }, guiltfree: { pct: 22 } } };
  }

  test('averages each bucket pct across the given months', () => {
    const months = [monthResult(50), monthResult(60)];
    const summary = computeYearSummary(months);
    assert.equal(summary.fixed.avgPct, 55);
  });

  test('classifies the averaged pct the same way a single month would be', () => {
    const months = [monthResult(70), monthResult(70)]; // avg 70%, over the 60% ceiling
    const summary = computeYearSummary(months);
    assert.equal(summary.fixed.status, 'over-target');
  });

  test('an empty month list never produces NaN', () => {
    const summary = computeYearSummary([]);
    assert.equal(summary.fixed.avgPct, 0);
    assert.ok(Number.isFinite(summary.fixed.avgPct));
  });
});
