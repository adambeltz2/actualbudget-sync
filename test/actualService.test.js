const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildTransactionFilters, SORT_ORDERS, summarizeBudgetCategory, resolvePayeeNames } = require('../src/actualService');

describe('buildTransactionFilters', () => {
  test('returns an empty array when no filters are given', () => {
    assert.deepEqual(buildTransactionFilters({}), []);
    assert.deepEqual(buildTransactionFilters(undefined), []);
  });

  test('builds an equality filter for accountId and categoryId', () => {
    const filters = buildTransactionFilters({ accountId: 'acc-1', categoryId: 'cat-1' });
    assert.deepEqual(filters, [{ account: 'acc-1' }, { category: 'cat-1' }]);
  });

  test('builds $gte/$lte range filters for date bounds', () => {
    const filters = buildTransactionFilters({ startDate: '2026-01-01', endDate: '2026-01-31' });
    assert.deepEqual(filters, [
      { date: { $gte: '2026-01-01' } },
      { date: { $lte: '2026-01-31' } }
    ]);
  });

  test('builds a $like filter for payee search', () => {
    const filters = buildTransactionFilters({ search: 'Amazon' });
    assert.deepEqual(filters, [{ payee_name: { $like: '%Amazon%' } }]);
  });

  test('combines all filters together, in order', () => {
    const filters = buildTransactionFilters({
      accountId: 'acc-1', categoryId: 'cat-1', startDate: '2026-01-01', endDate: '2026-01-31', search: 'Amazon'
    });
    assert.equal(filters.length, 5);
  });

  test('falsy values are omitted rather than producing empty-string filters', () => {
    const filters = buildTransactionFilters({ accountId: '', categoryId: undefined, search: null });
    assert.deepEqual(filters, []);
  });
});

describe('SORT_ORDERS', () => {
  test('has an orderBy expression for every sort option the API accepts', () => {
    assert.deepEqual(SORT_ORDERS.date_desc, { date: 'desc' });
    assert.deepEqual(SORT_ORDERS.date_asc, { date: 'asc' });
    assert.deepEqual(SORT_ORDERS.amount_desc, { amount: 'desc' });
    assert.deepEqual(SORT_ORDERS.amount_asc, { amount: 'asc' });
  });
});

describe('summarizeBudgetCategory', () => {
  // getBudgetMonth() reports amounts in cents, with spend as a negative sum
  // (like transaction amounts), the same convention used everywhere else.
  test('converts cents to dollars and computes remaining/pctUsed when under budget', () => {
    const result = summarizeBudgetCategory({ id: 'c1', name: 'Groceries', budgeted: 80000, spent: -68500 });
    assert.equal(result.budgeted, 800);
    assert.equal(result.spent, 685);
    assert.equal(result.remaining, 115);
    assert.equal(result.pctUsed, 86);
    assert.equal(result.overBudget, false);
  });

  test('flags overBudget and reports a negative remaining when spend exceeds budget', () => {
    const result = summarizeBudgetCategory({ id: 'c2', name: 'Dining Out', budgeted: 40000, spent: -47100 });
    assert.equal(result.remaining, -71);
    assert.equal(result.pctUsed, 118);
    assert.equal(result.overBudget, true);
  });

  test('a category with zero budget but nonzero spend is treated as fully over', () => {
    const result = summarizeBudgetCategory({ id: 'c3', name: 'Uncategorized', budgeted: 0, spent: -2000 });
    assert.equal(result.pctUsed, 100);
    assert.equal(result.overBudget, true);
  });

  test('a category with zero budget and zero spend is not over budget', () => {
    const result = summarizeBudgetCategory({ id: 'c4', name: 'Unused', budgeted: 0, spent: 0 });
    assert.equal(result.pctUsed, 0);
    assert.equal(result.overBudget, false);
  });

  test('missing budgeted/spent fields default to zero rather than throwing', () => {
    const result = summarizeBudgetCategory({ id: 'c5', name: 'Empty' });
    assert.equal(result.budgeted, 0);
    assert.equal(result.spent, 0);
    assert.equal(result.overBudget, false);
  });
});

describe('resolvePayeeNames', () => {
  // @actual-app/api's transactions view doesn't include payee_name from a
  // bare select('*') — only the raw payee id — so every transaction needs
  // its name resolved against a separately-fetched payees list.
  const payees = [{ id: 'p1', name: 'Coffee Shop' }, { id: 'p2', name: 'Employer' }];

  test('fills in payee_name from the payee id when missing', () => {
    const transactions = [{ id: 't1', payee: 'p1' }, { id: 't2', payee: 'p2' }];
    const resolved = resolvePayeeNames(transactions, payees);
    assert.equal(resolved[0].payee_name, 'Coffee Shop');
    assert.equal(resolved[1].payee_name, 'Employer');
  });

  test('leaves an existing payee_name untouched', () => {
    const transactions = [{ id: 't1', payee: 'p1', payee_name: 'Already Set' }];
    const resolved = resolvePayeeNames(transactions, payees);
    assert.equal(resolved[0].payee_name, 'Already Set');
  });

  test('a transaction with no matching payee (e.g. a transfer) gets null rather than throwing', () => {
    const transactions = [{ id: 't1', payee: null }, { id: 't2', payee: 'unknown-id' }];
    const resolved = resolvePayeeNames(transactions, payees);
    assert.equal(resolved[0].payee_name, null);
    assert.equal(resolved[1].payee_name, null);
  });

  test('does not mutate the original transaction objects', () => {
    const original = { id: 't1', payee: 'p1' };
    resolvePayeeNames([original], payees);
    assert.equal(original.payee_name, undefined);
  });
});
