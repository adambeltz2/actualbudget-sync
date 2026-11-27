// Federal ordinary-income tax brackets and Required Minimum Distribution
// math for retirement withdrawals. Deliberately bounded in scope (see each
// function's own comment for exactly what's modeled and what isn't) --
// this is still "simple math from real data, not a guarantee," the same
// ethos as the rest of this app's projections, just a materially more
// accurate approximation than a single flat tax rate on every withdrawal.

// 2026 federal brackets (IRS Rev. Proc. 2025-32, as amended by the One Big
// Beautiful Bill) and standard deductions. Federal only -- no state tax, no
// AMT, no Net Investment Income Tax, no itemizing -- and nominal (today's
// thresholds, not re-indexed for the inflation a multi-decade projection
// should expect), the same "today's dollars" simplification this app's
// other projections already make. These numbers need manual upkeep every
// tax year; there's no API for them.
const FEDERAL_BRACKETS = {
  single: [
    { rate: 0.10, upTo: 12400 },
    { rate: 0.12, upTo: 50400 },
    { rate: 0.22, upTo: 105700 },
    { rate: 0.24, upTo: 201775 },
    { rate: 0.32, upTo: 256225 },
    { rate: 0.35, upTo: 640600 },
    { rate: 0.37, upTo: Infinity }
  ],
  marriedJointly: [
    { rate: 0.10, upTo: 24800 },
    { rate: 0.12, upTo: 100800 },
    { rate: 0.22, upTo: 211400 },
    { rate: 0.24, upTo: 403550 },
    { rate: 0.32, upTo: 512450 },
    { rate: 0.35, upTo: 768700 },
    { rate: 0.37, upTo: Infinity }
  ]
};

const STANDARD_DEDUCTION = { single: 16100, marriedJointly: 32200 };

// Marginal-bracket tax on ordinary income -- traditional-account
// withdrawals and RMDs, specifically. Social Security benefits are
// deliberately excluded from this (real SS taxability is its own 0-85%
// combined-income calculation; treating it as untaxed here is the
// conservative simplification, erring toward not overstating the tax
// burden on a benefit that's often only partially taxable anyway).
function computeFederalTax(ordinaryIncome, filingStatus = 'single') {
  const brackets = FEDERAL_BRACKETS[filingStatus] || FEDERAL_BRACKETS.single;
  const deduction = STANDARD_DEDUCTION[filingStatus] ?? STANDARD_DEDUCTION.single;
  const taxableIncome = Math.max(0, ordinaryIncome - deduction);

  let tax = 0;
  let lowerBound = 0;
  for (const { rate, upTo } of brackets) {
    if (taxableIncome <= lowerBound) break;
    const amountInBracket = Math.min(taxableIncome, upTo) - lowerBound;
    tax += amountInBracket * rate;
    lowerBound = upTo;
  }
  return tax;
}

