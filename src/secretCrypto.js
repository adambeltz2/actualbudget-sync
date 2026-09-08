const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

// Only encrypts when CONFIG_ENCRYPTION_KEY is set, so upgrading doesn't break
// existing plaintext config.json files. The key itself never touches disk.
function getKey() {
  const secret = process.env.CONFIG_ENCRYPTION_KEY;
  if (!secret) return null;
  return crypto.scryptSync(secret, 'actualbudget-sync-config', 32);
}

function encrypt(plainText) {
  if (!plainText || plainText.startsWith(PREFIX)) return plainText;
  const key = getKey();
  if (!key) return plainText;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decrypt(value) {
  if (!value || !value.startsWith(PREFIX)) return value;
  const key = getKey();
  if (!key) return value;

  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function isEncryptionEnabled() {
  return !!process.env.CONFIG_ENCRYPTION_KEY;
}

module.exports = { encrypt, decrypt, isEncryptionEnabled };
