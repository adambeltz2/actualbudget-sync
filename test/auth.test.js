const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword, verifyPassword, signSession, verifySession, parseCookies,
  isLoginLocked, loginLockRemainingMs, recordLoginFailure, recordLoginSuccess
} = require('../src/auth');

describe('hashPassword / verifyPassword', () => {
  test('a password verifies against its own hash', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('correct horse battery staple', hash), true);
  });

  test('the wrong password is rejected', () => {
    const hash = hashPassword('correct horse battery staple');
    assert.equal(verifyPassword('wrong password', hash), false);
  });

  test('two hashes of the same password differ (random salt)', () => {
    const a = hashPassword('same password');
    const b = hashPassword('same password');
    assert.notEqual(a, b);
  });

  test('malformed stored values are rejected rather than throwing', () => {
    assert.equal(verifyPassword('anything', ''), false);
    assert.equal(verifyPassword('anything', 'not-a-valid-hash'), false);
    assert.equal(verifyPassword('anything', null), false);
  });
});

describe('signSession / verifySession', () => {
  test('a freshly signed, unexpired session verifies and defaults to the admin role', () => {
    const token = signSession('secret', Date.now() + 60_000);
    assert.equal(verifySession('secret', token), 'admin');
  });

  test('a viewer-role session verifies as viewer', () => {
    const token = signSession('secret', Date.now() + 60_000, 'viewer');
    assert.equal(verifySession('secret', token), 'viewer');
  });

  test('an expired session is rejected', () => {
    const token = signSession('secret', Date.now() - 1000);
    assert.equal(verifySession('secret', token), false);
  });

  test('a token signed with a different secret is rejected', () => {
    const token = signSession('secret-a', Date.now() + 60_000);
    assert.equal(verifySession('secret-b', token), false);
  });

  test('a tampered payload is rejected', () => {
    const token = signSession('secret', Date.now() + 60_000);
    const [, sig] = token.split('.');
    const tampered = `${Date.now() + 999_999_999}:admin.${sig}`;
    assert.equal(verifySession('secret', tampered), false);
  });

  test('a tampered role is rejected (signature no longer matches)', () => {
    const token = signSession('secret', Date.now() + 60_000, 'viewer');
    const [payload, sig] = token.split('.');
    const [expiresAt] = payload.split(':');
    const tampered = `${expiresAt}:admin.${sig}`;
    assert.equal(verifySession('secret', tampered), false);
  });

  test('malformed or missing tokens are rejected rather than throwing', () => {
    assert.equal(verifySession('secret', ''), false);
    assert.equal(verifySession('secret', undefined), false);
    assert.equal(verifySession('secret', 'no-dot-here'), false);
  });
});

describe('parseCookies', () => {
  test('parses a typical cookie header', () => {
    const cookies = parseCookies('abs_session=abc123; other=xyz');
    assert.equal(cookies.abs_session, 'abc123');
    assert.equal(cookies.other, 'xyz');
  });

  test('URL-decodes cookie values', () => {
    const cookies = parseCookies('name=hello%20world');
    assert.equal(cookies.name, 'hello world');
  });

  test('returns an empty object for a missing header', () => {
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
  });
});

describe('login rate limiting', () => {
  // Each test uses a distinct fake IP since the underlying state is a
  // module-level map shared across the whole test file.
  test('an IP with no recorded attempts is not locked', () => {
    assert.equal(isLoginLocked('10.0.0.1'), false);
    assert.equal(loginLockRemainingMs('10.0.0.1'), 0);
  });

  test('fewer than the limit of failures does not lock the IP', () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < 4; i++) recordLoginFailure(ip);
    assert.equal(isLoginLocked(ip), false);
  });

  test('reaching the failure limit locks the IP with a positive remaining time', () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    assert.equal(isLoginLocked(ip), true);
    assert.ok(loginLockRemainingMs(ip) > 0);
  });

  test('a successful login clears a locked-out IP', () => {
    const ip = '10.0.0.4';
    for (let i = 0; i < 5; i++) recordLoginFailure(ip);
    assert.equal(isLoginLocked(ip), true);
    recordLoginSuccess(ip);
    assert.equal(isLoginLocked(ip), false);
  });

  test('different IPs are tracked independently', () => {
    const lockedIp = '10.0.0.5';
    const cleanIp = '10.0.0.6';
    for (let i = 0; i < 5; i++) recordLoginFailure(lockedIp);
    assert.equal(isLoginLocked(lockedIp), true);
    assert.equal(isLoginLocked(cleanIp), false);
  });
});
