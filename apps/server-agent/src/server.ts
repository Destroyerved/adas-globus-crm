import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { AgentAuditLogger, type AgentRole } from './audit-log.js';
import { AgentCredentialStore } from './crypto-auth.js';
import {
  AgentOperationsService,
  ManagedServiceSchema,
  type AllowlistedConfigKey,
  type AllowlistedSecretFile,
} from './operations.js';
import { redactSensitiveText } from './redact.js';

/**
 * Authenticated HTTP Daemon for `@adas/server-agent` (`127.0.0.1:3090` default).
 *
 * Enforces:
 * - Single-use pairing rate limiting (`5` attempts / 10 minutes per IP -> `429`)
 * - Cryptographic HMAC-SHA256 request verification + 5-minute replay/nonce checks
 * - Strict RBAC (`viewer` < `operator` < `admin`)
 * - Append-only SHA-256 hash-chained audit logging (`agent-audit.jsonl`)
 */

const ROLE_RANK: Record<AgentRole, number> = {
  viewer: 1,
  operator: 2,
  admin: 3,
};

const PairRequestSchema = z.object({
  pairingCode: z.string().min(16).max(200),
  clientName: z.string().min(1).max(80).default('ADAS Desktop Console'),
});

const DeployRequestSchema = z.object({
  imageTag: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  buildFromSource: z.boolean().optional(),
});

const RollbackRequestSchema = z.object({
  targetTag: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
});

const RestoreRequestSchema = z.object({
  fileName: z.string().min(8).max(180),
  confirmationPhrase: z.string().min(10).max(240),
});

const ConfigUpdateSchema = z.object({
  values: z.record(z.string(), z.string()).optional(),
  rotateSecrets: z.record(z.string(), z.string()).optional(),
});

export interface ServerAgentHandle {
  server: Server;
  url: string;
  port: number;
  credentials: AgentCredentialStore;
  audit: AgentAuditLogger;
  operations: AgentOperationsService;
  close: () => Promise<void>;
}

class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const arr = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (arr.length >= this.maxRequests) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    return true;
  }
}

