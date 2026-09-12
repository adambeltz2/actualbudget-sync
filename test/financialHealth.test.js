const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeEmergencyFund, computeSavingsRate, computeDebtLoad,
  computeOverallScore, buildRecommendations, computeNetWorthBreakdown
} = require('../src/financialHealth');

describe('computeEmergencyFund', () => {
  test('meeting the target reads as good', () => {
    const result = computeEmergencyFund({ liquidBalance: 12000, monthlyAvgSpend: 2000, targetMonths: 6 });
    assert.equal(result.months, 6);
    assert.equal(result.pctOfTarget, 100);
    assert.equal(result.status, 'good');
  });

  test('halfway to target reads as watch', () => {
    const result = computeEmergencyFund({ liquidBalance: 6000, monthlyAvgSpend: 2000, targetMonths: 6 });
    assert.equal(result.months, 3);
    assert.equal(result.status, 'watch');
  });

  test('well below target reads as action', () => {
    const result = computeEmergencyFund({ liquidBalance: 1000, monthlyAvgSpend: 2000, targetMonths: 6 });
    assert.equal(result.status, 'action');
  });

  test('pctOfTarget never exceeds 100 even with a large surplus', () => {
    const result = computeEmergencyFund({ liquidBalance: 50000, monthlyAvgSpend: 2000, targetMonths: 6 });
    assert.equal(result.pctOfTarget, 100);
  });

  test('zero monthly spend does not divide by zero', () => {
    const result = computeEmergencyFund({ liquidBalance: 5000, monthlyAvgSpend: 0, targetMonths: 6 });
    assert.equal(result.months, 0);
    assert.ok(Number.isFinite(result.pctOfTarget));
  });
});

describe('computeSavingsRate', () => {
  test('meeting the target reads as good', () => {
    const result = computeSavingsRate({ income: 5000, spend: 4000, targetPct: 20 });
    assert.equal(result.ratePct, 20);
    assert.equal(result.status, 'good');
  });

  test('positive but below target reads as watch', () => {
    const result = computeSavingsRate({ income: 5000, spend: 4500, targetPct: 20 });
    assert.equal(result.status, 'watch');
  });

  test('spending more than earned reads as action, not watch', () => {
    const result = computeSavingsRate({ income: 4000, spend: 5000, targetPct: 20 });
    assert.ok(result.ratePct < 0);
    assert.equal(result.status, 'action');
  });

  test('a negative rate does not produce a negative pctOfTarget', () => {
    const result = computeSavingsRate({ income: 4000, spend: 5000, targetPct: 20 });
    assert.equal(result.pctOfTarget, 0);
  });

  test('zero income does not divide by zero', () => {
    const result = computeSavingsRate({ income: 0, spend: 0, targetPct: 20 });
    assert.equal(result.ratePct, 0);
  });
});

describe('computeDebtLoad', () => {
  test('no debt reads as good', () => {
    const result = computeDebtLoad({ debtTotal: 0, monthlyIncome: 5000 });
    assert.equal(result.status, 'good');
    assert.equal(result.monthsOfIncome, 0);
  });

  test('debt under one month of income reads as watch', () => {
    const result = computeDebtLoad({ debtTotal: 2000, monthlyIncome: 5000 });
    assert.equal(result.status, 'watch');
  });

  test('debt exceeding one month of income reads as action', () => {
    const result = computeDebtLoad({ debtTotal: 8000, monthlyIncome: 5000 });
    assert.equal(result.status, 'action');
  });

  test('zero income does not divide by zero', () => {
    const result = computeDebtLoad({ debtTotal: 1000, monthlyIncome: 0 });
    assert.equal(result.monthsOfIncome, 0);
  });
});

