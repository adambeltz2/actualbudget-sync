const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// syncAndReport() is the cron-driven sync -> snapshot-diff -> email/webhook
// flow this whole app exists for. Its individual pieces (summarizeBudgetCategory,
// buildReportHtml, buildWebhookPayload, etc.) are already well unit-tested,
// but nothing previously exercised the orchestration itself -- the snapshot
// comparison, the bank-sync-status gating, the Promise.all email-section
// fetch, the webhook send -- end to end. Building that safely here needs two
// things stubbed, both for the same reason: neither has an environment
// variable or constructor override to redirect it, so an un-stubbed call
// would touch something real.
//   - @actual-app/api, via the same module-resolution stub every other
//     actualService*.test.js file already uses, so the REAL actualService.js
//     runs against fake data instead of a live server.
//   - src/config.js, whose getConfig/saveConfig read and write a hardcoded
//     /data/config.json with no override -- a real file in this environment.
//     Stubbed in-memory the same way, via require.cache, so no test run
//     ever touches it.
// Email sending is skipped by keeping enableEmail false in the fake config
// (already covered by emailReport.test.js's own unit tests); the webhook
// path is exercised instead, with global.fetch stubbed so "sent a webhook"
// is checked by inspecting the request this code really built, not by
// making a real HTTP call. The 20-second "wait for SimpleFIN" delay is
// collapsed by stubbing global.setTimeout to fire immediately.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

function installFakeApi({ accounts, categories, payees, oldTransactions, newTransactions, bankSyncStatuses }) {
  const transactionCallCount = {};
  const fakeApi = {
    init: async () => {},
    downloadBudget: async () => {},
    shutdown: async () => {},
    getAccounts: async () => accounts,
    getAccountBalance: async () => 10000,
    getCategories: async () => categories,
    getCategoryGroups: async () => [],
    getPayees: async () => payees,
    getTransactions: async (accountId) => {
      transactionCallCount[accountId] = (transactionCallCount[accountId] || 0) + 1;
      // syncAndReport snapshots each account's transactions once before
      // runBankSync() and once after -- the first call per account gets
      // the "before" fixture, every call after gets "after".
      return transactionCallCount[accountId] === 1 ? oldTransactions[accountId] || [] : newTransactions[accountId] || [];
    },
    runBankSync: async () => ({}),
    runQuery: async () => ({ data: bankSyncStatuses })
  };
  const chain = {
    options: () => chain, filter: () => chain, groupBy: () => chain, select: () => chain, limit: () => chain, offset: () => chain, calculate: () => chain
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true,
    exports: Object.assign(fakeApi, { q: () => chain })
  };
}

function installFakeConfig(initialConfig) {
  let current = { ...initialConfig };
  const saved = [];
  const fakeConfigModule = {
    getConfig: () => current,
    saveConfig: (next) => { current = next; saved.push(next); }
  };
  const resolved = require.resolve('../src/config');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fakeConfigModule };
  return { getSaved: () => saved, getCurrent: () => current };
}

function installFakeFetch() {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return { ok: true };
  };
  return { getCalls: () => calls, restore: () => { global.fetch = originalFetch; } };
}

async function runWithFastTimers(fn) {
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (cb) => { cb(); return 0; };
  try {
    await fn();
  } finally {
    global.setTimeout = originalSetTimeout;
  }
}

const BASE_CONFIG = {
  actualUrl: 'https://example.com', actualPassword: 'pw', syncId: 'sync-1',
  enableEmail: false, webhookEnabled: false, webhookUrl: '', webhookPlatform: 'generic'
};

