const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword, verifyPassword, signSession, verifySession, parseCookies
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
  test('a freshly signed, unexpired session verifies', () => {
    const token = signSession('secret', Date.now() + 60_000);
    assert.equal(verifySession('secret', token), true);
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
    const tampered = `${Date.now() + 999_999_999}.${sig}`;
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
