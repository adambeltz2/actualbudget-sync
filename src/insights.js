// Pure math for trend detection and forward projection — no @actual-app/api
// dependency, so this is unit-testable without a live Actual server.

function average(numbers) {
  if (numbers.length === 0) return 0;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function standardDeviation(numbers) {
  if (numbers.length < 2) return 0;
  const mean = average(numbers);
  const variance = average(numbers.map(n => (n - mean) ** 2));
  return Math.sqrt(variance);
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
      monthlyTotals: trend.monthlyTotals,
      message: `${trend.name} spending has ${direction}d ${roundedPct}% over the last ${months} months ($${Math.round(firstHalfAvg)} → $${Math.round(secondHalfAvg)}/mo).`
    });
  }
  return insights.sort((a, b) => b.pctChange - a.pctChange);
}

// A single projection point: the straight-line continuation of the current
// pace (with a Wealthfront/Personal-Capital-style "typical range" band around
// it, derived from how volatile the actual month-to-month change has
// historically been — a wider historical swing means a wider band, and the
// band widens with sqrt(months) the way a random walk's uncertainty does),
// plus the compound-growth figure at the assumed return rate.
function projectAt({ currentBalance, avgMonthlyNetChange, monthlyVolatility, annualReturnRate, months }) {
  const trendContinuation = currentBalance + avgMonthlyNetChange * months;
  const band = monthlyVolatility * Math.sqrt(months);
  return {
    trendContinuation,
    trendLow: trendContinuation - band,
    trendHigh: trendContinuation + band,
    compoundGrowth: projectFutureValue({
      presentValue: currentBalance,
      monthlyContribution: avgMonthlyNetChange,
      annualReturnRate,
      months
    })
  };
}

// Builds the projection block for the dashboard: a historical monthly net
// change (from real balance history, via linear regression) extrapolated two
// ways — a straight-line continuation of the current pace (with a "typical
// range" band from historical volatility) and a compounded-growth projection
// assuming the same monthly contribution keeps being invested at
// `annualReturnRate`. `chartHorizonYears` also produces a finer year-by-year
// series (0..N) suitable for plotting a projection chart.
function buildBalanceProjection(monthlyBalances, { annualReturnRate = 0.07, horizonsYears = [1, 5, 10], chartHorizonYears = 10 } = {}) {
  if (monthlyBalances.length === 0) {
    return {
      currentBalance: 0, avgMonthlyNetChange: 0, monthlyVolatility: 0, annualReturnRate,
      history: [], projections: [], chartSeries: []
    };
  }

  const currentBalance = monthlyBalances[monthlyBalances.length - 1].balance;
  const points = monthlyBalances.map((m, i) => ({ x: i, y: m.balance }));
  const { slope } = linearRegression(points);
  const avgMonthlyNetChange = monthlyBalances.length >= 2 ? slope : 0;

  const deltas = monthlyBalances.slice(1).map((m, i) => m.balance - monthlyBalances[i].balance);
  const monthlyVolatility = standardDeviation(deltas);

  const projections = horizonsYears.map(years => ({
    years,
    ...projectAt({ currentBalance, avgMonthlyNetChange, monthlyVolatility, annualReturnRate, months: years * 12 })
  }));

  const chartSeries = [];
  for (let year = 0; year <= chartHorizonYears; year++) {
    chartSeries.push({ years: year, ...projectAt({ currentBalance, avgMonthlyNetChange, monthlyVolatility, annualReturnRate, months: year * 12 }) });
  }

  return { currentBalance, avgMonthlyNetChange, monthlyVolatility, annualReturnRate, history: monthlyBalances, projections, chartSeries };
}

module.exports = {
  linearRegression, projectFutureValue, classifySpendTrend, standardDeviation,
  buildSpendingInsights, buildBalanceProjection
};
