const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  linearRegression, projectFutureValue, classifySpendTrend, standardDeviation,
  buildSpendingInsights, buildBalanceProjection
} = require('../src/insights');

describe('linearRegression', () => {
  test('a perfect line has zero error', () => {
    const points = [{ x: 0, y: 10 }, { x: 1, y: 20 }, { x: 2, y: 30 }];
    const { slope, intercept } = linearRegression(points);
    assert.equal(slope, 10);
    assert.equal(intercept, 10);
  });

  test('a flat series has zero slope', () => {
    const points = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }];
    const { slope } = linearRegression(points);
    assert.equal(slope, 0);
  });

  test('a single point has zero slope and its own value as intercept', () => {
    const { slope, intercept } = linearRegression([{ x: 0, y: 42 }]);
    assert.equal(slope, 0);
    assert.equal(intercept, 42);
  });

  test('an empty series does not throw', () => {
    const { slope, intercept } = linearRegression([]);
    assert.equal(slope, 0);
    assert.equal(intercept, 0);
  });
});

describe('projectFutureValue', () => {
  test('zero return rate is simple addition, no compounding', () => {
    const fv = projectFutureValue({ presentValue: 1000, monthlyContribution: 100, annualReturnRate: 0, months: 12 });
    assert.equal(fv, 1000 + 100 * 12);
  });

  test('a lump sum with no contributions compounds at the given rate', () => {
    // $1000 at 12%/yr (1%/mo) for 12 months, no contributions
    const fv = projectFutureValue({ presentValue: 1000, monthlyContribution: 0, annualReturnRate: 0.12, months: 12 });
    assert.ok(Math.abs(fv - 1000 * Math.pow(1.01, 12)) < 0.001);
  });

  test('recurring contributions grow the total beyond simple addition when compounding', () => {
    const compounded = projectFutureValue({ presentValue: 0, monthlyContribution: 100, annualReturnRate: 0.07, months: 120 });
    const simple = 100 * 120;
    assert.ok(compounded > simple);
  });

  test('a negative return rate still resolves without dividing by zero', () => {
    const fv = projectFutureValue({ presentValue: 1000, monthlyContribution: 50, annualReturnRate: -0.05, months: 12 });
    assert.ok(Number.isFinite(fv));
  });
});

describe('standardDeviation', () => {
  test('a constant series has zero deviation', () => {
    assert.equal(standardDeviation([5, 5, 5, 5]), 0);
  });

  test('fewer than two values has zero deviation rather than throwing', () => {
    assert.equal(standardDeviation([]), 0);
    assert.equal(standardDeviation([42]), 0);
  });

  test('matches a hand-computed population standard deviation', () => {
    // values 2,4,4,4,5,5,7,9 -> mean 5, population variance 4, stdev 2
    assert.equal(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), 2);
  });
});

describe('classifySpendTrend', () => {
  test('detects a rising trend from an increasing series', () => {
    const monthlyTotals = [100, 100, 150, 150].map((total, i) => ({ month: `m${i}`, total }));
    const { pctChange, firstHalfAvg, secondHalfAvg } = classifySpendTrend(monthlyTotals);
    assert.equal(firstHalfAvg, 100);
    assert.equal(secondHalfAvg, 150);
    assert.equal(pctChange, 50);
  });

  test('detects a falling trend', () => {
    const monthlyTotals = [200, 200, 100, 100].map((total, i) => ({ month: `m${i}`, total }));
    const { pctChange } = classifySpendTrend(monthlyTotals);
    assert.equal(pctChange, -50);
  });

  test('a flat series has zero percent change', () => {
    const monthlyTotals = [100, 100, 100, 100].map((total, i) => ({ month: `m${i}`, total }));
    const { pctChange } = classifySpendTrend(monthlyTotals);
    assert.equal(pctChange, 0);
  });

  test('going from zero spend to some spend reads as a 100% increase, not a division by zero', () => {
    const monthlyTotals = [0, 0, 50, 50].map((total, i) => ({ month: `m${i}`, total }));
    const { pctChange } = classifySpendTrend(monthlyTotals);
    assert.equal(pctChange, 100);
  });
});