// The inverse question computeFederalTax can't answer directly: "I need
// this much spendable cash out of my traditional bucket after tax -- how
// much do I actually have to withdraw (gross) to net that?" Marginal
// brackets aren't algebraically invertible in closed form, but
// netIncome(gross) = gross - computeFederalTax(gross) is monotonically
// increasing (every bracket's rate is under 100%), so binary search
// converges quickly and reliably.
function solveGrossTraditionalWithdrawal({ netAmountNeeded, filingStatus = 'single', tolerance = 0.01, maxIterations = 100 }) {
  if (netAmountNeeded <= 0) return 0;

  let lo = 0;
  let hi = Math.max(netAmountNeeded * 2, 1000);
  while (hi - computeFederalTax(hi, filingStatus) < netAmountNeeded) hi *= 2;

  for (let i = 0; i < maxIterations; i++) {
    const mid = (lo + hi) / 2;
    const net = mid - computeFederalTax(mid, filingStatus);
    if (Math.abs(net - netAmountNeeded) < tolerance) return mid;
    if (net < netAmountNeeded) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// IRS Publication 590-B, Table III (the Uniform Lifetime Table) -- in
// effect unchanged since the 2022 revision. Applies to the large majority
// of IRA/401(k) owners; the separate Joint Life table (a spouse-beneficiary
// more than 10 years younger, which produces a smaller RMD) isn't modeled.
const UNIFORM_LIFETIME_DIVISORS = {
  72: 27.4, 73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2,
  81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7, 89: 12.9,
  90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8,
  100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9, 105: 4.6, 106: 4.3, 107: 4.1, 108: 3.9,
  109: 3.7, 110: 3.5, 111: 3.4, 112: 3.3, 113: 3.1, 114: 3.0, 115: 2.9, 116: 2.8, 117: 2.7,
  118: 2.5, 119: 2.3, 120: 2.0
};

// SECURE 2.0: RMDs start at 73 for anyone born 1951-1959, and at 75 for
// anyone born 1960 or later. Only Traditional accounts have RMDs --
// Roth IRAs never did, and Roth 401(k)s stopped requiring them starting
// with the 2024 tax year (also SECURE 2.0) -- so this is only ever called
// against a traditional-bucket balance.
function rmdStartAge(birthYear) {
  return birthYear >= 1960 ? 75 : 73;
}

function rmdDivisor(age) {
  const clampedAge = Math.min(Math.max(Math.round(age), 72), 120);
  return UNIFORM_LIFETIME_DIVISORS[clampedAge];
}

// The forced minimum withdrawal for a given year, from the traditional
// balance as of the end of the PRIOR year (the real IRS calculation's own
// timing) and the age reached this year. 0 before the start age, or with
// nothing in the account -- matches "no RMD" cleanly without a separate
// null case for callers to handle.
function computeRMD({ priorYearEndBalance, age, birthYear }) {
  if (!(priorYearEndBalance > 0)) return 0;
  if (age < rmdStartAge(birthYear)) return 0;
  return priorYearEndBalance / rmdDivisor(age);
}

// Splits a total balance into traditional/Roth/"everything else" shares
// that always sum to exactly 1 -- even when tagged account balances alone
// add up to MORE than totalBalance, which can genuinely happen: net worth
// nets out debt (a mortgage, a credit card), but these tags are asset-only,
// so a household with any untagged debt can have a tagged traditional+Roth
// total bigger than its net worth. Clamping each share independently to
// [0,1] isn't enough in that case (two shares can each be under 1 and still
// sum past it) -- scaling both down proportionally keeps their relative
// split intact while guaranteeing they never claim more than 100% of
// whatever's being divided (a withdrawal need, a contribution).
function computeBucketShares({ traditionalBalance = 0, rothBalance = 0, totalBalance = 0 }) {
  if (!(totalBalance > 0)) return { traditionalShare: 0, rothShare: 0, otherShare: 1 };
  let traditionalShare = Math.max(0, traditionalBalance / totalBalance);
  let rothShare = Math.max(0, rothBalance / totalBalance);
  const taggedShare = traditionalShare + rothShare;
  if (taggedShare > 1) {
    traditionalShare /= taggedShare;
    rothShare /= taggedShare;
  }
  const otherShare = Math.max(0, 1 - traditionalShare - rothShare);
  return { traditionalShare, rothShare, otherShare };
}

// Splits a target NET annual spending amount across three account-tax
// buckets, proportional to TODAY's tagged balances (a steady-state
// approximation -- the real proportion will drift between now and
// retirement as contributions/growth favor one bucket or another, the
// same "today's numbers, not a projection of themselves" simplification
// this app's other FIRE math already makes), then grosses up only the
// traditional share through real marginal brackets. The Roth share is
// untaxed. Everything else -- taxable accounts, or simply unset if no
// account has been tagged at all -- keeps the existing flat
// flatTaxRatePct treatment, so a household that tags nothing sees exactly
// the same number as before bucket tagging existed.
function grossUpAnnualNeed({ netAnnualNeed, traditionalBalance = 0, rothBalance = 0, netWorth = 0, filingStatus = 'single', flatTaxRatePct = 0 }) {
  if (!(netAnnualNeed > 0)) return 0;
  if (!(netWorth > 0)) {
    return flatTaxRatePct > 0 ? netAnnualNeed / (1 - flatTaxRatePct / 100) : netAnnualNeed;
  }

  const { traditionalShare, rothShare, otherShare } = computeBucketShares({ traditionalBalance, rothBalance, totalBalance: netWorth });

  const netFromTraditional = netAnnualNeed * traditionalShare;
  const netFromRoth = netAnnualNeed * rothShare;
  const netFromOther = netAnnualNeed * otherShare;

  const grossFromTraditional = solveGrossTraditionalWithdrawal({ netAmountNeeded: netFromTraditional, filingStatus });
  const grossFromOther = flatTaxRatePct > 0 ? netFromOther / (1 - flatTaxRatePct / 100) : netFromOther;

  return grossFromTraditional + netFromRoth + grossFromOther;
}

module.exports = {
  FEDERAL_BRACKETS, STANDARD_DEDUCTION, computeFederalTax, solveGrossTraditionalWithdrawal,
  UNIFORM_LIFETIME_DIVISORS, rmdStartAge, rmdDivisor, computeRMD, computeBucketShares, grossUpAnnualNeed
};
