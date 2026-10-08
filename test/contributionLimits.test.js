const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { limit401k, limitIra, getContributionLimits, LIMITS_YEAR } = require('../src/contributionLimits');

describe('limit401k', () => {
  test('base limit under 50', () => {
    assert.equal(limit401k(35), 23500);
  });
  test('standard catch-up for 50-59', () => {
    assert.equal(limit401k(50), 31000);
    assert.equal(limit401k(59), 31000);
  });
  test('super catch-up for exactly 60-63', () => {
    assert.equal(limit401k(60), 34750);
    assert.equal(limit401k(63), 34750);
  });
  test('reverts to standard catch-up at 64+', () => {
    assert.equal(limit401k(64), 31000);
    assert.equal(limit401k(80), 31000);
  });
  test('treats a missing age as the base limit, not a crash', () => {
    assert.equal(limit401k(null), 23500);
    assert.equal(limit401k(undefined), 23500);
  });
});

describe('limitIra', () => {
  test('base limit under 50', () => {
    assert.equal(limitIra(49), 7000);
  });
  test('catch-up limit at 50+', () => {
    assert.equal(limitIra(50), 8000);
    assert.equal(limitIra(70), 8000);
  });
  test('treats a missing age as the base limit', () => {
    assert.equal(limitIra(null), 7000);
  });
});

describe('getContributionLimits', () => {
  test('bundles both limits plus the year they apply to', () => {
    assert.deepEqual(getContributionLimits(62), { year: LIMITS_YEAR, limit401k: 34750, limitIra: 8000 });
  });
});
