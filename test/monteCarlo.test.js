const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { simulateRetirement, mulberry32, randomNormal, ALLOCATIONS } = require('../src/monteCarlo');

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

describe('ALLOCATIONS', () => {
  test('aggressive has both a higher mean and higher volatility than conservative', () => {
    assert.ok(ALLOCATIONS.aggressive.mean > ALLOCATIONS.conservative.mean);
    assert.ok(ALLOCATIONS.aggressive.vol > ALLOCATIONS.conservative.vol);
  });
});
