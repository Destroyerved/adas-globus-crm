import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run, insert } from './db.js';
import { HttpError, now, addMs, DAY, sha256, randomToken } from './util.js';

export const SESSION_COOKIE = 'agp_session';
const SESSION_TTL = 30 * DAY;
export const ROLES = ['admin', 'manager', 'sales'];

export function hashPassword(password) {
  if (!password || String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(String(password || ''), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const publicUser = (u) => u && ({
  id: u.id, name: u.name, email: u.email, role: u.role, active: !!u.active,
  signature: u.signature || '', created_at: u.created_at, last_login_at: u.last_login_at,
});

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession(res, userId, req) {
  const token = randomToken(32);
  insert('sessions', {
    token_hash: sha256(token), user_id: userId, created_at: now(), expires_at: addMs(SESSION_TTL),
    ip: req.ip, user_agent: String(req.get('user-agent') || '').slice(0, 200),
  });
  run('UPDATE users SET last_login_at = ? WHERE id = ?', now(), userId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.secureCookies, maxAge: SESSION_TTL, path: '/',
  });
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function createApiKey(name, userId) {
  const key = `agp_${randomToken(30)}`;
  const id = insert('api_keys', { name, key_hash: sha256(key), prefix: key.slice(0, 10), user_id: userId, created_at: now() });
  return { id, key };
}

function resolveUser(req) {
  const authz = req.get('authorization') || '';
  const apiKey = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : req.get('x-api-key');
  if (apiKey) {
    const k = get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0', sha256(apiKey));
    if (!k) throw new HttpError(401, 'Invalid API key');
    if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', now(), k.id);
    const owner = k.user_id ? get('SELECT * FROM users WHERE id = ? AND active = 1', k.user_id) : null;
    // API keys act with admin rights; actions are attributed to the user who created the key.
    return { user: { ...(owner || { id: null, name: 'API', email: '' }), role: 'admin', via: 'api_key', api_key_name: k.name }, viaCookie: false };
  }
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return { user: null };
  const s = get(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`, sha256(token), now());
  return { user: s || null, viaCookie: !!s };
}

export function requireAuth(req, res, next) {
  if (req.user) return next(); // already resolved by an earlier router
  try {
    const { user, viaCookie } = resolveUser(req);
    if (!user) throw new HttpError(401, 'Not signed in');
    // CSRF guard: browser sessions must send the custom header (cross-site forms cannot).
    if (viaCookie && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-agp-request') !== '1') {
      throw new HttpError(403, 'Missing request header');
    }
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

export const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(new HttpError(403, 'You do not have permission for this action'));

// Very small in-memory login throttle.
const attempts = new Map();
export function checkLoginThrottle(key) {
  const entry = attempts.get(key);
  if (entry && entry.count >= 10 && Date.now() - entry.first < 15 * 60_000) {
    throw new HttpError(429, 'Too many login attempts. Try again in 15 minutes.');
  }
}
export function recordLoginFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > 15 * 60_000) attempts.set(key, { count: 1, first: Date.now() });
  else entry.count++;
}
export const clearLoginFailures = (key) => attempts.delete(key);

export function pruneSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}
