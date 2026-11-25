const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ageInMonths, resolveSocialSecurityClaim, computeFireTargetAtAge, monthsToReachFireTarget } = require('../src/socialSecurity');

describe('ageInMonths', () => {
  test('computes whole months between a birthdate and an as-of date', () => {
    assert.equal(ageInMonths('1990-03-15', new Date('2026-09-15')), 36 * 12 + 6);
  });

  test('rounds down when the as-of day hasn\'t reached the birth day yet this month', () => {
    assert.equal(ageInMonths('1990-03-15', new Date('2026-09-10')), 36 * 12 + 5);
  });

  test('never returns negative months for a birthdate in the future', () => {
    assert.equal(ageInMonths('2030-01-01', new Date('2026-09-15')), 0);
  });
});

describe('resolveSocialSecurityClaim', () => {
  test('resolves age 62 to 744 months and an annualized benefit', () => {
    const claim = resolveSocialSecurityClaim({ claimingChoice: 'age62', age62MonthlyBenefit: 1500 });
    assert.deepEqual(claim, { claimAgeMonths: 744, annualBenefit: 18000 });
  });

  test('resolves age 70 to 840 months', () => {
    const claim = resolveSocialSecurityClaim({ claimingChoice: 'age70', age70MonthlyBenefit: 2800 });
    assert.equal(claim.claimAgeMonths, 840);
    assert.equal(claim.annualBenefit, 33600);
  });

  test('resolves FRA from separate years/months fields (e.g. 66y10m)', () => {
    const claim = resolveSocialSecurityClaim({
      claimingChoice: 'fra', fraAgeYears: 66, fraAgeMonths: 10, fraMonthlyBenefit: 2100
    });
    assert.equal(claim.claimAgeMonths, 66 * 12 + 10);
    assert.equal(claim.annualBenefit, 25200);
  });

  test('returns null when the chosen claim\'s benefit amount is missing', () => {
    assert.equal(resolveSocialSecurityClaim({ claimingChoice: 'age62' }), null);
  });

  test('returns null when FRA age fields are missing', () => {
    assert.equal(resolveSocialSecurityClaim({ claimingChoice: 'fra', fraMonthlyBenefit: 2100 }), null);
  });

  test('returns null for an unrecognized claiming choice', () => {
    assert.equal(resolveSocialSecurityClaim({ claimingChoice: '', age62MonthlyBenefit: 1500 }), null);
  });
});

describe('computeFireTargetAtAge', () => {
  test('matches the plain 25x-style target when Social Security is not set', () => {
    const target = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity: null });
    assert.equal(target, 1000000);
  });

  test('reduces the target to only the benefit-offset remainder once past the claim age', () => {
    const socialSecurity = { claimAgeMonths: 744, annualBenefit: 18000 };
    // Already 5 years past the claim age — no bridge needed.
    const target = computeFireTargetAtAge({ ageMonths: 744 + 60, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity });
    assert.equal(target, (40000 - 18000) * 25);
  });

  test('adds a bridge cost on top of the reduced target before the claim age', () => {
    const socialSecurity = { claimAgeMonths: 744, annualBenefit: 18000 };
    // 5 years (60 months) before the claim age.
    const target = computeFireTargetAtAge({ ageMonths: 744 - 60, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity });
    const expectedPostClaim = (40000 - 18000) * 25;
    const expectedBridge = 40000 * 5;
    assert.equal(target, expectedPostClaim + expectedBridge);
  });

  test('floors the post-claim expenses at zero when the benefit exceeds annual expenses', () => {
    const socialSecurity = { claimAgeMonths: 744, annualBenefit: 60000 };
    const target = computeFireTargetAtAge({ ageMonths: 800, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity });
    assert.equal(target, 0);
  });

  describe('taxRatePct', () => {
    test('defaults to 0 (no gross-up), unchanged from before this existed', () => {
      const withoutArg = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity: null });
      const explicitZero = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 0 });
      assert.equal(withoutArg, explicitZero);
    });

    test('grosses up the no-Social-Security target by 1 / (1 - taxRate)', () => {
      const target = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 20 });
      assert.equal(target, (40000 / 0.8) * 25);
    });

    test('grosses up the bridge cost, and grosses up the SS-offset remainder (SS nets out of raw expenses first)', () => {
      const socialSecurity = { claimAgeMonths: 744, annualBenefit: 18000 };
      const target = computeFireTargetAtAge({ ageMonths: 744 - 60, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity, taxRatePct: 15 });
      const expectedPostClaim = ((40000 - 18000) / 0.85) * 25;
      const expectedBridge = (40000 / 0.85) * 5;
      assert.ok(Math.abs(target - (expectedPostClaim + expectedBridge)) < 1e-6);
    });

    test('a higher tax rate always raises the target, holding everything else equal', () => {
      const noTax = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 50000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 0 });
      const taxed = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 50000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 25 });
      assert.ok(taxed > noTax);
    });
  });

  describe('taxBuckets', () => {
    test('omitted (null, the default) behaves identically to the flat-rate-only path', () => {
      const withoutBuckets = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 50000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 20 });
      const explicitNull = computeFireTargetAtAge({ ageMonths: 500, annualExpenses: 50000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 20, taxBuckets: null });
      assert.equal(withoutBuckets, explicitNull);
    });

    test('an all-Roth household needs exactly the untaxed 25x target, even with a flat tax rate configured', () => {
      const target = computeFireTargetAtAge({
        ageMonths: 500, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 20,
        taxBuckets: { traditionalBalance: 0, rothBalance: 1000000, netWorth: 1000000, filingStatus: 'single' }
      });
      assert.ok(Math.abs(target - 40000 * 25) < 1);
    });

    test('an all-traditional household needs more than the flat-rate target once real brackets apply at a high enough spend', () => {
      // At a large enough annualExpenses, real marginal brackets exceed a
      // modest flat rate, so the bucket-aware target should come out higher.
      const flatRateTarget = computeFireTargetAtAge({
        ageMonths: 500, annualExpenses: 150000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 15
      });
      const bucketTarget = computeFireTargetAtAge({
        ageMonths: 500, annualExpenses: 150000, withdrawalRatePct: 4, socialSecurity: null, taxRatePct: 15,
        taxBuckets: { traditionalBalance: 1000000, rothBalance: 0, netWorth: 1000000, filingStatus: 'single' }
      });
      assert.ok(bucketTarget > flatRateTarget);
    });

    test('taxBuckets also applies to the Social Security bridge and post-claim remainder', () => {
      const socialSecurity = { claimAgeMonths: 744, annualBenefit: 18000 };
      const taxBuckets = { traditionalBalance: 1000000, rothBalance: 0, netWorth: 1000000, filingStatus: 'single' };
      const target = computeFireTargetAtAge({
        ageMonths: 744 - 60, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity, taxBuckets
      });
      const noBucketsTarget = computeFireTargetAtAge({
        ageMonths: 744 - 60, annualExpenses: 40000, withdrawalRatePct: 4, socialSecurity
      });
      // 100% traditional with real brackets should cost more than the
      // untaxed baseline (no flat rate, no buckets).
      assert.ok(target > noBucketsTarget);
    });
  });
});

