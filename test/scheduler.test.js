const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// applySchedule() wires config into real node-cron jobs -- node-cron's own
// schedule() starts a real recurring timer, which would leak past this
// test's lifetime and keep the process alive, so it's stubbed to just
// record what applySchedule tried to register instead of actually starting
// anything. validate() stays real (it's a pure, side-effect-free check) so
// the invalid-schedule-is-skipped behavior is tested against the real
// cron-syntax rules, not a fake approximation of them. ./config, ./syncJob,
// and ./summaryJob are stubbed the same way (via require.cache) so this
// test never touches the real /data/config.json or requires a live
// @actual-app/api connection -- applySchedule() never calls any of their
// functions itself, it only passes them as callbacks to cron.schedule().
function installFakeCron() {
  const realCron = require('node-cron');
  const scheduled = [];
  const fakeCron = {
    validate: realCron.validate,
    schedule: (expr, fn, opts) => {
      scheduled.push({ expr, opts, fn });
      return { stop: () => {} };
    }
  };
  const resolved = require.resolve('node-cron');
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fakeCron };
  return scheduled;
}

function installFakeConfig(config) {
  const resolved = require.resolve('../src/config');
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true,
    exports: { getConfig: () => config, saveConfig: () => {} }
  };
}

function installFakeJobModules() {
  for (const name of ['../src/syncJob', '../src/summaryJob']) {
    const resolved = require.resolve(name);
    require.cache[resolved] = {
      id: resolved, filename: resolved, loaded: true,
      exports: {
        syncAndReport: async () => {},
        sendSummaryReport: async () => {},
        sendWeeklySummaryReport: async () => {}
      }
    };
  }
}

function loadScheduler() {
  delete require.cache[require.resolve('../src/scheduler')];
  return require('../src/scheduler');
}

describe('applySchedule', () => {
  test('registers one cron job per valid schedule', () => {
    const scheduled = installFakeCron();
    installFakeFixtures({ cronSchedules: ['0 6 * * *', '0 18 * * *'] });
    loadScheduler().applySchedule();

    const syncJobs = scheduled.filter(s => s.expr === '0 6 * * *' || s.expr === '0 18 * * *');
    assert.equal(syncJobs.length, 2);
  });

  test('skips an invalid cron expression rather than throwing', () => {
    const scheduled = installFakeCron();
    installFakeFixtures({ cronSchedules: ['not a cron expression', '0 6 * * *'] });
    assert.doesNotThrow(() => loadScheduler().applySchedule());

    assert.equal(scheduled.some(s => s.expr === 'not a cron expression'), false);
    assert.ok(scheduled.some(s => s.expr === '0 6 * * *'));
  });

  test('no schedules configured registers no sync jobs', () => {
    const scheduled = installFakeCron();
    installFakeFixtures({ cronSchedules: [] });
    loadScheduler().applySchedule();

    assert.equal(scheduled.length, 0);
  });

  test('clamps the Monthly Budget Summary day/hour into valid ranges', () => {
    const scheduled = installFakeCron();
    installFakeFixtures({ cronSchedules: [], enableSummaryEmail: true, summaryEmailDayOfMonth: 31, summaryEmailHour: 26 });
    loadScheduler().applySchedule();

    // Day clamped to 28 (so it fires every month), hour clamped to 23.
    assert.ok(scheduled.some(s => s.expr === '0 23 28 * *'));
  });

  test('builds the Weekly Budget Summary schedule from day-of-week and hour', () => {
    const scheduled = installFakeCron();
    installFakeFixtures({ cronSchedules: [], enableWeeklySummaryEmail: true, weeklySummaryEmailDayOfWeek: 3, weeklySummaryEmailHour: 9 });
    loadScheduler().applySchedule();

    assert.ok(scheduled.some(s => s.expr === '0 9 * * 3'));
  });

  test('disabled summary emails register no summary jobs', () => {
    const scheduled = installFakeCron();
    installFakeFixtures({ cronSchedules: [], enableSummaryEmail: false, enableWeeklySummaryEmail: false });
    loadScheduler().applySchedule();

    assert.equal(scheduled.length, 0);
  });
});

function installFakeFixtures(config) {
  installFakeConfig(config);
  installFakeJobModules();
}
