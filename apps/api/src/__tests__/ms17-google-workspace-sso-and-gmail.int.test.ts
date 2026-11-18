import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { ComplianceService } from '../modules/compliance/index.js';
import { InboxService } from '../modules/inbox/index.js';
import { OutreachService } from '../modules/outreach/index.js';
import { validateEnv } from '../platform/config/index.js';
import { SecretBox } from '../platform/crypto/index.js';
import { DatabaseService } from '../platform/db/index.js';
import {
  GoogleGmailMailboxClient,
  MailpitTransport,
  MicrosoftGraphMailboxClient,
} from '../platform/mail-transport/index.js';

/**
 * Dual-Provider Google Workspace + Microsoft 365 Integration Suite (PRD §4.11, §4.12, §6.6, §8.2, §8.3, §15 Q2; ADR 0028):
 * 1. Google Workspace OIDC Authorization Code + PKCE sign-in with RS256 JWKS verification, `email_verified`,
 *    `GOOGLE_ALLOWED_DOMAINS` (`hd`) guard, invite-only matching, and immutable `users.google_subject_id` pinning.
 * 2. Coexistence of Microsoft 365 (`microsoft_graph`) and Google Workspace (`google_gmail`) mailboxes in one team.
 * 3. Gmail REST v1 OAuth2 PKCE connect, AES-256-GCM SecretBox encryption, 90-day initial scan, `users.watch`,
 *    `POST /api/v1/webhooks/google` Pub/Sub push verification & dedup on `go.`, incremental `historyId` sync,
 *    on-demand attachment streaming, DSN `5.1.1` hard-bounce suppression, and sequence reply auto-stop.
 * 4. Live sequence step dispatch via `GoogleGmailMailboxClient` when `NODE_ENV=production` & `MAIL_LIVE=true`
 *    (pointed strictly at loopback mock server), while `NODE_ENV=test` routes strictly to Mailpit.
 */

const WEB_ORIGIN = 'http://localhost:5174';
const ENTRA_TENANT_ID = '11111111-2222-3333-4444-555555555555';
const ENTRA_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const GOOGLE_CLIENT_ID = '999888777666-testworkspace.apps.googleusercontent.com';
const GOOGLE_WEBHOOK_TOKEN = 'goog_pubsub_secret_token_for_int_test_2026';

