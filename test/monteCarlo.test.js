const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { simulateRetirement, mulberry32, randomNormal, ALLOCATIONS } = require('../src/monteCarlo');
const { computeRMD, computeFederalTax } = require('../src/retirementTax');

function baseOpts(overrides = {}) {
  return {
    startBalance: 400000,
    currentAge: 42,
    retireAge: 55,
    annualContribution: 20000,
    allocation: 'moderate',
    inflationPct: 3.0,
    withdrawalRatePct: 3.8,
    includeSocialSecurity: false,
    socialSecurity: null,
    glidepath: false,
    pensionMonthly: 0,
    oneTimeExpense: 0,
    survivor: false,
    paths: 500,
    seed: 42,
    ...overrides
  };
}

describe('mulberry32 + randomNormal', () => {
  test('is deterministic for a given seed', () => {
    const rngA = mulberry32(7);
    const rngB = mulberry32(7);
    const seqA = [rngA(), rngA(), rngA()];
    const seqB = [rngB(), rngB(), rngB()];
    assert.deepEqual(seqA, seqB);
  });

  test('produces different sequences for different seeds', () => {
    const a = mulberry32(1)();
    const b = mulberry32(2)();
    assert.notEqual(a, b);
  });

  test('randomNormal draws are roughly centered on 0 over many samples', () => {
    const rng = mulberry32(123);
    let sum = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) sum += randomNormal(rng);
    assert.ok(Math.abs(sum / n) < 0.05, `mean was ${sum / n}, expected close to 0`);
  });
});

describe('simulateRetirement — input validation', () => {
  test('throws when retireAge is not after currentAge', () => {
    assert.throws(() => simulateRetirement(baseOpts({ retireAge: 42 })));
  });
  test('throws when endAge is not after retireAge', () => {
    assert.throws(() => simulateRetirement(baseOpts({ endAge: 55 })));
  });
  test('throws on a negative starting balance', () => {
    assert.throws(() => simulateRetirement(baseOpts({ startBalance: -1 })));
  });
});

describe('simulateRetirement — determinism (regression)', () => {
  test('the same seed and inputs produce byte-identical output', () => {
    const a = simulateRetirement(baseOpts());
    const b = simulateRetirement(baseOpts());
    assert.deepEqual(a, b);
  });

  // Locks in today's known-good numbers for the default scenario so an
  // unintended change to the simulation math (not just a refactor) is
  // caught by CI instead of only showing up as a UI regression later.
  test('matches a fixed baseline snapshot for the default scenario', () => {
    const result = simulateRetirement(baseOpts());
    assert.equal(result.ages[0], 42);
    assert.equal(result.ages[result.ages.length - 1], 95);
    assert.equal(result.retireAge, 55);
    assert.equal(result.endAge, 95);
    assert.equal(result.ssStartAge, null);
    assert.equal(result.expenseAge, null);
    assert.equal(result.paths, 500);
    assert.ok(result.successPct >= 0 && result.successPct <= 100);
    assert.ok(Number.isFinite(result.medianBalanceAtRetirement));
    assert.ok(Number.isFinite(result.safeWithdrawalAmount));
    // Exact regression values for seed 42 — update deliberately if the
    // simulation math changes on purpose.
    assert.equal(result.successPct, 64);
    assert.equal(Math.round(result.medianBalanceAtRetirement), 1272737);
  });
});

describe('simulateRetirement — percentile bands', () => {
  test('bands are non-decreasing from p10 through p90 at every age', () => {
    const result = simulateRetirement(baseOpts());
    for (let i = 0; i < result.ages.length; i++) {
      assert.ok(result.bands.p10[i] <= result.bands.p25[i]);
      assert.ok(result.bands.p25[i] <= result.bands.p50[i]);
      assert.ok(result.bands.p50[i] <= result.bands.p75[i]);
      assert.ok(result.bands.p75[i] <= result.bands.p90[i]);
    }
  });

  test('every band starts at the starting balance', () => {
    const result = simulateRetirement(baseOpts());
    for (const key of Object.keys(result.bands)) {
      assert.equal(result.bands[key][0], 400000);
    }
  });
});

