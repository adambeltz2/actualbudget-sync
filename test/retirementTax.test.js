const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeFederalTax, solveGrossTraditionalWithdrawal, rmdStartAge, rmdDivisor, computeRMD,
  grossUpAnnualNeed, STANDARD_DEDUCTION, UNIFORM_LIFETIME_DIVISORS
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

describe('grossUpAnnualNeed', () => {
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
