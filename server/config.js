import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Load .env if present (Node 22 built-in, no dotenv needed)
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* no .env file */ }

export const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

// APP_SECRET encrypts stored credentials (SMTP/IMAP passwords, Apollo key) and signs tracking links.
// If not provided, one is generated once and kept in data/.app-secret.
function loadSecret() {
  if (process.env.APP_SECRET) return process.env.APP_SECRET;
  const file = path.join(DATA_DIR, '.app-secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

const port = Number(process.env.PORT || 3000);

export const config = {
  port,
  host: process.env.HOST || '0.0.0.0',
  // Public URL of the CRM. Needed for open/click tracking and unsubscribe links in emails.
  baseUrl: (process.env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  secret: loadSecret(),
  dbFile: path.join(DATA_DIR, 'crm.db'),
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 60_000),
  imapIntervalMin: Number(process.env.IMAP_INTERVAL_MIN || 5),
  trustProxy: process.env.TRUST_PROXY === 'true',
  secureCookies: process.env.SECURE_COOKIES === 'true',
};
