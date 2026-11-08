import { mkdtempSync, writeFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { SecretBox, totpCode, totpStep } from '../platform/crypto/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Emergency admin sign-in over real HTTP (PRD 6.6, 9): Argon2id password plus an
 * authenticator code, one use per code, lockout, identical failures, audit and alerts.
 */

const WEB_ORIGIN = 'http://localhost:5174';
const ONE = 'emergency.one@adasglobuspro.example.com';
const TWO = 'emergency.two@adasglobuspro.example.com';

let db: DatabaseService;
let base: string;
let close: () => Promise<void>;
let services: ReturnType<typeof createAppServer>['services'];
const creds = new Map<string, { password: string; totpSecret: string }>();
let usedCode = '';

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adas-bg-'));
  const secretFile = path.join(dir, 'session_secret.txt');
  writeFileSync(secretFile, 's'.repeat(64));
  const env = validateEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'fatal',
    PUBLIC_WEB_URL: WEB_ORIGIN,
    SESSION_SECRET_FILE: secretFile,
  });
  db = DatabaseService.forTests();
  const app = createAppServer(env, db, { secretBox: SecretBox.ephemeral() });
  services = app.services;
  await db.ensureInitialized();
  await new Promise<void>((resolve) => app.server.listen(0, resolve));
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => app.server.close(() => resolve()));
  // Two synthetic Admins invited for emergency use; the second is set up later.
  await db.query(
    `INSERT INTO users (id, email, name, role_id, team_id, market_focus, status)
     VALUES ('usr_bg_1', $1, 'Emergency Admin One', 'role_admin', NULL, 'US', 'invited'),
            ('usr_bg_2', $2, 'Emergency Admin Two', 'role_admin', NULL, 'US', 'active'),
            ('usr_bg_3', 'emergency.three@adasglobuspro.example.com', 'Emergency Admin Three',
             'role_admin', NULL, 'US', 'active')`,
    [ONE, TWO],
  );
});

afterAll(async () => {
  await close();
  await db.close();
});

function cred(email: string): { password: string; totpSecret: string } {
  const found = creds.get(email);
  if (!found) throw new Error(`no credentials set up for ${email}`);
  return found;
}

function code(email: string): string {
  return totpCode(cred(email).totpSecret, totpStep(Date.now()));
}

/** A code that hasn't been used yet: forgets the account's last used step first. */
async function freshCode(email: string, userId: string): Promise<string> {
  await db.query(`UPDATE local_credentials SET totp_last_step = NULL WHERE user_id = $1`, [userId]);
  return code(email);
}

