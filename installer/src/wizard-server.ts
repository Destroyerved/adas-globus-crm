import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { z } from 'zod';
import { runPreflightChecks, type CommandProbe } from './preflight.js';
import {
  InstallerConfigInputSchema,
  InstallerService,
  UNINSTALL_PURGE_CONFIRMATION,
} from './provision.js';

/**
 * Loopback-only (`127.0.0.1`) Interactive Production Setup Wizard HTTP Server.
 *
 * Security invariants:
 * - Binds strictly to `127.0.0.1` so the wizard is never exposed to LAN/WAN interfaces.
 * - Enforces a per-process 192-bit CSRF token (`X-Installer-Csrf`) + loopback `Origin` check
 *   on every mutating `POST` request.
 * - Never echoes existing secret file contents back to the browser.
 */

const InstallPayloadSchema = z.object({
  config: InstallerConfigInputSchema,
  imageTag: z.string().min(1).default('v1.0.0'),
  adminEmail: z.string().email().optional().or(z.literal('')),
  skipHealthWait: z.boolean().optional(),
});

const UpgradePayloadSchema = z.object({
  targetDir: z.string().min(1),
  imageTag: z.string().min(1),
  buildFromSource: z.boolean().optional(),
  healthUrl: z.string().optional(),
});

const RollbackPayloadSchema = z.object({
  targetDir: z.string().min(1),
  targetTag: z.string().optional(),
});

const UninstallPayloadSchema = z.object({
  targetDir: z.string().min(1),
  purgeData: z.boolean().optional(),
  confirmationPhrase: z.string().optional(),
});

export interface WizardServerHandle {
  server: Server;
  url: string;
  port: number;
  csrfToken: string;
  close: () => Promise<void>;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

async function readJsonBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new Error('Request payload exceeds 64 KiB limit.');
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as unknown;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  res.end(body);
}

function isAllowedLoopbackOrigin(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return true;
  return originHeader === `http://127.0.0.1:${port}` || originHeader === `http://localhost:${port}`;
}

