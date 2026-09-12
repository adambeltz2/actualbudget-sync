const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// queryAllTransactions calls into @actual-app/api, which requires a live
// server connection — unlike the rest of actualService.test.js, which only
// exercises the pure, dependency-free exports. To test the pagination loop
// itself (the exact bug this guards: CSV export silently capping at a fixed
// row limit), @actual-app/api is stubbed at the module-resolution level
// before actualService.js is required, so its top-level `require('@actual-app/api')`
// resolves to the stub instead of needing a real server.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

function installFakeApi(totalRows) {
  let queryCallCount = 0;
  const fakeApi = {
    getPayees: async () => [{ id: 'p1', name: 'Test Payee' }],
    runQuery: async (queryState) => {
      queryCallCount++;
      const { _limit, _offset } = queryState;
      const start = _offset;
      const end = Math.min(_offset + _limit, totalRows);
      const data = [];
      for (let i = start; i < end; i++) {
        data.push({ id: `t${i}`, date: '2026-09-01', account: 'a1', category: null, payee: 'p1', amount: -100 });
      }
      return { data };
    }
  };
  const q = () => {
    const state = { _limit: undefined, _offset: 0 };
    const chain = {
      options: () => chain,
      filter: () => chain,
      groupBy: () => chain,
      select: () => chain,
      orderBy: () => chain,
      limit: (n) => { state._limit = n; return { ...chain, ...state }; },
      offset: (n) => { state._offset = n; return { ...chain, ...state }; },
      calculate: () => chain,
      ...state
    };
    return chain;
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q })
  };
  return () => queryCallCount;
}

describe('queryAllTransactions', () => {
  test('pages through every matching row instead of capping at a fixed limit', async () => {
    const getCallCount = installFakeApi(6530);
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const all = await actualService.queryAllTransactions({}, { pageSize: 1000 });
    assert.equal(all.length, 6530);
    assert.equal(getCallCount(), 7);
  });

  test('a dataset that divides evenly into pages still fetches everything (one extra empty page confirms the end)', async () => {
    const getCallCount = installFakeApi(2000);
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');

    const all = await actualService.queryAllTransactions({}, { pageSize: 1000 });
    assert.equal(all.length, 2000);
    assert.equal(getCallCount(), 3); // 2 full pages + 1 empty page proving there's no more
  });

  test('resolves payee names on every page, not just the first', async () => {
    const getCallCount = installFakeApi(1500);
    delete require.cache[require.resolve('../src/actualService')];
    const actualService = require('../src/actualService');
    void getCallCount;

    const all = await actualService.queryAllTransactions({}, { pageSize: 1000 });
    assert.ok(all.every(t => t.payee_name === 'Test Payee'));
  });
});