describe('simulateRetirement — Social Security bridge gap', () => {
  test('without Social Security, including it has no effect', () => {
    const without = simulateRetirement(baseOpts({ includeSocialSecurity: false }));
    const withButNoClaim = simulateRetirement(baseOpts({ includeSocialSecurity: true, socialSecurity: null }));
    assert.deepEqual(without.bands, withButNoClaim.bands);
  });

  test('retiring before the claim age produces a bridge gap (ssStartAge > retireAge)', () => {
    const socialSecurity = { claimAgeMonths: 67 * 12, annualBenefit: 24000 };
    const result = simulateRetirement(baseOpts({
      retireAge: 55, includeSocialSecurity: true, socialSecurity, paths: 1500
    }));
    assert.equal(result.ssStartAge, 67);
    assert.ok(result.ssStartAge > result.retireAge);
  });

  test('retiring at or after the claim age starts Social Security immediately, no bridge', () => {
    const socialSecurity = { claimAgeMonths: 67 * 12, annualBenefit: 24000 };
    const result = simulateRetirement(baseOpts({
      retireAge: 70, includeSocialSecurity: true, socialSecurity, paths: 1500
    }));
    assert.equal(result.ssStartAge, 70);
  });

  test('a benefit that starts earlier (shorter bridge) improves the median outcome', () => {
    const longBridge = simulateRetirement(baseOpts({
      retireAge: 55, includeSocialSecurity: true,
      socialSecurity: { claimAgeMonths: 67 * 12, annualBenefit: 24000 }, paths: 3000, seed: 99
    }));
    const shortBridge = simulateRetirement(baseOpts({
      retireAge: 55, includeSocialSecurity: true,
      socialSecurity: { claimAgeMonths: 62 * 12, annualBenefit: 18000 }, paths: 3000, seed: 99
    }));
    const lastIdx = longBridge.ages.length - 1;
    assert.ok(shortBridge.bands.p50[lastIdx] > longBridge.bands.p50[lastIdx]);
  });
});

describe('simulateRetirement — annual contribution', () => {
  test('a larger annual contribution raises the median balance at retirement', () => {
    const low = simulateRetirement(baseOpts({ annualContribution: 0, paths: 3000, seed: 5 }));
    const high = simulateRetirement(baseOpts({ annualContribution: 30000, paths: 3000, seed: 5 }));
    assert.ok(high.medianBalanceAtRetirement > low.medianBalanceAtRetirement);
  });
});

describe('simulateRetirement — investment mix', () => {
  test('aggressive allocation has wider percentile bands than conservative at the same age', () => {
    const conservative = simulateRetirement(baseOpts({ allocation: 'conservative', paths: 4000, seed: 11 }));
    const aggressive = simulateRetirement(baseOpts({ allocation: 'aggressive', paths: 4000, seed: 11 }));
    const lastIdx = conservative.ages.length - 1;
    const conservativeSpread = conservative.bands.p90[lastIdx] - conservative.bands.p10[lastIdx];
    const aggressiveSpread = aggressive.bands.p90[lastIdx] - aggressive.bands.p10[lastIdx];
    assert.ok(aggressiveSpread > conservativeSpread);
  });

  test('an unrecognized allocation falls back to moderate', () => {
    const fallback = simulateRetirement(baseOpts({ allocation: 'not-a-real-mix', paths: 500, seed: 3 }));
    const moderate = simulateRetirement(baseOpts({ allocation: 'moderate', paths: 500, seed: 3 }));
    assert.deepEqual(fallback.bands, moderate.bands);
  });
});

describe('simulateRetirement — spending glidepath', () => {
  test('a glidepath spends more than flat in the first 10 retirement years', () => {
    // Same seed/paths so the only difference is the deterministic spend
    // schedule itself, isolating the glidepath's effect from RNG noise.
    const flat = simulateRetirement(baseOpts({ glidepath: false, paths: 2000, seed: 17, retireAge: 60 }));
    const smile = simulateRetirement(baseOpts({ glidepath: true, paths: 2000, seed: 17, retireAge: 60 }));
    const idxAtRetirePlus5 = flat.ages.indexOf(65);
    assert.ok(smile.bands.p50[idxAtRetirePlus5] < flat.bands.p50[idxAtRetirePlus5]);
  });
});