export async function startInstallerWizardServer(options: {
  defaultTargetDir: string;
  port?: number;
  service?: InstallerService;
  probeCommand?: CommandProbe;
  healthBaseUrl?: string;
}): Promise<WizardServerHandle> {
  const defaultTargetDir = path.resolve(options.defaultTargetDir);
  const service = options.service ?? new InstallerService({ probe: options.probeCommand });
  const csrfToken = randomBytes(24).toString('hex');
  let boundPort = options.port ?? 0;

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
      const method = req.method ?? 'GET';

      if (method === 'GET' && reqUrl.pathname === '/') {
        const html = renderWizardHtml({ defaultTargetDir, csrfToken });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
        });
        res.end(html);
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/api/csrf') {
        if (!isAllowedLoopbackOrigin(req.headers.origin, boundPort)) {
          sendJson(res, 403, { error: 'Cross-origin request rejected.' });
          return;
        }
        sendJson(res, 200, { csrfToken });
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/api/preflight') {
        const targetDir = path.resolve(
          reqUrl.searchParams.get('targetDir')?.trim() || defaultTargetDir,
        );
        const report = await runPreflightChecks({
          targetDir,
          probeCommand: options.probeCommand,
        });
        sendJson(res, 200, report);
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/api/health') {
        const url =
          reqUrl.searchParams.get('url')?.trim() ||
          options.healthBaseUrl ||
          'http://127.0.0.1:3000';
        const health = await service.checkStackHealth(url);
        sendJson(res, health.ok ? 200 : 503, health);
        return;
      }

      if (method === 'POST') {
        if (!isAllowedLoopbackOrigin(req.headers.origin, boundPort)) {
          sendJson(res, 403, { error: 'Forbidden origin header.' });
          return;
        }
        const suppliedCsrf = String(req.headers['x-installer-csrf'] ?? '');
        if (!suppliedCsrf || !constantTimeEquals(suppliedCsrf, csrfToken)) {
          sendJson(res, 403, { error: 'Invalid or missing CSRF token.' });
          return;
        }

        const rawBody = await readJsonBody(req);

        if (reqUrl.pathname === '/api/provision') {
          const result = service.provisionConfiguration(InstallerConfigInputSchema.parse(rawBody));
          sendJson(res, 200, { status: 'provisioned', result });
          return;
        }

        if (reqUrl.pathname === '/api/install') {
          const parsed = InstallPayloadSchema.parse(rawBody);
          const result = await service.installStack({
            config: parsed.config,
            imageTag: parsed.imageTag,
            adminEmail: parsed.adminEmail || undefined,
            skipHealthWait: parsed.skipHealthWait,
          });
          sendJson(res, 200, { status: 'installed', result });
          return;
        }

        if (reqUrl.pathname === '/api/upgrade') {
          const parsed = UpgradePayloadSchema.parse(rawBody);
          const result = await service.upgradeStack(parsed);
          sendJson(res, 200, { status: result.rolledBack ? 'rolled_back' : 'upgraded', result });
          return;
        }

        if (reqUrl.pathname === '/api/rollback') {
          const parsed = RollbackPayloadSchema.parse(rawBody);
          const result = service.rollbackStack(parsed);
          sendJson(res, 200, { status: 'rolled_back', result });
          return;
        }

        if (reqUrl.pathname === '/api/uninstall') {
          const parsed = UninstallPayloadSchema.parse(rawBody);
          const result = service.uninstallStack(parsed);
          sendJson(res, 200, { status: 'uninstalled', result });
          return;
        }
      }

      sendJson(res, 404, { error: 'Route not found.' });
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendJson(res, 400, {
          error: 'Validation failed',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : 'Unexpected installer error',
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3088, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      boundPort = addr.port;
      resolve();
    });
  });

  return {
    server,
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    csrfToken,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderWizardHtml(params: { defaultTargetDir: string; csrfToken: string }): string {
  const safeTarget = escapeHtml(params.defaultTargetDir);
  const safeCsrf = escapeHtml(params.csrfToken);
  const safeConfirm = escapeHtml(UNINSTALL_PURGE_CONFIRMATION);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ADAS CRM Server Installer</title>
  <style>
    :root {
      --navy: #041c3e;
      --teal: #00778a;
      --canvas: #fbfcfb;
      --surface: #ffffff;
      --line: #dfe5e8;
      --ink-1: #0c1b2a;
      --ink-2: #3c4d5e;
      --ok-bg: #e7f6ee;
      --ok-ink: #126b3f;
      --warn-bg: #fef5e5;
      --warn-ink: #8a5300;
      --err-bg: #fdebec;
      --err-ink: #a31b24;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Hanken Grotesk", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--canvas);
      color: var(--ink-1);
      line-height: 1.45;
    }
    header {
      background: var(--navy);
      color: #ffffff;
      padding: 20px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    header h1 { margin: 0; font-size: 18px; font-weight: 600; }
    header p { margin: 4px 0 0; font-size: 13px; color: #b7ccdf; }
    main { max-width: 1060px; margin: 24px auto; padding: 0 20px 48px; display: grid; gap: 20px; }
    section {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 20px;
    }
    h2 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
    label { display: block; font-size: 12px; font-weight: 500; color: var(--ink-2); margin-bottom: 4px; }
    input, select {
      width: 100%;
      height: 36px;
      padding: 0 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      font-size: 13px;
      color: var(--ink-1);
      background: #ffffff;
    }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
    button {
      height: 36px;
      padding: 0 16px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #ffffff;
      color: var(--ink-1);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    button.primary { background: var(--teal); border-color: var(--teal); color: #ffffff; }
    button.danger { background: #a31b24; border-color: #a31b24; color: #ffffff; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .pass { background: var(--ok-bg); color: var(--ok-ink); }
    .warn { background: var(--warn-bg); color: var(--warn-ink); }
    .fail { background: var(--err-bg); color: var(--err-ink); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid var(--line); }
    pre {
      background: #0c1826;
      color: #e2f1f5;
      padding: 14px;
      border-radius: 8px;
      font-size: 12px;
      overflow-x: auto;
      margin: 0;
      min-height: 110px;
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>ADAS CRM production server installer</h1>
      <p>Loopback setup wizard (127.0.0.1 only) · Idempotent secret provisioning, deploy, upgrade, and rollback</p>
    </div>
    <button type="button" id="btnRefreshPreflight">Run preflight checks</button>
  </header>
  <main>
    <section aria-labelledby="preflight-heading">
      <h2 id="preflight-heading">1. Server hardware, Docker, and port preflight</h2>
      <table>
        <thead><tr><th>Check</th><th>Status</th><th>Details</th></tr></thead>
        <tbody id="preflightBody"><tr><td colspan="3">Loading preflight checks…</td></tr></tbody>
      </table>
    </section>

    <section aria-labelledby="config-heading">
      <h2 id="config-heading">2. Production domain, authentication, and off-site backup settings</h2>
      <div class="grid">
        <div><label for="targetDir">Target server directory</label><input id="targetDir" value="${safeTarget}" /></div>
        <div><label for="domain">Primary domain</label><input id="domain" value="adasglobuspro.com" /></div>
        <div><label for="tunnelName">Cloudflare Tunnel name</label><input id="tunnelName" value="adas-crm-prod-16gb" /></div>
        <div><label for="tunnelToken">Cloudflare Tunnel token (optional)</label><input id="tunnelToken" type="password" placeholder="Preserved if left blank" /></div>
        <div><label for="cfAccessTeamDomain">Cloudflare Access team domain</label><input id="cfAccessTeamDomain" value="adasglobuspro.cloudflareaccess.com" /></div>
        <div><label for="entraTenantId">Microsoft Entra tenant ID</label><input id="entraTenantId" value="00000000-0000-0000-0000-000000000000" /></div>
        <div><label for="entraClientId">Microsoft Entra client ID</label><input id="entraClientId" value="00000000-0000-0000-0000-000000000000" /></div>
        <div><label for="entraClientSecret">Microsoft Entra client secret (optional)</label><input id="entraClientSecret" type="password" placeholder="Preserved if left blank" /></div>
        <div><label for="backupS3Endpoint">Off-site S3 endpoint URL</label><input id="backupS3Endpoint" placeholder="https://..." /></div>
        <div><label for="backupS3Bucket">Off-site S3 bucket</label><input id="backupS3Bucket" placeholder="adas-crm-backups" /></div>
        <div><label for="imageTag">Release image tag</label><input id="imageTag" value="v1.0.0" /></div>
        <div><label for="adminEmail">Break-glass admin email (optional)</label><input id="adminEmail" type="email" placeholder="admin@adasglobuspro.com" /></div>
      </div>
      <div class="actions">
        <button type="button" class="primary" id="btnProvision">Provision secrets &amp; .env.production</button>
        <button type="button" class="primary" id="btnInstall">Full one-click install</button>
        <button type="button" id="btnUpgrade">Safe upgrade to tag</button>
        <button type="button" id="btnRollback">Rollback to previous tag</button>
        <button type="button" id="btnHealth">Check /healthz</button>
      </div>
    </section>

    <section aria-labelledby="uninstall-heading">
      <h2 id="uninstall-heading">3. Stop stack or safe uninstall</h2>
      <div class="grid">
        <div><label for="confirmPhrase">Type "${safeConfirm}" only to purge volumes &amp; backups</label><input id="confirmPhrase" placeholder="Leave blank to preserve data" /></div>
      </div>
      <div class="actions">
        <button type="button" id="btnStopKeepData">Stop containers (keep all data &amp; secrets)</button>
        <button type="button" class="danger" id="btnPurge">Uninstall and purge data</button>
      </div>
    </section>

    <section aria-labelledby="log-heading">
      <h2 id="log-heading">Installer output</h2>
      <pre id="logOutput">Ready.</pre>
    </section>
  </main>
  <script>
    const CSRF = "${safeCsrf}";
    const logEl = document.getElementById('logOutput');
    function writeLog(obj) {
      logEl.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
    }
    function readConfig() {
      return {
        targetDir: document.getElementById('targetDir').value,
        domain: document.getElementById('domain').value,
        tunnelName: document.getElementById('tunnelName').value,
        tunnelToken: document.getElementById('tunnelToken').value,
        cfAccessTeamDomain: document.getElementById('cfAccessTeamDomain').value,
        entraTenantId: document.getElementById('entraTenantId').value,
        entraClientId: document.getElementById('entraClientId').value,
        entraClientSecret: document.getElementById('entraClientSecret').value,
        backupS3Endpoint: document.getElementById('backupS3Endpoint').value,
        backupS3Bucket: document.getElementById('backupS3Bucket').value,
      };
    }
    async function callApi(path, method, body) {
      const res = await fetch(path, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Installer-Csrf': CSRF,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      writeLog(json);
      return json;
    }
    async function loadPreflight() {
      const dir = encodeURIComponent(document.getElementById('targetDir').value);
      const res = await fetch('/api/preflight?targetDir=' + dir);
      const report = await res.json();
      const tbody = document.getElementById('preflightBody');
      tbody.innerHTML = '';
      for (const c of report.checks || []) {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td'); td1.textContent = c.label;
        const td2 = document.createElement('td');
        const span = document.createElement('span');
        span.className = 'badge ' + c.status;
        span.textContent = c.status.toUpperCase();
        td2.appendChild(span);
        const td3 = document.createElement('td');
        td3.textContent = c.detail + (c.remediation ? ' — ' + c.remediation : '');
        tr.append(td1, td2, td3);
        tbody.appendChild(tr);
      }
    }
    document.getElementById('btnRefreshPreflight').addEventListener('click', loadPreflight);
    document.getElementById('btnProvision').addEventListener('click', () => callApi('/api/provision', 'POST', readConfig()));
    document.getElementById('btnInstall').addEventListener('click', () => callApi('/api/install', 'POST', {
      config: readConfig(),
      imageTag: document.getElementById('imageTag').value,
      adminEmail: document.getElementById('adminEmail').value,
    }));
    document.getElementById('btnUpgrade').addEventListener('click', () => callApi('/api/upgrade', 'POST', {
      targetDir: document.getElementById('targetDir').value,
      imageTag: document.getElementById('imageTag').value,
      buildFromSource: true,
    }));
    document.getElementById('btnRollback').addEventListener('click', () => callApi('/api/rollback', 'POST', {
      targetDir: document.getElementById('targetDir').value,
    }));
    document.getElementById('btnHealth').addEventListener('click', async () => {
      const res = await fetch('/api/health');
      writeLog(await res.json());
    });
    document.getElementById('btnStopKeepData').addEventListener('click', () => callApi('/api/uninstall', 'POST', {
      targetDir: document.getElementById('targetDir').value,
      purgeData: false,
    }));
    document.getElementById('btnPurge').addEventListener('click', () => callApi('/api/uninstall', 'POST', {
      targetDir: document.getElementById('targetDir').value,
      purgeData: true,
      confirmationPhrase: document.getElementById('confirmPhrase').value,
    }));
    loadPreflight();
  </script>
</body>
</html>`;
}
