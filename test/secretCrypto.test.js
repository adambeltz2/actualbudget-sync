const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// secretCrypto reads process.env.CONFIG_ENCRYPTION_KEY at call time (not at
// require time), so tests can toggle it per-case without re-requiring the module.
const secretCrypto = require('../src/secretCrypto');

describe('secretCrypto with CONFIG_ENCRYPTION_KEY set', () => {
  const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;

  beforeEach(() => { process.env.CONFIG_ENCRYPTION_KEY = 'test-key-for-unit-tests'; });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  test('encrypt then decrypt round-trips to the original value', () => {
    const ciphertext = secretCrypto.encrypt('super-secret-password');
    assert.notEqual(ciphertext, 'super-secret-password');
    assert.match(ciphertext, /^enc:v1:/);
    assert.equal(secretCrypto.decrypt(ciphertext), 'super-secret-password');
  });

  test('encrypting an empty string is a no-op', () => {
    assert.equal(secretCrypto.encrypt(''), '');
  });

  test('encrypting an already-encrypted value is idempotent', () => {
    const once = secretCrypto.encrypt('a value');
    const twice = secretCrypto.encrypt(once);
    assert.equal(once, twice);
  });

  test('decrypting a plain (non-prefixed) value passes it through unchanged', () => {
    assert.equal(secretCrypto.decrypt('plain-text-value'), 'plain-text-value');
  });

  test('isEncryptionEnabled reflects the env var', () => {
    assert.equal(secretCrypto.isEncryptionEnabled(), true);
  });
});

describe('secretCrypto without CONFIG_ENCRYPTION_KEY', () => {
  const ORIGINAL_KEY = process.env.CONFIG_ENCRYPTION_KEY;

  beforeEach(() => { delete process.env.CONFIG_ENCRYPTION_KEY; });
  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.CONFIG_ENCRYPTION_KEY;
    else process.env.CONFIG_ENCRYPTION_KEY = ORIGINAL_KEY;
  });

  test('encrypt is a no-op (plaintext preserved for backward compatibility)', () => {
    assert.equal(secretCrypto.encrypt('a plaintext password'), 'a plaintext password');
  });

  test('isEncryptionEnabled reflects the env var', () => {
    assert.equal(secretCrypto.isEncryptionEnabled(), false);
  });
});