async function readRawBody(req: IncomingMessage, maxBytes = 64 * 1024): Promise<Buffer> {
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
  return Buffer.concat(chunks);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export async function startServerAgent(options: {
  repoRoot: string;
  dataDir?: string;
  host?: string;
  port?: number;
  serverName?: string;
  operations?: AgentOperationsService;
}): Promise<ServerAgentHandle> {
  const repoRoot = path.resolve(options.repoRoot);
  const dataDir = path.resolve(options.dataDir ?? path.join(repoRoot, 'data', 'server-agent'));
  const host = options.host ?? '127.0.0.1';
  const serverName = options.serverName ?? os.hostname();

  const credentials = new AgentCredentialStore(dataDir);
  const audit = new AgentAuditLogger(dataDir);
  const operations = options.operations ?? new AgentOperationsService({ repoRoot });

  const pairLimiter = new SlidingWindowLimiter(5, 10 * 60 * 1000);
  const apiLimiter = new SlidingWindowLimiter(120, 60 * 1000);

  let boundPort = options.port ?? 0;

  const server = createServer(async (req, res) => {
    const remoteIp = req.socket.remoteAddress ?? '127.0.0.1';
    const method = (req.method ?? 'GET').toUpperCase();
    const reqUrl = new URL(req.url ?? '/', `http://127.0.0.1:${boundPort}`);
    const pathWithQuery = `${reqUrl.pathname}${reqUrl.search}`;

    try {
      if (method === 'GET' && reqUrl.pathname === '/agent/v1/ping') {
        sendJson(res, 200, {
          service: 'adas-server-agent',
          version: '1.0.0',
          serverName,
        });
        return;
      }

      const rawBody =
        method === 'GET' || method === 'DELETE' ? Buffer.alloc(0) : await readRawBody(req);

      if (method === 'POST' && reqUrl.pathname === '/agent/v1/pair') {
        if (!pairLimiter.allow(remoteIp)) {
          audit.append({
            actorKeyId: 'none',
            actorName: 'unauthenticated',
            actorRole: 'unauthenticated',
            action: 'agent.pair',
            outcome: 'denied',
            remoteIp,
            metadata: { reason: 'rate_limited' },
          });
          sendJson(res, 429, { error: 'Too many pairing attempts. Try again later.' });
          return;
        }

        const parsed = PairRequestSchema.parse(JSON.parse(rawBody.toString('utf8') || '{}'));
        try {
          const paired = credentials.redeemPairingInvite(parsed);
          audit.append({
            actorKeyId: paired.keyId,
            actorName: paired.clientName,
            actorRole: paired.role,
            action: 'agent.pair',
            outcome: 'success',
            remoteIp,
            metadata: { role: paired.role },
          });
          sendJson(res, 200, {
            keyId: paired.keyId,
            sharedSecret: paired.sharedSecret,
            role: paired.role,
            clientName: paired.clientName,
            serverName,
          });
        } catch (err) {
          audit.append({
            actorKeyId: 'none',
            actorName: parsed.clientName,
            actorRole: 'unauthenticated',
            action: 'agent.pair',
            outcome: 'denied',
            remoteIp,
            metadata: { reason: err instanceof Error ? err.message : 'pair_failed' },
          });
          sendJson(res, 401, {
            error: err instanceof Error ? err.message : 'Pairing failed.',
          });
        }
        return;
      }

      // Authenticate all other /agent/v1/* endpoints via HMAC-SHA256
      const keyId = String(req.headers['x-adas-agent-key-id'] ?? '');
      const timestampHeader = String(req.headers['x-adas-agent-timestamp'] ?? '');
      const nonceHeader = String(req.headers['x-adas-agent-nonce'] ?? '');
      const signatureHeader = String(req.headers['x-adas-agent-signature'] ?? '');

      let principal: { keyId: string; clientName: string; role: AgentRole };
      try {
        principal = credentials.verifySignedRequest({
          keyId,
          timestampHeader,
          nonceHeader,
          signatureHeader,
          method,
          pathWithQuery,
          rawBody,
        });
      } catch (err) {
        audit.append({
          actorKeyId: keyId || 'missing',
          actorName: 'unauthenticated',
          actorRole: 'unauthenticated',
          action: `${method} ${reqUrl.pathname}`,
          outcome: 'denied',
          remoteIp,
          metadata: { reason: err instanceof Error ? err.message : 'auth_failed' },
        });
        sendJson(res, 401, { error: err instanceof Error ? err.message : 'Unauthorized' });
        return;
      }

      if (!apiLimiter.allow(principal.keyId)) {
        sendJson(res, 429, { error: 'Agent API rate limit exceeded.' });
        return;
      }

      const requireRole = (minimumRole: AgentRole): boolean => {
        if (ROLE_RANK[principal.role] < ROLE_RANK[minimumRole]) {
          audit.append({
            actorKeyId: principal.keyId,
            actorName: principal.clientName,
            actorRole: principal.role,
            action: `${method} ${reqUrl.pathname}`,
            outcome: 'denied',
            remoteIp,
            metadata: { requiredRole: minimumRole },
          });
          sendJson(res, 403, {
            error: `Insufficient role "${principal.role}" — "${minimumRole}" required.`,
          });
          return false;
        }
        return true;
      };

      const parseJson = (): unknown =>
        rawBody.length > 0 ? (JSON.parse(rawBody.toString('utf8')) as unknown) : {};

      // ---- VIEWER+ READ ENDPOINTS ----
      if (method === 'GET' && reqUrl.pathname === '/agent/v1/telemetry') {
        if (!requireRole('viewer')) return;
        const telemetry = await operations.getTelemetry();
        sendJson(res, 200, telemetry);
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/containers') {
        if (!requireRole('viewer')) return;
        sendJson(res, 200, { containers: operations.listContainers() });
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/logs') {
        if (!requireRole('viewer')) return;
        const service = ManagedServiceSchema.parse(reqUrl.searchParams.get('service') ?? 'api');
        const lines = Number.parseInt(reqUrl.searchParams.get('lines') ?? '120', 10);
        const levelParam = reqUrl.searchParams.get('level') ?? 'all';
        const level = z.enum(['all', 'info', 'warn', 'error']).parse(levelParam);
        const query = reqUrl.searchParams.get('q') ?? undefined;
        const result = operations.getLogs({
          service,
          lines: Number.isFinite(lines) ? lines : 120,
          level,
          query,
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/backups') {
        if (!requireRole('viewer')) return;
        sendJson(res, 200, { backups: operations.listBackups() });
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/config') {
        if (!requireRole('viewer')) return;
        sendJson(res, 200, operations.getMaskedConfig());
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/audit') {
        if (!requireRole('viewer')) return;
        const limit = Number.parseInt(reqUrl.searchParams.get('limit') ?? '100', 10);
        const integrity = audit.verifyChainIntegrity();
        sendJson(res, 200, {
          integrity,
          entries: audit.listRecent(Number.isFinite(limit) ? limit : 100),
        });
        return;
      }

      // ---- OPERATOR+ ENDPOINTS ----
      const svcMatch = /^\/agent\/v1\/services\/([a-z0-9-]+)\/(start|stop|restart)$/.exec(
        reqUrl.pathname,
      );
      if (method === 'POST' && svcMatch) {
        if (!requireRole('operator')) return;
        const svc = svcMatch[1] ?? '';
        const action = svcMatch[2] ?? '';
        const result = operations.controlService(svc, action);
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: `service.${result.action}`,
          outcome: 'success',
          remoteIp,
          metadata: { service: result.service },
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && reqUrl.pathname === '/agent/v1/backups/run') {
        if (!requireRole('operator')) return;
        const result = operations.runManualBackup();
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'backup.manual_run',
          outcome: 'success',
          remoteIp,
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && reqUrl.pathname === '/agent/v1/backups/drill') {
        if (!requireRole('operator')) return;
        const result = operations.runRestoreDrill();
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'backup.restore_drill',
          outcome: 'success',
          remoteIp,
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/diagnostics') {
        if (!requireRole('operator')) return;
        const bundle = await operations.buildDiagnosticsBundle(audit.listRecent(50));
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'diagnostics.export',
          outcome: 'success',
          remoteIp,
        });
        sendJson(res, 200, bundle);
        return;
      }

      // ---- ADMIN-ONLY ENDPOINTS ----
      if (method === 'POST' && reqUrl.pathname === '/agent/v1/deploy') {
        if (!requireRole('admin')) return;
        const body = DeployRequestSchema.parse(parseJson());
        const result = await operations.deployRelease(body);
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'release.deploy',
          outcome: result.rolledBack ? 'error' : 'success',
          remoteIp,
          metadata: {
            requestedTag: body.imageTag,
            activeTag: result.activeTag,
            rolledBack: result.rolledBack,
          },
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && reqUrl.pathname === '/agent/v1/rollback') {
        if (!requireRole('admin')) return;
        const body = RollbackRequestSchema.parse(parseJson());
        const result = operations.rollbackRelease(body);
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'release.rollback',
          outcome: 'success',
          remoteIp,
          metadata: { restoredTag: result.restoredTag },
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && reqUrl.pathname === '/agent/v1/migrate') {
        if (!requireRole('admin')) return;
        const result = operations.runMigrations();
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'database.migrate',
          outcome: 'success',
          remoteIp,
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'POST' && reqUrl.pathname === '/agent/v1/backups/restore') {
        if (!requireRole('admin')) return;
        const body = RestoreRequestSchema.parse(parseJson());
        const result = operations.restoreDatabaseFromBackup(body);
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'backup.restore_database',
          outcome: 'success',
          remoteIp,
          metadata: { restoredFile: result.restoredFile },
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'PUT' && reqUrl.pathname === '/agent/v1/config') {
        if (!requireRole('admin')) return;
        const body = ConfigUpdateSchema.parse(parseJson());
        const result = operations.updateConfig({
          values: body.values as Partial<Record<AllowlistedConfigKey, string>>,
          rotateSecrets: body.rotateSecrets as Partial<Record<AllowlistedSecretFile, string>>,
        });
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'config.update',
          outcome: 'success',
          remoteIp,
          metadata: {
            updatedKeysCount: result.updatedKeys.length,
            rotatedSecretsCount: result.rotatedSecrets.length,
          },
        });
        sendJson(res, 200, result);
        return;
      }

      if (method === 'GET' && reqUrl.pathname === '/agent/v1/clients') {
        if (!requireRole('admin')) return;
        sendJson(res, 200, { clients: credentials.listClients() });
        return;
      }

      const revokeMatch = /^\/agent\/v1\/clients\/(agt_[a-f0-9]+)$/.exec(reqUrl.pathname);
      if (method === 'DELETE' && revokeMatch) {
        if (!requireRole('admin')) return;
        const targetKeyId = revokeMatch[1] ?? '';
        const revoked = credentials.revokeClient(targetKeyId);
        audit.append({
          actorKeyId: principal.keyId,
          actorName: principal.clientName,
          actorRole: principal.role,
          action: 'agent.client_revoke',
          outcome: revoked ? 'success' : 'error',
          remoteIp,
          metadata: { targetKeyId, revoked },
        });
        sendJson(res, revoked ? 200 : 404, { revoked, keyId: targetKeyId });
        return;
      }

      sendJson(res, 404, { error: 'Agent endpoint not found.' });
    } catch (err) {
      if (err instanceof z.ZodError) {
        sendJson(res, 400, {
          error: 'Validation failed',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
        return;
      }
      sendJson(res, 400, {
        error: redactSensitiveText(err instanceof Error ? err.message : 'Agent operation failed'),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3090, host, () => {
      const addr = server.address() as AddressInfo;
      boundPort = addr.port;
      resolve();
    });
  });

  return {
    server,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${boundPort}`,
    port: boundPort,
    credentials,
    audit,
    operations,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
