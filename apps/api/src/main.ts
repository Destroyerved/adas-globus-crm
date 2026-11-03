import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { AuthAndUsersService } from './modules/auth/index.js';
import { ComplianceService, checkSendable } from './modules/compliance/index.js';
import { CrmService } from './modules/crm/index.js';
import { DataQualityService } from './modules/data-quality/index.js';
import { WebsiteIntakeService } from './modules/intake/index.js';
import { IntelligenceService } from './modules/intelligence/index.js';
import { OutreachService } from './modules/outreach/index.js';
import { isDevLoginEnabled, validateEnv, type AppEnv } from './platform/config/index.js';
import { DatabaseService } from './platform/db/index.js';
import { DomainError, toProblemDetails } from './platform/errors/index.js';
import { createLogger } from './platform/logger/index.js';
import { MailpitTransport } from './platform/mail-transport/index.js';

function serializeJson(data: unknown): string {
  return JSON.stringify(data, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  );
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

export function createAppServer(env: AppEnv = validateEnv(), existingDb?: DatabaseService) {
  const logger = createLogger(env.LOG_LEVEL);
  const db = existingDb ?? new DatabaseService();
  const transport = new MailpitTransport(env.MAIL_LIVE, env.NODE_ENV);
  const auth = new AuthAndUsersService(db, env.NODE_ENV);
  const compliance = new ComplianceService(db);
  const crm = new CrmService(db);
  const intake = new WebsiteIntakeService(db);
  const dataQuality = new DataQualityService(db);
  const outreach = new OutreachService(db, compliance, transport);
  const intelligence = new IntelligenceService(db);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const parsedUrl = new URL(rawUrl, 'http://localhost:3000');
    const pathname = parsedUrl.pathname;
    const hostHeader = req.headers.host ?? 'crm.localhost:3000';

    // CORS headers for web app (`http://localhost:5174`) and marketing website
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Dev-User-Id, X-CSRF-Token, Idempotency-Key',
    );

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

      if (method === 'GET' && (pathname === '/healthz' || pathname === '/api/v1/healthz')) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          serializeJson({
            status: 'ok',
            service: 'adas-crm-api',
            mailLive: env.MAIL_LIVE,
            devLoginEnabled: isDevLoginEnabled(env),
          }),
        );
        return;
      }

      await db.ensureInitialized();

      // Public RFC 8058 One-Click Unsubscribe (`POST /u/:token` or `GET /u/:token` — PRD §5.4 A17)
      if (pathname.startsWith('/u/')) {
        const token = pathname.slice('/u/'.length);
        const result = await compliance.handleUnsubscribeToken(token);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      // Public Website Inquiry Intake (`POST /api/v1/public/inquiries` — PRD §4.10 A1 & A2)
      if (method === 'POST' && pathname === '/api/v1/public/inquiries') {
        const body = await readJsonBody(req);
        const result = await intake.handlePublicInquiry(body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      // Auth endpoints
      if (method === 'POST' && pathname === '/api/v1/auth/break-glass') {
        const body = await readJsonBody(req);
        const result = await auth.signInBreakGlass(body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/auth/entra-oidc') {
        const body = await readJsonBody(req);
        const email = typeof body['email'] === 'string' ? body['email'] : '';
        const result = await auth.signInWithEntraOidc(email);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      // Resolve current user (via X-Dev-User-Id in non-production or default manager)
      const headerUserId = req.headers['x-dev-user-id'];
      const activeUserId =
        typeof headerUserId === 'string' && headerUserId.trim() !== ''
          ? headerUserId.trim()
          : 'usr_mgr_1';
      const user = await auth.resolveSessionUser(activeUserId);

      // Users & Audit Logs
      if (method === 'GET' && pathname === '/api/v1/users') {
        const items = await auth.listUsers();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/audit-logs') {
        const items = await auth.listAuditLogs(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      // Companies
      if (method === 'GET' && pathname === '/api/v1/companies') {
        const items = await crm.listCompanies(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/companies') {
        const body = await readJsonBody(req);
        const result = await crm.createOrFindCompany(user, body as never);
        res.writeHead(result.created ? 201 : 200, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        res.end(serializeJson(result));
        return;
      }

      if (method === 'PATCH' && pathname.startsWith('/api/v1/companies/')) {
        const companyId = pathname.slice('/api/v1/companies/'.length);
        const body = await readJsonBody(req);
        const updated = await crm.updateCompany(user, companyId, body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(updated));
        return;
      }

      // Contacts
      if (method === 'GET' && pathname === '/api/v1/contacts') {
        const items = await crm.listContacts(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/contacts') {
        const body = await readJsonBody(req);
        const created = await crm.createContact(user, body as never);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(created));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/contacts/merge') {
        const body = await readJsonBody(req);
        const merged = await dataQuality.mergeContacts(user, body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(merged));
        return;
      }

      // Leads
      if (method === 'GET' && pathname === '/api/v1/leads') {
        const items = await crm.listLeads(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/leads') {
        const body = await readJsonBody(req);
        const created = await crm.createLead(user, body as never);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(created));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/leads/convert') {
        const body = await readJsonBody(req);
        const converted = await crm.convertLead(user, body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(converted));
        return;
      }

      // Deals
      if (method === 'GET' && pathname === '/api/v1/deals') {
        const items = await crm.listDeals(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/deals') {
        const body = await readJsonBody(req);
        const created = await crm.createDeal(user, body as never);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(created));
        return;
      }

      if (
        method === 'PATCH' &&
        pathname.startsWith('/api/v1/deals/') &&
        pathname.endsWith('/stage')
      ) {
        const dealId = pathname.slice('/api/v1/deals/'.length, -'/stage'.length);
        const body = await readJsonBody(req);
        const updated = await crm.moveDealStage(user, dealId, body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(updated));
        return;
      }

      // Tasks
      if (method === 'GET' && pathname === '/api/v1/tasks') {
        const items = await crm.listTasks(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/tasks') {
        const body = await readJsonBody(req);
        const created = await crm.createTask(user, body as never);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(created));
        return;
      }

      // Compliance
      if (method === 'POST' && pathname === '/api/v1/compliance/check-sendable') {
        const body = await readJsonBody(req);
        const result = checkSendable(body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/compliance/suppressions') {
        const items = await compliance.listSuppressions();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/compliance/suppressions') {
        const body = await readJsonBody(req);
        const created = await compliance.addSuppression({
          email: String(body['email'] ?? ''),
          reason: (body['reason'] as 'manual_dnc') ?? 'manual_dnc',
          source: String(body['source'] ?? 'manual_ui'),
          actorUserId: user.id,
        });
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(created));
        return;
      }

      // Imports & Search
      if (method === 'POST' && pathname === '/api/v1/imports/csv') {
        const body = await readJsonBody(req);
        const summary = await dataQuality.runCsvImport(user, body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(summary));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/search') {
        const q = parsedUrl.searchParams.get('q') ?? '';
        const results = await dataQuality.globalSearch(user, q);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(results));
        return;
      }

      // Inbox, Sequences, Campaigns, Reports
      if (method === 'GET' && pathname === '/api/v1/inbox/threads') {
        const items = await outreach.listInboxThreads(user);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/sequences') {
        const items = await outreach.listSequences();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/campaigns') {
        const items = await outreach.listCampaigns();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson({ items }));
        return;
      }

      if (
        method === 'POST' &&
        pathname.startsWith('/api/v1/campaigns/') &&
        pathname.endsWith('/approve')
      ) {
        const campaignId = pathname.slice('/api/v1/campaigns/'.length, -'/approve'.length);
        const approved = await outreach.approveCampaign(user, campaignId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(approved));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/reports/pipeline-rollup') {
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
        }),
      );
    } catch (err) {
      const problem = toProblemDetails(err, pathname);
      res.writeHead(problem.status, {
        'Content-Type': 'application/problem+json; charset=utf-8',
      });
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
      compliance,
      crm,
      intake,
      dataQuality,
      outreach,
      intelligence,
    },
  };
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  const { server, logger, env } = createAppServer();
  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'ADAS CRM API listening');
  });
}