describe('syncAndReport', () => {
  test('a new transaction triggers a webhook built from the real snapshot diff', async () => {
    const accounts = [{ id: 'acc1', name: 'Checking', closed: false }];
    const oldTransactions = { acc1: [{ id: 't1', account: 'acc1', payee: 'p1', amount: -500, date: '2026-10-15' }] };
    const newTransactions = {
      acc1: [
        { id: 't1', account: 'acc1', payee: 'p1', amount: -500, date: '2026-10-15' },
        { id: 't2', account: 'acc1', payee: 'p1', amount: -300, date: '2026-10-20' }
      ]
    };
    installFakeApi({
      accounts, categories: [], payees: [{ id: 'p1', name: 'Coffee Shop' }],
      oldTransactions, newTransactions,
      bankSyncStatuses: [{ id: 'acc1', name: 'Checking', bank_sync_status: 'ok' }]
    });
    const configState = installFakeConfig({ ...BASE_CONFIG, webhookEnabled: true, webhookUrl: 'https://example.com/webhook' });
    const fakeFetch = installFakeFetch();

    delete require.cache[require.resolve('../src/syncJob')];
    delete require.cache[require.resolve('../src/actualClient')];
    delete require.cache[require.resolve('../src/actualService')];
    const syncJob = require('../src/syncJob');

    try {
      await runWithFastTimers(() => syncJob.syncAndReport());

      const calls = fakeFetch.getCalls();
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://example.com/webhook');
      // The webhook payload traces back to the real diff: only t2 (new),
      // with its payee name resolved from the id by the real actualService.
      const addedPayees = JSON.stringify(calls[0].body);
      assert.ok(addedPayees.includes('t2') || addedPayees.toLowerCase().includes('coffee shop'));

      const saved = configState.getSaved();
      assert.equal(saved[saved.length - 1].lastSyncStatus, 'success');
    } finally {
      fakeFetch.restore();
    }
  });

  test('no new transactions and no bank sync issue sends no webhook', async () => {
    const accounts = [{ id: 'acc1', name: 'Checking', closed: false }];
    const sameTransactions = { acc1: [{ id: 't1', account: 'acc1', payee: 'p1', amount: -500, date: '2026-10-15' }] };
    installFakeApi({
      accounts, categories: [], payees: [{ id: 'p1', name: 'Coffee Shop' }],
      oldTransactions: sameTransactions, newTransactions: sameTransactions,
      bankSyncStatuses: [{ id: 'acc1', name: 'Checking', bank_sync_status: 'ok' }]
    });
    const configState = installFakeConfig({ ...BASE_CONFIG, webhookEnabled: true, webhookUrl: 'https://example.com/webhook' });
    const fakeFetch = installFakeFetch();

    delete require.cache[require.resolve('../src/syncJob')];
    delete require.cache[require.resolve('../src/actualClient')];
    delete require.cache[require.resolve('../src/actualService')];
    const syncJob = require('../src/syncJob');

    try {
      await runWithFastTimers(() => syncJob.syncAndReport());

      assert.equal(fakeFetch.getCalls().length, 0);
      const saved = configState.getSaved();
      assert.equal(saved[saved.length - 1].lastSyncStatus, 'success');
    } finally {
      fakeFetch.restore();
    }
  });

  test('a bank sync issue is recorded as a warning, not a hard failure', async () => {
    const accounts = [{ id: 'acc1', name: 'Checking', closed: false }];
    const sameTransactions = { acc1: [] };
    installFakeApi({
      accounts, categories: [], payees: [],
      oldTransactions: sameTransactions, newTransactions: sameTransactions,
      bankSyncStatuses: [{ id: 'acc1', name: 'Checking', bank_sync_status: 'reauth-required' }]
    });
    const configState = installFakeConfig({ ...BASE_CONFIG });

    delete require.cache[require.resolve('../src/syncJob')];
    delete require.cache[require.resolve('../src/actualClient')];
    delete require.cache[require.resolve('../src/actualService')];
    const syncJob = require('../src/syncJob');

    await runWithFastTimers(() => syncJob.syncAndReport());

    const saved = configState.getSaved();
    const last = saved[saved.length - 1];
    assert.equal(last.lastSyncStatus, 'warning');
    assert.ok(last.lastSyncError.includes('Checking'));
  });

  test('missing Actual Budget configuration skips the sync without throwing', async () => {
    installFakeApi({ accounts: [], categories: [], payees: [], oldTransactions: {}, newTransactions: {}, bankSyncStatuses: [] });
    installFakeConfig({ actualUrl: '', actualPassword: '', syncId: '', enableEmail: false, webhookEnabled: false });

    delete require.cache[require.resolve('../src/syncJob')];
    delete require.cache[require.resolve('../src/actualClient')];
    delete require.cache[require.resolve('../src/actualService')];
    const syncJob = require('../src/syncJob');

    await assert.doesNotReject(() => syncJob.syncAndReport());
  });
});
