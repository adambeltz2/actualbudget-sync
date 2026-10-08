// A real per-path Monte Carlo retirement simulation: each of `paths` runs
// draws its own random annual return every year (not a closed-form
// percentile formula), compounds contributions while working, and compounds
// withdrawals (net of Social Security, pension, inflation, and an optional
// spending glidepath) while retired. Percentile bands are read back off the
// actual distribution of simulated balances at each age, same as a real
// advisor-grade tool — not an illustrative approximation.

// mulberry32: a small, fast, seedable PRNG. Seeded so regression tests get
// reproducible output; omit `seed` in production so every request draws a
// fresh distribution.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller transform: two uniform [0,1) draws -> one standard normal draw.
function randomNormal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Nominal mean/volatility by investment mix — more stocks means a higher
// expected return but a wider spread of outcomes, same trade-off a real
// advisor would describe.
const ALLOCATIONS = {
  conservative: { mean: 0.050, vol: 0.07 },
  moderate: { mean: 0.070, vol: 0.12 },
  aggressive: { mean: 0.090, vol: 0.17 }
};

const PERCENTILES = { p10: 0.10, p25: 0.25, p50: 0.50, p75: 0.75, p90: 0.90 };

function percentileOf(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.max(0, Math.round(p * (sortedArr.length - 1))));
  return sortedArr[idx];
}

/**
 * @param {object} opts
 * @param {number} opts.startBalance - current net worth, in dollars.
 * @param {number} opts.currentAge - current age in whole years.
 * @param {number} opts.retireAge - age contributions stop and withdrawals begin.
 * @param {number} [opts.endAge] - last simulated age. Defaults to 95, or 98
 *   when `survivor` is set (modeling a longer joint-life horizon for a couple
 *   is the real mechanism here, not a rate penalty).
 * @param {number} [opts.annualContribution] - added to the balance once per
 *   year while age <= retireAge.
 * @param {'conservative'|'moderate'|'aggressive'} [opts.allocation]
 * @param {number} [opts.inflationPct] - annual inflation, applied to the
 *   retirement spending base every year past retirement.
 * @param {number} [opts.withdrawalRatePct] - the fraction of the balance at
 *   retirement used as the first year's gross spending need.
 * @param {boolean} [opts.includeSocialSecurity]
 * @param {{claimAgeMonths:number, annualBenefit:number}|null} [opts.socialSecurity] -
 *   resolved via socialSecurity.js's resolveSocialSecurityClaim, so benefits
 *   only start at the user's real claiming age, never at retireAge itself.
 * @param {boolean} [opts.glidepath] - spend more in the early "go-go" years,
 *   less later, instead of a flat inflation-adjusted amount every year.
 * @param {number} [opts.pensionMonthly] - a guaranteed income that starts
 *   immediately at retireAge (unlike Social Security, no bridge gap).
 * @param {number} [opts.oneTimeExpense] - a lump sum subtracted once.
 * @param {number|null} [opts.oneTimeExpenseAge] - defaults to 10 years into
 *   retirement, capped at endAge - 1.
 * @param {boolean} [opts.survivor] - plan for a second, typically younger
 *   life by extending the simulated horizon.
 * @param {number} [opts.paths] - number of simulated paths.
 * @param {number|null} [opts.seed] - seed a reproducible PRNG (tests only).
 */
