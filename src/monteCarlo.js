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

const { computeFederalTax, solveGrossTraditionalWithdrawal, computeRMD } = require('./retirementTax');

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
 *   year while age <= retireAge (and age <= contributionStopAge, if set).
 * @param {number|null} [opts.contributionStopAge] - last age that still
 *   receives annualContribution; null (default) means "contribute all the
 *   way to retireAge," i.e. no change from before this existed. Set below
 *   retireAge to model stopping early (e.g. currentAge = stop contributing
 *   today) while still working/retiring on the same schedule otherwise.
 * @param {'conservative'|'moderate'|'aggressive'} [opts.allocation]
 * @param {number} [opts.inflationPct] - annual inflation, applied to the
 *   retirement spending base every year past retirement (and, when
 *   annualExpenses is used, between today and retirement too).
 * @param {number} [opts.withdrawalRatePct] - the fraction of the balance at
 *   retirement used as the first year's gross spending need. Ignored
 *   whenever annualExpenses > 0 is provided instead.
 * @param {number} [opts.annualExpenses] - today's-dollars real spending need
 *   (e.g. actual trailing tracked spend, or a manual FIRE override) used as
 *   the retirement spend base instead of withdrawalRatePct × balance, so
 *   success/failure is measured against what you actually spend rather than
 *   an arbitrary share of whatever balance the simulation happens to reach.
 *   Grown by inflationPct from today out to retirement, then same as
 *   withdrawalRatePct mode from there (continues growing with inflation,
 *   can be reduced by a glidepath). 0 (default) keeps the withdrawalRatePct
 *   behavior unchanged.
 * @param {number} [opts.taxRatePct] - flat effective tax rate applied only
 *   to the portion of each year's spending need actually funded by a
 *   portfolio withdrawal (Social Security/pension are netted out first,
 *   same order a flat-rate estimate like this can reasonably assume). 0
 *   (default) leaves withdrawals untaxed, same as before this existed.
 *   Ignored for the traditional/Roth share once traditionalBalance or
 *   rothBalance is set -- see those below.
 * @param {number} [opts.traditionalBalance] - the slice of startBalance held
 *   in traditional (pre-tax) accounts. When this or rothBalance is > 0, the
 *   simulation tracks three buckets (traditional/Roth/everything else)
 *   instead of one combined balance: new contributions split across them in
 *   today's proportions (not re-projected forward -- the same "today's
 *   numbers" approximation this app's other FIRE math already makes),
 *   retirement withdrawals draw taxable/untagged first, then traditional
 *   (through real marginal tax brackets via retirementTax.js, with a forced
 *   Required Minimum Distribution once age reaches the SECURE 2.0 RMD age),
 *   then Roth (untaxed) for whatever's still short. 0 (default, for both
 *   this and rothBalance) keeps the single-balance/flat-taxRatePct behavior
 *   above completely unchanged.
 * @param {number} [opts.rothBalance] - the slice of startBalance held in Roth
 *   accounts. See traditionalBalance.
 * @param {string} [opts.filingStatus] - 'single' or 'marriedJointly', used
 *   only for traditional-bucket bracket tax. Defaults to 'single'.
 * @param {number|null} [opts.birthYear] - needed only to know the SECURE 2.0
 *   RMD start age (73 for birth year <= 1959, 75 for 1960+). Required
 *   whenever a traditional bucket is in use; RMDs are skipped (not an
 *   error) if omitted, since a null birthYear can't resolve an RMD age.
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
    contributionStopAge = null,
    allocation = 'moderate',
    inflationPct = 3.0,
    withdrawalRatePct = 3.8,
    annualExpenses = 0,
    taxRatePct = 0,
    traditionalBalance = 0,
    rothBalance = 0,
    filingStatus = 'single',
    birthYear = null,
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

  // Buckets only activate when there's something to bucket -- the
  // single-balance path below stays byte-identical to before this existed
  // whenever both are 0 (the default).
  const bucketsEnabled = traditionalBalance > 0 || rothBalance > 0;
  const otherStartBalance = Math.max(0, startBalance - traditionalBalance - rothBalance);
  // Contribution split and RMD timing both rely on today's proportions,
  // not a reprojection of them -- same "today's numbers" approximation
  // already used for the FIRE Number's own bucket-aware tax gross-up.
  const traditionalShare = startBalance > 0 ? traditionalBalance / startBalance : 0;
  const rothShare = startBalance > 0 ? rothBalance / startBalance : 0;
  const otherShare = Math.max(0, 1 - traditionalShare - rothShare);

  const rng = seed != null ? mulberry32(seed) : Math.random;
  const samplesByAge = ages.map(() => new Array(paths));
  let successCount = 0;
  const retirementBalanceSamples = new Array(paths);
  const endingBalanceSamples = new Array(paths);

  for (let p = 0; p < paths; p++) {
    let balance = startBalance;
    let balanceTraditional = traditionalBalance;
    let balanceRoth = rothBalance;
    let balanceOther = otherStartBalance;
    let spendBase = null; // set once, the year retirement begins

    for (let i = 0; i < ages.length; i++) {
      const age = ages[i];
      if (i > 0) {
        const yearsRetiredForStress = age - retireAge;
        const inStressWindow = age > retireAge && yearsRetiredForStress <= stressFirstYears;
        const z = inStressWindow ? Math.min(randomNormal(rng), stressZCap) : randomNormal(rng);
        const r = mix.mean + mix.vol * z;
        if (age <= retireAge) {
          const contributes = contributionStopAge === null || age <= contributionStopAge;
          const contributionAmount = contributes ? annualContribution : 0;
          if (bucketsEnabled) {
            balanceTraditional = balanceTraditional * (1 + r) + contributionAmount * traditionalShare;
            balanceRoth = balanceRoth * (1 + r) + contributionAmount * rothShare;
            balanceOther = balanceOther * (1 + r) + contributionAmount * otherShare;
            balance = balanceTraditional + balanceRoth + balanceOther;
          } else {
            balance = balance * (1 + r) + contributionAmount;
          }
        } else {
          if (spendBase === null) {
            spendBase = annualExpenses > 0
              ? annualExpenses * Math.pow(1 + inflationPct / 100, retireAge - currentAge)
              : balance * (withdrawalRatePct / 100);
          }
          const yearsRetired = age - retireAge;
          const inflationFactor = Math.pow(1 + inflationPct / 100, yearsRetired);
          const smileFactor = !glidepath ? 1 : (yearsRetired <= 10 ? 1.15 : 0.85);
          const spendNeed = spendBase * inflationFactor * smileFactor;
          const ssIncome = ssStartAge !== null && age >= ssStartAge ? socialSecurity.annualBenefit : 0;
          const pensionIncome = pensionMonthly > 0 ? pensionMonthly * 12 : 0;
          const netNeeded = Math.max(0, spendNeed - ssIncome - pensionIncome);

          if (bucketsEnabled) {
            // RMD uses last year's ending traditional balance, same timing
            // the real IRS calculation uses, so it's computed before this
            // year's growth is applied.
            const rmdAmount = computeRMD({ priorYearEndBalance: balanceTraditional, age, birthYear });

            balanceOther *= (1 + r);
            balanceTraditional *= (1 + r);
            balanceRoth *= (1 + r);

            // 1) Taxable/untagged covers spend first (tax-efficient
            //    sequencing: let tax-advantaged balances keep growing).
            const fromOther = Math.min(netNeeded, Math.max(balanceOther, 0));
            balanceOther -= fromOther;
            let remainingNet = netNeeded - fromOther;

            // 2) Traditional: withdraw whichever is bigger, the forced RMD
            //    or whatever's needed to cover the rest of spend -- a
            //    bigger spend-driven withdrawal already satisfies the RMD
            //    on its own, so there's no separate case to handle.
            const neededGrossFromTraditional = solveGrossTraditionalWithdrawal({ netAmountNeeded: remainingNet, filingStatus });
            const grossTraditionalWithdrawal = Math.max(rmdAmount, neededGrossFromTraditional);
            const taxOnTraditional = computeFederalTax(grossTraditionalWithdrawal, filingStatus);
            const netFromTraditional = grossTraditionalWithdrawal - taxOnTraditional;
            balanceTraditional -= grossTraditionalWithdrawal;
            const appliedFromTraditional = Math.min(netFromTraditional, remainingNet);
            remainingNet -= appliedFromTraditional;
            // A forced RMD bigger than what spend needed leaves already-taxed
            // cash with nowhere else to go but the taxable bucket -- same
            // real-world mechanic as an RMD you don't spend.
            balanceOther += Math.max(0, netFromTraditional - appliedFromTraditional);

            // 3) Roth absorbs whatever's still short (untaxed).
            const fromRoth = Math.min(remainingNet, Math.max(balanceRoth, 0));
            balanceRoth -= fromRoth;

            if (age === expenseAge) balanceOther -= oneTimeExpense;
            balanceOther = Math.max(balanceOther, 0);
            balanceTraditional = Math.max(balanceTraditional, 0);
            balanceRoth = Math.max(balanceRoth, 0);
            balance = balanceOther + balanceTraditional + balanceRoth;
          } else {
            const netWithdrawal = taxRatePct > 0 ? netNeeded / (1 - taxRatePct / 100) : netNeeded;
            balance = balance * (1 + r) - netWithdrawal;
            if (age === expenseAge) balance -= oneTimeExpense;
            balance = Math.max(balance, 0);
          }
        }
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
    usesTrackedExpenses: annualExpenses > 0,
    usesBucketedTax: bucketsEnabled,
    retireAge,
    endAge,
    ssStartAge,
    expenseAge,
    paths
  };
}

module.exports = { simulateRetirement, mulberry32, randomNormal, ALLOCATIONS };
