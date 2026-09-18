const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildReportHtml, parseRecipients } = require('../src/emailReport');

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
