import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

      if (
        method === 'GET' &&
        (pathname === '/healthz' || pathname === '/api/v1/healthz' || pathname === '/api/v1/health')
      ) {
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

      if (method === 'POST' && pathname === '/api/v1/sequences/enroll') {
        const body = await readJsonBody(req);
        const enrolled = await outreach.enrollInSequence(user, body as never);
        if (body['executeStepOneImmediately'] === true) {
          const stepResult = await outreach.executeSequenceEnrollmentStep(enrolled.enrollmentId, {
            bypassSendWindow: true,
          });
          res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(serializeJson({ ...enrolled, stepOneSend: stepResult }));
          return;
        }
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(enrolled));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/n8n/pipeline/trigger') {
        const body = await readJsonBody(req);
        const result = await outreach.runN8nMarketingPipeline(user, {
          workflowId:
            body['workflowId'] === 'wf_02_marketing_campaign_dispatch'
              ? 'wf_02_marketing_campaign_dispatch'
              : 'wf_01_lead_sequence_enroll',
          contactId: typeof body['contactId'] === 'string' ? body['contactId'] : undefined,
          sequenceId: typeof body['sequenceId'] === 'string' ? body['sequenceId'] : undefined,
          campaignId: typeof body['campaignId'] === 'string' ? body['campaignId'] : undefined,
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/n8n/webhooks/dispatch') {
        const result = await intelligence.dispatchPendingOutboxEventsToWebhooks();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(result));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/n8n/api-tokens') {
        const body = await readJsonBody(req);
        const tokenName =
          typeof body['name'] === 'string' && body['name'].trim() !== ''
            ? body['name'].trim()
            : 'n8n Marketing Automation Service Token';
        const scopes = Array.isArray(body['scopes'])
          ? (body['scopes'] as string[])
          : ['leads:read', 'leads:write', 'sequences:enroll', 'campaigns:trigger'];
        const created = await intelligence.createApiToken(user, tokenName, scopes);
        res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(created));
        return;
      }

      if (method === 'GET' && pathname === '/api/v1/outreach/warmup-status') {
        const dayParam = Number(parsedUrl.searchParams.get('day') ?? '21');
        const status = outreach.getWarmupAndDeliverabilityStatus(
          Number.isFinite(dayParam) && dayParam > 0 ? dayParam : 21,
        );
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(status));
        return;
      }

      if (method === 'POST' && pathname === '/api/v1/outreach/tailor-preview') {
        const body = await readJsonBody(req);
        const preview = await outreach.tailorOutreachEmail(body as never);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(serializeJson(preview));
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

      if (method === 'POST' && pathname === '/api/v1/deployment/blueprint') {
        const body = await readJsonBody(req);
        const rawDomain =
          typeof body['domain'] === 'string' && body['domain'].trim() !== ''
            ? body['domain']
                .trim()
                .toLowerCase()
                .replace(/^https?:\/\//, '')
                .replace(/\/.*$/, '')
            : 'adasglobuspro.com';
        const tunnelName =
          typeof body['tunnelName'] === 'string' && body['tunnelName'].trim() !== ''
            ? body['tunnelName'].trim()
            : 'adas-crm-prod-16gb';

        const cloudflareTunnelYaml = [
          `# ADAS CRM Production Cloudflare Tunnel Config (PRD §10.4)`,
          `tunnel: ${tunnelName}`,
          `credentials-file: /etc/cloudflared/${tunnelName}.json`,
          `ingress:`,
          `  - hostname: crm.${rawDomain}`,
          `    service: http://localhost:3000`,
          `  - hostname: go.${rawDomain}`,
          `    service: http://localhost:3000`,
          `  - hostname: status.${rawDomain}`,
          `    service: http://localhost:3001`,
          `  - hostname: automation.${rawDomain}`,
          `    service: http://localhost:5678`,
          `  - service: http_status:404`,
        ].join('\n');

        const dnsRecordsBind = [
          `; --- ADAS CRM Cloudflare Tunnel CNAMEs & Anti-Spam Email Records (PRD §5.4, §10.4) ---`,
          `crm.${rawDomain}.         1   IN  CNAME   ${tunnelName}.cfargotunnel.com.`,
          `go.${rawDomain}.          1   IN  CNAME   ${tunnelName}.cfargotunnel.com.`,
          `status.${rawDomain}.      1   IN  CNAME   ${tunnelName}.cfargotunnel.com.`,
          `automation.${rawDomain}.  1   IN  CNAME   ${tunnelName}.cfargotunnel.com.`,
          `${rawDomain}.             300 IN  TXT     "v=spf1 include:spf.protection.outlook.com -all"`,
          `mail.${rawDomain}.        300 IN  TXT     "v=spf1 include:amazonses.com -all"`,
          `_dmarc.${rawDomain}.      300 IN  TXT     "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${rawDomain}; adkim=s; aspf=s"`,
          `_dmarc.mail.${rawDomain}. 300 IN  TXT     "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${rawDomain}"`,
        ].join('\n');

        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          serializeJson({
            domain: rawDomain,
            tunnelName,
            serverMemoryGb: 16,
            memoryAllocationMb: {
              postgres: 4096,
              apiAndSpa: 1024,
              worker: 768,
              n8n: 1536,
              uptimeKuma: 256,
              cloudflared: 128,
              osAndPostgresPageCache: 8448,
            },
            postgresTuning: {
              shared_buffers: '2GB',
              effective_cache_size: '8GB',
              work_mem: '16MB',
              maintenance_work_mem: '512MB',
              max_connections: 60,
              wal_compression: 'on',
            },
            hostRoutes: {
              crmAppUrl: `https://crm.${rawDomain}`,
              publicIntakeAndUnsubUrl: `https://go.${rawDomain}`,
              uptimeStatusUrl: `https://status.${rawDomain}`,
              n8nAutomationUrl: `https://automation.${rawDomain}`,
            },
            cloudflareTunnelYaml,
            dnsRecordsBind,
            exeInstallerPath: 'dist/deployer/ADAS-CRM-Deployer.exe',
          }),
        );
        return;
      }

      // Serve static built SPA (`apps/web/dist`) on non-API GET requests (PRD §6.2 & §10.2)
      if (method === 'GET' && !pathname.startsWith('/api/')) {
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
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
          res.setHeader('X-Frame-Options', 'DENY');
          res.writeHead(200, {
            'Content-Type': mimeMap[ext] ?? 'application/octet-stream',
          });
          res.end(readFileSync(targetFile));
          return;
        }
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
  const { server, logger, env, db } = createAppServer();
  void (async () => {
    await db.ensureInitialized();
    server.listen(env.PORT, () => {
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'ADAS CRM API listening');
    });
  })();
}
