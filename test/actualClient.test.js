const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ensureReady/refreshBudget/isReady/shutdown previously had no direct test
// coverage at all -- only indirectly, trivially, through syncJob.test.js's
// always-identical no-op fakes. Covered here now that they live in their
// own module. Deliberately NOT covered: the corrupted-cache self-heal
// retry path (downloadWithSelfHeal's catch block). That path calls
// purgeLocalCache(DATA_DIR), and DATA_DIR is a hardcoded '/data' with no
// override -- a real, populated directory in this environment (confirmed
// elsewhere in this repo's test suite). purgeLocalCache's own deletion
// logic is already safely unit-tested against a temp directory in
// actualService.test.js; triggering the self-heal path for real here
// would mean actually deleting real local files, which no test should do.
const origResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === '@actual-app/api') return request;
  return origResolveFilename.call(this, request, ...args);
};

function installFakeApi() {
  const calls = [];
  const fakeApi = {
    init: async (opts) => { calls.push({ method: 'init', opts }); },
    downloadBudget: async (syncId) => { calls.push({ method: 'downloadBudget', syncId }); },
    shutdown: async () => { calls.push({ method: 'shutdown' }); }
  };
  require.cache['@actual-app/api'] = {
    id: '@actual-app/api', filename: '@actual-app/api', loaded: true, exports: fakeApi
  };
  return calls;
}

function loadActualClient() {
  delete require.cache[require.resolve('../src/actualClient')];
  return require('../src/actualClient');
}

const CONFIG_A = { actualUrl: 'https://a.example.com', syncId: 'sync-a', actualPassword: 'pw-a' };
const CONFIG_B = { actualUrl: 'https://b.example.com', syncId: 'sync-b', actualPassword: 'pw-b' };

describe('ensureReady / refreshBudget / isReady / shutdown', () => {
  test('first call initializes and downloads the budget', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();

    assert.equal(actualClient.isReady(), false);
    await actualClient.ensureReady(CONFIG_A);

    assert.equal(actualClient.isReady(), true);
    assert.deepEqual(calls.map(c => c.method), ['init', 'downloadBudget']);
  });

  test('a second call with the same config is a no-op (same fingerprint)', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();

    await actualClient.ensureReady(CONFIG_A);
    await actualClient.ensureReady(CONFIG_A);

    assert.deepEqual(calls.map(c => c.method), ['init', 'downloadBudget']);
  });

  test('a call with a different config shuts down and reinitializes', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();

    await actualClient.ensureReady(CONFIG_A);
    await actualClient.ensureReady(CONFIG_B);

    assert.deepEqual(calls.map(c => c.method), ['init', 'downloadBudget', 'shutdown', 'init', 'downloadBudget']);
    assert.equal(calls[3].opts.serverURL, CONFIG_B.actualUrl);
  });

  test('refreshBudget re-downloads without re-initializing when already ready', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();

    await actualClient.ensureReady(CONFIG_A);
    calls.length = 0;
    await actualClient.refreshBudget(CONFIG_A);

    assert.deepEqual(calls.map(c => c.method), ['downloadBudget']);
  });

  test('refreshBudget on a cold start also initializes first', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();

    await actualClient.refreshBudget(CONFIG_A);

    assert.deepEqual(calls.map(c => c.method), ['init', 'downloadBudget', 'downloadBudget']);
  });

  test('shutdown resets ready state; a no-op when not initialized', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();

    await actualClient.shutdown();
    assert.equal(calls.length, 0);

    await actualClient.ensureReady(CONFIG_A);
    await actualClient.shutdown();

    assert.equal(actualClient.isReady(), false);
    assert.ok(calls.some(c => c.method === 'shutdown'));
  });

  test('runBankSync delegates straight to api.runBankSync', async () => {
    const calls = installFakeApi();
    const actualClient = loadActualClient();
    require.cache['@actual-app/api'].exports.runBankSync = async () => { calls.push({ method: 'runBankSync' }); return 'ok'; };

    const result = await actualClient.runBankSync();

    assert.equal(result, 'ok');
    assert.ok(calls.some(c => c.method === 'runBankSync'));
  });
});
