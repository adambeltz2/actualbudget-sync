// Pure math for trend detection and forward projection — no @actual-app/api
// dependency, so this is unit-testable without a live Actual server.

function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

// Ordinary least squares over {x, y} points. x is expected to be a simple
// 0-based month index, so slope is directly "average change per month".
function linearRegression(points) {
  const n = points.length;
  if (n === 0) return { slope: 0, intercept: 0 };
  if (n === 1) return { slope: 0, intercept: points[0].y };

  const meanX = average(points.map(p => p.x));
  const meanY = average(points.map(p => p.y));

  let numerator = 0;
  let denominator = 0;
  for (const { x, y } of points) {
    numerator += (x - meanX) * (y - meanY);
    denominator += (x - meanX) ** 2;
  }
  const slope = denominator === 0 ? 0 : numerator / denominator;
  const intercept = meanY - slope * meanX;
  return { slope, intercept };
}

// Future value of a present lump sum plus a recurring monthly contribution,
// compounded monthly: FV = PV(1+r)^n + PMT * (((1+r)^n - 1) / r).
// A zero/negative rate falls back to simple addition (no compounding) so the
// formula never divides by zero and still behaves sensibly for non-investment
// projections (rate 0 = "just keep saving at the current pace").
function projectFutureValue({ presentValue, monthlyContribution, annualReturnRate, months }) {
  const monthlyRate = annualReturnRate / 12;
  if (monthlyRate === 0) {
    return presentValue + monthlyContribution * months;
  }
  const growth = (1 + monthlyRate) ** months;
  return presentValue * growth + monthlyContribution * ((growth - 1) / monthlyRate);
}

// Splits a chronological series into an earlier and later half and compares
// their averages — more robust to a single noisy month than comparing just
// the first and last data points, while still reading naturally as
// "spending over the first half of the window vs. the second half."
function classifySpendTrend(monthlyTotals) {
  const n = monthlyTotals.length;
  const points = monthlyTotals.map((m, i) => ({ x: i, y: m.total }));
  const { slope } = linearRegression(points);

  const half = Math.floor(n / 2);
  const firstHalfAvg = average(monthlyTotals.slice(0, half).map(m => m.total));
  const secondHalfAvg = average(monthlyTotals.slice(n - half).map(m => m.total));
  const pctChange = firstHalfAvg > 0
    ? ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100
    : (secondHalfAvg > 0 ? 100 : 0);

  return { slopePerMonth: slope, firstHalfAvg, secondHalfAvg, pctChange };
}

// Turns per-category monthly spend series into plain-English alerts for
// categories that moved by more than `significantPctChange`. Requires at
// least 4 months of data (two 2-month halves) so a single expensive month
// doesn't read as a "trend".
function buildSpendingInsights(categoryTrends, { significantPctChange = 15, minMonths = 4 } = {}) {
  const insights = [];
  for (const trend of categoryTrends) {
    if (trend.monthlyTotals.length < minMonths) continue;

    const { pctChange, firstHalfAvg, secondHalfAvg } = classifySpendTrend(trend.monthlyTotals);
    if (Math.abs(pctChange) < significantPctChange) continue;

    const direction = pctChange > 0 ? 'increase' : 'decrease';
    const months = trend.monthlyTotals.length;
    const roundedPct = Math.round(Math.abs(pctChange));
    insights.push({
      categoryId: trend.categoryId,
      name: trend.name,
      direction,
      pctChange: roundedPct,
      firstHalfAvg: Math.round(firstHalfAvg * 100) / 100,
      secondHalfAvg: Math.round(secondHalfAvg * 100) / 100,
      message: `${trend.name} spending has ${direction}d ${roundedPct}% over the last ${months} months ($${Math.round(firstHalfAvg)} → $${Math.round(secondHalfAvg)}/mo).`
    });
  }
  return insights.sort((a, b) => b.pctChange - a.pctChange);
}

// Builds the projection block for the dashboard: a historical monthly net
// change (from real balance history, via linear regression) extrapolated two
// ways — a simple straight-line continuation of the current pace, and a
// compounded-growth projection assuming the same monthly contribution keeps
// being invested at `annualReturnRate`.
function buildBalanceProjection(monthlyBalances, { annualReturnRate = 0.07, horizonsYears = [1, 5, 10] } = {}) {
  if (monthlyBalances.length === 0) {
    return { currentBalance: 0, avgMonthlyNetChange: 0, annualReturnRate, projections: [] };
  }

  const currentBalance = monthlyBalances[monthlyBalances.length - 1].balance;
  const points = monthlyBalances.map((m, i) => ({ x: i, y: m.balance }));
  const { slope } = linearRegression(points);
  const avgMonthlyNetChange = monthlyBalances.length >= 2 ? slope : 0;

  const projections = horizonsYears.map(years => {
    const months = years * 12;
    return {
      years,
      trendContinuation: currentBalance + avgMonthlyNetChange * months,
      compoundGrowth: projectFutureValue({
        presentValue: currentBalance,
        monthlyContribution: avgMonthlyNetChange,
        annualReturnRate,
        months
      })
    };
  });

  return { currentBalance, avgMonthlyNetChange, annualReturnRate, projections };
}

module.exports = {
  linearRegression, projectFutureValue, classifySpendTrend,
  buildSpendingInsights, buildBalanceProjection
};