describe('buildSpendingInsights', () => {
  const sixMonthsRising = Array.from({ length: 6 }, (_, i) => ({ month: `2026-0${i + 1}`, total: 300 + i * 40 }));

  test('flags a category with a significant sustained increase', () => {
    const insights = buildSpendingInsights([{ categoryId: 'groceries', name: 'Groceries', monthlyTotals: sixMonthsRising }]);
    assert.equal(insights.length, 1);
    assert.equal(insights[0].direction, 'increase');
    assert.match(insights[0].message, /Groceries spending has increased/);
  });

  test('includes the raw monthly totals for sparkline rendering', () => {
    const insights = buildSpendingInsights([{ categoryId: 'groceries', name: 'Groceries', monthlyTotals: sixMonthsRising }]);
    assert.deepEqual(insights[0].monthlyTotals, sixMonthsRising);
  });

  test('ignores a category with fewer than the minimum months of history', () => {
    const shortHistory = sixMonthsRising.slice(0, 2);
    const insights = buildSpendingInsights([{ categoryId: 'groceries', name: 'Groceries', monthlyTotals: shortHistory }]);
    assert.equal(insights.length, 0);
  });

  test('ignores a category whose change is below the significance threshold', () => {
    const stable = Array.from({ length: 6 }, (_, i) => ({ month: `m${i}`, total: 100 + (i % 2) }));
    const insights = buildSpendingInsights([{ categoryId: 'rent', name: 'Rent', monthlyTotals: stable }]);
    assert.equal(insights.length, 0);
  });

  test('sorts multiple insights by magnitude of change, largest first', () => {
    const bigJump = Array.from({ length: 6 }, (_, i) => ({ month: `m${i}`, total: i < 3 ? 100 : 300 }));
    const smallJump = Array.from({ length: 6 }, (_, i) => ({ month: `m${i}`, total: i < 3 ? 100 : 130 }));
    const insights = buildSpendingInsights([
      { categoryId: 'small', name: 'Small', monthlyTotals: smallJump },
      { categoryId: 'big', name: 'Big', monthlyTotals: bigJump }
    ]);
    assert.equal(insights[0].categoryId, 'big');
  });
});

describe('buildBalanceProjection', () => {
  test('an empty history returns a zeroed-out projection instead of throwing', () => {
    const result = buildBalanceProjection([]);
    assert.equal(result.currentBalance, 0);
    assert.deepEqual(result.projections, []);
  });

  test('projects further out for a longer horizon', () => {
    const history = [
      { month: '2026-01', balance: 10000 },
      { month: '2026-02', balance: 10500 },
      { month: '2026-03', balance: 11000 },
      { month: '2026-04', balance: 11500 }
    ];
    const result = buildBalanceProjection(history, { annualReturnRate: 0.07 });
    assert.equal(result.currentBalance, 11500);
    assert.ok(Math.abs(result.avgMonthlyNetChange - 500) < 0.001);

    const oneYear = result.projections.find(p => p.years === 1);
    const tenYear = result.projections.find(p => p.years === 10);
    assert.ok(tenYear.trendContinuation > oneYear.trendContinuation);
    assert.ok(tenYear.compoundGrowth > oneYear.compoundGrowth);
  });

  test('compound growth exceeds trend continuation when contributions are positive and rate is positive', () => {
    const history = [
      { month: '2026-01', balance: 1000 },
      { month: '2026-02', balance: 1200 },
      { month: '2026-03', balance: 1400 }
    ];
    const result = buildBalanceProjection(history, { annualReturnRate: 0.07, horizonsYears: [10] });
    const projection = result.projections[0];
    assert.ok(projection.compoundGrowth > projection.trendContinuation);
  });

  test('the typical-range band widens for a longer horizon (grows with sqrt(months))', () => {
    // A volatile but flat-average history: net change alternates so the
    // regression slope is ~0 but month-to-month swings are real.
    const history = [
      { month: '2026-01', balance: 1000 },
      { month: '2026-02', balance: 1300 },
      { month: '2026-03', balance: 1000 },
      { month: '2026-04', balance: 1300 }
    ];
    const result = buildBalanceProjection(history, { annualReturnRate: 0.07 });
    assert.ok(result.monthlyVolatility > 0);

    const oneYear = result.projections.find(p => p.years === 1);
    const tenYear = result.projections.find(p => p.years === 10);
    const oneYearBand = oneYear.trendHigh - oneYear.trendLow;
    const tenYearBand = tenYear.trendHigh - tenYear.trendLow;
    assert.ok(tenYearBand > oneYearBand);
  });

  test('a perfectly steady history has no band (zero volatility)', () => {
    const history = [
      { month: '2026-01', balance: 1000 },
      { month: '2026-02', balance: 1100 },
      { month: '2026-03', balance: 1200 }
    ];
    const result = buildBalanceProjection(history, { annualReturnRate: 0.07 });
    assert.equal(result.monthlyVolatility, 0);
    for (const p of result.projections) {
      assert.equal(p.trendLow, p.trendContinuation);
      assert.equal(p.trendHigh, p.trendContinuation);
    }
  });

  test('chartSeries covers year 0 through chartHorizonYears inclusive, starting at the current balance', () => {
    const history = [
      { month: '2026-01', balance: 1000 },
      { month: '2026-02', balance: 1100 }
    ];
    const result = buildBalanceProjection(history, { annualReturnRate: 0.07, chartHorizonYears: 5 });
    assert.equal(result.chartSeries.length, 6);
    assert.equal(result.chartSeries[0].years, 0);
    assert.equal(result.chartSeries[0].trendContinuation, result.currentBalance);
    assert.equal(result.chartSeries[5].years, 5);
  });

  test('exposes the raw monthly history for charting', () => {
    const history = [
      { month: '2026-01', balance: 1000 },
      { month: '2026-02', balance: 1100 }
    ];
    const result = buildBalanceProjection(history);
    assert.deepEqual(result.history, history);
  });
});