function toBase64Url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function rawHttpPost(options: {
  port: number;
  path: string;
  hostHeader: string;
  headers?: Record<string, string>;
  body: string;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: 'POST',
        headers: {
          Host: options.hostHeader,
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(options.body)),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
}

async function devSignIn(baseUrl: string, userId: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('Dual-provider Google Workspace SSO & Gmail + Microsoft 365 coexistence (ADR 0028)', () => {
  let db: DatabaseService;
  let baseUrl = '';
  let appPort = 0;
  let mockGoogleUrl = '';
  let mockGraphUrl = '';
  let tempDir = '';
  let googleSecretFile = '';
  let entraSecretFile = '';
  let secretBox: SecretBox;
  let closeApp: (() => Promise<void>) | null = null;
  let closeGoogle: (() => Promise<void>) | null = null;
  let closeGraph: (() => Promise<void>) | null = null;

  let adminCookie = '';
  let bdr1Cookie = '';
  let bdr2Cookie = '';

  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const publicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: 'goog-test-key-1',
    alg: 'RS256',
    use: 'sig',
  };

  function signGoogleIdToken(claims: Record<string, unknown>): string {
    const header = toBase64Url(
      JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'goog-test-key-1' }),
    );
    const payload = toBase64Url(JSON.stringify(claims));
    const signingInput = `${header}.${payload}`;
    const signer = createSign('RSA-SHA256');
    signer.update(signingInput);
    signer.end();
    const signature = toBase64Url(signer.sign(privateKey));
    return `${signingInput}.${signature}`;
  }

  // Mutable mock Google OIDC + Gmail state
  const googleState: {
    nextOidcNonce: string;
    nextOidcClaims: {
      sub: string;
      email: string;
      email_verified: boolean;
      hd?: string;
      name: string;
    };
    profileEmail: string;
    currentHistoryId: string;
    initialMessages: Record<string, Record<string, unknown>>;
    historyAddedIds: string[];
    sentRawPayloads: Array<{ raw: string; threadId?: string }>;
    watchCalls: number;
    attachmentRequests: number;
  } = {
    nextOidcNonce: '',
    nextOidcClaims: {
      sub: 'goog_sub_bdr_2_immutable',
      email: 'marcus@adasglobus.example.com',
      email_verified: true,
      hd: 'adasglobus.example.com',
      name: 'Marcus Vance',
    },
    profileEmail: 'marcus@adasglobus.example.com',
    currentHistoryId: '5000',
    initialMessages: {},
    historyAddedIds: [],
    sentRawPayloads: [],
    watchCalls: 0,
    attachmentRequests: 0,
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'adas-ms17-google-'));
    googleSecretFile = path.join(tempDir, 'google_client_secret.txt');
    entraSecretFile = path.join(tempDir, 'entra_client_secret.txt');
    writeFileSync(googleSecretFile, 'google_client_secret_test_value_123456', 'utf8');
    writeFileSync(entraSecretFile, 'entra_client_secret_test_value_123456', 'utf8');

    // 1. Mock Google OIDC + OAuth2 + Gmail REST v1 server
    const mockGoogle = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && pathname === '/oauth2/v3/certs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ keys: [publicJwk] }));
        return;
      }

      if (method === 'POST' && pathname === '/token') {
        const form = new URLSearchParams(await readBodyText(req));
        const grantType = form.get('grant_type');
        const code = form.get('code') ?? '';

        if (grantType === 'authorization_code' && code.startsWith('oidc_code_')) {
          expect(form.get('code_verifier')).toBeTruthy();
          const nowSec = Math.floor(Date.now() / 1000);
          const idToken = signGoogleIdToken({
            iss: mockGoogleUrl,
            aud: GOOGLE_CLIENT_ID,
            sub: googleState.nextOidcClaims.sub,
            email: googleState.nextOidcClaims.email,
            email_verified: googleState.nextOidcClaims.email_verified,
            ...(googleState.nextOidcClaims.hd ? { hd: googleState.nextOidcClaims.hd } : {}),
            name: googleState.nextOidcClaims.name,
            nonce: googleState.nextOidcNonce,
            iat: nowSec - 5,
            exp: nowSec + 3600,
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'goog_sso_access_1',
              token_type: 'Bearer',
              expires_in: 3600,
              id_token: idToken,
            }),
          );
          return;
        }

        if (grantType === 'authorization_code') {
          expect(form.get('code_verifier')).toBeTruthy();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'gmail_access_tok_v1',
              refresh_token: 'gmail_refresh_tok_v1',
              expires_in: 3600,
              scope:
                'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
            }),
          );
          return;
        }

        if (grantType === 'refresh_token') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'gmail_access_tok_refreshed',
              expires_in: 3600,
              scope:
                'openid email profile https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
            }),
          );
          return;
        }
      }

      if (method === 'GET' && pathname === '/gmail/v1/users/me/profile') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            emailAddress: googleState.profileEmail,
            historyId: googleState.currentHistoryId,
          }),
        );
        return;
      }

      if (method === 'POST' && pathname === '/gmail/v1/users/me/watch') {
        googleState.watchCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            historyId: googleState.currentHistoryId,
            expiration: String(Date.now() + 6 * 86_400_000),
          }),
        );
        return;
      }

      if (method === 'GET' && pathname === '/gmail/v1/users/me/messages') {
        const ids = Object.keys(googleState.initialMessages).map((id) => ({ id }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: ids }));
        return;
      }

      if (method === 'GET' && pathname === '/gmail/v1/users/me/history') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            historyId: googleState.currentHistoryId,
            history:
              googleState.historyAddedIds.length > 0
                ? [
                    {
                      id: googleState.currentHistoryId,
                      messagesAdded: googleState.historyAddedIds.map((id) => ({
                        message: { id },
                      })),
                    },
                  ]
                : [],
          }),
        );
        return;
      }

      const attMatch = pathname.match(
        /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/,
      );
      if (method === 'GET' && attMatch) {
        googleState.attachmentRequests += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            size: 29,
            data: toBase64Url('%PDF-1.7 gmail engagement doc'),
          }),
        );
        return;
      }

      const msgMatch = pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
      if (method === 'GET' && msgMatch) {
        const msgId = decodeURIComponent(msgMatch[1] ?? '');
        const msg = googleState.initialMessages[msgId];
        if (!msg) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'Not found' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(msg));
        return;
      }

      if (method === 'POST' && pathname === '/gmail/v1/users/me/messages/send') {
        const body = JSON.parse(await readBodyText(req)) as { raw: string; threadId?: string };
        googleState.sentRawPayloads.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `gmail_sent_${googleState.sentRawPayloads.length}`,
            threadId: body.threadId ?? `gmail_thr_sent_${googleState.sentRawPayloads.length}`,
          }),
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Unhandled mock Google route ${pathname}` } }));
    });

    await new Promise<void>((resolve) => {
      mockGoogle.listen(0, '127.0.0.1', () => resolve());
    });
    mockGoogleUrl = `http://127.0.0.1:${(mockGoogle.address() as AddressInfo).port}`;
    closeGoogle = () =>
      new Promise<void>((resolve, reject) =>
        mockGoogle.close((err) => (err ? reject(err) : resolve())),
      );

    // 2. Minimal Mock Microsoft Graph server so BDR 1 connects Outlook alongside BDR 2 on Gmail
    const mockGraph = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'POST' && pathname === `/${ENTRA_TENANT_ID}/oauth2/v2.0/token`) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: 'graph_tok_coexist_1',
            refresh_token: 'graph_ref_coexist_1',
            expires_in: 3600,
            scope: 'openid profile email offline_access User.Read Mail.Read Mail.Send',
          }),
        );
        return;
      }
      if (method === 'GET' && pathname === '/v1.0/me') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'entra_bdr_1',
            mail: 'priya@adasglobus.example.com',
            displayName: 'Priya Nair',
          }),
        );
        return;
      }
      if (method === 'POST' && pathname === '/v1.0/subscriptions') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            id: `sub_${Math.random().toString(36).slice(2, 8)}`,
            expirationDateTime: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          }),
        );
        return;
      }
      if (method === 'GET' && pathname.includes('/messages/delta')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            value: [],
            '@odata.deltaLink': `${mockGraphUrl}/v1.0/me/mailFolders('Inbox')/messages/delta?$deltatoken=done`,
          }),
        );
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
    });

    await new Promise<void>((resolve) => {
      mockGraph.listen(0, '127.0.0.1', () => resolve());
    });
    mockGraphUrl = `http://127.0.0.1:${(mockGraph.address() as AddressInfo).port}`;
    closeGraph = () =>
      new Promise<void>((resolve, reject) =>
        mockGraph.close((err) => (err ? reject(err) : resolve())),
      );

    db = DatabaseService.forTests();
    await db.ensureInitialized();
    secretBox = SecretBox.ephemeral();

    // Ensure usr_bdr_2 has a predictable synthetic company domain email for Google SSO matching
    const bdr2Res = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE id = 'usr_bdr_2' LIMIT 1`,
    );
    const bdr2Email = bdr2Res.rows[0]?.email ?? 'marcus@adasglobus.example.com';
    const bdr2Domain = bdr2Email.split('@')[1] ?? 'adasglobus.example.com';
    googleState.nextOidcClaims.email = bdr2Email;
    googleState.nextOidcClaims.hd = bdr2Domain;
    googleState.profileEmail = bdr2Email;

    const env = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      MAIL_LIVE: 'false',
      ENTRA_TENANT_ID,
      ENTRA_CLIENT_ID,
      ENTRA_CLIENT_SECRET_FILE: entraSecretFile,
      ENTRA_MAIL_REDIRECT_URI: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      MICROSOFT_AUTHORITY_BASE_URL: mockGraphUrl,
      MICROSOFT_GRAPH_BASE_URL: `${mockGraphUrl}/v1.0`,
      GOOGLE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET_FILE: googleSecretFile,
      GOOGLE_REDIRECT_URI: 'http://localhost:5174/api/v1/auth/sso/google/callback',
      GOOGLE_MAIL_REDIRECT_URI: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      GOOGLE_ALLOWED_DOMAINS: bdr2Domain,
      GOOGLE_ISSUER_URL: mockGoogleUrl,
      GOOGLE_AUTH_URL: `${mockGoogleUrl}/o/oauth2/v2/auth`,
      GOOGLE_TOKEN_URL: `${mockGoogleUrl}/token`,
      GOOGLE_JWKS_URL: `${mockGoogleUrl}/oauth2/v3/certs`,
      GOOGLE_GMAIL_BASE_URL: `${mockGoogleUrl}/gmail/v1`,
      GOOGLE_PUBSUB_TOPIC: 'projects/adas-crm-test/topics/gmail-push',
    });

    const app = createAppServer(env, db, {
      secretBox,
      googleWebhookToken: GOOGLE_WEBHOOK_TOKEN,
    });
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve());
    });
    appPort = (app.server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${appPort}`;
    closeApp = () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      );

    adminCookie = await devSignIn(baseUrl, 'usr_admin_1');
    bdr1Cookie = await devSignIn(baseUrl, 'usr_bdr_1');
    bdr2Cookie = await devSignIn(baseUrl, 'usr_bdr_2');
  });

  afterAll(async () => {
    if (closeApp) await closeApp();
    if (closeGoogle) await closeGoogle();
    if (closeGraph) await closeGraph();
    if (db) await db.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes dual-provider SSO config and enforces Google OIDC PKCE, hosted domain, invite-only, and subject pinning', async () => {
    const cfgRes = await fetch(`${baseUrl}/api/v1/auth/config`);
    expect(cfgRes.status).toBe(200);
    const cfg = (await cfgRes.json()) as {
      microsoftSignIn: boolean;
      googleSignIn: boolean;
      devSignIn: boolean;
    };
    expect(cfg.microsoftSignIn).toBe(true);
    expect(cfg.googleSignIn).toBe(true);

    // 1. Start Google OIDC flow
    const startRes = await fetch(`${baseUrl}/api/v1/auth/sso/google/start`, {
      redirect: 'manual',
    });
    expect(startRes.status).toBe(302);
    const redirectLoc = new URL(startRes.headers.get('location') ?? '');
    expect(redirectLoc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(redirectLoc.searchParams.get('hd')).toBe(googleState.nextOidcClaims.hd);
    const state = redirectLoc.searchParams.get('state') ?? '';
    googleState.nextOidcNonce = redirectLoc.searchParams.get('nonce') ?? '';
    const oidcCookie = (startRes.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    // 2. Invite-only user signs in cleanly via Google Workspace OIDC + RS256 JWKS
    const cbOk = await fetch(
      `${baseUrl}/api/v1/auth/sso/google/callback?code=oidc_code_ok&state=${encodeURIComponent(state)}`,
      { headers: { Cookie: oidcCookie }, redirect: 'manual' },
    );
    expect(cbOk.status).toBe(302);
    expect(cbOk.headers.get('location')).toBe(`${WEB_ORIGIN}/`);
    const setCookies = cbOk.headers.getSetCookie();
    const sessionCookie =
      setCookies.find((c) => c.startsWith('adas_session='))?.split(';')[0] ?? '';
    expect(sessionCookie).toContain('adas_session=');

    const meRes = await fetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as { id: string };
    expect(me.id).toBe('usr_bdr_2');

    // Verify `google_subject_id` was pinned in PostgreSQL
    const pinned = await db.query<{ google_subject_id: string | null }>(
      `SELECT google_subject_id FROM users WHERE id = 'usr_bdr_2'`,
    );
    expect(pinned.rows[0]?.google_subject_id).toBe('goog_sub_bdr_2_immutable');

    // 3. Rejects recycled email with a different `sub` (`google_account_mismatch`)
    const startMismatch = await fetch(`${baseUrl}/api/v1/auth/sso/google/start`, {
      redirect: 'manual',
    });
    const locMismatch = new URL(startMismatch.headers.get('location') ?? '');
    googleState.nextOidcNonce = locMismatch.searchParams.get('nonce') ?? '';
    googleState.nextOidcClaims.sub = 'goog_sub_impersonator_999';
    const cookieMismatch = (startMismatch.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const cbMismatch = await fetch(
      `${baseUrl}/api/v1/auth/sso/google/callback?code=oidc_code_badsub&state=${encodeURIComponent(locMismatch.searchParams.get('state') ?? '')}`,
      { headers: { Cookie: cookieMismatch }, redirect: 'manual' },
    );
    expect(cbMismatch.status).toBe(302);
    expect(cbMismatch.headers.get('location')).toContain('error=google_account_mismatch');

    // 4. Rejects unallowed external Google domain (`google_domain_not_allowed`)
    const startBadDom = await fetch(`${baseUrl}/api/v1/auth/sso/google/start`, {
      redirect: 'manual',
    });
    const locBadDom = new URL(startBadDom.headers.get('location') ?? '');
    googleState.nextOidcNonce = locBadDom.searchParams.get('nonce') ?? '';
    googleState.nextOidcClaims = {
      sub: 'goog_sub_external_1',
      email: 'outsider@rogue-domain.example.org',
      email_verified: true,
      hd: 'rogue-domain.example.org',
      name: 'External User',
    };
    const cookieBadDom = (startBadDom.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const cbBadDom = await fetch(
      `${baseUrl}/api/v1/auth/sso/google/callback?code=oidc_code_baddom&state=${encodeURIComponent(locBadDom.searchParams.get('state') ?? '')}`,
      { headers: { Cookie: cookieBadDom }, redirect: 'manual' },
    );
    expect(cbBadDom.status).toBe(302);
    expect(cbBadDom.headers.get('location')).toContain('error=google_domain_not_allowed');
  });

  it('connects Microsoft 365 (BDR 1) and Google Workspace Gmail (BDR 2) side-by-side, syncs CRM mail, handles Pub/Sub webhooks, bounces & sequence reply auto-stop', async () => {
    // Seed a known CRM company + contact owned by BDR 2 so Gmail sync rule matches it
    await db.query(
      `INSERT INTO companies (id, name, domain, market, firm_type, staff_band, owner_user_id, team_id)
       VALUES ('cmp_gmail_cpa', 'Pacific Crest Tax LLP', 'pacificcrestcpa.example.com', 'US', 'CPA Firm', '11-25', 'usr_bdr_2', 'team_us')
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO contacts (id, company_id, first_name, last_name, full_name, primary_email, market, email_verification_status, owner_user_id, team_id)
       VALUES ('cnt_gmail_cpa', 'cmp_gmail_cpa', 'Claire', 'Bennett', 'Claire Bennett', 'claire@pacificcrestcpa.example.com', 'US', 'valid', 'usr_bdr_2', 'team_us')
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
       VALUES ('ce_gmail_cpa', 'cnt_gmail_cpa', 'claire@pacificcrestcpa.example.com', TRUE, 'valid')
       ON CONFLICT (email) DO NOTHING`,
    );

    // Seed a second contact that will hard-bounce via Gmail DSN
    await db.query(
      `INSERT INTO contacts (id, company_id, first_name, last_name, full_name, primary_email, market, email_verification_status, owner_user_id, team_id)
       VALUES ('cnt_gmail_bounce', 'cmp_gmail_cpa', 'Retired', 'Partner', 'Retired Partner', 'retired@pacificcrestcpa.example.com', 'US', 'valid', 'usr_bdr_2', 'team_us')
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO contact_emails (id, contact_id, email, is_primary, verification_status)
       VALUES ('ce_gmail_bounce', 'cnt_gmail_bounce', 'retired@pacificcrestcpa.example.com', TRUE, 'valid')
       ON CONFLICT (email) DO NOTHING`,
    );

    // Preload initial 90-day Gmail messages: 1 known CRM thread with attachment + 1 unknown external sender (must be ignored)
    googleState.initialMessages = {
      gm_initial_known: {
        id: 'gm_initial_known',
        threadId: 'gthr_pacific_1',
        historyId: '5001',
        labelIds: ['INBOX', 'UNREAD'],
        snippet: 'Interested in 2 senior tax preparers for Q1.',
        internalDate: String(Date.now() - 60_000),
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Claire Bennett <claire@pacificcrestcpa.example.com>' },
            { name: 'To', value: googleState.profileEmail },
            { name: 'Subject', value: 'Q1 Tax Staffing Inquiry' },
            { name: 'Message-ID', value: '<msg-init-1@pacificcrestcpa.example.com>' },
          ],
          parts: [
            {
              mimeType: 'text/html',
              body: {
                data: toBase64Url(
                  '<p>Interested in 2 senior tax preparers for Q1.</p><img src="https://tracker.example.org/pixel.gif" />',
                ),
              },
            },
            {
              mimeType: 'application/pdf',
              filename: 'engagement-scope.pdf',
              body: { attachmentId: 'gatt_scope_pdf_1', size: 29 },
            },
          ],
        },
      },
      gm_initial_unknown: {
        id: 'gm_initial_unknown',
        threadId: 'gthr_spam_1',
        historyId: '5002',
        labelIds: ['INBOX'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'newsletter@random-vendor.example.net' },
            { name: 'To', value: googleState.profileEmail },
            { name: 'Subject', value: 'Unrelated vendor promo' },
          ],
          body: { data: toBase64Url('Unrelated marketing email.') },
        },
      },
    };
    googleState.currentHistoryId = '5002';

    // 1. BDR 1 connects Microsoft 365 Outlook
    const msStart = await fetch(`${baseUrl}/api/v1/inbox/oauth/start?provider=microsoft_graph`, {
      headers: { Cookie: bdr1Cookie },
      redirect: 'manual',
    });
    expect(msStart.status).toBe(302);
    const msState = new URL(msStart.headers.get('location') ?? '').searchParams.get('state') ?? '';
    const msOAuthCookie = (msStart.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const msCb = await fetch(
      `${baseUrl}/api/v1/inbox/oauth/callback?code=ms_code_1&state=${encodeURIComponent(msState)}`,
      { headers: { Cookie: `${bdr1Cookie}; ${msOAuthCookie}` }, redirect: 'manual' },
    );
    expect(msCb.status).toBe(302);
    expect(msCb.headers.get('location')).toContain('mailConnected=1');

    // 2. BDR 2 connects Google Workspace Gmail
    const gStart = await fetch(`${baseUrl}/api/v1/inbox/oauth/start?provider=google_gmail`, {
      headers: { Cookie: bdr2Cookie },
      redirect: 'manual',
    });
    expect(gStart.status).toBe(302);
    const gLoc = new URL(gStart.headers.get('location') ?? '');
    expect(gLoc.searchParams.get('scope')).toContain('gmail.readonly');
    expect(gLoc.searchParams.get('scope')).toContain('gmail.send');
    expect(gLoc.searchParams.get('access_type')).toBe('offline');
    const gState = gLoc.searchParams.get('state') ?? '';
    const gOAuthCookie = (gStart.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const gCb = await fetch(
      `${baseUrl}/api/v1/inbox/oauth/callback?code=goog_mail_code_1&state=${encodeURIComponent(gState)}`,
      { headers: { Cookie: `${bdr2Cookie}; ${gOAuthCookie}` }, redirect: 'manual' },
    );
    expect(gCb.status).toBe(302);
    expect(gCb.headers.get('location')).toContain('mailConnected=1');
    expect(googleState.watchCalls).toBeGreaterThanOrEqual(1);

    // Check BDR 2 mailbox status reports `provider: 'google_gmail'`
    const mbxStatusRes = await fetch(`${baseUrl}/api/v1/inbox/mailbox`, {
      headers: { Cookie: bdr2Cookie },
    });
    expect(mbxStatusRes.status).toBe(200);
    const mbxStatus = (await mbxStatusRes.json()) as {
      connected: boolean;
      provider: string;
      googleConfigured: boolean;
      entraConfigured: boolean;
    };
    expect(mbxStatus.connected).toBe(true);
    expect(mbxStatus.provider).toBe('google_gmail');
    expect(mbxStatus.googleConfigured).toBe(true);
    expect(mbxStatus.entraConfigured).toBe(true);

    // Check Admin Integrations Overview shows 1 Microsoft 365 mailbox AND 1 Google Workspace mailbox
    const intRes = await fetch(`${baseUrl}/api/v1/admin/integrations`, {
      headers: { Cookie: adminCookie },
    });
    expect(intRes.status).toBe(200);
    const intBody = (await intRes.json()) as {
      connectors: {
        microsoftGraphMail: { connectedMailboxes: number };
        googleGmailMail: { configured: boolean; connectedMailboxes: number };
        googleSso: { configured: boolean };
      };
    };
    expect(intBody.connectors.microsoftGraphMail.connectedMailboxes).toBeGreaterThanOrEqual(1);
    expect(intBody.connectors.googleGmailMail.configured).toBe(true);
    expect(intBody.connectors.googleGmailMail.connectedMailboxes).toBe(1);
    expect(intBody.connectors.googleSso.configured).toBe(true);

    // Verify known Gmail message synced while unknown newsletter was ignored, and attachment was NOT downloaded yet
    expect(googleState.attachmentRequests).toBe(0);
    const threadsRes = await fetch(`${baseUrl}/api/v1/inbox/threads`, {
      headers: { Cookie: bdr2Cookie },
    });
    expect(threadsRes.status).toBe(200);
    const threadsBody = (await threadsRes.json()) as {
      items: Array<{ id: string; subject: string }>;
    };
    const syncedThread = threadsBody.items.find((t) => t.subject === 'Q1 Tax Staffing Inquiry');
    expect(syncedThread).toBeDefined();

    // Stream attachment on demand from Gmail REST v1
    const detailRes = await fetch(`${baseUrl}/api/v1/inbox/threads/${syncedThread?.id ?? ''}`, {
      headers: { Cookie: bdr2Cookie },
    });
    const detailBody = (await detailRes.json()) as {
      messages: Array<{
        id: string;
        hasRemoteImages: boolean;
        attachments: Array<{ id: string; filename: string }>;
      }>;
    };
    const firstMsg = detailBody.messages[0];
    expect(firstMsg?.hasRemoteImages).toBe(true);
    expect(firstMsg?.attachments[0]?.filename).toBe('engagement-scope.pdf');

    const attStreamRes = await fetch(
      `${baseUrl}/api/v1/inbox/messages/${firstMsg?.id ?? ''}/attachments/${firstMsg?.attachments[0]?.id ?? ''}`,
      { headers: { Cookie: bdr2Cookie } },
    );
    expect(attStreamRes.status).toBe(200);
    expect(await attStreamRes.text()).toBe('%PDF-1.7 gmail engagement doc');
    expect(googleState.attachmentRequests).toBe(1);

    // 3. Active sequence enrollment for Claire + Pub/Sub push webhook + incremental historyId sync
    await db.query(
      `INSERT INTO sequences (id, name, market, status, owner_user_id, team_id)
       VALUES ('seq_gmail_test', 'US Tax Outreach', 'US', 'active', 'usr_bdr_2', 'team_us')
       ON CONFLICT (id) DO NOTHING`,
    );
    await db.query(
      `INSERT INTO sequence_enrollments (id, sequence_id, contact_id, email, sender_user_id, status, current_step_order, next_send_at)
       VALUES ('enr_gmail_claire', 'seq_gmail_test', 'cnt_gmail_cpa', 'claire@pacificcrestcpa.example.com', 'usr_bdr_2', 'active', 1, NOW() + INTERVAL '1 day')
       ON CONFLICT (id) DO NOTHING`,
    );

    // Queue incremental messages in Gmail history: (a) Claire's reply, (b) DSN 5.1.1 bounce for retired@
    googleState.initialMessages['gm_delta_reply'] = {
      id: 'gm_delta_reply',
      threadId: 'gthr_pacific_1',
      historyId: '5010',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'claire@pacificcrestcpa.example.com' },
          { name: 'To', value: googleState.profileEmail },
          { name: 'Subject', value: 'Re: US Tax Outreach' },
          { name: 'In-Reply-To', value: '<seq-msg-1@adasglobuspro.com>' },
        ],
        body: { data: toBase64Url('Let us schedule a 3-day free trial next Tuesday.') },
      },
    };
    googleState.initialMessages['gm_delta_dsn'] = {
      id: 'gm_delta_dsn',
      threadId: 'gthr_dsn_1',
      historyId: '5011',
      labelIds: ['INBOX'],
      payload: {
        mimeType: 'multipart/report',
        headers: [
          { name: 'From', value: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>' },
          { name: 'To', value: googleState.profileEmail },
          { name: 'Subject', value: 'Delivery Status Notification (Failure)' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: toBase64Url('Address not found') } },
          {
            mimeType: 'message/delivery-status',
            body: {
              data: toBase64Url(
                'Final-Recipient: rfc822; retired@pacificcrestcpa.example.com\r\nAction: failed\r\nStatus: 5.1.1\r\n',
              ),
            },
          },
        ],
      },
    };
    googleState.historyAddedIds = ['gm_delta_reply', 'gm_delta_dsn'];
    googleState.currentHistoryId = '5011';

    // Rejects wrong token on `POST /api/v1/webhooks/google` on `go.` host
    const badPush = await rawHttpPost({
      port: appPort,
      path: '/api/v1/webhooks/google?token=wrong_token',
      hostHeader: 'go.adasglobuspro.com',
      body: JSON.stringify({
        message: {
          messageId: 'pubsub_msg_1',
          data: Buffer.from(
            JSON.stringify({ emailAddress: googleState.profileEmail, historyId: '5011' }),
          ).toString('base64'),
        },
      }),
    });
    expect(badPush.status).toBe(401);

    // Accepts valid token on `go.` host and deduplicates replays
    const pubsubPayload = JSON.stringify({
      message: {
        messageId: 'pubsub_msg_valid_1',
        data: Buffer.from(
          JSON.stringify({ emailAddress: googleState.profileEmail, historyId: '5011' }),
        ).toString('base64'),
      },
    });
    const goodPush = await rawHttpPost({
      port: appPort,
      path: `/api/v1/webhooks/google?token=${encodeURIComponent(GOOGLE_WEBHOOK_TOKEN)}`,
      hostHeader: 'go.adasglobuspro.com',
      body: pubsubPayload,
    });
    expect(goodPush.status).toBe(202);
    expect(JSON.parse(goodPush.body)).toMatchObject({ accepted: 1, ignored: 0 });

    const replayPush = await rawHttpPost({
      port: appPort,
      path: `/api/v1/webhooks/google?token=${encodeURIComponent(GOOGLE_WEBHOOK_TOKEN)}`,
      hostHeader: 'go.adasglobuspro.com',
      body: pubsubPayload,
    });
    expect(replayPush.status).toBe(202);
    expect(JSON.parse(replayPush.body)).toMatchObject({ accepted: 0, ignored: 1 });

    // Trigger sync on BDR 2's Gmail mailbox
    const syncRes = await fetch(`${baseUrl}/api/v1/inbox/mailbox/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN, Cookie: bdr2Cookie },
      body: '{}',
    });
    expect(syncRes.status).toBe(200);
    const syncJson = (await syncRes.json()) as {
      syncedMessages: number;
      bouncesProcessed: number;
    };
    expect(syncJson.syncedMessages).toBe(1);
    expect(syncJson.bouncesProcessed).toBe(1);

    // Verify Claire's enrollment stopped as `replied` and retired@ is suppressed as `hard_bounce`
    const enrCheck = await db.query<{ status: string }>(
      `SELECT status FROM sequence_enrollments WHERE id = 'enr_gmail_claire'`,
    );
    expect(enrCheck.rows[0]?.status).toBe('replied');

    const supCheck = await db.query<{ reason: string; source: string }>(
      `SELECT reason, source FROM suppressions WHERE email = 'retired@pacificcrestcpa.example.com'`,
    );
    expect(supCheck.rows[0]).toEqual({
      reason: 'hard_bounce',
      source: 'google_gmail_ndr',
    });
  });

  it('dispatches live sequence steps via connected Google Workspace Gmail when production + MAIL_LIVE=true (loopback mock)', async () => {
    // Grant counsel sign-off and lawful US consent for Claire so live sequence gate passes
    await db.query(
      `INSERT INTO settings (key, value_json)
       VALUES ('compliance.counsel_signed_off', 'true'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value_json = 'true'::jsonb`,
    );
    await db.query(
      `INSERT INTO consent_records (id, contact_id, email, market, basis, status, source, captured_at)
       VALUES ('cns_gmail_claire', 'cnt_gmail_cpa', 'claire@pacificcrestcpa.example.com', 'US', 'legitimate_interest_b2b', 'active', 'crm_test', NOW())
       ON CONFLICT (id) DO NOTHING`,
    );

    const mockGmailClient = new GoogleGmailMailboxClient({
      clientId: GOOGLE_CLIENT_ID,
      clientSecretFile: googleSecretFile,
      redirectUri: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      authUrl: `${mockGoogleUrl}/o/oauth2/v2/auth`,
      tokenUrl: `${mockGoogleUrl}/token`,
      gmailBaseUrl: `${mockGoogleUrl}/gmail/v1`,
    });
    const dummyGraphClient = new MicrosoftGraphMailboxClient({
      tenantId: ENTRA_TENANT_ID,
      clientId: ENTRA_CLIENT_ID,
      clientSecretFile: entraSecretFile,
      redirectUri: 'http://localhost:5174/api/v1/inbox/oauth/callback',
      authorityBaseUrl: mockGraphUrl,
      graphBaseUrl: `${mockGraphUrl}/v1.0`,
    });
    const prodMailpit = new MailpitTransport(true, 'production');
    const prodInbox = new InboxService(db, dummyGraphClient, prodMailpit, {
      nodeEnv: 'production',
      mailLive: true,
      publicHost: 'go.adasglobuspro.com',
      maxAttachmentBytes: 20_971_520,
      secretBox,
      gmail: mockGmailClient,
    });
    const prodOutreach = new OutreachService(db, new ComplianceService(db), prodMailpit, {
      nodeEnv: 'production',
      mailLive: true,
      publicHost: 'go.adasglobuspro.com',
      liveMailboxSender: (senderUserId, payload) =>
        prodInbox.sendSequenceMessageViaUserMailbox(senderUserId, payload),
    });

    const beforeCount = googleState.sentRawPayloads.length;
    const sendResult = await prodOutreach.executeSendMessageJob({
      idempotencyKey: 'seq_live_gmail_step_1',
      channel: 'sequence',
      recipientEmail: 'claire@pacificcrestcpa.example.com',
      contactId: 'cnt_gmail_cpa',
      senderUserId: 'usr_bdr_2',
      sequenceId: 'seq_gmail_test',
      subject: 'Checking Q1 tax staffing capacity',
      bodyText: 'Hi Claire, wanted to share our 3-day free trial details.',
      bypassSendWindow: true,
    });

    expect(sendResult.sent).toBe(true);
    expect(googleState.sentRawPayloads.length).toBe(beforeCount + 1);

    const lastSentRaw = Buffer.from(
      (googleState.sentRawPayloads[googleState.sentRawPayloads.length - 1]?.raw ?? '')
        .replace(/-/g, '+')
        .replace(/_/g, '/'),
      'base64',
    ).toString('utf8');
    expect(lastSentRaw).toContain('To: claire@pacificcrestcpa.example.com');
    expect(lastSentRaw).toContain('List-Unsubscribe:');

    const msRow = await db.query<{ transport_provider: string }>(
      `SELECT transport_provider FROM message_sends WHERE idempotency_key = 'seq_live_gmail_step_1'`,
    );
    expect(msRow.rows[0]?.transport_provider).toBe('google_gmail');
  });
});
