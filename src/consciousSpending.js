// Pure helpers behind the Conscious Spending Plan page — no @actual-app/api
// calls, same split as socialSecurity.js/insights.js/budgetSummary.js. The
// four-bucket framework and its target bands are from Ramit Sethi's
// "I Will Teach You to Be Rich": Fixed Costs, Investments, Savings, and
// Guilt-Free Spending, each a target share of take-home pay (not gross
// income — the book is explicit about that basis throughout).
const BUCKET_KEYS = ['fixed', 'investments', 'savings', 'guiltfree'];

const BUCKETS = {
  fixed: { label: 'Fixed Costs', lo: 50, hi: 60, openEnded: false, warnDir: 'over' },
  // Investments has no upper target — the book phrases it as "at least
  // 10%", so openEnded means inRange only checks the floor.
  investments: { label: 'Investments', lo: 10, hi: null, openEnded: true, warnDir: 'under' },
  savings: { label: 'Savings', lo: 5, hi: 10, openEnded: false, warnDir: 'under' },
  guiltfree: { label: 'Guilt-Free Spending', lo: 20, hi: 35, openEnded: false, warnDir: 'over' }
};

function inRange(bucketKey, pct) {
  var b = BUCKETS[bucketKey];
  if (b.openEnded) return pct >= b.lo;
  return pct >= b.lo && pct <= b.hi;
}

// "Safe" direction: out-of-range the direction that isn't a problem for
// this bucket (e.g. Investments running above its 10% minimum) still reads
// as fine, never a warning — mirrors the approved mockup's logic exactly.
function isSafeDirection(bucketKey, pct) {
  var b = BUCKETS[bucketKey];
  if (b.warnDir === 'over' && pct < b.lo) return true;
  if (b.warnDir === 'under' && !b.openEnded && pct > b.hi) return true;
  return false;
}

function classifyBucket(bucketKey, pct) {
  var b = BUCKETS[bucketKey];
  if (inRange(bucketKey, pct)) return { status: 'on-target', label: 'On Target' };
  if (isSafeDirection(bucketKey, pct)) return { status: 'above-target', label: pct > b.hi ? 'Above Target' : 'Below Target' };
  return { status: pct < b.lo ? 'under-target' : 'over-target', label: pct < b.lo ? 'Under Target' : 'Over Target' };
}

/**
 * @param {Array} budgetVsActual - summarizeBudgetCategory shape: {categoryId, name, groupName, budgeted, spent, remaining, pctUsed, overBudget}
 * @param {Object} categoryClassification - { [categoryId]: 'fixed'|'investments'|'savings'|'guiltfree' }
 * @param {number} takeHomePay - dollars, the denominator for every bucket's %
 */
function computeMonthBuckets(budgetVsActual, categoryClassification, takeHomePay) {
  var grouped = { fixed: [], investments: [], savings: [], guiltfree: [] };
  var unclassified = [];
  (budgetVsActual || []).forEach(function (cat) {
    var key = categoryClassification[cat.categoryId];
    if (key && grouped[key]) grouped[key].push(cat);
    else unclassified.push(cat);
  });

  function bucketResult(key) {
    var cats = grouped[key];
    var spent = cats.reduce(function (s, c) { return s + c.spent; }, 0);
    var pct = takeHomePay > 0 ? (spent / takeHomePay) * 100 : 0;
    var cls = classifyBucket(key, pct);
    return {
      label: BUCKETS[key].label, lo: BUCKETS[key].lo, hi: BUCKETS[key].hi, openEnded: BUCKETS[key].openEnded,
      spent: spent, pct: pct, status: cls.status, statusLabel: cls.label,
      categories: cats.map(function (c) { return { name: c.name, spent: c.spent }; }).sort(function (a, b) { return b.spent - a.spent; })
    };
  }

  var unclassifiedSpent = unclassified.reduce(function (s, c) { return s + c.spent; }, 0);
  var classifiedSpent = BUCKET_KEYS.reduce(function (sum, key) { return sum + grouped[key].reduce(function (s, c) { return s + c.spent; }, 0); }, 0);

  return {
    takeHomePay: takeHomePay,
    buckets: {
      fixed: bucketResult('fixed'), investments: bucketResult('investments'),
      savings: bucketResult('savings'), guiltfree: bucketResult('guiltfree')
    },
    unclassified: {
      spent: unclassifiedSpent,
      pct: takeHomePay > 0 ? (unclassifiedSpent / takeHomePay) * 100 : 0,
      categories: unclassified.map(function (c) { return { name: c.name, spent: c.spent }; }).sort(function (a, b) { return b.spent - a.spent; })
    },
    classifiedPct: takeHomePay > 0 ? (classifiedSpent / takeHomePay) * 100 : 0,
    classifiedSpent: classifiedSpent
  };
}

// Averages a year of per-month bucket results (as computeMonthBuckets
// returns) into one summary per bucket, classified the same way a single
// month would be, against the mean of its monthly %s.
function computeYearSummary(monthResults) {
  var summary = {};
  BUCKET_KEYS.forEach(function (key) {
    var pcts = monthResults.map(function (m) { return m.buckets[key].pct; });
    var avgPct = pcts.length > 0 ? pcts.reduce(function (s, v) { return s + v; }, 0) / pcts.length : 0;
    var cls = classifyBucket(key, avgPct);
    summary[key] = { label: BUCKETS[key].label, lo: BUCKETS[key].lo, hi: BUCKETS[key].hi, openEnded: BUCKETS[key].openEnded, avgPct: avgPct, status: cls.status, statusLabel: cls.label };
  });
  return summary;
}

module.exports = { BUCKETS, BUCKET_KEYS, inRange, isSafeDirection, classifyBucket, computeMonthBuckets, computeYearSummary };
