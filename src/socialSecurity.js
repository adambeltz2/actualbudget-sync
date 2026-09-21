const { projectFutureValue } = require('./insights');

// Whole months between a birthdate and an "as of" date (today, by default).
// Whole-month precision matters here — Social Security's own eligibility
// math (and the "years, months" format SSA statements use for Full
// Retirement Age) is monthly, not just yearly.
function ageInMonths(birthdate, asOfDate = new Date()) {
  const birth = new Date(birthdate);
  let months = (asOfDate.getFullYear() - birth.getFullYear()) * 12 + (asOfDate.getMonth() - birth.getMonth());
  if (asOfDate.getDate() < birth.getDate()) months -= 1;
  return Math.max(months, 0);
}

// A real SSA statement gives three claiming ages — 62, Full Retirement Age
// (which varies by birth year, so it's user-entered rather than assumed),
// and 70 — each with its own monthly benefit. Resolves whichever one the
// user picked to actually claim into a single {claimAgeMonths,
// annualBenefit} pair; returns null if that claim's inputs aren't
// (yet) fully filled in, so the caller can fall back to ignoring Social
// Security entirely rather than computing against a zero/missing benefit.
function resolveSocialSecurityClaim({
  claimingChoice, age62MonthlyBenefit, fraAgeYears, fraAgeMonths, fraMonthlyBenefit, age70MonthlyBenefit
}) {
  const claims = {
    age62: { ageMonths: 62 * 12, monthlyBenefit: age62MonthlyBenefit },
    fra: {
      ageMonths: (fraAgeYears != null && fraAgeMonths != null) ? (fraAgeYears * 12 + fraAgeMonths) : null,
      monthlyBenefit: fraMonthlyBenefit
    },
    age70: { ageMonths: 70 * 12, monthlyBenefit: age70MonthlyBenefit }
  };
  const claim = claims[claimingChoice];
  if (!claim || !claim.ageMonths || !claim.monthlyBenefit) return null;
  return { claimAgeMonths: claim.ageMonths, annualBenefit: claim.monthlyBenefit * 12 };
}

// The FIRE target at a given age, in months. Without Social Security this
// is just the standard "annual expenses x (100 / withdrawal rate)" target.
// With it, the target still has to cover 100% of expenses out of savings
// alone until the claim age (a "bridge" — modeled as a flat annualExpenses
// x bridge-years dollar amount, not a full drawdown simulation, consistent
// with this app's existing "simple math from your own data, not a
// guarantee" approach elsewhere), and only needs to cover the
// benefit-reduced remainder forever after that.
function computeFireTargetAtAge({ ageMonths, annualExpenses, withdrawalRatePct, socialSecurity }) {
  const baseFireNumber = annualExpenses * (100 / withdrawalRatePct);
  if (!socialSecurity) return baseFireNumber;

  const { claimAgeMonths, annualBenefit } = socialSecurity;
  const bridgeYears = Math.max(claimAgeMonths - ageMonths, 0) / 12;
  const bridgeCost = annualExpenses * bridgeYears;
  const postClaimAnnualExpenses = Math.max(annualExpenses - annualBenefit, 0);
  const postClaimFireNumber = postClaimAnnualExpenses * (100 / withdrawalRatePct);
  return postClaimFireNumber + bridgeCost;
}

// Months until net worth (growing at annualReturnRate, plus a monthly
// contribution) first reaches its FIRE target — which itself can shrink
// month to month as the Social Security bridge narrows, so a fixed-target
// search isn't enough once Social Security is factored in. Without
// Social Security (or without a known current age) the target never
// moves, so this behaves identically to a plain fixed-target search.
function monthsToReachFireTarget({
  currentBalance, monthlyContribution, annualReturnRate,
  annualExpenses, withdrawalRatePct, currentAgeMonths, socialSecurity, maxMonths = 1200
}) {
  for (let m = 0; m <= maxMonths; m++) {
    const target = computeFireTargetAtAge({
      ageMonths: (currentAgeMonths ?? 0) + m, annualExpenses, withdrawalRatePct, socialSecurity
    });
    const projected = projectFutureValue({ presentValue: currentBalance, monthlyContribution, annualReturnRate, months: m });
    if (projected >= target) return m;
  }
  return null;
}

module.exports = { ageInMonths, resolveSocialSecurityClaim, computeFireTargetAtAge, monthsToReachFireTarget };