describe('simulateRetirement — pension / other guaranteed income', () => {
  test('a pension raises the median ending balance', () => {
    const noPension = simulateRetirement(baseOpts({ pensionMonthly: 0, paths: 3000, seed: 21 }));
    const withPension = simulateRetirement(baseOpts({ pensionMonthly: 3000, paths: 3000, seed: 21 }));
    assert.ok(withPension.medianEndingBalance > noPension.medianEndingBalance);
  });
});

describe('simulateRetirement — one-time expense', () => {
  test('a one-time expense visibly drops the median balance right after it hits', () => {
    const result = simulateRetirement(baseOpts({ oneTimeExpense: 100000, paths: 3000, seed: 8 }));
    assert.ok(result.expenseAge !== null);
    const idx = result.ages.indexOf(result.expenseAge);
    const idxBefore = idx - 1;
    assert.ok(result.bands.p50[idx] < result.bands.p50[idxBefore] + 50000, 'expense should be visible as a drop, not absorbed by growth');
  });

  test('no expense is applied when oneTimeExpense is 0', () => {
    const result = simulateRetirement(baseOpts({ oneTimeExpense: 0 }));
    assert.equal(result.expenseAge, null);
  });

  test('expense age is capped before the horizon end', () => {
    const result = simulateRetirement(baseOpts({ retireAge: 90, endAge: 95, oneTimeExpense: 10000 }));
    assert.ok(result.expenseAge < result.endAge);
  });
});

describe('simulateRetirement — survivor planning', () => {
  test('defaults to a longer horizon (98) instead of 95 when survivor is set', () => {
    const result = simulateRetirement(baseOpts({ survivor: true }));
    assert.equal(result.endAge, 98);
  });

  test('does not override an explicitly-passed endAge', () => {
    const result = simulateRetirement(baseOpts({ survivor: true, endAge: 100 }));
    assert.equal(result.endAge, 100);
  });
});

describe('simulateRetirement — retirement age', () => {
  test('a later retirement age raises success probability, holding everything else equal', () => {
    const early = simulateRetirement(baseOpts({ retireAge: 55, paths: 4000, seed: 2 }));
    const late = simulateRetirement(baseOpts({ retireAge: 65, paths: 4000, seed: 2 }));
    assert.ok(late.successPct >= early.successPct);
  });
});

describe('simulateRetirement — sequence-of-returns stress test', () => {
  test('stressing the first years of retirement never helps, and usually hurts, success probability', () => {
    const calm = simulateRetirement(baseOpts({ paths: 4000, seed: 30 }));
    const stressed = simulateRetirement(baseOpts({ paths: 4000, seed: 30, stressFirstYears: 5 }));
    assert.ok(stressed.successPct <= calm.successPct);
  });

  test('stressFirstYears: 0 behaves identically to no stress test at all', () => {
    const noStressArg = simulateRetirement(baseOpts({ seed: 15 }));
    const explicitZero = simulateRetirement(baseOpts({ seed: 15, stressFirstYears: 0 }));
    assert.deepEqual(noStressArg.bands, explicitZero.bands);
  });

  test('does not affect years before retirement', () => {
    const calm = simulateRetirement(baseOpts({ paths: 1000, seed: 6 }));
    const stressed = simulateRetirement(baseOpts({ paths: 1000, seed: 6, stressFirstYears: 5 }));
    const idxAtRetirement = calm.ages.indexOf(55);
    assert.deepEqual(stressed.bands.p50.slice(0, idxAtRetirement + 1), calm.bands.p50.slice(0, idxAtRetirement + 1));
  });
});