function signIn(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/auth/local/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function auditActions(entityId: string | null, action: string) {
  const res = await db.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM audit_logs WHERE action = $1
       AND entity_id IS NOT DISTINCT FROM $2 ORDER BY created_at`,
    [action, entityId],
  );
  return res.rows;
}

async function securityAlerts(title: string) {
  const res = await db.query<{ user_id: string }>(
    `SELECT user_id FROM notifications WHERE kind = 'security' AND title = $1 ORDER BY user_id`,
    [title],
  );
  return res.rows.map((r) => r.user_id);
}

describe('setting up emergency sign-in', () => {
  it('stores only an Argon2id hash and an encrypted secret, and alerts every admin', async () => {
    const setup = await services.breakGlass.setUp(ONE.toUpperCase());
    creds.set(ONE, setup);
    expect(setup.email).toBe(ONE);
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\/ADAS%20CRM%3Aemergency\.one%40/);

    const row = await db.query<{ password_hash: string; totp_secret_ciphertext: string }>(
      `SELECT password_hash, totp_secret_ciphertext FROM local_credentials WHERE user_id = 'usr_bg_1'`,
    );
    expect(row.rows[0]?.password_hash).toMatch(/^\$argon2id\$/);
    expect(row.rows[0]?.password_hash).not.toContain(setup.password);
    expect(row.rows[0]?.totp_secret_ciphertext).not.toContain(setup.totpSecret);
    const user = await db.query<{ is_break_glass: boolean }>(
      `SELECT is_break_glass FROM users WHERE id = 'usr_bg_1'`,
    );
    expect(user.rows[0]?.is_break_glass).toBe(true);
    expect(await auditActions('usr_bg_1', 'auth.break_glass.credentials_set')).toHaveLength(1);
    // Every active Admin, including the seeded one; not the still-invited account itself.
    expect(await securityAlerts('Emergency admin credentials set')).toEqual([
      'usr_admin_1',
      'usr_bg_2',
      'usr_bg_3',
    ]);
  });

  it('only for Admins, and for at most two accounts', async () => {
    await expect(services.breakGlass.setUp('arjun@adasglobuspro.example.com')).rejects.toThrow(
      /Admin role/,
    );
    await expect(services.breakGlass.setUp('nobody@adasglobuspro.example.com')).rejects.toThrow(
      /No CRM user/,
    );
    creds.set(TWO, await services.breakGlass.setUp(TWO));
    await expect(
      services.breakGlass.setUp('emergency.three@adasglobuspro.example.com'),
    ).rejects.toThrow(/already 2/);
  });
});

describe('signing in (PRD 6.6)', () => {
  it('starts a session with the password and a current code, and alerts every admin', async () => {
    usedCode = code(ONE);
    const res = await signIn({
      email: ONE,
      password: cred(ONE).password,
      totpCode: usedCode,
    });
    expect(res.status).toBe(200);
    const cookie = /adas_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    expect(cookie).toBeTruthy();
    const me = await fetch(`${base}/api/v1/auth/me`, {
      headers: { Cookie: `adas_session=${cookie}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: 'usr_bg_1', role: 'Admin' });

    // The invited account is active from its first sign-in.
    const user = await db.query<{ status: string }>(
      `SELECT status FROM users WHERE id = 'usr_bg_1'`,
    );
    expect(user.rows[0]?.status).toBe('active');
    const signedIn = await db.query(
      `SELECT 1 FROM audit_logs WHERE action = 'auth.signed_in.break_glass' AND actor_user_id = 'usr_bg_1'`,
    );
    expect(signedIn.rows).toHaveLength(1);
    expect(await securityAlerts('Emergency admin sign-in used')).toEqual([
      'usr_admin_1',
      'usr_bg_1',
      'usr_bg_2',
      'usr_bg_3',
    ]);
  });

  it('refuses the same code a second time', async () => {
    const res = await signIn({
      email: ONE,
      password: cred(ONE).password,
      totpCode: usedCode,
    });
    expect(res.status).toBe(401);
  });

  it('answers every failure the same way and never stores the attempted email', async () => {
    const answers = await Promise.all([
      signIn({ email: 'someone@example.com', password: 'whatever', totpCode: '123456' }),
      signIn({ email: ONE, password: 'wrong-password', totpCode: code(ONE) }),
      signIn({ email: ONE, password: cred(ONE).password, totpCode: '000000' }),
    ]);
    const bodies = await Promise.all(
      answers.map(async (r) => {
        const body = (await r.json()) as Record<string, unknown>;
        return { status: r.status, code: body['code'], detail: body['detail'] };
      }),
    );
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ status: 401, code: 'SIGN_IN_FAILED' });

    const reasons = (await auditActions(null, 'auth.break_glass.failed')).map(
      (r) => r.metadata['reason'],
    );
    expect(reasons).toEqual(['unknown_account']);
    const all = await db.query<{ text: string }>(`SELECT metadata::text AS text FROM audit_logs`);
    expect(all.rows.some((r) => r.text.includes('someone@example.com'))).toBe(false);
    const forOne = (await auditActions('usr_bg_1', 'auth.break_glass.failed')).map(
      (r) => r.metadata['reason'],
    );
    expect(forOne).toEqual(expect.arrayContaining(['bad_password', 'bad_code']));
  });

  it('locks after five wrong tries, even for the right password, and alerts every admin', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await signIn({ email: TWO, password: 'nope', totpCode: code(TWO) })).status).toBe(
        401,
      );
    }
    const locked = { email: TWO, password: cred(TWO).password, totpCode: code(TWO) };
    expect((await signIn(locked)).status).toBe(401);
    expect(await auditActions('usr_bg_2', 'auth.break_glass.locked')).toHaveLength(1);
    expect(await securityAlerts('Emergency admin account locked')).toHaveLength(4);
    const reasons = (await auditActions('usr_bg_2', 'auth.break_glass.failed')).map(
      (r) => r.metadata['reason'],
    );
    expect(reasons.at(-1)).toBe('locked');

    // When the lock runs out the right details work again and the count starts over.
    await db.query(
      `UPDATE local_credentials SET locked_until = NOW() - INTERVAL '1 minute' WHERE user_id = 'usr_bg_2'`,
    );
    const right = { ...locked, totpCode: await freshCode(TWO, 'usr_bg_2') };
    expect((await signIn(right)).status).toBe(200);
    const after = await db.query<{ failed_attempts: number; locked_until: string | null }>(
      `SELECT failed_attempts, locked_until FROM local_credentials WHERE user_id = 'usr_bg_2'`,
    );
    expect(after.rows[0]).toEqual({ failed_attempts: 0, locked_until: null });
  });

  it('refuses a deactivated account', async () => {
    await db.query(`UPDATE users SET status = 'disabled' WHERE id = 'usr_bg_1'`);
    const res = await signIn({
      email: ONE,
      password: cred(ONE).password,
      totpCode: await freshCode(ONE, 'usr_bg_1'),
    });
    expect(res.status).toBe(401);
    const reasons = (await auditActions('usr_bg_1', 'auth.break_glass.failed')).map(
      (r) => r.metadata['reason'],
    );
    expect(reasons.at(-1)).toBe('not_allowed');
    await db.query(`UPDATE users SET status = 'active' WHERE id = 'usr_bg_1'`);
  });

  it('needs the CRM web app as origin and checks the fields', async () => {
    const noOrigin = await fetch(`${base}/api/v1/auth/local/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ONE, password: 'x', totpCode: '123456' }),
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { code: string }).code).toBe('CSRF_ORIGIN_REJECTED');

    const bad = await signIn({ email: 'not-an-email', password: '', totpCode: '12' });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { fieldErrors: Record<string, string[]> }).fieldErrors).toEqual({
      email: ['Enter the account’s email address'],
      password: ['Enter the password'],
      totpCode: ['Enter the 6-digit code from your authenticator app'],
    });
  });

  it('removing the credentials ends the sessions and stops sign-in', async () => {
    const before = await db.query(
      `SELECT 1 FROM sessions WHERE user_id = 'usr_bg_2' AND revoked_at IS NULL`,
    );
    expect(before.rows.length).toBeGreaterThan(0);
    await services.breakGlass.remove(TWO);
    const live = await db.query(
      `SELECT 1 FROM sessions WHERE user_id = 'usr_bg_2' AND revoked_at IS NULL`,
    );
    expect(live.rows).toHaveLength(0);
    expect(await auditActions('usr_bg_2', 'auth.break_glass.credentials_removed')).toHaveLength(1);
    const res = await signIn({
      email: TWO,
      password: cred(TWO).password,
      totpCode: code(TWO),
    });
    expect(res.status).toBe(401);
  });

  it('slows down a network that keeps guessing', async () => {
    let status = 0;
    for (let i = 0; i < 25 && status !== 429; i += 1) {
      status = (await signIn({ email: 'guess@example.com', password: 'x', totpCode: '111111' }))
        .status;
    }
    expect(status).toBe(429);
  });
});

describe('without an encryption key', () => {
  it('says admin sign-in is unavailable instead of failing later', async () => {
    const app = createAppServer(
      validateEnv({ NODE_ENV: 'test', LOG_LEVEL: 'fatal', PUBLIC_WEB_URL: WEB_ORIGIN }),
      db,
      { secretBox: null },
    );
    await new Promise<void>((resolve) => app.server.listen(0, resolve));
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api/v1/auth`;
    try {
      const config = await fetch(`${url}/config`);
      expect(((await config.json()) as { adminSignIn: boolean }).adminSignIn).toBe(false);
      const res = await fetch(`${url}/local/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
        body: JSON.stringify({ email: ONE, password: 'x', totpCode: '123456' }),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('BREAK_GLASS_UNAVAILABLE');
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
  });
});
