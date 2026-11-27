const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeFederalTax, solveGrossTraditionalWithdrawal, rmdStartAge, rmdDivisor, computeRMD,
  computeBucketShares, grossUpAnnualNeed, STANDARD_DEDUCTION, UNIFORM_LIFETIME_DIVISORS
} = require('../src/retirementTax');

describe('computeFederalTax', () => {
  test('income at or below the standard deduction owes zero tax', () => {
    assert.equal(computeFederalTax(10000, 'single'), 0);
    assert.equal(computeFederalTax(STANDARD_DEDUCTION.single, 'single'), 0);
  });

  test('a single filer entirely in the 10% bracket', () => {
    // 16100 (deduction) + 5000 taxable, all within the 10% bracket (up to 12400).
    const tax = computeFederalTax(16100 + 5000, 'single');
    assert.ok(Math.abs(tax - 500) < 0.01);
  });

  test('a single filer spanning two brackets pays the marginal rate on each slice', () => {
    // Taxable income of 20000: 12400 at 10% + 7600 at 12%.
    const tax = computeFederalTax(16100 + 20000, 'single');
    const expected = 12400 * 0.10 + 7600 * 0.12;
    assert.ok(Math.abs(tax - expected) < 0.01);
  });

  test('married filing jointly uses its own wider brackets and deduction', () => {
    const singleTax = computeFederalTax(100000, 'single');
    const marriedTax = computeFederalTax(100000, 'marriedJointly');
    assert.ok(marriedTax < singleTax, 'the same income should owe less tax filing jointly');
  });

  test('an unrecognized filing status falls back to single', () => {
    const fallback = computeFederalTax(80000, 'not-a-real-status');
    const single = computeFederalTax(80000, 'single');
    assert.equal(fallback, single);
  });

  test('defaults to single when filingStatus is omitted', () => {
    const withoutArg = computeFederalTax(80000);
    const single = computeFederalTax(80000, 'single');
    assert.equal(withoutArg, single);
  });

  test('tax owed is monotonically non-decreasing with income', () => {
    const incomes = [0, 10000, 20000, 50000, 100000, 200000, 500000, 1000000];
    for (let i = 1; i < incomes.length; i++) {
      assert.ok(computeFederalTax(incomes[i], 'single') >= computeFederalTax(incomes[i - 1], 'single'));
    }
  });

  test('a very high income is taxed at the top marginal rate on the tail', () => {
    const tax1 = computeFederalTax(1000000, 'single');
    const tax2 = computeFederalTax(1000001, 'single');
    assert.ok(Math.abs((tax2 - tax1) - 0.37) < 0.001);
  });
});

describe('solveGrossTraditionalWithdrawal', () => {
  test('zero (or negative) net need requires zero gross withdrawal', () => {
    assert.equal(solveGrossTraditionalWithdrawal({ netAmountNeeded: 0, filingStatus: 'single' }), 0);
    assert.equal(solveGrossTraditionalWithdrawal({ netAmountNeeded: -100, filingStatus: 'single' }), 0);
  });

  test('is the inverse of computeFederalTax: feeding the result back in nets the target amount', () => {
    const netAmountNeeded = 60000;
    const gross = solveGrossTraditionalWithdrawal({ netAmountNeeded, filingStatus: 'single' });
    const actualNet = gross - computeFederalTax(gross, 'single');
    assert.ok(Math.abs(actualNet - netAmountNeeded) < 0.05);
  });

  test('a small net need entirely under the standard deduction solves to itself (no tax owed)', () => {
    const gross = solveGrossTraditionalWithdrawal({ netAmountNeeded: 5000, filingStatus: 'single' });
    assert.ok(Math.abs(gross - 5000) < 0.05);
  });

  test('converges correctly for a large net need spanning several brackets', () => {
    const netAmountNeeded = 500000;
    const gross = solveGrossTraditionalWithdrawal({ netAmountNeeded, filingStatus: 'single' });
    const actualNet = gross - computeFederalTax(gross, 'single');
    assert.ok(Math.abs(actualNet - netAmountNeeded) < 0.1);
  });

  test('married filing jointly requires a smaller gross withdrawal for the same net need', () => {
    const netAmountNeeded = 80000;
    const singleGross = solveGrossTraditionalWithdrawal({ netAmountNeeded, filingStatus: 'single' });
    const marriedGross = solveGrossTraditionalWithdrawal({ netAmountNeeded, filingStatus: 'marriedJointly' });
    assert.ok(marriedGross < singleGross);
  });
});

describe('rmdStartAge', () => {
  test('73 for anyone born 1959 or earlier', () => {
    assert.equal(rmdStartAge(1950), 73);
    assert.equal(rmdStartAge(1959), 73);
  });

  test('75 for anyone born 1960 or later', () => {
    assert.equal(rmdStartAge(1960), 75);
    assert.equal(rmdStartAge(1990), 75);
  });
});

