// Pure helpers behind the Monthly Budget Summary email — no @actual-app/api
// calls, same split as socialSecurity.js/insights.js/financialHealth.js.

// Where the current calendar month stands: day X of Y, and what % of the
// month has elapsed (used to judge whether a category is running ahead of
// or behind its own budget pace).
function computeMonthProgress(now = new Date()) {
  const dayOfMonth = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const pctMonthElapsed = Math.round((dayOfMonth / daysInMonth) * 100);
  const monthLabel = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return { dayOfMonth, daysInMonth, pctMonthElapsed, monthLabel };
}

// Ranks categories by how far AHEAD of pace they are in dollar terms —
// $100 over pace on a small budget matters more than the same percentage
// over pace on a tiny one, and a big budget only slightly ahead of pace
// (in %) can still represent real dollars. aheadBy is spent minus the
// dollar amount "on pace" would have spent by this point in the month;
// projectedTotal extrapolates the current day's spend rate out to month end.
function computeCategoriesToWatch(budgetVsActual, pctMonthElapsed, { limit = 3, minAheadBy = 20 } = {}) {
  if (pctMonthElapsed <= 0) return [];
  return budgetVsActual
    .filter(cat => cat.budgeted > 0)
    .map(cat => {
      const paceDollarsExpected = cat.budgeted * (pctMonthElapsed / 100);
      const aheadBy = cat.spent - paceDollarsExpected;
      const projectedTotal = cat.spent / (pctMonthElapsed / 100);
      return { ...cat, aheadBy, projectedTotal };
    })
    .filter(cat => cat.aheadBy > minAheadBy)
    .sort((a, b) => b.aheadBy - a.aheadBy)
    .slice(0, limit);
}

// The trailing 7-day label for the Weekly Summary email's header ("Oct 14 –
// Oct 20") — the week ending on `now`, not a Mon-Sun calendar week, so it
// always matches whatever day the email actually goes out on.
function weekRangeLabel(now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(now)}`;
}

module.exports = { computeMonthProgress, computeCategoriesToWatch, weekRangeLabel };
