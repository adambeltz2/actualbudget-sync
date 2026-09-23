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

// Months until a compounding balance (current balance + monthly
// contribution, growing at annualReturnRate) first reaches `target`.
// Iterates month-by-month rather than solving the compound-interest formula
// algebraically — with monthlyContribution <= 0 there may be no closed-form
// solution (the balance can shrink toward zero without ever reaching a
// positive target), and a bounded loop handles that case for free by simply
// running out of months. Returns null if not reached within maxMonths.
function monthsToReachTarget({ currentBalance, monthlyContribution, annualReturnRate, target, maxMonths = 1200 }) {
  if (currentBalance >= target) return 0;
  for (let m = 1; m <= maxMonths; m++) {
    if (projectFutureValue({ presentValue: currentBalance, monthlyContribution, annualReturnRate, months: m }) >= target) {
      return m;
    }
  }
  return null;
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
//
// Ranked and capped by dollar impact rather than percent change: a category
// that dropped 100% from $2/mo isn't meaningful even though its percent
// change is the largest possible, and a household with one large one-time
// expense in the first half of the lookback window (a vacation, a home
// project) sees nearly every category "decrease" once that spend tapers
// off — without a cap, that reads as a wall of 30+ near-identical lines
// instead of the handful of changes actually worth a second look.
function buildSpendingInsights(categoryTrends, { significantPctChange = 15, minMonths = 4, maxInsights = 6 } = {}) {
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
      dollarImpact: Math.abs(secondHalfAvg - firstHalfAvg),
      firstHalfAvg: Math.round(firstHalfAvg * 100) / 100,
      secondHalfAvg: Math.round(secondHalfAvg * 100) / 100,
      monthlyTotals: trend.monthlyTotals,
      message: `${trend.name} spending has ${direction}d ${roundedPct}% over the last ${months} months ($${Math.round(firstHalfAvg)} → $${Math.round(secondHalfAvg)}/mo).`
    });
  }
  return insights
    .sort((a, b) => b.dollarImpact - a.dollarImpact)
    .slice(0, maxInsights)
    .map(({ dollarImpact, ...rest }) => rest);
}

// Compares each category's recent average monthly spend (over 3/6/12-month
// trailing windows) against what's currently budgeted for it, to answer "am
// I over- or under-budgeting this category". A category spending notably
// more than its budget on average is under-budgeted (the budget should go
// up); notably less is over-budgeted (money is being set aside faster than
// it's spent, so the budget could come down); anything within
// `thresholdPct` of the budget is on-track and not worth flagging.
// `budgetedByCategory` is a Map<categoryId, budgeted dollars> for the
// current month — deliberately not itself averaged, since a budget is a
// forward-looking plan set once, not a trailing figure.
function buildBudgetCalibration(categoryTrends, budgetedByCategory, { windows = [3, 6, 12], thresholdPct = 10 } = {}) {
  const results = [];
  for (const trend of categoryTrends) {
    const budgeted = budgetedByCategory.get(trend.categoryId) || 0;
    const byWindow = {};
    for (const w of windows) {
      // Requires at least half the window's months of data so a category
      // that only recently started being used doesn't get judged against
      // an average built from mostly-zero months.
      const slice = trend.monthlyTotals.slice(-w);
      if (slice.length < Math.ceil(w / 2)) continue;

      const avg = average(slice.map(m => m.total));
      const diffPct = budgeted > 0 ? ((avg - budgeted) / budgeted) * 100 : (avg > 0 ? 100 : 0);
      let status = 'on-track';
      if (diffPct > thresholdPct) status = 'under-budgeted';
      else if (diffPct < -thresholdPct) status = 'over-budgeted';

      byWindow[w] = {
        avgMonthlySpend: Math.round(avg * 100) / 100,
        budgeted,
        gap: Math.round((avg - budgeted) * 100) / 100,
        diffPct: Math.round(diffPct),
        status
      };
    }
    if (Object.keys(byWindow).length === 0) continue;
    results.push({ categoryId: trend.categoryId, name: trend.name, groupName: trend.groupName, windows: byWindow });
  }
  return results;
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

// Projects a single balance series forward: a straight-line continuation of
// the current pace (with a "typical range" band from historical volatility)
// plus a compounded-growth projection assuming the same monthly contribution
// keeps being invested at `annualReturnRate`. `chartHorizonYears` also
// produces a finer year-by-year series (0..N) suitable for plotting.
function projectSeries(monthlyBalances, { annualReturnRate = 0.07, horizonsYears = [1, 5, 10], chartHorizonYears = 10 } = {}) {
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

// Builds the projection block for the dashboard. The "current pace (typical
// range)" line always reflects the whole net-worth history, unchanged
// regardless of investment tagging — it's the "if nothing changes" baseline.
// The "invested at assumed return" line, when investment accounts are
// tagged, only compounds the balance actually tagged as investments at
// `annualReturnRate`; the remaining (liquid) balance is assumed to keep
// growing at its own historical linear pace instead of a market return,
// since cash sitting in checking doesn't compound like equities. With no
// investment history to split out, it falls back to compounding the whole
// balance, same as before investment tagging existed.
function buildBalanceProjection(monthlyBalances, investmentMonthlyBalances = [], liquidMonthlyBalances = [], options = {}) {
  const totalProjection = projectSeries(monthlyBalances, options);
  if (investmentMonthlyBalances.length === 0 || liquidMonthlyBalances.length === 0) {
    return totalProjection;
  }

  const { annualReturnRate = 0.07 } = options;
  const investmentProjection = projectSeries(investmentMonthlyBalances, { ...options, annualReturnRate });
  const liquidProjection = projectSeries(liquidMonthlyBalances, { ...options, annualReturnRate: 0 });

  const combine = (point, i) => ({
    ...point,
    compoundGrowth: liquidProjection.projections[i].trendContinuation + investmentProjection.projections[i].compoundGrowth
  });
  const combineChart = (point, i) => ({
    ...point,
    compoundGrowth: liquidProjection.chartSeries[i].trendContinuation + investmentProjection.chartSeries[i].compoundGrowth
  });

  return {
    ...totalProjection,
    projections: totalProjection.projections.map(combine),
    chartSeries: totalProjection.chartSeries.map(combineChart)
  };
}

module.exports = {
  linearRegression, projectFutureValue, classifySpendTrend, standardDeviation,
  buildSpendingInsights, buildBalanceProjection, monthsToReachTarget, buildBudgetCalibration
};
