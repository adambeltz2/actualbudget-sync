const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// routes.js's query-string parsing/clamping/config-fallback logic (fire-progress,
// retirement-model, parseMonteCarloParams) had no direct test coverage -- every
// other test exercises the pure functions one layer down. Stubs src/config.js
// (hardcoded /data/config.json, no override -- same require.cache technique
// syncJob.test.js already established) and src/actualService.js (so we can
// capture exactly what params the route computed and handed it, without
// running the real @actual-app/api-backed logic at all -- that's already
// covered by actualService's own test files).
//
// requireAuth (session/login) is applied in index.js, not inside routes.js
// itself, so mounting the router alone in a bare Express app exercises the
// real route handlers with no auth layer to route around.

function installFakeConfig(config) {
  const resolved = require.resolve('../src/config');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: { getConfig: () => config, saveConfig: () => {} }
  };
}

function installFakeActualService() {
  const calls = {};
  const resolved = require.resolve('../src/actualService');
  const fake = {
    ensureReady: async () => {},
    getFireProgress: async (params) => { calls.getFireProgress = params; return { ok: true }; },
    getRetirementModel: async (params) => { calls.getRetirementModel = params; return { ok: true }; },
    getMonteCarloProjection: async (params) => { calls.getMonteCarloProjection = params; return { hasBirthdate: false }; },
    getMonteCarloCompare: async (params) => { calls.getMonteCarloCompare = params; return { hasBirthdate: false, rows: [] }; }
  };
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fake };
  return calls;
}

const BASE_CONFIG = {
  actualUrl: 'https://example.com', actualPassword: 'pw', syncId: 'sync-1',
  fireAnnualExpenses: 40000, fireWithdrawalRatePct: 4, fireTaxRatePct: 10, fireFilingStatus: 'single',
  traditionalAccountIds: ['acc-trad'], rothAccountIds: ['acc-roth'],
  fireBirthdate: '1980-01-01', fireTargetRetirementAge: 60,
  insightsAnnualReturnPct: 7,
  ssClaimingChoice: '', ssAge62MonthlyBenefit: null, ssFraAgeYears: 67, ssFraAgeMonths: 0,
  ssFraMonthlyBenefit: null, ssAge70MonthlyBenefit: null
};

// Fresh app + fresh routes.js require per test, so each test's fakes are
// picked up cleanly (routes.js captures actualService/config at require time).
function freshApp(config) {
  installFakeConfig(config);
  const calls = installFakeActualService();
  delete require.cache[require.resolve('../src/routes')];
  const routes = require('../src/routes');
  const app = express();
  app.use(express.json());
  app.use(routes);
  return { app, calls };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

after(() => {
  // Leave the real modules in place for any test file that runs after this
  // one in the same process.
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/actualService')];
  delete require.cache[require.resolve('../src/routes')];
});

describe('GET /api/data/fire-progress', () => {
  test('400s when Actual Budget is not configured', async () => {
    const { app } = freshApp({ ...BASE_CONFIG, actualUrl: '' });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/data/fire-progress`);
      assert.equal(res.status, 400);
    });
  });

  test('with no query params, every value falls back to config', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/data/fire-progress`);
      assert.equal(res.status, 200);
      assert.equal(calls.getFireProgress.fireAnnualExpenses, 40000);
      assert.equal(calls.getFireProgress.fireWithdrawalRatePct, 4);
      assert.equal(calls.getFireProgress.fireTaxRatePct, 10);
      assert.equal(calls.getFireProgress.fireFilingStatus, 'single');
      assert.equal(calls.getFireProgress.targetRetirementAge, 60);
      assert.equal(calls.getFireProgress.birthdate, '1980-01-01');
    });
  });

  test('query params override config values', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/fire-progress?fireAnnualExpenses=55000&fireWithdrawalRatePct=3.5&fireTaxRatePct=22&fireFilingStatus=marriedJointly&targetRetirementAge=50`);
      assert.equal(calls.getFireProgress.fireAnnualExpenses, 55000);
      assert.equal(calls.getFireProgress.fireWithdrawalRatePct, 3.5);
      assert.equal(calls.getFireProgress.fireTaxRatePct, 22);
      assert.equal(calls.getFireProgress.fireFilingStatus, 'marriedJointly');
      assert.equal(calls.getFireProgress.targetRetirementAge, 50);
    });
  });

  test('fireWithdrawalRatePct is clamped to [1, 20]', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/fire-progress?fireWithdrawalRatePct=0.1`);
      assert.equal(calls.getFireProgress.fireWithdrawalRatePct, 1);
      await fetch(`${base}/api/data/fire-progress?fireWithdrawalRatePct=99`);
      assert.equal(calls.getFireProgress.fireWithdrawalRatePct, 20);
    });
  });

  test('fireTaxRatePct is clamped to [0, 60] and a non-numeric value floors to 0', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/fire-progress?fireTaxRatePct=200`);
      assert.equal(calls.getFireProgress.fireTaxRatePct, 60);
      await fetch(`${base}/api/data/fire-progress?fireTaxRatePct=-5`);
      assert.equal(calls.getFireProgress.fireTaxRatePct, 0);
      await fetch(`${base}/api/data/fire-progress?fireTaxRatePct=not-a-number`);
      assert.equal(calls.getFireProgress.fireTaxRatePct, 0);
    });
  });

  test('an unrecognized fireFilingStatus query value falls back to config, not the raw junk value', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/fire-progress?fireFilingStatus=headOfHousehold`);
      assert.equal(calls.getFireProgress.fireFilingStatus, 'single');
    });
  });
});