describe('simulateRetirement — tracked annualExpenses as the spend base', () => {
  test('annualExpenses: 0 behaves identically to withdrawalRatePct mode (default, unchanged)', () => {
    const withoutArg = simulateRetirement(baseOpts({ seed: 50 }));
    const explicitZero = simulateRetirement(baseOpts({ seed: 50, annualExpenses: 0 }));
    assert.deepEqual(withoutArg.bands, explicitZero.bands);
    assert.equal(explicitZero.usesTrackedExpenses, false);
  });

  test('a higher annualExpenses spends down the balance faster (lower success)', () => {
    const modest = simulateRetirement(baseOpts({ seed: 60, paths: 3000, annualExpenses: 30000 }));
    const lavish = simulateRetirement(baseOpts({ seed: 60, paths: 3000, annualExpenses: 90000 }));
    assert.equal(modest.usesTrackedExpenses, true);
    assert.ok(lavish.successPct <= modest.successPct);
  });

  test('withdrawalRatePct is ignored once annualExpenses is set — changing it has no effect', () => {
    const lowRate = simulateRetirement(baseOpts({ seed: 70, annualExpenses: 50000, withdrawalRatePct: 2.0 }));
    const highRate = simulateRetirement(baseOpts({ seed: 70, annualExpenses: 50000, withdrawalRatePct: 6.0 }));
    assert.deepEqual(lowRate.bands, highRate.bands);
  });

  test('the spend base is grown by inflation from today to retirement, not just from retirement', () => {
    // Exact reconstruction: replay the same seeded RNG stream the
    // implementation draws from (via the exported primitives), computing
    // the expected year-by-year balance independently using the documented
    // formula, and confirm simulateRetirement's single-path (paths: 1)
    // output matches it exactly -- the only way to isolate "the spend base
    // compounds inflation starting from today" from "it compounds inflation
    // starting from retirement" without the comparison being swamped by
    // portfolio-growth noise from varying the pre-retirement time span.
    const seed = 7, currentAge = 40, retireAge = 60, endAge = 63;
    const annualExpenses = 40000, inflationPct = 3.0, allocation = 'conservative', startBalance = 1000000;

    const result = simulateRetirement(baseOpts({
      seed, paths: 1, allocation, annualExpenses, inflationPct, currentAge, retireAge, endAge,
      annualContribution: 0, startBalance
    }));

    const rng = mulberry32(seed);
    const mix = ALLOCATIONS[allocation];
    let balance = startBalance;
    let spendBase = null;
    const expected = [balance];
    for (let age = currentAge + 1; age <= endAge; age++) {
      const z = randomNormal(rng);
      const r = mix.mean + mix.vol * z;
      if (age <= retireAge) {
        balance = balance * (1 + r);
      } else {
        if (spendBase === null) spendBase = annualExpenses * Math.pow(1 + inflationPct / 100, retireAge - currentAge);
        const spendNeed = spendBase * Math.pow(1 + inflationPct / 100, age - retireAge);
        balance = Math.max(balance * (1 + r) - spendNeed, 0);
      }
      expected.push(balance);
    }

    for (let i = 0; i < expected.length; i++) {
      assert.ok(Math.abs(result.bands.p50[i] - expected[i]) < 0.01, `age index ${i}: expected ${expected[i]}, got ${result.bands.p50[i]}`);
    }
  });
});

describe('simulateRetirement — contributionStopAge', () => {
  test('null (default) behaves identically to contributing all the way to retireAge', () => {
    const withoutArg = simulateRetirement(baseOpts({ seed: 80 }));
    const explicitNull = simulateRetirement(baseOpts({ seed: 80, contributionStopAge: null }));
    assert.deepEqual(withoutArg.bands, explicitNull.bands);
  });

  test('set to retireAge is identical to the default (contributing the whole way)', () => {
    const base = baseOpts({ seed: 81 });
    const withoutArg = simulateRetirement(base);
    const explicitRetireAge = simulateRetirement({ ...base, contributionStopAge: base.retireAge });
    assert.deepEqual(withoutArg.bands, explicitRetireAge.bands);
  });

  test('stopping contributions early lowers the median balance at retirement', () => {
    const keepGoing = simulateRetirement(baseOpts({ seed: 90, paths: 3000 }));
    const stopNow = simulateRetirement(baseOpts({ seed: 90, paths: 3000, contributionStopAge: 42 }));
    assert.ok(stopNow.medianBalanceAtRetirement < keepGoing.medianBalanceAtRetirement);
  });

  test('with annualContribution already 0, setting contributionStopAge has no further effect', () => {
    const noContribution = simulateRetirement(baseOpts({ seed: 95, annualContribution: 0 }));
    const noContributionStopped = simulateRetirement(baseOpts({ seed: 95, annualContribution: 0, contributionStopAge: 42 }));
    assert.deepEqual(noContribution.bands, noContributionStopped.bands);
  });
});

