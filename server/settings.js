import crypto from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db.js';
import { HttpError } from './util.js';

export const MASK = '••••••••';

const serverTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
const env = process.env;

const DEFAULTS = {
  company: {
    name: env.COMPANY_NAME || 'Adas Globus Pro',
    website: env.COMPANY_WEBSITE || 'https://adasglobuspro.com',
    address: '',
    phone: '',
    currency: env.CURRENCY || 'USD',
    timezone: env.TZ || serverTz,
  },
  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from_name: env.SMTP_FROM_NAME || '',
    from_email: env.SMTP_FROM_EMAIL || '',
    reply_to: env.SMTP_REPLY_TO || '',
    dry_run: env.MAIL_DRY_RUN === 'true',
  },
  imap: {
    enabled: env.IMAP_ENABLED === 'true',
    host: env.IMAP_HOST || '',
    port: Number(env.IMAP_PORT || 993),
    secure: env.IMAP_SECURE !== 'false',
    user: env.IMAP_USER || '',
    pass: env.IMAP_PASS || '',
    mailbox: 'INBOX',
  },
  mail: {
    tracking: true,
    rate_per_minute: 20,
    footer:
      '<p style="font-size:12px;color:#8a8a8a;margin-top:24px">{{my_company}}{{my_address_line}}<br>' +
      'Not interested? <a href="{{unsubscribe_url}}" style="color:#8a8a8a">Unsubscribe</a></p>',
    business_start: 9,
    business_end: 18,
    business_days: [1, 2, 3, 4, 5],
  },
  apollo: {
    api_key: env.APOLLO_API_KEY || '',
    reveal_personal_emails: false,
    default_tags: 'apollo',
    default_status: 'lead',
  },
};

const SECRETS = { smtp: ['pass'], imap: ['pass'], apollo: ['api_key'] };
export const SECTIONS = Object.keys(DEFAULTS);

const key = crypto.createHash('sha256').update(`${config.secret}:settings`).digest();

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `enc:v1:${Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64')}`;
}

function decrypt(value) {
  if (!value || !String(value).startsWith('enc:v1:')) return value || '';
  try {
    const raw = Buffer.from(String(value).slice(7), 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return ''; // secret changed: credential must be re-entered
  }
}

function readRaw(section) {
  const row = get('SELECT value FROM settings WHERE key = ?', section);
  if (!row) return {};
  try { return JSON.parse(row.value) || {}; } catch { return {}; }
}

function writeRaw(section, obj) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', section, JSON.stringify(obj));
}

export function getSettings(section) {
  if (!DEFAULTS[section]) throw new HttpError(404, `Unknown settings section: ${section}`);
  const stored = readRaw(section);
  const out = { ...DEFAULTS[section] };
  for (const [k, v] of Object.entries(stored)) {
    if (!(k in DEFAULTS[section])) continue;
    const isSecret = SECRETS[section]?.includes(k);
    const val = isSecret ? decrypt(v) : v;
    // Empty stored secrets fall back to environment-provided defaults
    if (isSecret && !val) continue;
    out[k] = val;
  }
  return out;
}

export function publicSettings(section) {
  const s = getSettings(section);
  for (const f of SECRETS[section] || []) s[f] = s[f] ? MASK : '';
  return s;
}

function coerce(def, v) {
  if (typeof def === 'number') { const n = Number(v); return Number.isFinite(n) ? n : def; }
  if (typeof def === 'boolean') return v === true || v === 'true' || v === 1 || v === '1';
  if (Array.isArray(def)) return Array.isArray(v) ? v : String(v || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => (isNaN(x) ? x : Number(x)));
  return v === null || v === undefined ? '' : String(v);
}

export function saveSettings(section, patch = {}) {
  if (!DEFAULTS[section]) throw new HttpError(404, `Unknown settings section: ${section}`);
  const stored = readRaw(section);
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS[section])) continue;
    if (SECRETS[section]?.includes(k)) {
      if (v === MASK || v === undefined) continue; // unchanged
      stored[k] = encrypt(String(v || '').trim());
    } else {
      stored[k] = coerce(DEFAULTS[section][k], v);
    }
  }
  writeRaw(section, stored);
  return publicSettings(section);
}

// Internal key/value state (not user-editable), e.g. IMAP sync cursor.
export function getState(name, fallback = {}) {
  const row = get('SELECT value FROM settings WHERE key = ?', `state:${name}`);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
export function setState(name, value) {
  writeRaw(`state:${name}`, value);
}

export function publicBaseUrl() {
  return config.baseUrl;
}
