const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { buildTransactionFilters, SORT_ORDERS } = require('../src/actualService');

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