describe('computeOverallScore', () => {
  test('all three metrics healthy scores near 100', () => {
    const emergencyFund = computeEmergencyFund({ liquidBalance: 12000, monthlyAvgSpend: 2000, targetMonths: 6 });
    const savingsRate = computeSavingsRate({ income: 5000, spend: 4000, targetPct: 20 });
    const debtLoad = computeDebtLoad({ debtTotal: 0, monthlyIncome: 5000 });
    const { overall, label } = computeOverallScore({ emergencyFund, savingsRate, debtLoad });
    assert.equal(overall, 100);
    assert.equal(label, 'Strong');
  });

  test('all three metrics failing scores low', () => {
    const emergencyFund = computeEmergencyFund({ liquidBalance: 0, monthlyAvgSpend: 2000, targetMonths: 6 });
    const savingsRate = computeSavingsRate({ income: 4000, spend: 5000, targetPct: 20 });
    const debtLoad = computeDebtLoad({ debtTotal: 20000, monthlyIncome: 4000 });
    const { overall, label } = computeOverallScore({ emergencyFund, savingsRate, debtLoad });
    assert.ok(overall < 40);
    assert.equal(label, 'Needs Attention');
  });

  test('score is always between 0 and 100', () => {
    const emergencyFund = computeEmergencyFund({ liquidBalance: 0, monthlyAvgSpend: 2000, targetMonths: 6 });
    const savingsRate = computeSavingsRate({ income: 1000, spend: 9000, targetPct: 20 });
    const debtLoad = computeDebtLoad({ debtTotal: 100000, monthlyIncome: 1000 });
    const { overall } = computeOverallScore({ emergencyFund, savingsRate, debtLoad });
    assert.ok(overall >= 0 && overall <= 100);
  });
});

describe('buildRecommendations', () => {
  test('flags only the metrics that are not good', () => {
    const emergencyFund = computeEmergencyFund({ liquidBalance: 12000, monthlyAvgSpend: 2000, targetMonths: 6 }); // good
    const savingsRate = computeSavingsRate({ income: 5000, spend: 4800, targetPct: 20 }); // watch
    const debtLoad = computeDebtLoad({ debtTotal: 0, monthlyIncome: 5000 }); // good, no debt
    const recs = buildRecommendations({ emergencyFund, savingsRate, debtLoad });
    assert.equal(recs.length, 1);
    assert.match(recs[0].message, /saving/);
  });

  test('reports all healthy when nothing needs attention', () => {
    const emergencyFund = computeEmergencyFund({ liquidBalance: 12000, monthlyAvgSpend: 2000, targetMonths: 6 });
    const savingsRate = computeSavingsRate({ income: 5000, spend: 4000, targetPct: 20 });
    const debtLoad = computeDebtLoad({ debtTotal: 0, monthlyIncome: 5000 });
    const recs = buildRecommendations({ emergencyFund, savingsRate, debtLoad });
    assert.equal(recs.length, 1);
    assert.equal(recs[0].status, 'good');
  });

  test('debt recommendation appears even if debt load status is only watch', () => {
    const emergencyFund = computeEmergencyFund({ liquidBalance: 12000, monthlyAvgSpend: 2000, targetMonths: 6 });
    const savingsRate = computeSavingsRate({ income: 5000, spend: 4000, targetPct: 20 });
    const debtLoad = computeDebtLoad({ debtTotal: 500, monthlyIncome: 5000 });
    const recs = buildRecommendations({ emergencyFund, savingsRate, debtLoad });
    assert.equal(recs.length, 1);
    assert.match(recs[0].message, /debt/);
  });
});

describe('computeNetWorthBreakdown', () => {
  test('liquid + investment - debt equals net worth', () => {
    const result = computeNetWorthBreakdown({ netWorth: 15000, investmentBalance: 8000, debtTotal: 1000 });
    assert.equal(result.investment, 8000);
    assert.equal(result.debt, 1000);
    assert.equal(result.liquid, 8000);
    assert.equal(result.liquid + result.investment - result.debt, result.netWorth);
  });

  test('no investment accounts tagged means all net worth is liquid (net of debt)', () => {
    const result = computeNetWorthBreakdown({ netWorth: 5000, investmentBalance: 0, debtTotal: 500 });
    assert.equal(result.investment, 0);
    assert.equal(result.liquid, 5500);
  });

  test('liquid never goes negative even if debt/investment overstate net worth', () => {
    const result = computeNetWorthBreakdown({ netWorth: 1000, investmentBalance: 20000, debtTotal: 0 });
    assert.equal(result.liquid, 0);
  });

  test('a negative investment balance is treated as zero investment', () => {
    const result = computeNetWorthBreakdown({ netWorth: 1000, investmentBalance: -200, debtTotal: 0 });
    assert.equal(result.investment, 0);
    assert.equal(result.liquid, 1000);
  });
});
