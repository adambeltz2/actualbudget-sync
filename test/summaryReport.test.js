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

  // Regression: a category funded mostly from a prior month's rollover (a
  // sinking fund, or a household that allocates ahead and spends later)
  // used to make the intro line's "total budget" count only this month's
  // freshly-assigned dollars, while "spent" drew on budgeted + rollover
  // together -- producing a nonsensical total like "$2,061 of your $360
  // budget (573%)" even though nothing was actually overspent.
  test('total budget/percent includes rolled-over balance, not just this month\'s fresh allocation', () => {
    // Groceries: only $100 freshly budgeted this month, but $1,900 of
    // rollover sitting in the category lets $2,000 be spent without going
    // over -- available = remaining(1900) + spent(2000) = 3900.
    const rolledOver = [
      { categoryId: 'c1', name: 'Groceries', groupName: 'Food', budgeted: 100, spent: 2000, pctUsed: 51, remaining: 1900, overBudget: false }
    ];
    const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual: rolledOver });
    assert.match(html, /\$2,000\.00/); // spent
    assert.match(html, /\$3,900\.00/); // total available (budgeted + rollover), not the naive $100
    assert.doesNotMatch(html, /\$100\.00 total/);
    assert.match(html, /\(51%\)/);
    assert.doesNotMatch(html, /2000%/);
  });

  describe('frequency: weekly', () => {
    test('subject names the trailing 7-day range, not the month', () => {
      const { subject } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, frequency: 'weekly' });
      assert.equal(subject, 'Actual Budget Weekly Summary: Oct 12 – Oct 18');
    });

    test('header subtitle says Weekly Summary with the week range', () => {
      const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, frequency: 'weekly' });
      assert.match(html, /Weekly Summary · Oct 12 – Oct 18/);
      assert.doesNotMatch(html, /Monthly Summary/);
    });

    test('intro line includes both the week range and the month-elapsed context', () => {
      const { html } = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, frequency: 'weekly' });
      assert.match(html, /Week of Oct 12 – Oct 18/);
      assert.match(html, /day 18 of 31/);
      assert.match(html, /58% through October 2026/);
    });

    test('is otherwise identical content to the monthly version — same watch list, same budget bars', () => {
      const weekly = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, frequency: 'weekly' });
      const monthly = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, frequency: 'monthly' });
      assert.match(weekly.html, /Dining Out/);
      assert.match(weekly.html, /Budget Progress by Category/);
      // Same category bars/pace tags underneath — only the header/intro framing differs.
      assert.equal(weekly.html.includes('Groceries'), monthly.html.includes('Groceries'));
    });

    test('defaults to monthly when frequency is omitted, matching prior behavior exactly', () => {
      const omitted = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual });
      const explicitMonthly = buildSummaryReportHtml({ now: new Date(2026, 9, 18), budgetVsActual, frequency: 'monthly' });
      assert.deepEqual(omitted, explicitMonthly);
    });
  });
});