describe('GET /api/data/retirement-model', () => {
  test('400s when Actual Budget is not configured', async () => {
    const { app } = freshApp({ ...BASE_CONFIG, syncId: '' });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/data/retirement-model`);
      assert.equal(res.status, 400);
    });
  });

  test('targetRetirementAge has no config fallback -- omitted query means null, unlike fire-progress', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/retirement-model`);
      assert.equal(calls.getRetirementModel.targetRetirementAge, null);
    });
  });

  test('an empty modeledMonthlyContribution string means null ("auto"), not NaN or 0', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/retirement-model?modeledMonthlyContribution=`);
      assert.equal(calls.getRetirementModel.modeledMonthlyContribution, null);
      await fetch(`${base}/api/data/retirement-model?modeledMonthlyContribution=1500`);
      assert.equal(calls.getRetirementModel.modeledMonthlyContribution, 1500);
    });
  });

  test('contributionStopAge is clamped to [0, 120]; omitted means null (never stop)', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/retirement-model`);
      assert.equal(calls.getRetirementModel.contributionStopAge, null);
      await fetch(`${base}/api/data/retirement-model?contributionStopAge=-10`);
      assert.equal(calls.getRetirementModel.contributionStopAge, 0);
      await fetch(`${base}/api/data/retirement-model?contributionStopAge=500`);
      assert.equal(calls.getRetirementModel.contributionStopAge, 120);
      await fetch(`${base}/api/data/retirement-model?contributionStopAge=55`);
      assert.equal(calls.getRetirementModel.contributionStopAge, 55);
    });
  });

  test('annualReturnRatePct is clamped to [-20, 30] and otherwise falls back to config', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/retirement-model`);
      assert.equal(calls.getRetirementModel.annualReturnRatePct, 7);
      await fetch(`${base}/api/data/retirement-model?annualReturnRatePct=99`);
      assert.equal(calls.getRetirementModel.annualReturnRatePct, 30);
    });
  });
});

describe('GET /api/data/monte-carlo (parseMonteCarloParams)', () => {
  test('400s when Actual Budget is not configured', async () => {
    const { app } = freshApp({ ...BASE_CONFIG, actualPassword: '' });
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/api/data/monte-carlo`);
      assert.equal(res.status, 400);
    });
  });

  test('retireAge defaults to 55 when missing or non-numeric', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo`);
      assert.equal(calls.getMonteCarloProjection.retireAge, 55);
      await fetch(`${base}/api/data/monte-carlo?retireAge=not-a-number`);
      assert.equal(calls.getMonteCarloProjection.retireAge, 55);
      await fetch(`${base}/api/data/monte-carlo?retireAge=63`);
      assert.equal(calls.getMonteCarloProjection.retireAge, 63);
    });
  });

  test('an unrecognized allocation falls back to moderate', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo?allocation=yolo`);
      assert.equal(calls.getMonteCarloProjection.allocation, 'moderate');
      await fetch(`${base}/api/data/monte-carlo?allocation=aggressive`);
      assert.equal(calls.getMonteCarloProjection.allocation, 'aggressive');
    });
  });

  test('paths is clamped to [200, 10000]', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo?paths=1`);
      assert.equal(calls.getMonteCarloProjection.paths, 200);
      await fetch(`${base}/api/data/monte-carlo?paths=9999999`);
      assert.equal(calls.getMonteCarloProjection.paths, 10000);
    });
  });

  test('contributionStopAge parses and clamps the same way as retirement-model', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo`);
      assert.equal(calls.getMonteCarloProjection.contributionStopAge, null);
      await fetch(`${base}/api/data/monte-carlo?contributionStopAge=200`);
      assert.equal(calls.getMonteCarloProjection.contributionStopAge, 120);
    });
  });

  test('traditionalAccountIds/rothAccountIds/fireFilingStatus come from config, not query overrides', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo?fireFilingStatus=marriedJointly`);
      assert.deepEqual(calls.getMonteCarloProjection.traditionalAccountIds, ['acc-trad']);
      assert.deepEqual(calls.getMonteCarloProjection.rothAccountIds, ['acc-roth']);
      // Unlike fire-progress/retirement-model, the Monte Carlo page has no
      // filing-status query override of its own -- always config's value.
      assert.equal(calls.getMonteCarloProjection.fireFilingStatus, 'single');
    });
  });

  test('omitting all three contribution fields keeps annualContribution null ("use my real pace")', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo`);
      assert.equal(calls.getMonteCarloProjection.annualContribution, null);
    });
  });

  test('providing any one contribution field switches to an explicit scenario, treating the others as 0', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo?contribution401k=20000`);
      assert.equal(calls.getMonteCarloProjection.annualContribution, 20000);
    });
  });
});

describe('GET /api/data/monte-carlo/compare', () => {
  test('reuses the same parseMonteCarloParams parsing/clamping', async () => {
    const { app, calls } = freshApp(BASE_CONFIG);
    await withServer(app, async (base) => {
      await fetch(`${base}/api/data/monte-carlo/compare?paths=50&retireAge=58`);
      assert.equal(calls.getMonteCarloCompare.retireAge, 58);
      // Compare caps at 1500 even if a (clamped) paths value is higher.
      assert.ok(calls.getMonteCarloCompare.paths <= 1500);
    });
  });
});
