const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { simulateRetirement, ALLOCATIONS } = require('../src/monteCarlo');
const { buildMonteCarloPdf, fmtShort, fmtFull } = require('../src/monteCarloReport');

function scenarioFor(allocation, overrides = {}) {
  return {
    allocationMean: ALLOCATIONS[allocation].mean,
    allocationVol: ALLOCATIONS[allocation].vol,
    inflationPct: 3.0,
    withdrawalRatePct: 3.8,
    ...overrides
  };
}

describe('fmtShort / fmtFull', () => {
  test('fmtShort abbreviates millions and thousands', () => {
    assert.equal(fmtShort(1400000), '$1.4M');
    assert.equal(fmtShort(54000), '$54K');
    assert.equal(fmtShort(500), '$500');
  });
  test('fmtFull adds thousands separators', () => {
    assert.equal(fmtFull(1234567), '$1,234,567');
  });
});

describe('buildMonteCarloPdf', () => {
  test('produces a well-formed PDF buffer', async () => {
    const result = simulateRetirement({
      startBalance: 400000, currentAge: 42, retireAge: 55, annualContribution: 20000,
      allocation: 'moderate', inflationPct: 3, withdrawalRatePct: 3.8, paths: 500, seed: 1
    });
    const pdf = await buildMonteCarloPdf({ result, scenario: scenarioFor('moderate'), generatedAt: new Date('2026-10-08') });
    assert.ok(Buffer.isBuffer(pdf));
    assert.equal(pdf.slice(0, 5).toString('ascii'), '%PDF-');
    assert.ok(pdf.includes('%%EOF'));
    assert.ok(pdf.length > 1000, `expected a non-trivial PDF, got ${pdf.length} bytes`);
  });

  test('does not throw for a scenario with Social Security, pension, and a one-time expense', async () => {
    const result = simulateRetirement({
      startBalance: 400000, currentAge: 42, retireAge: 55, annualContribution: 20000,
      allocation: 'aggressive', inflationPct: 4, withdrawalRatePct: 4.5, paths: 500, seed: 2,
      includeSocialSecurity: true, socialSecurity: { claimAgeMonths: 67 * 12, annualBenefit: 24000 },
      pensionMonthly: 1500, oneTimeExpense: 50000, glidepath: true, survivor: true
    });
    const pdf = await buildMonteCarloPdf({ result, scenario: scenarioFor('aggressive', { inflationPct: 4, withdrawalRatePct: 4.5 }) });
    assert.equal(pdf.slice(0, 5).toString('ascii'), '%PDF-');
  });
});
