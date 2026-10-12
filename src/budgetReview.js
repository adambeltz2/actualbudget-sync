// Pure helpers behind the Budget Review page — no @actual-app/api calls,
// same split as socialSecurity.js/financialHealth.js/consciousSpending.js.
// The page is built around three questions you'd actually ask yourself at
// a monthly budget review: are we consistently spending more than we earn
// (sustainability), does every dollar have a job (zero-based budgeting),
// and which categories' numbers are stale or genuinely trending (the
// category grid and year-over-year trend charts). The grid and trend math
// both consume actualService.getCategorySpendTrend's own output shape
// ({categoryId, name, groupName, monthlyTotals: [{month, total}]}) rather
// than a second parallel data-fetch path — the same real monthly spend
// history already built and tested for Financial Insights' budget
// calibration feeds this page too.

function average(values) {
  return values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;
}

// Flags a real pattern, not one bad month: counts how many of the last
// `lookbackMonths` had negative net savings, and separately the current
// unbroken streak ending at the most recent month, since "3 of the last 6
// months" and "the last 3 months in a row" read very differently even at
// the same count.
function computeSustainability(monthlySavingsHistory, { lookbackMonths = 6, minOverspendMonths = 2 } = {}) {
  const window = monthlySavingsHistory.slice(-lookbackMonths);
  const overspendMonths = window.filter(m => m.net < 0).length;
  let currentStreak = 0;
  for (let i = window.length - 1; i >= 0; i--) {
    if (window[i].net < 0) currentStreak++;
    else break;
  }
  return {
    lookbackMonths: window.length,
    overspendMonths,
    currentStreak,
    isFlagged: overspendMonths >= minOverspendMonths,
    avgNet: average(window.map(m => m.net))
  };
}

// Zero-based budgeting's own failure mode: money that left an account with
// no budgeted job at all, distinct from a category that has a budget but
// ran over it. budgetVsActual's own `budgeted`/`spent` (from
// summarizeBudgetCategory) are already dollars, not cents.
function computeUnassignedSpend(budgetVsActual) {
  const rows = (budgetVsActual || [])
    .filter(cat => (cat.budgeted || 0) === 0 && (cat.spent || 0) > 0)
    .sort((a, b) => b.spent - a.spent);
  return {
    categories: rows,
    total: rows.reduce((s, c) => s + c.spent, 0)
  };
}

// Population standard deviation / mean -- how "lumpy" a category's spend
// is across the window. A sinking fund (an annual premium, a planned
// renovation) is funded a little every month but spent in one or two, so
// its average alone reads as either "barely spent" or "wildly over
// budget" depending which month you look at; a high coefficient of
// variation is the signal to read its Gap as "check the pattern before
// reacting" rather than "chronically over budget."
function coefficientOfVariation(values) {
  if (values.length === 0) return 0;
  const mean = average(values);
  if (mean === 0) return 0;
  const variance = average(values.map(v => (v - mean) ** 2));
  return Math.sqrt(variance) / mean;
}

const LUMPY_CV_THRESHOLD = 0.9;

/**
 * @param {Array<{categoryId, name, groupName, monthlyTotals: Array<{month, total}>}>} categoryTrends - getCategorySpendTrend's shape, oldest month first
 * @param {Map<string, number>} budgetedByCategory - categoryId -> this month's live budgeted dollars
 * @param {number} trailingMonths - how many of the most recent months count as "this year" for the average/gap; whatever's left (if any) is the year-ago comparison window
 */
function computeCategoryGrid(categoryTrends, budgetedByCategory, { trailingMonths = 12 } = {}) {
  const rows = categoryTrends.map(trend => {
    const all = trend.monthlyTotals;
    const trailing = all.slice(-trailingMonths);
    const priorYear = all.slice(0, Math.max(0, all.length - trailingMonths));
    const trailingValues = trailing.map(m => m.total);
    const avg = average(trailingValues);
    const yearAgoAvg = priorYear.length > 0 ? average(priorYear.map(m => m.total)) : null;
    const budget = budgetedByCategory.get(trend.categoryId) || 0;
    return {
      categoryId: trend.categoryId, name: trend.name, groupName: trend.groupName,
      months: trailingValues, monthLabels: trailing.map(m => m.month),
      avg, yearAgoAvg, yearAgoMonthsAvailable: priorYear.length,
      budget, gap: avg - budget,
      isLumpy: coefficientOfVariation(trailingValues) > LUMPY_CV_THRESHOLD,
      yoyChange: yearAgoAvg !== null ? avg - yearAgoAvg : null
    };
  });
  return rows.sort((a, b) => a.groupName.localeCompare(b.groupName) || a.name.localeCompare(b.name));
}

// The Monthly Trends tab's small-multiples data: each category's spend in
// the same calendar months this year vs. last year (e.g. Jan-Sep both
// years), so seasonality and real shifts are visible month by month
// instead of hidden inside one averaged number. A category with zero
// spend in both windows is dropped -- nothing to compare.
function computeYearOverYearTrends(categoryTrends, thisYearMonths, lastYearMonths) {
  const rows = categoryTrends.map(trend => {
    const byMonth = new Map(trend.monthlyTotals.map(m => [m.month, m.total]));
    const thisYear = thisYearMonths.map(m => byMonth.get(m) || 0);
    const lastYear = lastYearMonths.map(m => byMonth.get(m) || 0);
    const totalThis = thisYear.reduce((s, v) => s + v, 0);
    const totalLast = lastYear.reduce((s, v) => s + v, 0);
    if (totalThis === 0 && totalLast === 0) return null;
    return {
      categoryId: trend.categoryId, name: trend.name, groupName: trend.groupName,
      thisYear, lastYear, totalThis, totalLast, yoyChange: totalThis - totalLast
    };
  }).filter(Boolean);
  return rows.sort((a, b) => Math.abs(b.yoyChange) - Math.abs(a.yoyChange));
}

module.exports = {
  computeSustainability, computeUnassignedSpend, computeCategoryGrid, computeYearOverYearTrends,
  coefficientOfVariation, LUMPY_CV_THRESHOLD
};