describe('rmdDivisor', () => {
  test('matches known published values from the Uniform Lifetime Table', () => {
    assert.equal(rmdDivisor(72), 27.4);
    assert.equal(rmdDivisor(73), 26.5);
    assert.equal(rmdDivisor(75), 24.6);
    assert.equal(rmdDivisor(80), 20.2);
    assert.equal(rmdDivisor(100), 6.4);
    assert.equal(rmdDivisor(120), 2.0);
  });

  test('clamps below 72 to the age-72 divisor and above 120 to the age-120 divisor', () => {
    assert.equal(rmdDivisor(50), UNIFORM_LIFETIME_DIVISORS[72]);
    assert.equal(rmdDivisor(150), UNIFORM_LIFETIME_DIVISORS[120]);
  });

  test('divisors decrease monotonically with age (older = smaller divisor = bigger RMD share)', () => {
    for (let age = 73; age <= 120; age++) {
      assert.ok(rmdDivisor(age) <= rmdDivisor(age - 1));
    }
  });
});

describe('computeRMD', () => {
  test('zero before the start age, regardless of balance', () => {
    assert.equal(computeRMD({ priorYearEndBalance: 500000, age: 72, birthYear: 1959 }), 0);
    assert.equal(computeRMD({ priorYearEndBalance: 500000, age: 74, birthYear: 1965 }), 0);
  });

  test('zero with no balance, even past the start age', () => {
    assert.equal(computeRMD({ priorYearEndBalance: 0, age: 80, birthYear: 1950 }), 0);
  });

  test('matches a known calculation at the start age', () => {
    // Born 1959 -> RMD starts at 73, divisor 26.5.
    const rmd = computeRMD({ priorYearEndBalance: 265000, age: 73, birthYear: 1959 });
    assert.ok(Math.abs(rmd - 10000) < 0.01);
  });

  test('a larger balance produces a proportionally larger RMD at the same age', () => {
    const small = computeRMD({ priorYearEndBalance: 100000, age: 80, birthYear: 1950 });
    const large = computeRMD({ priorYearEndBalance: 200000, age: 80, birthYear: 1950 });
    assert.ok(Math.abs(large - small * 2) < 0.01);
  });

  test('the RMD share of balance grows with age (shrinking divisor)', () => {
    const at75 = computeRMD({ priorYearEndBalance: 1000000, age: 75, birthYear: 1950 });
    const at90 = computeRMD({ priorYearEndBalance: 1000000, age: 90, birthYear: 1950 });
    assert.ok(at90 > at75);
  });
});

describe('computeBucketShares', () => {
  test('a zero or negative total balance gives all weight to "other" (same as no buckets)', () => {
    assert.deepEqual(computeBucketShares({ traditionalBalance: 50000, rothBalance: 50000, totalBalance: 0 }),
      { traditionalShare: 0, rothShare: 0, otherShare: 1 });
  });

  test('ordinary case: shares equal each balance\'s plain ratio and sum to 1', () => {
    const { traditionalShare, rothShare, otherShare } = computeBucketShares({
      traditionalBalance: 300000, rothBalance: 200000, totalBalance: 1000000
    });
    assert.ok(Math.abs(traditionalShare - 0.3) < 1e-9);
    assert.ok(Math.abs(rothShare - 0.2) < 1e-9);
    assert.ok(Math.abs(otherShare - 0.5) < 1e-9);
    assert.ok(Math.abs((traditionalShare + rothShare + otherShare) - 1) < 1e-9);
  });

  test('a single tagged bucket bigger than the total (untagged debt drags net worth down) still sums to 1', () => {
    // 100k traditional tagged, but net worth is only 90k because of 10k of
    // untagged debt sitting elsewhere -- traditionalBalance/totalBalance
    // alone would be 1.11, more than 100%.
    const { traditionalShare, rothShare, otherShare } = computeBucketShares({
      traditionalBalance: 100000, rothBalance: 0, totalBalance: 90000
    });
    assert.equal(traditionalShare, 1);
    assert.equal(rothShare, 0);
    assert.equal(otherShare, 0);
  });

  test('two tagged buckets together bigger than the total: shares are scaled down proportionally, not just clamped', () => {
    // 70k traditional + 60k Roth tagged (130k), but net worth is only 100k
    // because of 30k of untagged debt -- each individual ratio (0.7, 0.6)
    // is under 1 on its own, so clamping each alone wouldn't catch this;
    // their sum (1.3) is what has to be caught and rescaled.
    const { traditionalShare, rothShare, otherShare } = computeBucketShares({
      traditionalBalance: 70000, rothBalance: 60000, totalBalance: 100000
    });
    assert.ok(Math.abs(traditionalShare - (0.7 / 1.3)) < 1e-9);
    assert.ok(Math.abs(rothShare - (0.6 / 1.3)) < 1e-9);
    assert.equal(otherShare, 0);
    assert.ok(Math.abs((traditionalShare + rothShare + otherShare) - 1) < 1e-9);
  });

  test('negative tagged balances (shouldn\'t happen in practice, but) floor to 0 rather than going negative', () => {
    const { traditionalShare, rothShare } = computeBucketShares({
      traditionalBalance: -5000, rothBalance: 50000, totalBalance: 100000
    });
    assert.equal(traditionalShare, 0);
    assert.ok(Math.abs(rothShare - 0.5) < 1e-9);
  });
});

