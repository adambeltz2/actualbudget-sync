const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildSummaryReportHtml } = require('../src/summaryReport');

const budgetVsActual = [
  { categoryId: 'c1', name: 'Groceries', groupName: 'Food', budgeted: 400, spent: 380, pctUsed: 95, remaining: 20, overBudget: false },
  { categoryId: 'c2', name: 'Dining Out', groupName: 'Food', budgeted: 300, spent: 420, pctUsed: 140, remaining: -120, overBudget: true },
  { categoryId: 'c3', name: 'Gas', groupName: 'Transportation', budgeted: 180, spent: 95, pctUsed: 53, remaining: 85, overBudget: false }
];

describe('buildSummaryReportHtml', () => {
  test('subject names the month, never a transaction count', () => {
    const { subject } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual });
    assert.equal(subject, 'Actual Budget Monthly Summary: October 2026');
    assert.doesNotMatch(subject, /Transaction/);
  });

  test('never includes a transaction list or uncategorized-transactions section', () => {
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual });
    assert.doesNotMatch(html, /New Transactions/);
    assert.doesNotMatch(html, /Uncategorized Transactions/);
  });

  test('shows total balance when provided', () => {
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, totalBalance: 42850 });
    assert.match(html, /\$42,850\.00/);
  });

  test('day-of-month progress line reflects the given date', () => {
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual });
    assert.match(html, /Day 18 of 31/);
    assert.match(html, /58% through October 2026/);
  });

  test('categories to watch lists the over-pace category and excludes well-paced ones', () => {
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual });
    assert.match(html, /Dining Out/);
    const watchSectionStart = html.indexOf('Categories to Watch');
    const watchSectionEnd = html.indexOf('Net Savings This Month');
    const watchSection = html.slice(watchSectionStart, watchSectionEnd);
    assert.doesNotMatch(watchSection, /Gas/); // well under pace at day 18, should not appear here
  });

  test('shows a positive message when nothing is ahead of pace', () => {
    const allUnderPace = budgetVsActual.map(c => ({ ...c, spent: 10, pctUsed: 3, remaining: c.budgeted - 10, overBudget: false }));
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual: allUnderPace });
    assert.match(html, /Nothing running ahead of pace/);
  });

  test('net savings and typical pace both render', () => {
    const { html } = buildSummaryReportHtml({
      now: new Date(2026, 9, 18), budgetVsActual, netSavingsThisMonth: 1350, typicalPaceNetSavings: 1100
    });
    assert.match(html, /\$1,350/);
    assert.match(html, /\$1,100/);
  });

  test('budget progress section is skipped entirely when there is no budget data', () => {
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual: [] });
    assert.doesNotMatch(html, /Budget Progress by Category/);
  });

  test('includes a View Full Report link only when publicUrl is set', () => {
    const without = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual });
    assert.doesNotMatch(without.html, /View Full Report/);
    const withUrl = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, publicUrl: 'https://example.com' });
    assert.match(withUrl.html, /View Full Report/);
    assert.match(withUrl.html, /https:\/\/example\.com/);
  });

  test('escapes a category name containing HTML-significant characters', () => {
    const malicious = [{ categoryId: 'c1', name: '<script>alert(1)</script>', groupName: 'Food', budgeted: 100, spent: 50, pctUsed: 50, remaining: 50, overBudget: false }];
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual: malicious });
    assert.doesNotMatch(html, /<script>alert/);
  });
});
