import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AddressInfo } from 'node:net';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Sign-in, sessions, CSRF and sign-out over real HTTP (PRD 6.6, 9).
 */

const WEB_ORIGIN = 'http://localhost:5174';

async function startServer(nodeEnv: 'test' | 'production') {
  const dir = mkdtempSync(path.join(tmpdir(), 'adas-auth-'));
  const secretFile = path.join(dir, 'session_secret.txt');
  writeFileSync(secretFile, 'x'.repeat(64));
  const env = validateEnv({
    NODE_ENV: nodeEnv,
    LOG_LEVEL: 'error',
    PUBLIC_WEB_URL: WEB_ORIGIN,
    SESSION_SECRET_FILE: secretFile,
    ENTRA_CLIENT_SECRET_FILE: path.join(dir, 'missing-entra-secret.txt'),
  });
  const db = DatabaseService.forTests();
  const { server } = createAppServer(env, db);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return { server, db, base: `http://127.0.0.1:${port}` };
}

function sessionCookieFrom(res: Response): string {
  const raw = res.headers.get('set-cookie') ?? '';
  const match = /adas_session=([^;]+)/.exec(raw);
  if (!match) throw new Error(`no session cookie in: ${raw}`);
  return `adas_session=${match[1]}`;
}

describe('sessions and sign-in (development and test mode)', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer('test');
  });
  afterAll(async () => {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
  });

  it('reports which sign-in methods are available', async () => {
    const res = await fetch(`${ctx.base}/api/v1/auth/config`);
    expect(await res.json()).toEqual({ microsoftSignIn: false, devSignIn: true });
  });

  it('refuses API calls without a session, and ignores the old dev header', async () => {
    const res = await fetch(`${ctx.base}/api/v1/leads`, {
      headers: { 'X-Dev-User-Id': 'usr_admin_1' },
    });
    expect(res.status).toBe(401);
  });

  it('sends unconfigured Microsoft sign-in back to the login page with a clear error', async () => {
    const res = await fetch(`${ctx.base}/api/v1/auth/sso/start`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${WEB_ORIGIN}/?screen=login&error=sso_not_configured`,
    );
  });

  it('rejects a Microsoft callback that has no matching sign-in in progress', async () => {
    const res = await fetch(`${ctx.base}/api/v1/auth/sso/callback?code=abc&state=xyz`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/?screen=login&error=');
  });

  it('signs in, enforces CSRF on writes, then signs out everywhere the cookie was used', async () => {
    const login = await fetch(`${ctx.base}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_mgr_1' }),
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const cookie = sessionCookieFrom(login);

    const me = await fetch(`${ctx.base}/api/v1/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { role: string }).role).toBe('Sales Manager');

    // The session is stored hashed, never as the raw token
    const raw = cookie.split('=')[1] ?? '';
    const stored = await ctx.db.query<{ id: string }>('SELECT id FROM sessions');
    expect(stored.rows.some((r) => r.id === raw)).toBe(false);

    const lead = {
      firstName: 'Csrf',
      lastName: 'Check',
      email: 'csrf@check.example.com',
      market: 'US',
    };
    const forged = await fetch(`${ctx.base}/api/v1/leads`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.net',
      },
      body: JSON.stringify(lead),
    });
    expect(forged.status).toBe(403);
    const genuine = await fetch(`${ctx.base}/api/v1/leads`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
      body: JSON.stringify(lead),
    });
    expect(genuine.status).toBe(201);

    const logout = await fetch(`${ctx.base}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie, Origin: WEB_ORIGIN },
    });
    expect(logout.status).toBe(204);
    const after = await fetch(`${ctx.base}/api/v1/auth/me`, { headers: { Cookie: cookie } });
    expect(after.status).toBe(401);
  });

  it('ends a session when the user is deactivated', async () => {
    const login = await fetch(`${ctx.base}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_ae_1' }),
    });
    const cookie = sessionCookieFrom(login);
    await ctx.db.query(`UPDATE users SET status = 'disabled' WHERE id = 'usr_ae_1'`);
    const me = await fetch(`${ctx.base}/api/v1/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(401);
  });
});

describe('sign-in in production mode', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    ctx = await startServer('production');
  });
  afterAll(async () => {
    await new Promise((r) => ctx.server.close(r));
    await ctx.db.close();
  });

  it('has no development sign-in', async () => {
    const config = await fetch(`${ctx.base}/api/v1/auth/config`);
    expect(((await config.json()) as { devSignIn: boolean }).devSignIn).toBe(false);
    const res = await fetch(`${ctx.base}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_admin_1' }),
    });
    expect(res.status).toBe(404);
  });
});
