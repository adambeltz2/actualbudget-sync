// IRS annual contribution limits, used only to flag (never block) the
// Monte Carlo page's contribution scenario when it exceeds what's actually
// allowed into a tax-advantaged account. These are nominal dollar figures
// set by the IRS each year — not derived from anything else in this app —
// so they're collected here as plain constants rather than computed, and
// will need a manual bump when the IRS publishes new figures.
const LIMITS_YEAR = 2025;

// Employee elective deferral limit for 401(k)/403(b)/most 457 plans.
const LIMIT_401K_BASE = 23500;
const LIMIT_401K_CATCHUP_50 = 7500; // ages 50-59 and 64+
const LIMIT_401K_CATCHUP_60_63 = 11250; // SECURE 2.0 "super" catch-up, ages 60-63 only

// Traditional + Roth IRA combined limit.
const LIMIT_IRA_BASE = 7000;
const LIMIT_IRA_CATCHUP_50 = 1000;

function limit401k(age) {
  if (age == null) return LIMIT_401K_BASE;
  if (age >= 60 && age <= 63) return LIMIT_401K_BASE + LIMIT_401K_CATCHUP_60_63;
  if (age >= 50) return LIMIT_401K_BASE + LIMIT_401K_CATCHUP_50;
  return LIMIT_401K_BASE;
}

function limitIra(age) {
  if (age == null) return LIMIT_IRA_BASE;
  return age >= 50 ? LIMIT_IRA_BASE + LIMIT_IRA_CATCHUP_50 : LIMIT_IRA_BASE;
}

// Taxable/other accounts have no IRS contribution limit.
function getContributionLimits(age) {
  return { year: LIMITS_YEAR, limit401k: limit401k(age), limitIra: limitIra(age) };
}

module.exports = { LIMITS_YEAR, limit401k, limitIra, getContributionLimits };
