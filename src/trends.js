// Pure category-delta computation for the Trends page's month-over-month
// and year-over-year "which categories are costing more/less" tables.
//
// Ranked by dollar impact and capped, the same anti-clutter lesson learned
// from Financial Insights' Spending Trends (a category that moved by a
// large percent but a trivial dollar amount isn't useful, and an
// uncapped list of every category that changed at all becomes a wall of
// noise instead of something worth reading).
function buildCategoryDeltas(current, prior, { maxResults = 12 } = {}) {
  const currentByName = new Map(current.map(c => [c.name, c]));
  const priorByName = new Map(prior.map(c => [c.name, c]));
  const names = new Set([...currentByName.keys(), ...priorByName.keys()]);

  const deltas = [];
  for (const name of names) {
    const currentRow = currentByName.get(name);
    const priorRow = priorByName.get(name);
    const currentTotal = currentRow?.total || 0;
    const priorTotal = priorRow?.total || 0;
    const delta = currentTotal - priorTotal;
    if (delta === 0) continue;
    const pctChange = priorTotal > 0 ? Math.round((delta / priorTotal) * 100) : 100;
    // A category's group doesn't change between the two periods being
    // compared, so either row's groupName (whichever exists) is correct.
    const groupName = currentRow?.groupName || priorRow?.groupName || 'Other';
    deltas.push({ name, groupName, current: currentTotal, prior: priorTotal, delta, pctChange });
  }

  return deltas
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, maxResults);
}

module.exports = { buildCategoryDeltas };
