import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiTokenService,
  AuthAndUsersService,
  BreakGlassService,
  CloudflareAccessVerifier,
  CookieSigner,
  EntraSignIn,
  SessionService,
  readCookies,
  serializeCookie,
  sessionCookieName,
  type CloudflareAccessOptions,
} from './modules/auth/index.js';
import { AdminService, registerAdminRoutes } from './modules/admin/index.js';
import { ComplianceService, registerComplianceRoutes } from './modules/compliance/index.js';
import {
  BulkActionService,
  CrmListService,
  CrmRecordService,
  CrmService,
  CrmTimelineService,
  CustomFieldService,
  LeadScoringService,
  SavedViewService,
  registerCrmRoutes,
} from './modules/crm/index.js';
import { DashboardService, registerDashboardRoutes } from './modules/dashboard/index.js';
import { ReportsService, registerReportRoutes } from './modules/reports/index.js';
import { NotificationService } from './modules/notifications/index.js';
import { DataQualityService } from './modules/data-quality/index.js';
import { ImportService, registerImportRoutes } from './modules/imports/index.js';
import { DuplicateService, registerDuplicateRoutes } from './modules/duplicates/index.js';
import { ExportService, registerExportRoutes } from './modules/exports/index.js';
import { HealthService, registerHealthRoutes } from './modules/health/index.js';
import { InboxService, registerInboxRoutes } from './modules/inbox/index.js';
import { WebsiteIntakeService, registerIntakeRoutes } from './modules/intake/index.js';
import { IntelligenceService, registerIntelligenceRoutes } from './modules/intelligence/index.js';
import { OutreachService, registerOutreachRoutes } from './modules/outreach/index.js';
import { ApolloClient } from './platform/apollo/index.js';
import {
  isDevLoginEnabled,
  loadDotEnv,
  resolveConfigPath,
  validateEnv,
  verifyProductionReadiness,
  type AppEnv,
} from './platform/config/index.js';
import { loadSecretBox, type SecretBox } from './platform/crypto/index.js';
import { DatabaseService } from './platform/db/index.js';
import { LocalFileStorage, type FileStorage } from './platform/files/index.js';
import { DomainError, NotFoundDomainError, toProblemDetails } from './platform/errors/index.js';
import { createLogger } from './platform/logger/index.js';
import { Router, type RouteContext } from './platform/http/router.js';
import {
  EspBulkSender,
  MailpitTransport,
  MicrosoftGraphMailboxClient,
} from './platform/mail-transport/index.js';
import { effectiveCapabilities, requireCapability } from './platform/scope/index.js';
import {
  PerUserRateLimiter,
  applySecurityHeaders,
  resolveRequestId,
} from './platform/security/index.js';