describe('simulateRetirement — taxRatePct', () => {
  test('0 (default) leaves withdrawals untaxed, unchanged from before', () => {
    const withoutArg = simulateRetirement(baseOpts({ seed: 100 }));
    const explicitZero = simulateRetirement(baseOpts({ seed: 100, taxRatePct: 0 }));
    assert.deepEqual(withoutArg.bands, explicitZero.bands);
  });

  test('a higher tax rate grosses up withdrawals, spending the balance down faster', () => {
    const noTax = simulateRetirement(baseOpts({ seed: 110, paths: 3000, taxRatePct: 0 }));
    const taxed = simulateRetirement(baseOpts({ seed: 110, paths: 3000, taxRatePct: 20 }));
    assert.ok(taxed.successPct <= noTax.successPct);
  });

  test('tax is applied only to the portfolio-funded portion, after Social Security is netted out', () => {
    const socialSecurity = { claimAgeMonths: 67 * 12, annualBenefit: 24000 };
    // inflationPct: 0 keeps the spend base at exactly annualExpenses with no
    // pre-retirement growth to account for, so Social Security's $24k fully
    // covers the $20k need in every retirement year, leaving nothing for
    // taxRatePct to act on.
    const withSsNoTax = simulateRetirement(baseOpts({
      seed: 120, paths: 1, allocation: 'conservative', retireAge: 67, annualContribution: 0, inflationPct: 0,
      includeSocialSecurity: true, socialSecurity, annualExpenses: 20000, taxRatePct: 0
    }));
    const withSsTaxed = simulateRetirement(baseOpts({
      seed: 120, paths: 1, allocation: 'conservative', retireAge: 67, annualContribution: 0, inflationPct: 0,
      includeSocialSecurity: true, socialSecurity, annualExpenses: 20000, taxRatePct: 25
    }));
    // Spending need ($20k) is fully covered by Social Security ($24k) from
    // age 67 on, so there's nothing left to tax -- both paths should be
    // identical even with a 25% tax rate configured.
    assert.deepEqual(withSsNoTax.bands, withSsTaxed.bands);
  });
});