function simulateRetirement(opts) {
  const {
    startBalance, currentAge, retireAge,
    annualContribution = 0,
    allocation = 'moderate',
    inflationPct = 3.0,
    withdrawalRatePct = 3.8,
    includeSocialSecurity = false,
    socialSecurity = null,
    glidepath = false,
    pensionMonthly = 0,
    oneTimeExpense = 0,
    oneTimeExpenseAge = null,
    survivor = false,
    paths = 2000,
    seed = null,
    // Sequence-of-returns stress test: forces the first `stressFirstYears`
    // years AFTER retirement into the bottom quartile of the return
    // distribution (capping the drawn z-score at `stressZCap`, the 25th
    // percentile's z-score by default) instead of sampling freely — models
    // "what if the market craters right as I stop working," which hurts far
    // more than the same bad years spread across a 30-year retirement.
    stressFirstYears = 0,
    stressZCap = -0.6745
  } = opts;

  const endAge = opts.endAge != null ? opts.endAge : (survivor ? 98 : 95);
  if (!(startBalance >= 0) || !(currentAge >= 0) || !(retireAge > currentAge) || !(endAge > retireAge)) {
    throw new Error('Invalid Monte Carlo inputs: need startBalance >= 0 and currentAge < retireAge < endAge.');
  }

  const mix = ALLOCATIONS[allocation] || ALLOCATIONS.moderate;
  const ssStartAge = includeSocialSecurity && socialSecurity
    ? Math.max(retireAge, Math.ceil(socialSecurity.claimAgeMonths / 12))
    : null;
  const expenseAge = oneTimeExpense > 0
    ? Math.min(endAge - 1, oneTimeExpenseAge != null ? oneTimeExpenseAge : retireAge + 10)
    : null;

  const ages = [];
  for (let a = currentAge; a <= endAge; a++) ages.push(a);

  const rng = seed != null ? mulberry32(seed) : Math.random;
  const samplesByAge = ages.map(() => new Array(paths));
  let successCount = 0;
  const retirementBalanceSamples = new Array(paths);
  const endingBalanceSamples = new Array(paths);

  for (let p = 0; p < paths; p++) {
    let balance = startBalance;
    let spendBase = null; // set once, the year retirement begins

    for (let i = 0; i < ages.length; i++) {
      const age = ages[i];
      if (i > 0) {
        const yearsRetiredForStress = age - retireAge;
        const inStressWindow = age > retireAge && yearsRetiredForStress <= stressFirstYears;
        const z = inStressWindow ? Math.min(randomNormal(rng), stressZCap) : randomNormal(rng);
        const r = mix.mean + mix.vol * z;
        if (age <= retireAge) {
          balance = balance * (1 + r) + annualContribution;
        } else {
          if (spendBase === null) spendBase = balance * (withdrawalRatePct / 100);
          const yearsRetired = age - retireAge;
          const inflationFactor = Math.pow(1 + inflationPct / 100, yearsRetired);
          const smileFactor = !glidepath ? 1 : (yearsRetired <= 10 ? 1.15 : 0.85);
          const spendNeed = spendBase * inflationFactor * smileFactor;
          const ssIncome = ssStartAge !== null && age >= ssStartAge ? socialSecurity.annualBenefit : 0;
          const pensionIncome = pensionMonthly > 0 ? pensionMonthly * 12 : 0;
          const netWithdrawal = Math.max(0, spendNeed - ssIncome - pensionIncome);
          balance = balance * (1 + r) - netWithdrawal;
          if (age === expenseAge) balance -= oneTimeExpense;
        }
        balance = Math.max(balance, 0);
      }
      samplesByAge[i][p] = balance;
      if (age === retireAge) retirementBalanceSamples[p] = balance;
    }
    endingBalanceSamples[p] = balance;
    if (balance > 0) successCount++;
  }

  const bands = {};
  for (const key of Object.keys(PERCENTILES)) bands[key] = new Array(ages.length);
  for (let i = 0; i < ages.length; i++) {
    const sorted = samplesByAge[i].slice().sort((a, b) => a - b);
    for (const key of Object.keys(PERCENTILES)) bands[key][i] = percentileOf(sorted, PERCENTILES[key]);
  }

  const sortedRetirement = retirementBalanceSamples.slice().sort((a, b) => a - b);
  const sortedEnding = endingBalanceSamples.slice().sort((a, b) => a - b);
  const medianBalanceAtRetirement = percentileOf(sortedRetirement, 0.5);

  // "Money lasts until": a bottom-10th-percentile question, read directly
  // off the simulated p10 band, not the median (which rarely hits zero).
  let longevityAge = null;
  const p10 = bands.p10;
  for (let i = 0; i < ages.length; i++) {
    if (ages[i] < retireAge) continue;
    if (p10[i] <= 1) { longevityAge = ages[i]; break; }
  }

  return {
    ages,
    bands,
    successPct: Math.round((successCount / paths) * 100),
    longevityAge,
    medianBalanceAtRetirement,
    medianEndingBalance: percentileOf(sortedEnding, 0.5),
    p10EndingBalance: percentileOf(sortedEnding, 0.10),
    p90EndingBalance: percentileOf(sortedEnding, 0.90),
    safeWithdrawalAmount: medianBalanceAtRetirement * (withdrawalRatePct / 100),
    retireAge,
    endAge,
    ssStartAge,
    expenseAge,
    paths
  };
}

module.exports = { simulateRetirement, mulberry32, randomNormal, ALLOCATIONS };
