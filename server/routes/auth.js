import { get, all, run, insert, update } from '../db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, publicUser, requireAuth, requireRole, ROLES,
  checkLoginThrottle, recordLoginFailure, clearLoginFailures,
} from '../auth.js';
import { saveSettings, getSettings } from '../settings.js';
import { Router, HttpError, now, required, isEmail, pick } from '../util.js';

export const authRoutes = Router();

authRoutes.get('/status', (req, res) => {
  const users = get('SELECT COUNT(*) AS n FROM users').n;
  res.json({ needs_setup: users === 0, company: getSettings('company').name });
});

// First run: create the admin account.
authRoutes.post('/setup', (req, res) => {
  if (get('SELECT COUNT(*) AS n FROM users').n > 0) throw new HttpError(409, 'Setup is already complete');
  const { name, email, password, company_name: companyName } = req.body || {};
  required(req.body || {}, ['name', 'email', 'password']);
  if (!isEmail(email)) throw new HttpError(400, 'Enter a valid email address');
  const id = insert('users', {
    name: String(name).trim(), email: String(email).trim().toLowerCase(), password_hash: hashPassword(password),
    role: 'admin', created_at: now(),
  });
  if (companyName) saveSettings('company', { name: companyName });
  createSession(res, id, req);
  res.status(201).json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) });
});

authRoutes.post('/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const throttleKey = `${req.ip}|${email}`;
  checkLoginThrottle(throttleKey);
  const user = get('SELECT * FROM users WHERE email = ?', email);
  if (!user || !user.active || !verifyPassword(req.body?.password, user.password_hash)) {
    recordLoginFailure(throttleKey);
    throw new HttpError(400, 'Wrong email or password');
  }
  clearLoginFailures(throttleKey);
  createSession(res, user.id, req);
  res.json({ user: publicUser(user) });
});

authRoutes.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ user: { ...publicUser(req.user), via: req.user.via || 'session' } });
});

authRoutes.patch('/me', requireAuth, (req, res) => {
  if (!req.user.id) throw new HttpError(400, 'API keys have no profile');
  const patch = pick(req.body, ['name', 'signature']);
  if (req.body.new_password) {
    const me = get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!verifyPassword(req.body.current_password, me.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    patch.password_hash = hashPassword(req.body.new_password);
  }
  if (patch.name !== undefined && !String(patch.name).trim()) throw new HttpError(400, 'Name cannot be empty');
  update('users', req.user.id, patch);
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

// ---------- user management ----------
export const userRoutes = Router();
userRoutes.use(requireAuth);

userRoutes.get('/', (req, res) => {
  res.json({ users: all('SELECT * FROM users ORDER BY active DESC, name').map(publicUser) });
});

userRoutes.post('/', requireRole('admin'), (req, res) => {
  required(req.body, ['name', 'email', 'password']);
  if (!isEmail(req.body.email)) throw new HttpError(400, 'Enter a valid email address');
  const role = ROLES.includes(req.body.role) ? req.body.role : 'sales';
  if (get('SELECT id FROM users WHERE email = ?', req.body.email.trim().toLowerCase())) throw new HttpError(409, 'A user with that email already exists');
  const id = insert('users', {
    name: req.body.name.trim(), email: req.body.email.trim().toLowerCase(), password_hash: hashPassword(req.body.password),
    role, created_at: now(),
  });
  res.status(201).json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) });
});

userRoutes.patch('/:id', requireRole('admin'), (req, res) => {
  const id = Number(req.params.id);
  const user = get('SELECT * FROM users WHERE id = ?', id);
  if (!user) throw new HttpError(404, 'User not found');
  const patch = pick(req.body, ['name', 'role', 'active']);
  if (patch.role && !ROLES.includes(patch.role)) throw new HttpError(400, `Role must be one of ${ROLES.join(', ')}`);
  if ('active' in patch) patch.active = patch.active ? 1 : 0;
  const demoting = (patch.role && patch.role !== 'admin') || patch.active === 0;
  if (user.role === 'admin' && demoting && get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n <= 1) {
    throw new HttpError(400, 'There must be at least one active admin');
  }
  if (req.body.password) patch.password_hash = hashPassword(req.body.password);
  update('users', id, patch);
  if (patch.active === 0) run('DELETE FROM sessions WHERE user_id = ?', id);
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', id)) });
});
