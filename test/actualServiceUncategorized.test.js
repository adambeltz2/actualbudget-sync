const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// getUncategorizedTransactions calls into @actual-app/api, which requires a
// live server connection — same module-resolution stub technique as
// actualServicePagination.test.js. Unlike that file's fake query builder
// (which ignores .filter() entirely), this one actually applies the
// filters to a fixed dataset, so it can catch a real regression: a split
// transaction's parent/summary row has category: null by design (its
// amount is divided across properly-categorized is_child rows), and a
// query that doesn't exclude is_parent rows will falsely count a
// fully-categorized split as uncategorized forever.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

function applyFilters(data, filters) {
  return data.filter(row => filters.every(f => {
    const [field, condition] = Object.entries(f)[0];
    if (condition && typeof condition === 'object') {
      if ('$oneof' in condition) return condition.$oneof.includes(row[field]);
      if ('$ne' in condition) return row[field] !== condition.$ne;
    }
    return row[field] === condition;
  }));
}

function installFakeApi(transactions) {
  const fakeApi = {
    getAccounts: async () => [{ id: 'a1', offbudget: false, closed: false }],
    getPayees: async () => [{ id: 'p1', name: 'Test Payee' }],
    runQuery: async (queryState) => ({ data: applyFilters(transactions, queryState._filters) })
  };
  const q = () => {
    const state = { _filters: [] };
    const chain = {
      options: () => chain,
      filter: (f) => { state._filters.push(f); return { ...chain, ...state }; },
      select: () => ({ ...chain, ...state }),
      orderBy: () => ({ ...chain, ...state }),
      ...state
    };
    return chain;
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q })
  };
}

describe('getUncategorizedTransactions', () => {
  test('excludes a split transaction\'s parent row, which has category: null by design', async () => {
    installFakeApi([
      { id: 't1', account: 'a1', category: null, transfer_id: null, starting_balance_flag: false, is_parent: true, payee: 'p1', amount: -15000 },
      { id: 't1-1', account: 'a1', category: 'c1', transfer_id: null, starting_balance_flag: false, is_parent: false, is_child: true, parent_id: 't1', payee: 'p1', amount: -10000 },
      { id: 't1-2', account: 'a1', category: 'c2', transfer_id: null, starting_balance_flag: false, is_parent: false, is_child: true, parent_id: 't1', payee: 'p1', amount: -5000 }
    ]);
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const result = await actualService.getUncategorizedTransactions();
    assert.deepEqual(result.map(t => t.id), []);
  });

  test('still flags a genuinely uncategorized, non-split transaction', async () => {
    installFakeApi([
      { id: 't2', account: 'a1', category: null, transfer_id: null, starting_balance_flag: false, is_parent: false, payee: 'p1', amount: -5000 }
    ]);
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const result = await actualService.getUncategorizedTransactions();
    assert.deepEqual(result.map(t => t.id), ['t2']);
  });

  test('a split child that is itself missing a category is still flagged', async () => {
    installFakeApi([
      { id: 't3', account: 'a1', category: null, transfer_id: null, starting_balance_flag: false, is_parent: true, payee: 'p1', amount: -15000 },
      { id: 't3-1', account: 'a1', category: 'c1', transfer_id: null, starting_balance_flag: false, is_parent: false, is_child: true, parent_id: 't3', payee: 'p1', amount: -10000 },
      { id: 't3-2', account: 'a1', category: null, transfer_id: null, starting_balance_flag: false, is_parent: false, is_child: true, parent_id: 't3', payee: 'p1', amount: -5000 }
    ]);
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const result = await actualService.getUncategorizedTransactions();
    assert.deepEqual(result.map(t => t.id), ['t3-2']);
  });
});
