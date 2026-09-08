const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildReportHtml } = require('../src/emailReport');

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
    assert.equal(subject, 'Budget Sync: 2 New Transactions');
  });

  test('a bank sync issue overrides the subject and always appears in the body', () => {
    const { subject, html } = buildReportHtml({
      accounts, accountBalances, accountMap, added: [], bankSyncIssue: 'Connection timed out',
      sections: { balances: false, transactions: false }
    });
    assert.match(subject, /Connection Issues/);
    assert.match(html, /Connection timed out/);
  });

  test('balances section is included by default and omitted when disabled', () => {
    const withBalances = buildReportHtml({ accounts, accountBalances, accountMap, added, bankSyncIssue: null });
    assert.match(withBalances.html, /Checking/);
    assert.match(withBalances.html, /\$1250\.50/);

    const withoutBalances = buildReportHtml({
      accounts, accountBalances, accountMap, added, bankSyncIssue: null, sections: { balances: false }
    });
    assert.doesNotMatch(withoutBalances.html, /\$1250\.50/);
  });

  test('transactions section is included by default and omitted when disabled', () => {
    const withTx = buildReportHtml({ accounts, accountBalances, accountMap, added, bankSyncIssue: null });
    assert.match(withTx.html, /Coffee Shop/);

    const withoutTx = buildReportHtml({
      accounts, accountBalances, accountMap, added, bankSyncIssue: null, sections: { transactions: false }
    });
    assert.doesNotMatch(withoutTx.html, /Coffee Shop/);
  });

  test('a negative balance renders with a minus sign', () => {
    const { html } = buildReportHtml({ accounts, accountBalances, accountMap, added: [], bankSyncIssue: null });
    assert.match(html, /-\$42\.00/);
  });

  test('user-provided text is HTML-escaped', () => {
    const maliciousAccounts = [{ id: 'acc-1', name: '<script>alert(1)</script>' }];
    const { html } = buildReportHtml({
      accounts: maliciousAccounts,
      accountBalances: { 'acc-1': 10 },
      accountMap: {},
      added: [],
      bankSyncIssue: null
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });
});
