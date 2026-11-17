import { createHash, createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Milestone 2 Security & Authentication Penetration Suite (PRD 2.2, 4.14, 6.5, 6.6, 6.7, 9).
 * Covers: CSP & HSTS headers, unauthenticated blocking, RBAC privilege escalation, IDOR &
 * cross-team isolation, session expiry/idle/revocation, session fixation, CSRF Origin checks,
 * Cloudflare Access JWT enforcement, scoped Bearer API tokens, directory email redaction, and
 * internal-only /api/docs.
 */

const WEB_ORIGIN = 'http://localhost:5174';

let db: DatabaseService;
let baseUrl = '';
let serverPort = 0;
let serverClose: (() => Promise<void>) | null = null;

async function signInSession(
  url: string,
  userId: string,
  existingCookie?: string,
): Promise<{ cookie: string; rawToken: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: WEB_ORIGIN,
  };
  if (existingCookie) headers['Cookie'] = existingCookie;
  const res = await fetch(`${url}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const pair = setCookie.split(';')[0] ?? '';
  const rawToken = decodeURIComponent(pair.split('=')[1] ?? '');
  return { cookie: pair, rawToken };
}

function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

describe('Milestone 2: authentication, authorization & HTTP security hardening', () => {
  let adminCookie = '';
  let usManagerCookie = '';
  let usBdrCookie = '';
  let caBdrCookie = '';
  let analystCookie = '';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    const env = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      MAIL_LIVE: 'false',
    });
    const app = createAppServer(env, db);
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    serverPort = addr.port;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    serverClose = () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      );

    adminCookie = (await signInSession(baseUrl, 'usr_admin_1')).cookie;
    usManagerCookie = (await signInSession(baseUrl, 'usr_mgr_1')).cookie;
    usBdrCookie = (await signInSession(baseUrl, 'usr_bdr_2')).cookie;
    caBdrCookie = (await signInSession(baseUrl, 'usr_bdr_1')).cookie;
    analystCookie = (await signInSession(baseUrl, 'usr_ro_1')).cookie;
  });

  afterAll(async () => {
    if (serverClose) await serverClose();
    if (db) await db.close();
  });

  it('applies strict CSP, X-Content-Type-Options, X-Frame-Options, Permissions-Policy and X-Request-Id on responses (PRD 9)', async () => {
    const unauth = await fetch(`${baseUrl}/api/v1/leads`, {
      headers: { 'X-Request-Id': 'req_audit_check_01' },
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('x-request-id')).toBe('req_audit_check_01');
    expect(unauth.headers.get('x-content-type-options')).toBe('nosniff');
    expect(unauth.headers.get('x-frame-options')).toBe('DENY');
    expect(unauth.headers.get('permissions-policy')).toContain('camera=()');
    expect(unauth.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const problem = (await unauth.json()) as { requestId: string; code: string };
    expect(problem.requestId).toBe('req_audit_check_01');
    expect(problem.code).toBe('UNAUTHENTICATED');
  });

  it('prevents session fixation, enforces idle & absolute expiry, and revokes sessions on deactivation (PRD 6.6)', async () => {
    // 1. Session fixation: signing in while holding an existing session cookie revokes the old session
    const first = await signInSession(baseUrl, 'usr_bdr_2');
    const second = await signInSession(baseUrl, 'usr_mgr_1', first.cookie);
    expect(second.rawToken).not.toBe(first.rawToken);

    const oldSessionCheck = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: first.cookie },
    });
    expect(oldSessionCheck.status).toBe(401);

    // 2. Idle timeout enforcement: backdate last_seen_at beyond 12 hours -> 401
    const idleSession = await signInSession(baseUrl, 'usr_bdr_2');
    await db.query(`UPDATE sessions SET last_seen_at = NOW() - INTERVAL '13 hours' WHERE id = $1`, [
      hashSessionToken(idleSession.rawToken),
    ]);
    const idleCheck = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: idleSession.cookie },
    });
    expect(idleCheck.status).toBe(401);

    // 3. Absolute expiry enforcement: backdate expires_at -> 401
    const expiredSession = await signInSession(baseUrl, 'usr_bdr_2');
    await db.query(`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [
      hashSessionToken(expiredSession.rawToken),
    ]);
    const expCheck = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: expiredSession.cookie },
    });
    expect(expCheck.status).toBe(401);
  });

  it('blocks CSRF attacks on state-changing cookie requests without matching Origin (PRD 6.6, 9)', async () => {
    const noOrigin = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: { Cookie: usManagerCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Csrf',
        lastName: 'Attempt',
        email: 'csrf@attempt.example.com',
      }),
    });
    expect(noOrigin.status).toBe(403);
    expect(((await noOrigin.json()) as { code: string }).code).toBe('CSRF_ORIGIN_REJECTED');

    const wrongOrigin = await fetch(`${baseUrl}/api/v1/me/preferences`, {
      method: 'PATCH',
      headers: {
        Cookie: usManagerCookie,
        Origin: 'https://attacker.example.org',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ timezone: 'UTC' }),
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it('blocks privilege escalation, IDOR, cross-team access on sequences/campaigns, and redacts employee emails for non-admins (PRD 2.2, 9)', async () => {
    // 1. Read-Only Analyst cannot write leads, manage settings, or manage users
    const analystCreate = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: {
        Cookie: analystCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Blocked',
        lastName: 'Write',
        email: 'blocked@write.example.com',
      }),
    });
    expect(analystCreate.status).toBe(403);

    // 2. Non-admin `/api/v1/users` redacts employee email addresses; admin sees them
    const bdrUsersRes = await fetch(`${baseUrl}/api/v1/users`, {
      headers: { Cookie: usBdrCookie },
    });
    const bdrUsers = (await bdrUsersRes.json()) as { items: Array<{ email: string }> };
    expect(bdrUsers.items.every((u) => u.email === '')).toBe(true);

    const adminUsersRes = await fetch(`${baseUrl}/api/v1/users`, {
      headers: { Cookie: adminCookie },
    });
    const adminUsers = (await adminUsersRes.json()) as { items: Array<{ email: string }> };
    expect(adminUsers.items.some((u) => u.email.includes('@'))).toBe(true);

    // 3. IDOR: CA BDR (`usr_bdr_1`, own scope) cannot read, edit or delete US Manager's lead `lead_jane`
    const idorRead = await fetch(`${baseUrl}/api/v1/leads/lead_jane`, {
      headers: { Cookie: caBdrCookie },
    });
    expect(idorRead.status).toBe(404);

    const idorPatch = await fetch(`${baseUrl}/api/v1/leads/lead_jane`, {
      method: 'PATCH',
      headers: {
        Cookie: caBdrCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ version: 1, title: 'Tampered' }),
    });
    expect(idorPatch.status).toBe(404);

    // 4. Cross-team sequence scoping: CA BDR (`team_ca`, sequences.read = 'team') does NOT see `team_us` sequence `seq_us_cpa_trial`
    const caSeqRes = await fetch(`${baseUrl}/api/v1/sequences`, {
      headers: { Cookie: caBdrCookie },
    });
    expect(caSeqRes.status).toBe(200);
    const caSeqs = (await caSeqRes.json()) as { items: Array<{ id: string; team_id: string }> };
    expect(caSeqs.items.some((s) => s.id === 'seq_us_cpa_trial')).toBe(false);

    // US BDR (`team_us`, sequences.read = 'team') DOES see `seq_us_cpa_trial`, and cannot read campaigns
    const usSeqRes = await fetch(`${baseUrl}/api/v1/sequences`, {
      headers: { Cookie: usBdrCookie },
    });
    const usSeqs = (await usSeqRes.json()) as { items: Array<{ id: string }> };
    expect(usSeqs.items.some((s) => s.id === 'seq_us_cpa_trial')).toBe(true);

    const bdrCampRes = await fetch(`${baseUrl}/api/v1/campaigns`, {
      headers: { Cookie: usBdrCookie },
    });
    expect(bdrCampRes.status).toBe(403);
  });

  it('authenticates scoped Bearer API tokens without Origin CSRF, enforces capability/scope ceilings, and revokes cleanly (PRD 4.14, 9)', async () => {
    // Non-admin cannot create API tokens
    const forbiddenCreate = await fetch(`${baseUrl}/api/v1/admin/api-tokens`, {
      method: 'POST',
      headers: {
        Cookie: usManagerCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Unauthorized token',
        capabilities: ['leads.read'],
        scopeLevel: 'team',
      }),
    });
    expect(forbiddenCreate.status).toBe(403);

    // Admin creates a read-only `leads.read` token restricted to `team` scope
    const createRes = await fetch(`${baseUrl}/api/v1/admin/api-tokens`, {
      method: 'POST',
      headers: {
        Cookie: adminCookie,
        Origin: WEB_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'n8n Lead Reader',
        capabilities: ['leads.read'],
        scopeLevel: 'team',
        expiresInDays: 30,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      secretToken: string;
      token: { id: string; tokenPrefix: string };
    };
    expect(created.secretToken).toMatch(/^adas_pat_[a-f0-9]{48}$/);

    // Token list never exposes secretToken
    const listRes = await fetch(`${baseUrl}/api/v1/admin/api-tokens`, {
      headers: { Cookie: adminCookie },
    });
    const listBody = await listRes.text();
    expect(listBody).not.toContain(created.secretToken);
    expect(listBody).toContain(created.token.tokenPrefix);

    // Token can read team_us leads without a cookie or Origin header
    const tokenLeadsRes = await fetch(`${baseUrl}/api/v1/leads`, {
      headers: { Authorization: `Bearer ${created.secretToken}` },
    });
    expect(tokenLeadsRes.status).toBe(200);
    const tokenLeads = (await tokenLeadsRes.json()) as { items: Array<{ owner_user_id: string }> };
    // Admin is on team_us; because token scopeLevel is 'team', CA lead owned by usr_bdr_1 is excluded!
    expect(tokenLeads.items.some((l) => l.owner_user_id === 'usr_bdr_1')).toBe(false);

    // Token CANNOT write leads or read contacts (outside its granted capabilities, even though creator is Admin!)
    const tokenWriteLead = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${created.secretToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Denied',
        lastName: 'TokenWrite',
        email: 'denied@token.example.com',
      }),
    });
    expect(tokenWriteLead.status).toBe(403);

    const tokenReadContacts = await fetch(`${baseUrl}/api/v1/contacts`, {
      headers: { Authorization: `Bearer ${created.secretToken}` },
    });
    expect(tokenReadContacts.status).toBe(403);

    // Revoking the token invalidates it immediately (401)
    const revokeRes = await fetch(`${baseUrl}/api/v1/admin/api-tokens/${created.token.id}/revoke`, {
      method: 'POST',
      headers: { Cookie: adminCookie, Origin: WEB_ORIGIN },
    });
    expect(revokeRes.status).toBe(200);

    const afterRevoke = await fetch(`${baseUrl}/api/v1/leads`, {
      headers: { Authorization: `Bearer ${created.secretToken}` },
    });
    expect(afterRevoke.status).toBe(401);
  });

  it('serves /api/docs on crm. to authenticated users while hiding it on go. (PRD 6.5, 6.7)', async () => {
    const unauthDocs = await fetch(`${baseUrl}/api/docs`);
    expect(unauthDocs.status).toBe(401);

    const jsonDocs = await fetch(`${baseUrl}/api/docs.json`, {
      headers: { Cookie: usBdrCookie },
    });
    expect(jsonDocs.status).toBe(200);
    const spec = (await jsonDocs.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.paths['/admin/api-tokens']).toBeTruthy();

    const htmlDocs = await fetch(`${baseUrl}/api/docs`, {
      headers: { Cookie: usBdrCookie, Accept: 'text/html' },
    });
    expect(htmlDocs.status).toBe(200);
    expect(await htmlDocs.text()).toContain('ADAS CRM API');

    // Blocked on go.adasglobuspro.com
    const goDocsStatus = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port: serverPort,
          method: 'GET',
          path: '/api/docs',
          headers: { Host: 'go.adasglobuspro.com', Cookie: adminCookie },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(goDocsStatus).toBe(404);
  });

  it('enforces Cloudflare Access JWT assertion on crm. and HSTS + disabled dev-login in production mode (PRD 6.5, 6.6, 9)', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;
    const nowSec = Math.floor(Date.now() / 1000);

    const prodEnv = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      CF_ACCESS_ENFORCE: 'true',
      CF_ACCESS_TEAM_DOMAIN: 'adasglobuspro.cloudflareaccess.com',
      CF_ACCESS_AUD: 'aud_crm_12345',
      API_RATE_LIMIT_PER_MIN: '3',
      MAIL_LIVE: 'false',
    });

    const cfApp = createAppServer(prodEnv, db, {
      cfAccessJwksLoader: async () => ({ keys: [{ ...jwk, kid: 'cf_key_1', alg: 'RS256' }] }),
    });
    await new Promise<void>((resolve) => {
      cfApp.server.listen(0, '127.0.0.1', () => resolve());
    });
    const cfPort = (cfApp.server.address() as AddressInfo).port;
    const cfUrl = `http://127.0.0.1:${cfPort}`;

    try {
      // Missing Cf-Access-Jwt-Assertion on crm. -> 403 CF_ACCESS_DENIED
      const blocked = await fetch(`${cfUrl}/api/v1/auth/config`);
      expect(blocked.status).toBe(403);
      expect(((await blocked.json()) as { code: string }).code).toBe('CF_ACCESS_DENIED');

      // Valid Cf-Access-Jwt-Assertion -> 200
      const headerB64 = Buffer.from(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'cf_key_1' }),
      ).toString('base64url');
      const bodyB64 = Buffer.from(
        JSON.stringify({
          sub: 'oid_ved',
          email: 'ved@adasglobuspro.com',
          iss: 'https://adasglobuspro.cloudflareaccess.com',
          aud: 'aud_crm_12345',
          exp: nowSec + 300,
        }),
      ).toString('base64url');
      const signer = createSign('RSA-SHA256');
      signer.update(`${headerB64}.${bodyB64}`);
      signer.end();
      const validAssertion = `${headerB64}.${bodyB64}.${signer.sign(privateKey).toString('base64url')}`;

      const allowed = await fetch(`${cfUrl}/api/v1/auth/config`, {
        headers: { 'Cf-Access-Jwt-Assertion': validAssertion },
      });
      expect(allowed.status).toBe(200);

      // Per-user API rate limit (API_RATE_LIMIT_PER_MIN = 3): 4th authenticated call returns 429
      const loginRes = await fetch(`${cfUrl}/api/v1/auth/dev-login`, {
        method: 'POST',
        headers: {
          'Cf-Access-Jwt-Assertion': validAssertion,
          'Content-Type': 'application/json',
          Origin: WEB_ORIGIN,
        },
        body: JSON.stringify({ userId: 'usr_bdr_2' }),
      });
      const rateCookie = (loginRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

      for (let i = 0; i < 3; i += 1) {
        const ok = await fetch(`${cfUrl}/api/v1/auth/me`, {
          headers: { 'Cf-Access-Jwt-Assertion': validAssertion, Cookie: rateCookie },
        });
        expect(ok.status).toBe(200);
      }
      const rateLimited = await fetch(`${cfUrl}/api/v1/auth/me`, {
        headers: { 'Cf-Access-Jwt-Assertion': validAssertion, Cookie: rateCookie },
      });
      expect(rateLimited.status).toBe(429);
      expect(rateLimited.headers.get('retry-after')).toBe('60');
    } finally {
      await new Promise<void>((resolve) => cfApp.server.close(() => resolve()));
    }
  });
});