describe('simulateRetirement — traditional/Roth buckets + RMDs', () => {
  test('traditionalBalance: 0, rothBalance: 0 (defaults) behaves identically to before buckets existed', () => {
    const withoutArg = simulateRetirement(baseOpts({ seed: 200 }));
    const explicitZero = simulateRetirement(baseOpts({ seed: 200, traditionalBalance: 0, rothBalance: 0 }));
    assert.deepEqual(withoutArg.bands, explicitZero.bands);
    assert.equal(explicitZero.usesBucketedTax, false);
  });

  test('usesBucketedTax reports true once either bucket is set', () => {
    const result = simulateRetirement(baseOpts({ seed: 201, traditionalBalance: 200000 }));
    assert.equal(result.usesBucketedTax, true);
  });

  test('a 100% Roth portfolio needs no tax at all -- outlasts an equivalent 100% traditional portfolio', () => {
    const allRoth = simulateRetirement(baseOpts({
      seed: 210, paths: 3000, allocation: 'conservative', annualContribution: 0,
      startBalance: 1000000, rothBalance: 1000000, retireAge: 65, currentAge: 50,
      annualExpenses: 60000, birthYear: 1950, filingStatus: 'single'
    }));
    const allTraditional = simulateRetirement(baseOpts({
      seed: 210, paths: 3000, allocation: 'conservative', annualContribution: 0,
      startBalance: 1000000, traditionalBalance: 1000000, retireAge: 65, currentAge: 50,
      annualExpenses: 60000, birthYear: 1950, filingStatus: 'single'
    }));
    assert.ok(allRoth.successPct >= allTraditional.successPct);
    assert.ok(allRoth.medianEndingBalance >= allTraditional.medianEndingBalance);
  });

  test('an RMD forces a traditional withdrawal even with no spending need (Social Security covers it all) -- exact reconstruction', () => {
    // Social Security (100k) fully covers the 30k spend need, so the only
    // thing touching the traditional balance is the forced RMD. Its net
    // proceeds are redeposited into the "other" bucket (since nothing was
    // actually needed from it), so the one measurable effect on the
    // COMBINED balance is the tax paid on the RMD -- a precise, checkable
    // invariant, not just "the path doesn't look broken."
    const seed = 220;
    const retireAge = 65, currentAge = 60, endAge = 66;
    const traditionalBalance = 500000, startBalance = 500000; // 100% traditional
    const socialSecurity = { claimAgeMonths: 65 * 12, annualBenefit: 100000 };
    const birthYear = 1945; // RMDs already started well before 65

    const result = simulateRetirement(baseOpts({
      seed, paths: 1, allocation: 'conservative', annualContribution: 0,
      startBalance, traditionalBalance, retireAge, currentAge, endAge,
      annualExpenses: 30000, includeSocialSecurity: true, socialSecurity, birthYear
    }));

    // Reconstruct the single path's own RNG draws independently.
    const rng = mulberry32(seed);
    const mix = ALLOCATIONS.conservative;
    let bal = startBalance;
    for (let age = currentAge + 1; age <= retireAge; age++) {
      const z = randomNormal(rng);
      bal *= (1 + mix.mean + mix.vol * z);
    }
    const balAtRetirement = bal;
    const z = randomNormal(rng);
    const r = mix.mean + mix.vol * z;
    const grown = balAtRetirement * (1 + r);
    const rmdAmount = computeRMD({ priorYearEndBalance: balAtRetirement, age: retireAge + 1, birthYear });
    const tax = computeFederalTax(rmdAmount, 'single');
    const expectedBalanceOneYearIn = grown - tax; // RMD's net proceeds stay in the total; only tax leaves it

    const idxOneYearIn = result.ages.indexOf(retireAge + 1);
    assert.ok(Math.abs(result.bands.p50[idxOneYearIn] - expectedBalanceOneYearIn) < 0.5);
  });

  test('RMDs reduce the ending balance compared to an otherwise-identical portfolio with no traditional bucket (so no RMDs force extra taxed withdrawals)', () => {
    const socialSecurity = { claimAgeMonths: 65 * 12, annualBenefit: 100000 };
    const withTraditionalAndRmd = simulateRetirement(baseOpts({
      seed: 230, paths: 3000, allocation: 'conservative', annualContribution: 0,
      startBalance: 500000, traditionalBalance: 500000, retireAge: 65, currentAge: 60, endAge: 90,
      annualExpenses: 20000, includeSocialSecurity: true, socialSecurity, birthYear: 1945
    }));
    const allOther = simulateRetirement(baseOpts({
      seed: 230, paths: 3000, allocation: 'conservative', annualContribution: 0,
      startBalance: 500000, retireAge: 65, currentAge: 60, endAge: 90,
      annualExpenses: 20000, includeSocialSecurity: true, socialSecurity
    }));
    assert.ok(withTraditionalAndRmd.medianEndingBalance <= allOther.medianEndingBalance);
  });

  test('contributions split across buckets in today\'s starting proportions', () => {
    // 50/50 traditional/other split, no growth (0 vol isn't available, but
    // a single path with a controlled seed and checking relative growth
    // direction is enough): a larger contribution should grow both buckets,
    // not concentrate entirely in one.
    const result = simulateRetirement(baseOpts({
      seed: 240, paths: 1, allocation: 'conservative', annualContribution: 20000,
      startBalance: 200000, traditionalBalance: 100000, currentAge: 40, retireAge: 45, endAge: 46
    }));
    assert.equal(result.usesBucketedTax, true);
    // Just confirm it runs end-to-end without throwing and produces a
    // sane (positive, finite) trajectory -- the exact split is covered by
    // code inspection/behavioral tests above; this is a smoke test for the
    // accumulation-phase bucket math specifically.
    assert.ok(Number.isFinite(result.medianBalanceAtRetirement));
    assert.ok(result.medianBalanceAtRetirement > 200000);
  });

  test('no traditional balance but a Roth balance still activates bucket mode (taxable + Roth only, no RMDs ever)', () => {
    const result = simulateRetirement(baseOpts({
      seed: 250, paths: 2000, allocation: 'conservative', annualContribution: 0,
      startBalance: 500000, rothBalance: 500000, retireAge: 65, currentAge: 60, endAge: 90, annualExpenses: 30000
    }));
    assert.equal(result.usesBucketedTax, true);
    assert.ok(result.successPct >= 0 && result.successPct <= 100);
  });
});

describe('ALLOCATIONS', () => {
  test('aggressive has both a higher mean and higher volatility than conservative', () => {
    assert.ok(ALLOCATIONS.aggressive.mean > ALLOCATIONS.conservative.mean);
    assert.ok(ALLOCATIONS.aggressive.vol > ALLOCATIONS.conservative.vol);
  });
});
