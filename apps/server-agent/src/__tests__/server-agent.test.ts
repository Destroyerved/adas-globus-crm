import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { signAgentRequest } from '../crypto-auth.js';
import { AgentOperationsService } from '../operations.js';
import { startServerAgent, type ServerAgentHandle } from '../server.js';

describe('Milestone 13: Authenticated Local & Remote Server Management Agent', () => {
  const tempDirs: string[] = [];
  const activeAgents: ServerAgentHandle[] = [];

  function makeTempRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adas-agent-test-'));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, 'secrets'), { recursive: true });
    mkdirSync(path.join(dir, 'data', 'backups'), { recursive: true });
    mkdirSync(path.join(dir, 'infra'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{"name":"adas-crm"}\n', 'utf8');
    writeFileSync(
      path.join(dir, 'secrets', 'session_secret.txt'),
      'sess_super_secret_value_never_exposed_12345\n',
      'utf8',
    );
    writeFileSync(
      path.join(dir, '.env.production'),
      'NODE_ENV=production\nADAS_DOMAIN=adasglobuspro.com\nMAIL_LIVE=false\n',
      'utf8',
    );
    // Write a valid ADASBK01 header archive
    writeFileSync(
      path.join(dir, 'data', 'backups', 'adas-20261118-020000.adasbk'),
      Buffer.concat([Buffer.from('ADASBK01', 'ascii'), Buffer.alloc(64, 0xaa)]),
    );
    return dir;
  }

  afterEach(async () => {
    while (activeAgents.length > 0) {
      const a = activeAgents.pop();
      if (a) await a.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  async function signedFetch(params: {
    baseUrl: string;
    keyId: string;
    sharedSecret: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    pathWithQuery: string;
    body?: unknown;
    timestampSec?: number;
    nonce?: string;
  }) {
    const rawBody =
      params.body !== undefined && params.method !== 'GET' && params.method !== 'DELETE'
        ? JSON.stringify(params.body)
        : '';
    const headers = signAgentRequest({
      keyId: params.keyId,
      sharedSecret: params.sharedSecret,
      method: params.method,
      pathWithQuery: params.pathWithQuery,
      rawBody,
      timestampSec: params.timestampSec,
      nonce: params.nonce,
    });
    return fetch(`${params.baseUrl}${params.pathWithQuery}`, {
      method: params.method,
      headers: {
        ...headers,
        ...(rawBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: rawBody || undefined,
    });
  }

  it('enforces single-use pairing codes, pairing rate limits, HMAC replay/tamper defense, and viewer/operator/admin RBAC', async () => {
    const repoRoot = makeTempRepo();
    const ops = new AgentOperationsService({
      repoRoot,
      exec: (_cmd, args) => {
        if (args.includes('logs')) {
          return {
            status: 0,
            stdout:
              '2026-11-18T10:00:00Z INFO user=jane.doe@cpafirm.example auth=Bearer secretJwtToken123 db=postgresql://adas_app:myPass123@postgres:5432/adas_crm pat=adas_pat_abcdef123456',
            stderr: '',
          };
        }
        if (args.includes('ps')) {
          return {
            status: 0,
            stdout: JSON.stringify({
              Service: 'api',
              State: 'running',
              Status: 'Up 4 hours (healthy)',
              Image: 'adas-crm-api:v1.0.0',
            }),
            stderr: '',
          };
        }
        return { status: 0, stdout: 'ok', stderr: '' };
      },
    });

    const agent = await startServerAgent({ repoRoot, port: 0, operations: ops });
    activeAgents.push(agent);

    // Issue viewer, operator, and admin pairing invites
    const viewerInvite = agent.credentials.issuePairingInvite({
      role: 'viewer',
      label: 'Read-only laptop',
    });
    const adminInvite = agent.credentials.issuePairingInvite({
      role: 'admin',
      label: 'Lead SRE laptop',
    });

    // Verify raw invite code is NOT stored in plaintext in agent-auth.json
    const authDisk = readFileSync(
      path.join(repoRoot, 'data', 'server-agent', 'agent-auth.json'),
      'utf8',
    );
    expect(authDisk).not.toContain(viewerInvite.pairingCode);
    expect(authDisk).not.toContain(adminInvite.pairingCode);

    // Redeem viewer invite
    const pairViewerRes = await fetch(`${agent.url}/agent/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: viewerInvite.pairingCode, clientName: 'Viewer PC' }),
    });
    expect(pairViewerRes.status).toBe(200);
    const viewerCreds = (await pairViewerRes.json()) as {
      keyId: string;
      sharedSecret: string;
      role: string;
    };
    expect(viewerCreds.role).toBe('viewer');

    // Reusing the same pairing code must fail with 401
    const reuseRes = await fetch(`${agent.url}/agent/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: viewerInvite.pairingCode, clientName: 'Attacker' }),
    });
    expect(reuseRes.status).toBe(401);

    // Redeem admin invite
    const pairAdminRes = await fetch(`${agent.url}/agent/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: adminInvite.pairingCode, clientName: 'Admin PC' }),
    });
    expect(pairAdminRes.status).toBe(200);
    const adminCreds = (await pairAdminRes.json()) as {
      keyId: string;
      sharedSecret: string;
    };

    // Exhaust remaining pairing rate limit (5 per 10m -> 6th gets 429)
    await fetch(`${agent.url}/agent/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'pair_invalid_0000000000000001', clientName: 'Brute' }),
    });
    await fetch(`${agent.url}/agent/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'pair_invalid_0000000000000002', clientName: 'Brute' }),
    });
    const limitedRes = await fetch(`${agent.url}/agent/v1/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: 'pair_invalid_0000000000000003', clientName: 'Brute' }),
    });
    expect(limitedRes.status).toBe(429);

    // Replay / stale timestamp rejection
    const staleRes = await signedFetch({
      baseUrl: agent.url,
      keyId: viewerCreds.keyId,
      sharedSecret: viewerCreds.sharedSecret,
      method: 'GET',
      pathWithQuery: '/agent/v1/telemetry',
      timestampSec: Math.floor(Date.now() / 1000) - 600,
    });
    expect(staleRes.status).toBe(401);

    const fixedNonce = '0123456789abcdef0123456789abcdef';
    const firstNonceRes = await signedFetch({
      baseUrl: agent.url,
      keyId: viewerCreds.keyId,
      sharedSecret: viewerCreds.sharedSecret,
      method: 'GET',
      pathWithQuery: '/agent/v1/telemetry',
      nonce: fixedNonce,
    });
    expect(firstNonceRes.status).toBe(200);

    const replayNonceRes = await signedFetch({
      baseUrl: agent.url,
      keyId: viewerCreds.keyId,
      sharedSecret: viewerCreds.sharedSecret,
      method: 'GET',
      pathWithQuery: '/agent/v1/telemetry',
      nonce: fixedNonce,
    });
    expect(replayNonceRes.status).toBe(401);

    // Viewer can read redacted logs & masked config, but CANNOT restart services (403)
    const logsRes = await signedFetch({
      baseUrl: agent.url,
      keyId: viewerCreds.keyId,
      sharedSecret: viewerCreds.sharedSecret,
      method: 'GET',
      pathWithQuery: '/agent/v1/logs?service=api',
    });
    expect(logsRes.status).toBe(200);
    const logsBody = (await logsRes.json()) as { lines: string[] };
    expect(logsBody.lines[0]).not.toContain('jane.doe@cpafirm.example');
    expect(logsBody.lines[0]).not.toContain('secretJwtToken123');
    expect(logsBody.lines[0]).not.toContain('myPass123');
    expect(logsBody.lines[0]).not.toContain('abcdef123456');
    expect(logsBody.lines[0]).toContain('[REDACTED_EMAIL]');

    const viewerRestart = await signedFetch({
      baseUrl: agent.url,
      keyId: viewerCreds.keyId,
      sharedSecret: viewerCreds.sharedSecret,
      method: 'POST',
      pathWithQuery: '/agent/v1/services/api/restart',
      body: {},
    });
    expect(viewerRestart.status).toBe(403);

    // Admin can restart allowlisted service, cannot invoke non-allowlisted service (404), and secrets stay masked
    const adminRestart = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'POST',
      pathWithQuery: '/agent/v1/services/api/restart',
      body: {},
    });
    expect(adminRestart.status).toBe(200);

    const evilService = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'POST',
      pathWithQuery: '/agent/v1/services/arbitrary-shell/restart',
      body: {},
    });
    expect(evilService.status).toBe(400);

    const noShellEndpoint = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'POST',
      pathWithQuery: '/agent/v1/exec',
      body: { cmd: 'whoami' },
    });
    expect(noShellEndpoint.status).toBe(404);

    // Masked config never leaks secret file content, and blocks MAIL_LIVE updates
    const cfgRes = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'GET',
      pathWithQuery: '/agent/v1/config',
    });
    const cfgText = await cfgRes.text();
    expect(cfgText).not.toContain('sess_super_secret_value_never_exposed_12345');

    const forbiddenKeyUpdate = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'PUT',
      pathWithQuery: '/agent/v1/config',
      body: { values: { MAIL_LIVE: 'true' } },
    });
    expect(forbiddenKeyUpdate.status).toBe(400);

    // Destructive backup restore requires exact confirmation phrase
    const badRestore = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'POST',
      pathWithQuery: '/agent/v1/backups/restore',
      body: { fileName: 'adas-20261118-020000.adasbk', confirmationPhrase: 'yes' },
    });
    expect(badRestore.status).toBe(400);

    const okRestore = await signedFetch({
      baseUrl: agent.url,
      keyId: adminCreds.keyId,
      sharedSecret: adminCreds.sharedSecret,
      method: 'POST',
      pathWithQuery: '/agent/v1/backups/restore',
      body: {
        fileName: 'adas-20261118-020000.adasbk',
        confirmationPhrase: 'RESTORE DATABASE adas-20261118-020000.adasbk',
      },
    });
    expect(okRestore.status).toBe(200);

    // Verify tamper-evident SHA-256 audit hash chain
    const integrityBefore = agent.audit.verifyChainIntegrity();
    expect(integrityBefore.valid).toBe(true);
    expect(integrityBefore.checkedCount).toBeGreaterThanOrEqual(6);

    // Tamper with a single word in agent-audit.jsonl -> chain verification must fail!
    const auditLogFile = path.join(repoRoot, 'data', 'server-agent', 'agent-audit.jsonl');
    const tampered = readFileSync(auditLogFile, 'utf8').replace('service.restart', 'service.stop');
    writeFileSync(auditLogFile, tampered, 'utf8');
    expect(agent.audit.verifyChainIntegrity().valid).toBe(false);
  });
});
