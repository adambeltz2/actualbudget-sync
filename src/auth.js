const crypto = require('crypto');
const { getConfig } = require('./config');

const SESSION_COOKIE = 'abs_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Routes reachable without a session: the login page itself and the two
// endpoints it calls to check setup state and authenticate.
const PUBLIC_PATHS = new Set(['/login.html', '/api/auth/status', '/api/auth/login']);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(derived, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signSession(secret, expiresAt) {
  const payload = String(expiresAt);
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifySession(secret, token) {
  if (!token || !token.includes('.')) return false;
  const [payload, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  return Number(payload) > Date.now();
}

// In-memory login rate limiting, keyed by client IP. Resets on process
// restart — acceptable for a single-instance, single-user dashboard; the
// goal is slowing down an automated guesser, not surviving a restart.
const LOGIN_ATTEMPT_LIMIT = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const loginAttempts = new Map();

function isLoginLocked(ip) {
  const state = loginAttempts.get(ip);
  return !!(state && state.lockedUntil > Date.now());
}

function loginLockRemainingMs(ip) {
  const state = loginAttempts.get(ip);
  return state ? Math.max(0, state.lockedUntil - Date.now()) : 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  let state = loginAttempts.get(ip);
  if (!state || now - state.windowStart > LOGIN_WINDOW_MS) {
    state = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  state.count += 1;
  if (state.count >= LOGIN_ATTEMPT_LIMIT) {
    state.lockedUntil = now + LOGIN_LOCKOUT_MS;
  }
  loginAttempts.set(ip, state);
}

function recordLoginSuccess(ip) {
  loginAttempts.delete(ip);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  const config = getConfig();
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];

  if (config.dashboardPasswordHash && verifySession(config.sessionSecret, token)) {
    return next();
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return res.redirect('/login.html');
}

module.exports = {
  SESSION_COOKIE, SESSION_TTL_MS,
  hashPassword, verifyPassword, signSession, verifySession, parseCookies,
  requireAuth,
  isLoginLocked, loginLockRemainingMs, recordLoginFailure, recordLoginSuccess
};