describe('grossUpAnnualNeed', () => {
  test('with untagged debt dragging net worth below the tagged total, the gross-up no longer overstates the need (regression)', () => {
    // Same scenario as computeBucketShares' proportional-scaling test above,
    // fed through the full gross-up: before the fix, each share was clamped
    // to [0,1] independently, so their sum (1.3) silently over-allocated
    // more than 100% of the need across the two tagged buckets.
    const result = grossUpAnnualNeed({
      netAnnualNeed: 40000, traditionalBalance: 70000, rothBalance: 60000, netWorth: 100000, filingStatus: 'single'
    });
    const traditionalPortion = 40000 * (70000 / 130000);
    const rothPortion = 40000 * (60000 / 130000);
    const expected = solveGrossTraditionalWithdrawal({ netAmountNeeded: traditionalPortion, filingStatus: 'single' }) + rothPortion;
    assert.ok(Math.abs(result - expected) < 0.01);
    // The old, buggy behavior independently clamped each share to 1,
    // leaving their sum at 1.3 -- which taxed/grossed-up 30% more need
    // than was actually asked for. Confirm this comes out meaningfully
    // lower than that.
    assert.ok(result < 40000 * 1.3);
  });


  test('with no netWorth data at all, falls back to the flat rate exactly as before bucket tagging existed', () => {
    const withoutRate = grossUpAnnualNeed({ netAnnualNeed: 40000 });
    assert.equal(withoutRate, 40000);
    const withRate = grossUpAnnualNeed({ netAnnualNeed: 40000, flatTaxRatePct: 20 });
    assert.ok(Math.abs(withRate - 50000) < 0.01);
  });

  test('100% traditional balance grosses the whole need through real brackets', () => {
    const result = grossUpAnnualNeed({
      netAnnualNeed: 60000, traditionalBalance: 1000000, rothBalance: 0, netWorth: 1000000, filingStatus: 'single'
    });
    const expected = solveGrossTraditionalWithdrawal({ netAmountNeeded: 60000, filingStatus: 'single' });
    assert.ok(Math.abs(result - expected) < 0.01);
  });

  test('100% Roth balance needs no gross-up at all', () => {
    const result = grossUpAnnualNeed({
      netAnnualNeed: 60000, traditionalBalance: 0, rothBalance: 1000000, netWorth: 1000000, filingStatus: 'single'
    });
    assert.ok(Math.abs(result - 60000) < 0.01);
  });

  test('an untagged remainder (netWorth beyond traditional+Roth) keeps the flat-rate treatment', () => {
    // 500k traditional, 500k untagged, out of 1M net worth -- 50% of the
    // need goes through brackets, the other 50% through the flat rate.
    const result = grossUpAnnualNeed({
      netAnnualNeed: 40000, traditionalBalance: 500000, rothBalance: 0, netWorth: 1000000,
      filingStatus: 'single', flatTaxRatePct: 20
    });
    const traditionalShareGross = solveGrossTraditionalWithdrawal({ netAmountNeeded: 20000, filingStatus: 'single' });
    const otherShareGross = 20000 / 0.8;
    assert.ok(Math.abs(result - (traditionalShareGross + otherShareGross)) < 0.01);
  });

  test('a mix of all three buckets sums each bucket\'s own treatment', () => {
    // 40% traditional, 40% Roth, 20% untagged (flat 15%).
    const result = grossUpAnnualNeed({
      netAnnualNeed: 50000, traditionalBalance: 400000, rothBalance: 400000, netWorth: 1000000,
      filingStatus: 'marriedJointly', flatTaxRatePct: 15
    });
    const traditionalGross = solveGrossTraditionalWithdrawal({ netAmountNeeded: 20000, filingStatus: 'marriedJointly' });
    const rothGross = 20000;
    const otherGross = 10000 / 0.85;
    assert.ok(Math.abs(result - (traditionalGross + rothGross + otherGross)) < 0.01);
  });

  test('zero or negative net need requires no gross-up', () => {
    assert.equal(grossUpAnnualNeed({ netAnnualNeed: 0, traditionalBalance: 100000, netWorth: 100000 }), 0);
    assert.equal(grossUpAnnualNeed({ netAnnualNeed: -500, traditionalBalance: 100000, netWorth: 100000 }), 0);
  });

  test('a higher traditional share always requires a bigger gross withdrawal (brackets never beat 0% tax)', () => {
    const mostlyRoth = grossUpAnnualNeed({
      netAnnualNeed: 60000, traditionalBalance: 100000, rothBalance: 900000, netWorth: 1000000, filingStatus: 'single'
    });
    const mostlyTraditional = grossUpAnnualNeed({
      netAnnualNeed: 60000, traditionalBalance: 900000, rothBalance: 100000, netWorth: 1000000, filingStatus: 'single'
    });
    assert.ok(mostlyTraditional > mostlyRoth);
  });
});
