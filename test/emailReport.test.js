const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildReportHtml, parseRecipients, renderBudgetRow, renderEmailFooter } = require('../src/emailReport');
const { version } = require('../package.json');

const accounts = [{ id: 'acc-1', name: 'Checking' }, { id: 'acc-2', name: 'Savings' }];
const accountBalances = { 'acc-1': 1250.50, 'acc-2': -42.00 };
const accountMap = { 'acc-1': 'Checking', 'acc-2': 'Savings' };
const added = [
  { id: 't1', account: 'acc-1', date: '2026-09-01', payee_name: 'Coffee Shop', amount: -450 },
  { id: 't2', account: 'acc-1', date: '2026-09-02', payee_name: 'Employer', amount: 200000 }
];

describe('buildReportHtml', () => {
  test('subject reflects the number of new transactions', () => {
    const { subject } = buildReportHtml({ accounts, accountBalances, accountMap, added, bankSyncIssue: null });
    assert.equal(subject, 'Actual Budget Sync: 2 New Transactions');
  });

  test('subject is singular for exactly one new transaction', () => {
    const { subject } = buildReportHtml({ accounts, accountBalances, accountMap, added: [added[0]], bankSyncIssue: null });
    assert.equal(subject, 'Actual Budget Sync: 1 New Transaction');
  });

  test('subject falls back to a generic summary with zero new transactions, even with a bank sync issue', () => {
    const { subject } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null });
    assert.equal(subject, 'Actual Budget Sync: Summary');
  });

  test('a bank sync issue never leaks into the subject, but always appears in the body', () => {
    const { subject, html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: 'Connection timed out',
      sections: { balances: false, transactions: false }
    });
    assert.equal(subject, 'Actual Budget Sync: Summary');
    assert.match(html, /Connection timed out/);
  });

  test('balances section is included by default and omitted when disabled', () => {
    const withBalances = buildReportHtml({ accounts, accountBalances, accountMap, added, bankSyncIssue: null, totalBalance: 1208.50 });
    assert.match(withBalances.html, /\$1,208\.50/);

    const withoutBalances = buildReportHtml({
      accounts, accountBalances, accountMap, added, bankSyncIssue: null, totalBalance: 1208.50, sections: { balances: false }
    });
    assert.doesNotMatch(withoutBalances.html, /\$1,208\.50/);
  });

  test('only accounts with a negative balance appear in the account list', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null });
    assert.doesNotMatch(html, /Checking/);
    assert.match(html, /Savings/);
    assert.match(html, /-\$42\.00/);
  });

  test('shows a fallback message when no account has a negative balance', () => {
    const allPositive = { 'acc-1': 1250.50, 'acc-2': 42.00 };
    const { html } = buildReportHtml({ accounts, accountBalances: allPositive, accountMap, added: [], bankSyncIssue: null });
    assert.match(html, /No accounts with a negative balance/);
  });

  test('explicit liabilityAccountIds override the negative-balance heuristic', () => {
    // Checking has a positive balance but is explicitly tagged as a
    // liability (e.g. a line of credit currently paid to zero); Savings is
    // negative but untagged, so it should be excluded once tags are set.
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null,
      liabilityAccountIds: ['acc-1']
    });
    assert.match(html, /Checking/);
    assert.doesNotMatch(html, /Savings/);
  });

  test('transactions section is included by default and omitted when disabled', () => {
    const withTx = buildReportHtml({ accounts, accountBalances, accountMap, added, bankSyncIssue: null });
    assert.match(withTx.html, /Coffee Shop/);

    const withoutTx = buildReportHtml({
      accounts, accountBalances, accountMap, added, bankSyncIssue: null, sections: { transactions: false }
    });
    assert.doesNotMatch(withoutTx.html, /Coffee Shop/);
  });

  test('uncategorized transactions get their own section, independent of what synced this time', () => {
    // Nothing new synced this time (`added` is empty) — the uncategorized
    // count still reflects the whole budget's backlog, not just this sync.
    const uncategorizedTransactions = [
      { id: 't2', account: 'acc-1', date: '2026-09-02', payee_name: 'Mystery Charge', amount: -1200 },
      { id: 't3', account: 'acc-2', date: '2026-09-03', payee_name: 'Cash Withdrawal', amount: -5000 }
    ];
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, uncategorizedTransactions });
    const uncatIndex = html.indexOf('Uncategorized Transactions');
    assert.ok(uncatIndex !== -1);
    assert.match(html.slice(uncatIndex), /Mystery Charge/);
    assert.match(html.slice(uncatIndex), /Cash Withdrawal/);
    assert.match(html.slice(uncatIndex), />2</); // count headline
  });

  test('uncategorized section shows zero and no rows when the list is empty', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, uncategorizedTransactions: [] });
    const uncatIndex = html.indexOf('Uncategorized Transactions');
    assert.ok(uncatIndex !== -1);
    assert.match(html.slice(uncatIndex, uncatIndex + 200), />0</);
  });

  test('uncategorized section respects the transactions toggle', () => {
    const uncategorizedTransactions = [{ id: 't1', account: 'acc-1', date: '2026-09-01', payee_name: 'Mystery Charge', amount: -1200 }];
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, uncategorizedTransactions,
      sections: { transactions: false }
    });
    assert.doesNotMatch(html, /Uncategorized Transactions/);
  });

  test('uncategorized section renders before Spend vs Budget', () => {
    const uncategorizedTransactions = [{ id: 't1', account: 'acc-1', date: '2026-09-01', payee_name: 'Mystery Charge', amount: -1200 }];
    const budgetVsActual = [{ categoryId: 'c1', name: 'Groceries', budgeted: 800, spent: 685, remaining: 115, pctUsed: 86, overBudget: false }];
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, uncategorizedTransactions, budgetVsActual });
    const uncatIndex = html.indexOf('Uncategorized Transactions');
    const budgetIndex = html.indexOf('Spend vs Budget');
    assert.ok(uncatIndex !== -1 && budgetIndex !== -1 && uncatIndex < budgetIndex);
  });

  test('a negative balance renders with a minus sign', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null });
    assert.match(html, /-\$42\.00/);
  });

  test('total balance renders in the balances section', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, totalBalance: 1208.50 });
    assert.match(html, /\$1,208\.50/);
  });

  test('budgetVsActual section is included by default and omitted when disabled', () => {
    const budgetVsActual = [
      { categoryId: 'c1', name: 'Groceries', budgeted: 800, spent: 685, remaining: 115, pctUsed: 86, overBudget: false },
      { categoryId: 'c2', name: 'Dining Out', budgeted: 400, spent: 471, remaining: -71, pctUsed: 118, overBudget: true }
    ];
    const withBudget = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual });
    assert.match(withBudget.html, /Groceries/);
    assert.match(withBudget.html, /\$115\.00 remaining/);
    assert.match(withBudget.html, /Dining Out/);
    assert.match(withBudget.html, /-\$71\.00 over/);

    const withoutBudget = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual,
      sections: { budgetVsActual: false }
    });
    assert.doesNotMatch(withoutBudget.html, /Dining Out/);
  });

  test('a near-zero percentage moves the label out of the bar instead of overflowing its left edge', () => {
    const budgetVsActual = [
      { categoryId: 'c1', name: 'College Savings (529)', budgeted: 200, spent: 0, remaining: 200, pctUsed: 0, overBudget: false }
    ];
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual });
    // The label should sit in its own table cell after the bar, not inside
    // the (near-)zero-width colored fill where right-aligned text would
    // overflow past the bar's left edge.
    assert.match(html, /<td[^>]*><span[^>]*>0%<\/span><\/td>/);
  });

  test('a comfortably large percentage keeps the label inside the bar', () => {
    const budgetVsActual = [
      { categoryId: 'c1', name: 'Groceries', budgeted: 800, spent: 685, remaining: 115, pctUsed: 86, overBudget: false }
    ];
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual });
    assert.match(html, /width:86%[\s\S]*?86%<\/div>/);
  });

  test('an empty budgetVsActual list renders no budget section', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual: [] });
    assert.doesNotMatch(html, /Spend vs Budget/);
  });

  test('all budget categories render, not just a sample', () => {
    const budgetVsActual = Array.from({ length: 9 }, (_, i) => (
      { categoryId: `c${i}`, name: `Category ${i}`, budgeted: 100, spent: 50, remaining: 50, pctUsed: 50, overBudget: false }
    ));
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual });
    for (let i = 0; i < 9; i++) {
      assert.match(html, new RegExp(`Category ${i}`));
    }
  });

  test('a Total row sums budgeted and spent across every category', () => {
    const budgetVsActual = [
      { categoryId: 'c1', name: 'Groceries', budgeted: 800, spent: 685, remaining: 115, pctUsed: 86, overBudget: false },
      { categoryId: 'c2', name: 'Dining Out', budgeted: 400, spent: 471, remaining: -71, pctUsed: 118, overBudget: true }
    ];
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual });
    assert.match(html, />Total</);
    assert.match(html, /\$44\.00 remaining/); // (800+400) - (685+471) = 1200 - 1156 = 44
  });

  test('shows the new-transaction count as a headline even with zero transactions', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null });
    assert.match(html, /New Transactions[\s\S]*?>0</);
  });

  test('sections render in the requested order: balances, then transactions, budget, then account status at the bottom', () => {
    const budgetVsActual = [
      { categoryId: 'c1', name: 'Groceries', budgeted: 800, spent: 685, remaining: 115, pctUsed: 86, overBudget: false }
    ];
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added, bankSyncIssue: 'Connection timed out',
      totalBalance: 1208.50, budgetVsActual
    });
    const balanceIndex = html.indexOf('Total Balance');
    const txIndex = html.indexOf('New Transactions');
    const budgetIndex = html.indexOf('Spend vs Budget');
    const statusIndex = html.indexOf('Account Status');

    assert.ok(txIndex !== -1 && statusIndex !== -1 && budgetIndex !== -1 && balanceIndex !== -1);
    assert.ok(balanceIndex < txIndex, 'balances should come before transactions');
    assert.ok(txIndex < budgetIndex, 'transactions should come before budget');
    assert.ok(budgetIndex < statusIndex, 'account status should come after everything else, at the bottom');
  });

  test('lists every account with a sync issue, not just one', () => {
    const accountSyncErrors = [
      { accountId: 'acc-1', accountName: 'Checking', status: 'reauth-required', label: 'Needs reconnecting — the bank login has expired' },
      { accountId: 'acc-2', accountName: 'Savings', status: 'rate-limit-exceeded', label: 'Rate limited by the bank provider — will retry next sync' }
    ];
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: '2 accounts had sync issues: Checking, Savings.',
      accountSyncErrors
    });
    assert.match(html, /Checking[\s\S]*?Needs reconnecting/);
    assert.match(html, /Savings[\s\S]*?Rate limited/);
  });

  test('a Total Liability row sums across all liability accounts', () => {
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null,
      liabilityAccountIds: ['acc-1', 'acc-2']
    });
    assert.match(html, /Total Liability[\s\S]*?\$1,208\.50/); // 1250.50 + -42.00 = 1208.50
  });

  test('no Cash vs Investments breakdown when no account is tagged Investment', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, totalBalance: 1208.50 });
    assert.doesNotMatch(html, /Investments:/);
  });

  test('Cash vs Investments breakdown splits balances once accounts are tagged', () => {
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null,
      totalBalance: 1208.50, investmentAccountIds: ['acc-1']
    });
    assert.match(html, /Cash:[\s\S]*?-\$42\.00/);
    assert.match(html, /Investments:[\s\S]*?\$1,250\.50/);
  });

  test('Income vs Spend chart renders a bar per month and omits when there is no data', () => {
    const recentIncomeVsSpend = [
      { month: '2026-07', income: 5000, spend: 4000, net: 1000 },
      { month: '2026-08', income: 4500, spend: 5200, net: -700 },
      { month: '2026-09', income: 5100, spend: 4800, net: 300 }
    ];
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, recentIncomeVsSpend
    });
    assert.match(html, /Income vs Spend/);
    assert.match(html, /July/);
    assert.match(html, /August/);
    assert.match(html, /September/);
    assert.match(html, /Total \(3 mo\)/);
    assert.match(html, /\+\$600\.00/); // 1000 - 700 + 300

    const { html: withoutData } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null });
    assert.doesNotMatch(withoutData, /Income vs Spend/);
  });

  test('the 12-month strip only appears when more than 3 months of history were fetched', () => {
    const threeMonths = [
      { month: '2026-07', income: 5000, spend: 4000, net: 1000 },
      { month: '2026-08', income: 4500, spend: 5200, net: -700 },
      { month: '2026-09', income: 5100, spend: 4800, net: 300 }
    ];
    const { html: withThree } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, recentIncomeVsSpend: threeMonths
    });
    assert.doesNotMatch(withThree, /Last 3 Months/);
    assert.doesNotMatch(withThree, /running total/);
    assert.doesNotMatch(withThree, /border-radius:50%; background:#33404A;/); // no running-total dots either

    const recentIncomeVsSpend = [
      { month: '2025-10', income: 6000, spend: 5700, net: 300 },
      { month: '2025-11', income: 5600, spend: 6400, net: -800 },
      { month: '2025-12', income: 5800, spend: 7000, net: -1200 },
      { month: '2026-01', income: 6100, spend: 5900, net: 200 },
      { month: '2026-02', income: 5900, spend: 6000, net: -100 },
      { month: '2026-03', income: 6200, spend: 5800, net: 400 },
      { month: '2026-04', income: 7200, spend: 5600, net: 1600 },
      { month: '2026-05', income: 6000, spend: 6300, net: -300 },
      { month: '2026-06', income: 6300, spend: 5800, net: 500 },
      { month: '2026-07', income: 6900, spend: 5550, net: 1350 },
      { month: '2026-08', income: 6100, spend: 6700, net: -600 },
      { month: '2026-09', income: 6400, spend: 5300, net: 1100 }
    ];
    const { html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, recentIncomeVsSpend
    });
    assert.match(html, /Last 12 Months/);
    assert.match(html, /running total/);
    // Vertical list still shows only the most recent 3 months (Jul/Aug/Sep),
    // not all 12 — October shouldn't appear as a row in that list.
    assert.match(html, /Total \(3 mo\)/);
    const verticalListSection = html.slice(html.indexOf('Income vs Spend'), html.indexOf('Last 12 Months'));
    assert.doesNotMatch(verticalListSection, /October/);
    // 12-month total: sums to +$2,450.00
    assert.match(html, /Total \(12 mo\): \+\$2,450\.00/);
    // Per-month micro-labels: month's own net, then rolling cumulative net,
    // in compact (+/-NNN, no $ or commas) form.
    assert.match(html, />\+300</); // October's own net
    assert.match(html, />-1700</); // December's rolling total

    // Regression: neither the bars nor the dot use CSS `position` at all
    // (no absolute, no relative) anywhere in this strip -- a second real
    // inbox screenshot, version-stamped to confirm it was rendered by the
    // exact commit that had already switched the bars from `top`+`bottom`
    // to `top`+explicit `height`, still showed every bar hanging from the
    // same top edge regardless of sign. That ruled out `bottom`
    // specifically: `position: absolute` itself wasn't taking effect in
    // Gmail's app in this nested-table context, so every offset was
    // silently ignored. Rebuilt around `valign` (a table-cell alignment,
    // not a CSS position) and a plain negative `margin-top` to overlay the
    // dot -- neither depends on `position` working at all.
    const stripSection = html.slice(html.indexOf('Last 12 Months'), html.indexOf('Liability Accounts'));
    assert.doesNotMatch(stripSection, /position:/, 'the 12-month strip must not rely on CSS position at all');

    // Every positive month's bar fill sits in the upper (valign="bottom")
    // cell, colored teal; every negative month's sits in the lower
    // (valign="top") cell, colored coral -- counted directly rather than by
    // reading an offset, since there's no offset anymore. Fixture has 7
    // positive months (Oct, Jan, Mar, Apr, Jun, Jul, Sep) and 5 negative
    // (Nov, Dec, Feb, May, Aug).
    const upperBarMatches = [...stripSection.matchAll(/height:(\d+)px; background:#0EA894; border-radius:2px 2px 0 0;/g)];
    const lowerBarMatches = [...stripSection.matchAll(/height:(\d+)px; background:#C4573F; border-radius:0 0 2px 2px;/g)];
    assert.equal(upperBarMatches.length, 7, 'expected one upper-half bar per positive month');
    assert.equal(lowerBarMatches.length, 5, 'expected one lower-half bar per negative month');
    assert.ok(upperBarMatches.some(m => Number(m[1]) > 0), 'at least one positive bar should have real height');
    assert.ok(lowerBarMatches.some(m => Number(m[1]) > 0), 'at least one negative bar should have real height');
    // April (+1600) is the largest-magnitude month in the fixture, so its
    // bar should hit the full 17px half-height.
    assert.ok(upperBarMatches.some(m => Number(m[1]) === 17), 'the largest positive month should reach the full bar height');

    // The dot: one neutral-navy 5px circle per month, still built as a
    // spacer-above/dot/spacer-below stack that always sums to the box's
    // full height (35px) regardless of where the dot lands in it.
    const dotCircles = [...stripSection.matchAll(/border-radius:50%; background:#33404A; border:1px solid #FFFFFF;/g)];
    assert.equal(dotCircles.length, 12, 'expected one running-total dot per month');
    const dotSpacers = [...stripSection.matchAll(/margin-top:-35px;">\s*<tr><td height="(\d+)"[^>]*>&nbsp;<\/td><\/tr>\s*<tr><td height="5"[\s\S]*?<\/tr>\s*<tr><td height="(\d+)"[^>]*>&nbsp;<\/td><\/tr>/g)];
    assert.equal(dotSpacers.length, 12, 'expected one spacer-above/spacer-below pair per month');
    assert.ok(dotSpacers.every(m => Number(m[1]) + 5 + Number(m[2]) === 35), 'each month\'s spacer-above + dot + spacer-below must sum to the full 35px box height');
    const spacerAboves = dotSpacers.map(m => Number(m[1]));
    assert.ok(spacerAboves.some(s => s < 15), 'a dot should sit in the upper half of the box when the running total is positive');
    assert.ok(spacerAboves.some(s => s > 15), 'a dot should sit in the lower half of the box when the running total is negative');
  });

  test('Spend vs Budget folds categories under their parent group with a group total', () => {
    const budgetVsActual = [
      { categoryId: 'c1', name: 'Groceries', groupName: 'Food & Dining', budgeted: 500, spent: 400, remaining: 100, pctUsed: 80, overBudget: false },
      { categoryId: 'c2', name: 'Restaurants & Out to Eat', groupName: 'Food & Dining', budgeted: 300, spent: 350, remaining: -50, pctUsed: 117, overBudget: true },
      { categoryId: 'c3', name: 'Gas', groupName: 'Transportation', budgeted: 150, spent: 90, remaining: 60, pctUsed: 60, overBudget: false }
    ];
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null, budgetVsActual });
    assert.match(html, /Food &amp; Dining/);
    assert.match(html, /Groceries/);
    assert.match(html, /Restaurants &amp; Out to Eat/);
    // Group total: (500+300) budgeted vs (400+350) spent -> remaining 50
    assert.match(html, /Food &amp; Dining[\s\S]*?\$50\.00 remaining/);
    // A single-category group (Transportation) renders just that category, not a duplicate group header
    assert.match(html, /Gas/);
    assert.doesNotMatch(html, /Transportation/);
  });

  test('user-provided text is HTML-escaped', () => {
    const maliciousAccounts = [{ id: 'acc-1', name: '<script>alert(1)</script>' }];
    const { html } = buildReportHtml({
      accounts: maliciousAccounts,
      accountBalances: { 'acc-1': -10 },
      accountMap: {},
      added: [],
      bankSyncIssue: null
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});

describe('parseRecipients', () => {
  test('passes a single address through unchanged', () => {
    assert.equal(parseRecipients('alice@example.com'), 'alice@example.com');
  });

  test('splits comma-separated addresses and trims whitespace', () => {
    assert.equal(
      parseRecipients('alice@example.com,   bob@example.com'),
      'alice@example.com, bob@example.com'
    );
  });

  test('also accepts semicolon-separated addresses', () => {
    assert.equal(
      parseRecipients('alice@example.com; bob@example.com'),
      'alice@example.com, bob@example.com'
    );
  });

  test('drops empty entries from trailing/duplicate separators', () => {
    assert.equal(
      parseRecipients('alice@example.com,, bob@example.com,'),
      'alice@example.com, bob@example.com'
    );
  });

  test('de-duplicates repeated addresses', () => {
    assert.equal(
      parseRecipients('alice@example.com, alice@example.com'),
      'alice@example.com'
    );
  });

  test('handles empty or missing input without throwing', () => {
    assert.equal(parseRecipients(''), '');
    assert.equal(parseRecipients(undefined), '');
  });
});

describe('renderBudgetRow', () => {
  // Regression: the bar fill and the pace-tick mark both used to rely on
  // `top`/`bottom` together (no explicit height) to stretch to their
  // parent's height -- the exact mechanism that collapsed the 12-month
  // strip's bars in Gmail's app (a `bottom` offset on an absolutely-
  // positioned element isn't honored there the way `top` is). Both now use
  // an explicit pixel `height` instead, so they can't collapse the same way
  // even if `bottom` is ignored.
  test('the bar fill uses an explicit pixel height, never a bottom offset', () => {
    const cat = { name: 'Groceries', budgeted: 500, spent: 400, remaining: 100, pctUsed: 80, overBudget: false };
    const html = renderBudgetRow(cat);
    assert.doesNotMatch(html, /top:0;\s*bottom:0;/);
    assert.match(html, /top:0; height:13px; width:80%; background:#0EA894;/);
  });

  test('a nested row uses its own shorter explicit height', () => {
    const cat = { name: 'Groceries', budgeted: 500, spent: 400, remaining: 100, pctUsed: 80, overBudget: false };
    const html = renderBudgetRow(cat, { nested: true });
    assert.match(html, /top:0; height:11px; width:80%; background:#0EA894;/);
  });

  test('the pace-tick mark (Monthly/Weekly Summary only) also uses an explicit height, never top/bottom together', () => {
    const cat = { name: 'Groceries', budgeted: 500, spent: 400, remaining: 100, pctUsed: 80, overBudget: false };
    const html = renderBudgetRow(cat, { pctMonthElapsed: 60 });
    assert.doesNotMatch(html, /top:-2px;\s*bottom:-2px;/);
    assert.match(html, /left:60%; top:-2px; height:17px; width:2px;/); // barHeight(13) + 4
  });

  test('no pctMonthElapsed means no tick mark at all, and the daily sync report never passes one', () => {
    const cat = { name: 'Groceries', budgeted: 500, spent: 400, remaining: 100, pctUsed: 80, overBudget: false };
    const html = renderBudgetRow(cat);
    assert.doesNotMatch(html, /background:#1E2A32; opacity:0.45;/);
  });
});

describe('renderEmailFooter', () => {
  // So a sync email can be compared directly against the dashboard footer
  // (GET /api/version) to confirm a deployed fix actually reached this
  // instance, rather than guessing from send time whether a report
  // predates a deploy -- the exact ambiguity that came up confirming the
  // 12-month strip fix.
  const originalCommit = process.env.GIT_COMMIT;
  function restoreEnv() {
    if (originalCommit === undefined) delete process.env.GIT_COMMIT;
    else process.env.GIT_COMMIT = originalCommit;
  }

  test('shows the version alone when GIT_COMMIT is unset', () => {
    delete process.env.GIT_COMMIT;
    const footer = renderEmailFooter();
    restoreEnv();
    assert.match(footer, new RegExp(`Actual Budget Smart Sync v${version} · sent from your self-hosted instance`));
  });

  test('appends a short commit hash when GIT_COMMIT is set', () => {
    process.env.GIT_COMMIT = 'abcdef1234567890';
    const footer = renderEmailFooter();
    restoreEnv();
    assert.match(footer, new RegExp(`Actual Budget Smart Sync v${version} \\(abcdef1\\) · sent from your self-hosted instance`));
  });
});