describe('monthsToReachFireTarget', () => {
  test('behaves identically to a fixed-target search when Social Security is not set', () => {
    const months = monthsToReachFireTarget({
      currentBalance: 0, monthlyContribution: 1000, annualReturnRate: 0,
      annualExpenses: 12000, withdrawalRatePct: 4, currentAgeMonths: null, socialSecurity: null
    });
    // Target is 300000 with no growth: 300 months of $1000 contributions.
    assert.equal(months, 300);
  });

  test('reaching FIRE sooner requires less money when the bridge to Social Security has nearly closed', () => {
    const socialSecurity = { claimAgeMonths: 800, annualBenefit: 20000 };
    const withSS = monthsToReachFireTarget({
      currentBalance: 400000, monthlyContribution: 2000, annualReturnRate: 0,
      annualExpenses: 40000, withdrawalRatePct: 4, currentAgeMonths: 790, socialSecurity
    });
    const withoutSS = monthsToReachFireTarget({
      currentBalance: 400000, monthlyContribution: 2000, annualReturnRate: 0,
      annualExpenses: 40000, withdrawalRatePct: 4, currentAgeMonths: 790, socialSecurity: null
    });
    assert.ok(withSS < withoutSS, 'Social Security should shorten (or match) the time to reach FIRE, never lengthen it');
  });

  test('taxRatePct defaults to 0, unchanged from before it existed', () => {
    const withoutArg = monthsToReachFireTarget({
      currentBalance: 0, monthlyContribution: 1000, annualReturnRate: 0,
      annualExpenses: 12000, withdrawalRatePct: 4, currentAgeMonths: null, socialSecurity: null
    });
    const explicitZero = monthsToReachFireTarget({
      currentBalance: 0, monthlyContribution: 1000, annualReturnRate: 0,
      annualExpenses: 12000, withdrawalRatePct: 4, currentAgeMonths: null, socialSecurity: null, taxRatePct: 0
    });
    assert.equal(withoutArg, explicitZero);
  });

  test('a higher tax rate raises the target, so it takes at least as long to reach it', () => {
    const noTax = monthsToReachFireTarget({
      currentBalance: 0, monthlyContribution: 1000, annualReturnRate: 0,
      annualExpenses: 12000, withdrawalRatePct: 4, currentAgeMonths: null, socialSecurity: null, taxRatePct: 0
    });
    const taxed = monthsToReachFireTarget({
      currentBalance: 0, monthlyContribution: 1000, annualReturnRate: 0,
      annualExpenses: 12000, withdrawalRatePct: 4, currentAgeMonths: null, socialSecurity: null, taxRatePct: 20
    });
    assert.ok(taxed > noTax);
  });
});
