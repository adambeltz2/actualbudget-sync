const fs = require('fs');
const path = require('path');
const api = require('@actual-app/api');
const { logger } = require('./logger');

// Connection lifecycle for the shared @actual-app/api session: init/
// download/shutdown, the self-healing retry around a corrupted local
// cache, and the FIFO lock that keeps concurrent callers from racing each
// other's init()/download()/shutdown() calls. Split out of actualService.js
// (which still owns every data-access/shaping function, built on top of
// this connection) so "how we talk to Actual" and "what we ask it for" are
// two separate concerns -- actualService.js re-exports everything here
// under its own public API, so no caller outside these two files needed to
// change.

const DATA_DIR = '/data';

// Kept open across sync cycles instead of init()/shutdown() per run, so the
// downloaded budget stays queryable between syncs (needed by the data
// explorer/dashboard work planned in the backlog).
let initialized = false;
let currentFingerprint = null;

function fingerprint(config) {
  return `${config.actualUrl}|${config.syncId}|${config.actualPassword}`;
}

// @actual-app/api's init()/shutdown()/downloadBudget() aren't safe to call
// concurrently against the same DATA_DIR — two dashboard tabs hitting
// different /api/data/* routes, or a scheduled sync firing while a
// dashboard load is in flight, could otherwise interleave a shutdown() with
// another call's init()/download(). This serializes every such call through
// one FIFO queue instead of locking per-call, so callers never race.
let apiOpQueue = Promise.resolve();
function withApiLock(fn) {
  const result = apiOpQueue.then(fn, fn);
  apiOpQueue = result.catch(() => {});
  return result;
}

// @actual-app/api throws these when its local SQLite/JSON cache under
// DATA_DIR is corrupted or stale relative to the server — e.g. metadata
// left truncated by an interrupted write, or the server no longer
// recognizing a cached fileId (the budget was reset/recreated server-side,
// or the cache survived a Sync ID change). Previously this required an
// operator to manually find and delete the right cache subfolder under
// ./data; self-healing here means a bad local cache can't wedge the
// scheduled sync indefinitely.
const CORRUPTED_CACHE_SIGNATURES = [
  'invalid fileId',
  'Unexpected end of JSON input',
  "reading 'prepare'",
  'services are already running'
];

function isCorruptedCacheError(err) {
  const message = String((err && err.message) || err);
  return CORRUPTED_CACHE_SIGNATURES.some(sig => message.includes(sig));
}

// Wipes everything under dataDir except config.json — the rest is entirely
// @actual-app/api's own per-budget cache, safe to discard and let it
// re-download fresh.
function purgeLocalCache(dataDir) {
  let entries;
  try {
    entries = fs.readdirSync(dataDir);
  } catch (err) {
    return;
  }
  for (const entry of entries) {
    if (entry === 'config.json') continue;
    fs.rmSync(path.join(dataDir, entry), { recursive: true, force: true });
  }
}

async function downloadWithSelfHeal(config) {
  try {
    await api.downloadBudget(config.syncId);
  } catch (err) {
    if (!isCorruptedCacheError(err)) throw err;
    logger.warn(`Local Actual Budget cache appears corrupted (${err.message}); clearing it under ${DATA_DIR} and retrying once...`);
    await api.shutdown().catch(() => {});
    purgeLocalCache(DATA_DIR);
    await api.init({ dataDir: DATA_DIR, serverURL: config.actualUrl, password: config.actualPassword });
    await api.downloadBudget(config.syncId);
  }
}

async function ensureReady(config) {
  return withApiLock(async () => {
    const fp = fingerprint(config);
    if (initialized && fp === currentFingerprint) return;

    if (initialized) {
      logger.info('Actual Budget configuration changed; reinitializing data service...');
      await shutdown();
    }

    await api.init({ dataDir: DATA_DIR, serverURL: config.actualUrl, password: config.actualPassword });
    await downloadWithSelfHeal(config);
    initialized = true;
    currentFingerprint = fp;
  });
}

async function refreshBudget(config) {
  await ensureReady(config);
  await withApiLock(() => downloadWithSelfHeal(config));
}

async function runBankSync() {
  return api.runBankSync();
}

async function shutdown() {
  if (!initialized) return;
  await api.shutdown();
  initialized = false;
  currentFingerprint = null;
}

function isReady() {
  return initialized;
}

module.exports = {
  ensureReady, refreshBudget, runBankSync, shutdown, isReady,
  // Exported for unit testing (pure functions, no @actual-app/api calls).
  isCorruptedCacheError, purgeLocalCache
};