function serializeJson(data: unknown): string {
  return JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

const MAX_JSON_BODY_BYTES = 1_048_576; // 1 MB for internal API calls
const MAX_PUBLIC_BODY_BYTES = 16_384; // 16 KB for website inquiries (PRD §4.10)

async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new DomainError({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        title: 'Request body too large',
        detail: `Request bodies are limited to ${maxBytes} bytes.`,
      });
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new DomainError({
      status: 400,
      code: 'INVALID_JSON',
      title: 'Invalid JSON',
      detail: 'The request body must be a JSON object.',
    });
  }
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    total += buf.length;
    if (total > maxBytes) {
      throw new DomainError({
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        title: 'File too large',
        detail: `Uploads are limited to ${Math.round(maxBytes / 1_048_576)} MB.`,
      });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

function clientIpOf(req: IncomingMessage): string | null {
  const forwarded = req.headers['cf-connecting-ip'];
  if (typeof forwarded === 'string' && forwarded) return forwarded;
  return req.socket.remoteAddress ?? null;
}

/** Secret for signing short-lived cookies. Production must provide the file. */
function loadSessionSecret(file: string, production: boolean): string {
  if (existsSync(file) && readFileSync(file, 'utf8').trim().length >= 32) {
    return readFileSync(file, 'utf8').trim();
  }
  if (production)
    throw new Error(`SESSION_SECRET_FILE ${file} is missing or shorter than 32 characters.`);
  return randomBytes(32).toString('hex'); // development: valid until the API restarts
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Public unsubscribe pages use the website's look (DESIGN §6.15): off-white canvas, one white card. */
function publicPage(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} · ADAS Globus Pro</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#FBFCFB;color:#0F1B2A;
font:17px/1.6 "Hanken Grotesk","Helvetica Neue",Helvetica,Arial,sans-serif;padding:16px}
.card{max-width:480px;width:100%;background:#fff;border:1px solid #DCE2E2;border-radius:14px;padding:40px}
h1{margin:0 0 12px;font-size:28px;font-weight:300;letter-spacing:-.02em;line-height:1.15}
p{margin:0 0 20px;color:#445161}
button{height:52px;padding:0 26px;border:0;border-radius:999px;background:#00778A;color:#fff;font:600 16px/1 inherit;cursor:pointer}
button:hover{background:#005E6D}
button:focus-visible{outline:2px solid #015FA7;outline-offset:3px}
.brand{font-weight:650;margin-bottom:24px;letter-spacing:-.01em}
</style></head><body><main class="card"><div class="brand">ADAS Globus Pro</div>${bodyHtml}</main></body></html>`;
}

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  production: boolean,
  kind: 'public_html' | 'docs_html' = 'public_html',
): void {
  applySecurityHeaders(res, { production, kind });
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(html);
}

export function createAppServer(
  env: AppEnv = validateEnv(),
  existingDb?: DatabaseService,
  options: {
    /** Tests and the e2e server pass a throw-away key; otherwise TOKEN_ENCRYPTION_KEY_FILE. */
    secretBox?: SecretBox | null;
    /** Tests pass in-memory storage; otherwise FILE_STORAGE_LOCAL_PATH. */
    files?: FileStorage;
    /** Optional Cloudflare Access JWKS loader override for offline integration tests. */
    cfAccessJwksLoader?: CloudflareAccessOptions['jwksLoader'];
    /** Optional ESP webhook HMAC secret override for offline integration tests. */
    espWebhookSecret?: string;
    /** Optional ApolloClient override for offline HTTP protocol integration tests. */
    apolloClient?: ApolloClient;
    /** Optional Microsoft Bookings webhook HMAC secret override for integration tests. */
    bookingsWebhookSecret?: string;
  } = {},
) {
  const logger = createLogger(env.LOG_LEVEL);
  const db = existingDb ?? DatabaseService.connect(env.DATABASE_URL);
  const devLoginEnabled = isDevLoginEnabled(env);
  const production = env.NODE_ENV === 'production';
  const resolvedSecretBox =
    options.secretBox !== undefined
      ? options.secretBox
      : loadSecretBox(
          resolveConfigPath(env.TOKEN_ENCRYPTION_KEY_FILE),
          env.TOKEN_ENCRYPTION_KEY_VERSION,
          production,
        );
  const transport = new MailpitTransport(env.MAIL_LIVE, env.NODE_ENV, env.MAILPIT_HTTP_URL);
  const espSender = new EspBulkSender({
    provider: env.ESP_PROVIDER,
    apiBaseUrl: env.ESP_API_BASE_URL,
    apiKeyFile: resolveConfigPath(env.ESP_API_KEY_FILE),
    webhookSecretFile: resolveConfigPath(env.ESP_WEBHOOK_SECRET_FILE),
    sendingDomain: env.ESP_SENDING_DOMAIN,
    nodeEnv: env.NODE_ENV,
    mailLive: env.MAIL_LIVE,
  });
  const graph = new MicrosoftGraphMailboxClient({
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    clientSecretFile: resolveConfigPath(env.ENTRA_CLIENT_SECRET_FILE),
    redirectUri: env.ENTRA_MAIL_REDIRECT_URI,
    authorityBaseUrl: env.MICROSOFT_AUTHORITY_BASE_URL,
    graphBaseUrl: env.MICROSOFT_GRAPH_BASE_URL,
  });
  const entra = new EntraSignIn({
    tenantId: env.ENTRA_TENANT_ID,
    clientId: env.ENTRA_CLIENT_ID,
    clientSecretFile: resolveConfigPath(env.ENTRA_CLIENT_SECRET_FILE),
    redirectUri: env.ENTRA_REDIRECT_URI,
  });
  const apolloClient =
    options.apolloClient ??
    new ApolloClient({
      apiBaseUrl: env.APOLLO_API_BASE_URL,
      apiKeyFile: resolveConfigPath(env.APOLLO_API_KEY_FILE),
    });
  const auth = new AuthAndUsersService(db, env.NODE_ENV);
  const apiTokens = new ApiTokenService(db, auth);
  const cfAccess = new CloudflareAccessVerifier({
    enforce: env.CF_ACCESS_ENFORCE,
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    audience: env.CF_ACCESS_AUD,
    jwksLoader: options.cfAccessJwksLoader,
  });
  const userRateLimiter = new PerUserRateLimiter(env.API_RATE_LIMIT_PER_MIN);
  const compliance = new ComplianceService(db);
  const crm = new CrmService(db);
  const intake = new WebsiteIntakeService(db, {
    rateLimitPer10Min: env.INQUIRY_RATE_LIMIT_PER_10M,
  });
  const dataQuality = new DataQualityService(db);
  const outreach = new OutreachService(db, compliance, transport, {
    nodeEnv: env.NODE_ENV,
    mailLive: env.MAIL_LIVE,
    publicHost: env.APP_PUBLIC_HOST,
    sendingSubdomain: env.ESP_SENDING_DOMAIN,
    espSender,
    espWebhookSecret: options.espWebhookSecret ?? null,
  });
  const intelligence = new IntelligenceService(db, {
    apolloClient,
    secretBox: resolvedSecretBox,
    bookingsWebhookSecretFile: resolveConfigPath(env.BOOKINGS_WEBHOOK_SECRET_FILE),
    bookingsWebhookSecret: options.bookingsWebhookSecret ?? null,
    nodeEnv: env.NODE_ENV,
    mailLive: env.MAIL_LIVE,
    publicHost: env.APP_PUBLIC_HOST,
    allowPrivateWebhookTargets: env.WEBHOOK_ALLOW_PRIVATE_TARGETS || !production,
    connectorFlags: {
      entraConfigured: entra.isConfigured(),
      graphConfigured: graph.isConfigured(),
      espConfigured: espSender.isConfigured(),
      espProvider: env.ESP_PROVIDER,
      espSendingDomain: env.ESP_SENDING_DOMAIN,
    },
  });
  const lists = new CrmListService(db);
  const records = new CrmRecordService(db);
  const timeline = new CrmTimelineService(db);
  const savedViews = new SavedViewService(db);
  const bulk = new BulkActionService(db, (userId) => auth.resolveSessionUser(userId), logger);
  const customFields = new CustomFieldService(db);
  const scoring = new LeadScoringService(db);
  const notifications = new NotificationService(db);
  const router = new Router();
  registerCrmRoutes(router, {
    crm,
    lists,
    records,
    timeline,
    savedViews,
    bulk,
    customFields,
    scoring,
  });
  registerComplianceRoutes(router, compliance);
  registerIntakeRoutes(router, intake);
  registerOutreachRoutes(router, outreach);
  registerIntelligenceRoutes(router, intelligence);
  const health = new HealthService(db, {
    nodeEnv: env.NODE_ENV,
    mailLive: env.MAIL_LIVE,
    devLoginEnabled: isDevLoginEnabled(env),
  });
  registerHealthRoutes(router, health);
  const admin = new AdminService(db);
  registerAdminRoutes(router, admin);
  const dashboard = new DashboardService(db);
  registerDashboardRoutes(router, dashboard);
  const reports = new ReportsService(db);
  registerReportRoutes(router, reports);
  const files =
    options.files ?? new LocalFileStorage(resolveConfigPath(env.FILE_STORAGE_LOCAL_PATH));
  const imports = new ImportService(db, files);
  registerImportRoutes(router, imports, env.MAX_IMPORT_UPLOAD_BYTES);
  const duplicates = new DuplicateService(db);
  registerDuplicateRoutes(router, duplicates);
  const exportService = new ExportService(
    db,
    files,
    lists,
    (userId) => auth.resolveSessionUser(userId),
    logger,
  );
  registerExportRoutes(router, exportService);
  router.get('/api/v1/notifications', async (ctx) => {
    ctx.json(
      200,
      await notifications.list(ctx.user, { unreadOnly: ctx.query.get('unread') === '1' }),
    );
  });
  router.post('/api/v1/notifications/read', async (ctx) => {
    const body = await ctx.body();
    ctx.json(
      200,
      await notifications.markRead(ctx.user, typeof body['id'] === 'string' ? body['id'] : null),
    );
  });
  router.get('/api/v1/admin/api-tokens', async (ctx) => {
    ctx.json(200, await apiTokens.listTokens(ctx.user));
  });
  router.post('/api/v1/admin/api-tokens', async (ctx) => {
    ctx.json(201, await apiTokens.createToken(ctx.user, await ctx.body(), ctx.ip));
  });
  router.post('/api/v1/admin/api-tokens/:id/revoke', async (ctx) => {
    ctx.json(200, await apiTokens.revokeToken(ctx.user, ctx.params['id'] ?? '', ctx.ip));
  });
  const inbox = new InboxService(db, graph, transport, {
    nodeEnv: env.NODE_ENV,
    mailLive: env.MAIL_LIVE,
    publicHost: env.APP_PUBLIC_HOST,
    maxAttachmentBytes: env.MAX_ATTACHMENT_UPLOAD_BYTES,
    secretBox: resolvedSecretBox,
  });
  registerInboxRoutes(router, inbox);
  const sessions = new SessionService(
    db,
    env.SESSION_IDLE_TIMEOUT_HOURS,
    env.SESSION_ABSOLUTE_TIMEOUT_DAYS,
  );
  const signer = new CookieSigner(
    loadSessionSecret(resolveConfigPath(env.SESSION_SECRET_FILE), production),
  );
  const breakGlass = new BreakGlassService(db, resolvedSecretBox, logger);
  const OIDC_COOKIE = production ? '__Host-adas_oidc' : 'adas_oidc';
  const MAIL_OAUTH_COOKIE = production ? '__Host-adas_mail_oauth' : 'adas_mail_oauth';
  const sessionCookie = (token: string) =>
    serializeCookie(sessionCookieName(production), token, {
      maxAgeSeconds: env.SESSION_ABSOLUTE_TIMEOUT_DAYS * 86_400,
      secure: production,
    });
  const webOrigin = new URL(env.PUBLIC_WEB_URL).origin;
  const inquiryOrigins = env.INQUIRY_CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const requestId = resolveRequestId(req);
    res.setHeader('X-Request-Id', requestId);
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, 'http://localhost:3000');
    const pathname = parsedUrl.pathname;
    const hostHeader = req.headers.host ?? 'crm.localhost:3000';

    // Default strict API security headers on every response; SPA/HTML handlers override kind.
    applySecurityHeaders(res, { production, kind: 'api' });

    // CORS: only the CRM web app (with credentials) and the marketing website (intake only).
    // Never reflect arbitrary origins (PRD §9).
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (origin && pathname.startsWith('/api/v1/public/') && inquiryOrigins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
    } else if (origin && origin === webOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Dev-User-Id, X-CSRF-Token, Idempotency-Key',
      );
    }

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      // Host routing check (`crm.` vs `go.` — PRD §6.1)
      const hostCheck = auth.verifyHostRouteAccess(hostHeader, pathname);
      if (!hostCheck.allowed) {
        throw new DomainError({
          status: 404,
          code: 'HOST_ROUTE_NOT_ALLOWED',
          title: 'Route not available on this host',
          detail: `Path ${pathname} is not exposed on host ${hostHeader}.`,
        });
      }

      if (
        method === 'GET' &&
        (pathname === '/healthz' || pathname === '/api/v1/healthz' || pathname === '/api/v1/health')
      ) {
        const strictParam = parsedUrl.searchParams.get('strict');
        const strict = strictParam === '1' || strictParam === 'true';
        const readiness = await health.checkReadiness({ strict });
        res.writeHead(readiness.httpStatus, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(serializeJson(readiness.body));
        return;
      }

      await db.ensureInitialized();

      // Public unsubscribe (PRD §5.5, §8.6). GET only shows a confirmation page, because
      // mail security scanners open links automatically. POST (the button, or the RFC 8058
      // one-click request a mail app sends) performs the unsubscribe.
      if (pathname.startsWith('/u/') && (method === 'GET' || method === 'POST')) {
        const token = decodeURIComponent(pathname.slice('/u/'.length));
        try {
          if (method === 'POST') {
            await compliance.handleUnsubscribeToken(token);
            sendHtml(
              res,
              200,
              publicPage(
                'Unsubscribed',
                `<h1>You're <strong>unsubscribed</strong></h1><p>You won't receive any more emails from ADAS Globus Pro at this address. This takes effect immediately.</p>`,
              ),
              production,
            );
            return;
          }
          const info = await compliance.describeUnsubscribeToken(token);
          const action = `/u/${encodeURIComponent(token)}`;
          sendHtml(
            res,
            200,
            publicPage(
              'Unsubscribe',
              info.alreadyUnsubscribed
                ? `<h1>Already <strong>unsubscribed</strong></h1><p>${escapeHtml(info.maskedEmail)} won't receive any more emails from ADAS Globus Pro.</p>`
                : `<h1>Unsubscribe from <strong>ADAS Globus Pro</strong> emails?</h1><p>Stop all emails to ${escapeHtml(info.maskedEmail)}.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Unsubscribe</button></form>`,
            ),
            production,
          );
        } catch (err) {
          if (err instanceof DomainError && err.status === 404) {
            sendHtml(
              res,
              404,
              publicPage(
                'Link not found',
                `<h1>This link <strong>isn't valid</strong></h1><p>It may be incomplete. To stop emails from us, reply to any message with "unsubscribe" or write to info@adasglobuspro.com.</p>`,
              ),
              production,
            );
            return;
          }
          throw err;
        }
        return;
      }

      // Public Website Inquiry Intake (`POST /api/v1/public/inquiries` — PRD §4.10, A13).
      // Always returns `202 {"status":"received"}` so bots and external callers learn nothing
      // about honeypot hits, deduplication or internal CRM IDs.
      if (method === 'POST' && pathname === '/api/v1/public/inquiries') {
        const body = await readJsonBody(req, MAX_PUBLIC_BODY_BYTES);
        await intake.handlePublicInquiry(body as never, {
          ipAddress: clientIpOf(req),
          userAgent:
            typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        });
        res.writeHead(202, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(serializeJson({ status: 'received' }));
        return;
      }

      // Public Microsoft Graph change-notification webhook (`POST /api/v1/webhooks/microsoft` on `go.` — PRD §8.2).
      // Handles both the plain-text `?validationToken=...` subscription handshake and JSON notifications.
      if (pathname === '/api/v1/webhooks/microsoft' && (method === 'POST' || method === 'GET')) {
        const validationToken = parsedUrl.searchParams.get('validationToken');
        if (validationToken !== null) {
          if (validationToken.length === 0 || validationToken.length > 1024) {
            throw new DomainError({
              status: 400,
              code: 'INVALID_VALIDATION_TOKEN',
              title: 'Invalid validation token',
              detail: 'The Microsoft Graph validationToken query parameter is invalid.',
            });
          }
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(validationToken);
          return;
        }
        if (method === 'POST') {
          const body = await readJsonBody(req, 262_144);
          const result = await inbox.handleMicrosoftWebhook(body);
          res.writeHead(202, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          res.end(serializeJson({ status: 'accepted', ...result }));
          return;
        }
      }

      // Public stored-URL click redirect (`GET /c/:token` on `go.` — PRD §8.6).
      // Redirects strictly to the stored `click_tokens.target_url`; never an open redirect.
      if (method === 'GET' && pathname.startsWith('/c/')) {
        const rawToken = decodeURIComponent(pathname.slice('/c/'.length));
        try {
          const { targetUrl } = await outreach.handleClickRedirect(rawToken);
          res.writeHead(302, {
            Location: targetUrl,
            'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer',
          });
          res.end();
          return;
        } catch (err) {
          if (err instanceof DomainError && err.status === 404) {
            sendHtml(
              res,
              404,
              publicPage(
                'Link not found',
                `<h1>This link <strong>isn't valid</strong></h1><p>It may be incomplete or expired.</p>`,
              ),
              production,
            );
            return;
          }
          throw err;
        }
      }

      // Public ESP webhook receiver (`POST /api/v1/webhooks/esp` on `go.` — PRD §8.4, §8.7, §9).
      // Verifies constant-time HMAC-SHA256 signature over raw bytes before processing events.
      if (method === 'POST' && pathname === '/api/v1/webhooks/esp') {
        const rawBuf = await readRawBody(req, 262_144);
        const rawBody = rawBuf.toString('utf-8');
        let parsedBody: unknown;
        try {
          parsedBody = rawBody.trim() ? JSON.parse(rawBody) : {};
        } catch {
          throw new DomainError({
            status: 400,
            code: 'INVALID_JSON',
            title: 'Invalid JSON',
            detail: 'The webhook body must be valid JSON.',
          });
        }
        const sigHeader =
          (typeof req.headers['x-esp-signature'] === 'string'
            ? req.headers['x-esp-signature']
            : undefined) ??
          (typeof req.headers['x-postmark-signature'] === 'string'
            ? req.headers['x-postmark-signature']
            : undefined) ??
          (typeof req.headers['svix-signature'] === 'string'
            ? req.headers['svix-signature']
            : undefined);
        const tsHeader =
          (typeof req.headers['x-esp-timestamp'] === 'string'
            ? req.headers['x-esp-timestamp']
            : undefined) ??
          (typeof req.headers['svix-timestamp'] === 'string'
            ? req.headers['svix-timestamp']
            : undefined);

        const result = await outreach.handleEspWebhook({
          rawBody,
          signatureHeader: sigHeader,
          timestampHeader: tsHeader,
          parsedBody,
        });
        res.writeHead(202, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(serializeJson({ status: 'accepted', ...result }));
        return;
      }

      // Public Microsoft Bookings webhook receiver (`POST /api/v1/webhooks/bookings` on `go.` — PRD §4.14, §6.5, §9).
      // Verifies constant-time timestamped HMAC-SHA256 signature (`X-Bookings-Signature`) with 5-minute replay window.
      if (method === 'POST' && pathname === '/api/v1/webhooks/bookings') {
        const rawBuf = await readRawBody(req, 131_072);
        const rawBody = rawBuf.toString('utf-8');
        const sigHeader =
          (typeof req.headers['x-bookings-signature'] === 'string'
            ? req.headers['x-bookings-signature']
            : undefined) ??
          (typeof req.headers['x-adas-signature'] === 'string'
            ? req.headers['x-adas-signature']
            : undefined);
        const tsHeader =
          typeof req.headers['x-bookings-timestamp'] === 'string'
            ? req.headers['x-bookings-timestamp']
            : undefined;
        const result = await intelligence.handleSignedBookingsWebhook({
          rawBody,
          signatureHeader: sigHeader,
          timestampHeader: tsHeader,
        });
        res.writeHead(202, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(serializeJson({ status: 'accepted', ...result }));
        return;
      }

      // Cloudflare Access JWT defence-in-depth on internal `crm.` routes (PRD §6.5, §9)
      if (hostCheck.target === 'crm') {
        await cfAccess.verifyAssertion(req.headers['cf-access-jwt-assertion']);
      }

      // Serve static built SPA (`apps/web/dist`) on non-API GET requests before session auth
      // so unauthenticated browsers on `crm.` load the sign-in screen cleanly (PRD §6.2 & §10.2).
      if (method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/c/')) {
        const currentDir = path.dirname(fileURLToPath(import.meta.url));
        const webDistDir = path.resolve(currentDir, '../../web/dist');
        const indexHtmlPath = path.join(webDistDir, 'index.html');
        if (existsSync(indexHtmlPath)) {
          const safeRel = pathname.replace(/^\/+/, '');
          const candidatePath = path.resolve(webDistDir, safeRel);
          const isInsideDist = candidatePath.startsWith(webDistDir);
          const targetFile =
            isInsideDist &&
            safeRel !== '' &&
            existsSync(candidatePath) &&
            statSync(candidatePath).isFile()
              ? candidatePath
              : indexHtmlPath;
          const ext = path.extname(targetFile).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.html': 'text/html; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.woff2': 'font/woff2',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.json': 'application/json; charset=utf-8',
          };
          applySecurityHeaders(res, { production, kind: 'spa' });
          res.writeHead(200, {
            'Content-Type': mimeMap[ext] ?? 'application/octet-stream',
          });
          res.end(readFileSync(targetFile));
          return;
        }
      }

      // ---- Sign-in, sessions and sign-out (PRD 6.6) ----
      const cookies = readCookies(req);
      const sendJson = (
        status: number,
        data: unknown,
        extraHeaders: Record<string, string | string[]> = {},
      ) => {
        res.writeHead(status, {
          'Content-Type': 'application/json; charset=utf-8',
          ...extraHeaders,
        });
        res.end(serializeJson(data));
      };
      const redirect = (location: string, setCookies: string[] = []) => {
        res.writeHead(302, {
          Location: location,
          'Cache-Control': 'no-store',
          'Set-Cookie': setCookies,
        });
        res.end();
      };

      if (method === 'GET' && pathname === '/api/v1/auth/config') {
        sendJson(200, {
          microsoftSignIn: entra.isConfigured(),
          devSignIn: devLoginEnabled,
          adminSignIn: breakGlass.isAvailable(),
        });
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/auth/sso/start') {
        if (!entra.isConfigured()) {
          redirect(`${env.PUBLIC_WEB_URL}/?screen=login&error=sso_not_configured`);
          return;
        }
        const { url, pending } = await entra.start();
        redirect(url, [
          serializeCookie(OIDC_COOKIE, signer.sign(JSON.stringify(pending)), {
            maxAgeSeconds: 600,
            secure: production,
          }),
        ]);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/auth/sso/callback') {
        const clearPending = serializeCookie(OIDC_COOKIE, '', {
          maxAgeSeconds: 0,
          secure: production,
        });
        try {
          const pendingRaw = signer.verify(cookies[OIDC_COOKIE]);
          if (!pendingRaw) throw new Error('Sign-in expired or was started in another browser.');
          if (parsedUrl.searchParams.get('error')) {
            throw new Error(
              parsedUrl.searchParams.get('error_description') ?? 'Microsoft sign-in was cancelled.',
            );
          }
          const identity = await entra.finish(parsedUrl.search, JSON.parse(pendingRaw));
          const userId = await auth.findUserForEntraSignIn(identity);
          // Session fixation protection: invalidate any pre-existing session cookie first.
          await sessions.revoke(cookies[sessionCookieName(production)]);
          const token = await sessions.create(userId, req, 'microsoft');
          redirect(`${env.PUBLIC_WEB_URL}/`, [clearPending, sessionCookie(token)]);
        } catch (err) {
          const code = err instanceof DomainError ? err.code.toLowerCase() : 'sso_failed';
          logger.warn(
            { requestId, code, err: err instanceof Error ? err.message : String(err) },
            'Microsoft sign-in failed',
          );
          await db
            .transaction((tx) =>
              db.writeAuditLog(tx, {
                action: 'auth.sso.failed',
                entityType: 'session',
                metadata: { code },
                ipAddress: clientIpOf(req),
              }),
            )
            .catch(() => undefined);
          redirect(`${env.PUBLIC_WEB_URL}/?screen=login&error=${encodeURIComponent(code)}`, [
            clearPending,
          ]);
        }
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/auth/dev-login') {
        // Development and tests only: sign in as a seeded user with a real session.
        if (!devLoginEnabled) throw new NotFoundDomainError('Route', pathname);
        const body = await readJsonBody(req);
        const userId = await auth.findUserForDevSignIn(String(body['userId'] ?? ''));
        await sessions.revoke(cookies[sessionCookieName(production)]);
        const token = await sessions.create(userId, req, 'dev');
        sendJson(200, await auth.resolveSessionUser(userId), {
          'Set-Cookie': [sessionCookie(token)],
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/auth/local/login') {
        // Emergency admin sign-in (PRD 6.6). Sign-in requests must come from the CRM web app
        // too, so another site can't sign a browser in to an account it controls.
        if (req.headers.origin !== webOrigin) {
          throw new DomainError({
            status: 403,
            code: 'CSRF_ORIGIN_REJECTED',
            title: 'Request blocked',
            detail: 'Sign-in requests must come from the CRM web app.',
          });
        }
        const body = await readJsonBody(req);
        const userId = await breakGlass.signIn(body, clientIpOf(req) ?? 'unknown');
        await sessions.revoke(cookies[sessionCookieName(production)]);
        const token = await sessions.create(userId, req, 'break_glass');
        sendJson(200, await auth.resolveSessionUser(userId), {
          'Set-Cookie': [sessionCookie(token)],
        });
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/auth/logout') {
        await sessions.revoke(cookies[sessionCookieName(production)]);
        res.writeHead(204, {
          'Set-Cookie': serializeCookie(sessionCookieName(production), '', {
            maxAgeSeconds: 0,
            secure: production,
          }),
        });
        res.end();
        return;
      }

      // Every other API route requires either a valid Bearer service token or a signed-in session.
      const bearerAuth = await apiTokens.authenticateBearer(
        req.headers.authorization,
        clientIpOf(req),
      );
      let user: Awaited<ReturnType<typeof auth.resolveSessionUser>>;
      let rateActorKey: string;
      if (bearerAuth) {
        user = bearerAuth.user;
        rateActorKey = `tok:${bearerAuth.tokenId}`;
      } else {
        const userId = await sessions.resolve(cookies[sessionCookieName(production)]);
        if (!userId) {
          throw new DomainError({
            status: 401,
            code: 'UNAUTHENTICATED',
            title: 'Sign-in required',
            detail: 'Your session has ended. Sign in again.',
          });
        }
        // Cross-site request forgery: cookie-authenticated writes must come from the CRM web app.
        if (method !== 'GET' && method !== 'HEAD' && req.headers.origin !== webOrigin) {
          throw new DomainError({
            status: 403,
            code: 'CSRF_ORIGIN_REJECTED',
            title: 'Request blocked',
            detail: 'This request did not come from the CRM web app.',
          });
        }
        user = await auth.resolveSessionUser(userId);
        rateActorKey = `usr:${user.id}`;
      }

      const rateStatus = userRateLimiter.check(rateActorKey);
      res.setHeader('X-RateLimit-Remaining', String(rateStatus.remaining));

      // Delegated Microsoft 365 mailbox connection OAuth2 + PKCE flow (PRD §4.11, §8.2)
      if (method === 'GET' && pathname === '/api/v1/inbox/oauth/start') {
        try {
          const { url, pending } = inbox.startOAuthConnect(user);
          redirect(url, [
            serializeCookie(MAIL_OAUTH_COOKIE, signer.sign(JSON.stringify(pending)), {
              maxAgeSeconds: 600,
              secure: production,
            }),
          ]);
        } catch (err) {
          const code = err instanceof DomainError ? err.code.toLowerCase() : 'mail_oauth_failed';
          redirect(`${env.PUBLIC_WEB_URL}/?screen=inbox&mailError=${encodeURIComponent(code)}`);
        }
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/inbox/oauth/callback') {
        const clearMailPending = serializeCookie(MAIL_OAUTH_COOKIE, '', {
          maxAgeSeconds: 0,
          secure: production,
        });
        try {
          const pendingRaw = signer.verify(cookies[MAIL_OAUTH_COOKIE]);
          if (!pendingRaw) {
            throw new DomainError({
              status: 400,
              code: 'OAUTH_SESSION_EXPIRED',
              title: 'Authorization expired',
              detail: 'Start the Microsoft 365 mailbox connection again.',
            });
          }
          if (parsedUrl.searchParams.get('error')) {
            throw new DomainError({
              status: 400,
              code: 'OAUTH_ACCESS_DENIED',
              title: 'Microsoft 365 connection cancelled',
              detail: 'Consent was cancelled in Microsoft 365.',
            });
          }
          const code = parsedUrl.searchParams.get('code') ?? '';
          const state = parsedUrl.searchParams.get('state') ?? '';
          if (!code || !state) {
            throw new DomainError({
              status: 400,
              code: 'OAUTH_CODE_MISSING',
              title: 'Missing authorization code',
              detail: 'Microsoft did not return an authorization code.',
            });
          }
          await inbox.finishOAuthConnect(user, {
            code,
            state,
            pending: JSON.parse(pendingRaw),
            ipAddress: clientIpOf(req),
          });
          redirect(`${env.PUBLIC_WEB_URL}/?screen=inbox&mailConnected=1`, [clearMailPending]);
        } catch (err) {
          const code = err instanceof DomainError ? err.code.toLowerCase() : 'mail_oauth_failed';
          logger.warn(
            {
              requestId,
              userId: user.id,
              code,
              err: err instanceof Error ? err.message : String(err),
            },
            'Microsoft 365 mailbox connection failed',
          );
          redirect(`${env.PUBLIC_WEB_URL}/?screen=inbox&mailError=${encodeURIComponent(code)}`, [
            clearMailPending,
          ]);
        }
        return;
      }

      // Internal OpenAPI documentation on `crm.` (PRD §6.7, AGENTS.md §6)
      if (method === 'GET' && (pathname === '/api/docs' || pathname === '/api/docs.json')) {
        const specPath = path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          '../openapi.json',
        );
        const specText = existsSync(specPath) ? readFileSync(specPath, 'utf8') : '{}';
        const wantsJson =
          pathname === '/api/docs.json' ||
          String(req.headers.accept ?? '').includes('application/json');
        if (wantsJson) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(specText);
          return;
        }
        const specObj = JSON.parse(specText) as {
          info?: { title?: string; version?: string };
          paths?: Record<string, Record<string, { summary?: string }>>;
        };
        const rows = Object.entries(specObj.paths ?? {})
          .flatMap(([p, methods]) =>
            Object.entries(methods).map(
              ([m, op]) =>
                `<tr><td><code>${escapeHtml(m.toUpperCase())}</code></td><td><code>${escapeHtml(p)}</code></td><td>${escapeHtml(op.summary ?? '')}</td></tr>`,
            ),
          )
          .join('');
        sendHtml(
          res,
          200,
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(specObj.info?.title ?? 'ADAS CRM API')} · OpenAPI</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px;color:#0F1B2A;background:#FBFCFB}table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #DCE2E2}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #DCE2E2}code{font-weight:600;color:#005E6D}</style></head><body><h1>${escapeHtml(specObj.info?.title ?? 'ADAS CRM API')} (${escapeHtml(specObj.info?.version ?? '1.0.0')})</h1><p><a href="/api/docs.json">Download openapi.json</a></p><table><thead><tr><th>Method</th><th>Path</th><th>Summary</th></tr></thead><tbody>${rows}</tbody></table></body></html>`,
          production,
          'docs_html',
        );
        return;
      }

      const matched = router.match(method, pathname);
      if (matched) {
        const ctx: RouteContext = {
          req,
          res,
          user,
          params: matched.params,
          query: parsedUrl.searchParams,
          body: () => readJsonBody(req),
          raw: (maxBytes) => readRawBody(req, maxBytes),
          json: sendJson,
          send: (status, contentType, payload, headers = {}) => {
            res.writeHead(status, { 'Content-Type': contentType, ...headers });
            res.end(payload);
          },
          ip: clientIpOf(req),
        };
        // PRD 6.7: POSTs that create records accept Idempotency-Key; a retry gets the stored
        // response instead of creating a second record.
        const idemKey = req.headers['idempotency-key'];
        if (method === 'POST' && typeof idemKey === 'string' && idemKey.length > 0) {
          const key = idemKey.slice(0, 200);
          const stored = await db.query<{
            status_code: number;
            response_json: unknown;
            path: string;
          }>(
            `SELECT status_code, response_json, path FROM idempotency_keys
             WHERE key = $1 AND actor_id = $2 AND created_at > NOW() - INTERVAL '24 hours'`,
            [key, user.id],
          );
          const hit = stored.rows[0];
          if (hit) {
            if (hit.path !== pathname) {
              throw new DomainError({
                status: 422,
                code: 'IDEMPOTENCY_KEY_REUSED',
                title: 'Idempotency key reused',
                detail: 'This Idempotency-Key was already used for a different request.',
              });
            }
            sendJson(hit.status_code, hit.response_json, { 'Idempotent-Replayed': 'true' });
            return;
          }
          ctx.json = (status, data, headers) => {
            const body = JSON.parse(serializeJson(data)) as unknown;
            void db
              .query(
                `INSERT INTO idempotency_keys (key, actor_id, method, path, status_code, response_json)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb) ON CONFLICT (key) DO NOTHING`,
                [key, user.id, method, pathname, status, JSON.stringify(body)],
              )
              .catch((err: unknown) =>
                logger.warn(
                  { err: err instanceof Error ? err.message : String(err) },
                  'idempotency store failed',
                ),
              );
            sendJson(status, data, headers);
          };
        }
        await matched.handler(ctx);
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/auth/me') {
        sendJson(200, { ...user, capabilities: effectiveCapabilities(user) });
        return;
      }

      if (method === 'PATCH' && pathname === '/api/v1/me/preferences') {
        sendJson(200, await auth.updatePreferences(user, await readJsonBody(req)));
        return;
      }

      // Users
      if (method === 'GET' && pathname === '/api/v1/users') {
        const items = await auth.listUsers(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      // Search
      if (method === 'GET' && pathname === '/api/v1/search') {
        const q = parsedUrl.searchParams.get('q') ?? '';
        const includeExtended = parsedUrl.searchParams.get('extended') === '1';
        const results = await dataQuality.globalSearch(user, q, { includeExtended });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(results));
        return;
      }

      // Legacy Pipeline Rollup
      if (method === 'GET' && pathname === '/api/v1/reports/pipeline-rollup') {
        requireCapability(user, 'reports.read');
        const currency = (parsedUrl.searchParams.get('currency') as 'USD' | 'CAD') ?? 'USD';
        const report = await intelligence.getPipelineRollupReport(user, currency);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(report));
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/problem+json; charset=utf-8' });
      res.end(
        serializeJson({
          type: 'https://crm.adasglobuspro.com/errors/not-found',
          title: 'Not found',
          status: 404,
          code: 'route_not_found',
          detail: `No route matched ${method} ${pathname}`,
          requestId,
        }),
      );
    } catch (err) {
      const problem = { ...toProblemDetails(err, pathname), requestId };
      if (problem.status >= 500) {
        // Log the cause; never echo database or internal messages to the client (AGENTS.md 5).
        logger.error(
          {
            requestId,
            path: pathname,
            method,
            err: err instanceof Error ? err.message : String(err),
          },
          'request failed',
        );
        problem.detail =
          'Something went wrong on the server. Try again, and tell an admin if it keeps happening.';
      }
      if (res.headersSent) {
        res.end();
        return;
      }
      const headers: Record<string, string> = {
        'Content-Type': 'application/problem+json; charset=utf-8',
      };
      if (problem.status === 429) {
        headers['Retry-After'] = pathname.startsWith('/api/v1/public/') ? '600' : '60';
      }
      res.writeHead(problem.status, headers);
      res.end(serializeJson(problem));
    }
  });

  return {
    server,
    logger,
    env,
    db,
    transport,
    services: {
      auth,
      apiTokens,
      cfAccess,
      breakGlass,
      compliance,
      crm,
      intake,
      inbox,
      graph,
      dataQuality,
      outreach,
      intelligence,
      lists,
      records,
      timeline,
      notifications,
      admin,
      dashboard,
      health,
      imports,
      duplicates,
      exports: exportService,
    },
    files,
    secretBox: resolvedSecretBox,
  };
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  loadDotEnv();
  const { server, logger, env, db, secretBox } = createAppServer();
  void (async () => {
    try {
      await db.ensureInitialized();
      await verifyProductionReadiness({
        env,
        db,
        secretBox,
        resolvePath: resolveConfigPath,
      });
    } catch (err) {
      // Start-up only: no request data can be in this error.
      const e = err as { name?: string; code?: string; message?: string };
      logger.fatal(
        { err: { name: e.name, code: e.code, message: e.message } },
        'API startup verification failed',
      );
      await db.close().catch(() => undefined);
      process.exit(1);
    }
    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'ADAS CRM API listening');
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'API server draining in-flight HTTP requests');
      const forceTimer = setTimeout(() => {
        logger.error({ signal }, 'API graceful shutdown timed out; forcing exit');
        process.exit(1);
      }, 15_000);
      forceTimer.unref();

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await db.close().catch((err: Error) => {
        logger.error({ err: err.message }, 'error closing database pool');
      });
      clearTimeout(forceTimer);
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  })();
}
