import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runPreflightChecks } from '../preflight.js';
import { InstallerService, UNINSTALL_PURGE_CONFIRMATION } from '../provision.js';
import { startInstallerWizardServer } from '../wizard-server.js';

describe('Milestone 11: One-Click Cross-Platform Server Installer', () => {
  const tempDirs: string[] = [];

  function makeTempRepo(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'adas-installer-test-'));
    tempDirs.push(dir);
    writeFileSync(path.join(dir, 'package.json'), '{"name":"adas-crm-test"}\n', 'utf8');
    return dir;
  }

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('evaluates hardware, Docker, and port collisions during preflight and treats active .deploy-state ports as warn', async () => {
    const targetDir = makeTempRepo();

    // Occupy an ephemeral loopback port to simulate a port collision
    const occupiedServer = createServer();
    await new Promise<void>((resolve) => occupiedServer.listen(0, '127.0.0.1', () => resolve()));
    const occupiedPort = (occupiedServer.address() as AddressInfo).port;

    try {
      const failReport = await runPreflightChecks({
        targetDir,
        portsToCheck: [occupiedPort],
        probeCommand: (cmd, args) => {
          if (cmd === 'docker' && args[0] === 'info') {
            return { status: 0, stdout: '27.5.1', stderr: '' };
          }
          if (cmd === 'docker' && args[0] === 'compose') {
            return { status: 0, stdout: '2.32.4', stderr: '' };
          }
          return { status: 1, stdout: '', stderr: 'unknown' };
        },
      });

      const portCheck = failReport.checks.find((c) => c.id === `port_${occupiedPort}`);
      expect(portCheck?.status).toBe('fail');
      expect(failReport.readyForProductionDeploy).toBe(false);
      expect(failReport.readyForProvisionOnly).toBe(true);

      // Now mark an existing ADAS CRM deployment in .deploy-state -> port in use downgrades to 'warn'
      writeFileSync(path.join(targetDir, '.deploy-state'), 'v1.0.0\n', 'utf8');
      const upgradeReport = await runPreflightChecks({
        targetDir,
        portsToCheck: [occupiedPort],
        probeCommand: () => ({ status: 0, stdout: '27.5.1', stderr: '' }),
      });

      const upgradePortCheck = upgradeReport.checks.find((c) => c.id === `port_${occupiedPort}`);
      expect(upgradePortCheck?.status).toBe('warn');
      expect(upgradeReport.existingInstall.currentTag).toBe('v1.0.0');
    } finally {
      await new Promise<void>((resolve) => occupiedServer.close(() => resolve()));
    }
  });

  it('provisions secrets, .env.production, and Cloudflare ingress idempotently without overwriting existing secrets', () => {
    const targetDir = makeTempRepo();
    const service = new InstallerService();

    const first = service.provisionConfiguration({
      targetDir,
      domain: 'https://ExampleCPAStaffing.com/path',
      tunnelName: 'cpa-office-tunnel',
      tunnelToken: 'cf_tok_initial_123456',
      enableAutomationProfile: true,
    });

    expect(first.domain).toBe('examplecpastaffing.com');
    expect(first.createdSecrets).toEqual([
      'postgres_admin_password.txt',
      'postgres_app_password.txt',
      'session_secret.txt',
      'token_encryption_key.txt',
      'backup_encryption_key.txt',
    ]);
    expect(first.preservedSecrets).toEqual([]);
    expect(first.backupEnvPath).toBeNull();
    expect(existsSync(first.cloudflareConfigPath)).toBe(true);
    expect(existsSync(first.dnsZonePath)).toBe(true);

    const initialSecrets = new Map<string, string>();
    for (const filename of first.createdSecrets) {
      initialSecrets.set(filename, readFileSync(path.join(targetDir, 'secrets', filename), 'utf8'));
    }

    // Simulate owner enabling MAIL_LIVE=true and rotating key version to 2
    const modifiedEnv = readFileSync(first.envFilePath, 'utf8')
      .replace('MAIL_LIVE=false', 'MAIL_LIVE=true')
      .replace('TOKEN_ENCRYPTION_KEY_VERSION=1', 'TOKEN_ENCRYPTION_KEY_VERSION=2');
    writeFileSync(first.envFilePath, modifiedEnv, 'utf8');

    // Second run must preserve ALL 5 secrets + MAIL_LIVE=true + key version 2
    const second = service.provisionConfiguration({
      targetDir,
      domain: 'examplecpastaffing.com',
      tunnelName: 'cpa-office-tunnel',
    });

    expect(second.createdSecrets).toEqual([]);
    expect(second.preservedSecrets).toHaveLength(5);
    expect(second.backupEnvPath).toBe(`${first.envFilePath}.bak`);
    expect(existsSync(`${first.envFilePath}.bak`)).toBe(true);

    for (const [filename, originalValue] of initialSecrets.entries()) {
      expect(readFileSync(path.join(targetDir, 'secrets', filename), 'utf8')).toBe(originalValue);
    }

    const secondEnv = readFileSync(second.envFilePath, 'utf8');
    expect(secondEnv).toContain('MAIL_LIVE=true');
    expect(secondEnv).toContain('TOKEN_ENCRYPTION_KEY_VERSION=2');
    expect(secondEnv).toContain('DATABASE_URL=postgresql://adas_app:');
    expect(secondEnv).toContain('DATABASE_ADMIN_URL=postgresql://adas_admin:');
  });

  it('installs, upgrades with automatic rollback on failed /healthz, and enforces safe uninstall confirmation', async () => {
    const targetDir = makeTempRepo();
    writeFileSync(path.join(targetDir, 'package.json'), '{}', 'utf8');

    const executedCommands: string[] = [];
    const service = new InstallerService({
      exec: (cmd, args, options) => {
        const tag = options?.env?.ADAS_IMAGE_TAG ?? '';
        executedCommands.push(`${cmd} ${args.join(' ')} [tag=${tag}]`);
        if (args.includes('apps/api/dist/cli/break-glass.js')) {
          return { status: 0, stdout: 'Break-glass configured for admin', stderr: '' };
        }
        return { status: 0, stdout: 'ok', stderr: '' };
      },
      probe: () => ({ status: 0, stdout: '27.5.1', stderr: '' }),
    });

    // Install v1.0.0 (skip loopback port 3000 health wait; test health server explicitly on upgrade)
    const installed = await service.installStack({
      config: { targetDir, domain: 'adasglobuspro.com' },
      imageTag: 'v1.0.0',
      adminEmail: 'ops-admin@adasglobuspro.com',
      skipHealthWait: true,
    });

    expect(installed.imageTag).toBe('v1.0.0');
    expect(installed.breakGlassOutput).toContain('Break-glass configured');
    expect(readFileSync(path.join(targetDir, '.deploy-state'), 'utf8').trim()).toBe('v1.0.0');

    // Spin up a local health mock that starts healthy for v1.1.0, then fails 503 for v1.2.0
    let healthStatus = 200;
    const mockHealth = createServer((_req, res) => {
      res.writeHead(healthStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: healthStatus === 200 ? 'ok' : 'down' }));
    });
    await new Promise<void>((resolve) => mockHealth.listen(0, '127.0.0.1', () => resolve()));
    const healthPort = (mockHealth.address() as AddressInfo).port;
    const healthUrl = `http://127.0.0.1:${healthPort}/healthz`;

    try {
      const upgraded = await service.upgradeStack({
        targetDir,
        imageTag: 'v1.1.0',
        healthUrl,
      });
      expect(upgraded.rolledBack).toBe(false);
      expect(upgraded.activeTag).toBe('v1.1.0');
      expect(readFileSync(path.join(targetDir, '.deploy-state'), 'utf8').trim()).toBe('v1.1.0');
      expect(readFileSync(path.join(targetDir, '.deploy-state.prev'), 'utf8').trim()).toBe(
        'v1.0.0',
      );

      // Now simulate broken v1.2.0 health check -> must automatically roll back to v1.1.0!
      healthStatus = 503;
      // Override checkStackHealth wait timeout via fast failure check: waitForHealthy polls 30s unless we mock it or test checkStackHealth directly.
      // Let's verify checkStackHealth 503 + explicit rollbackStack first, and fast-override waitForHealthy for instant rollback test!
      const badCheck = await service.checkStackHealth(`http://127.0.0.1:${healthPort}`);
      expect(badCheck.ok).toBe(false);
      expect(badCheck.httpStatus).toBe(503);

      (
        service as unknown as { waitForHealthy: () => Promise<{ ok: boolean; detail: string }> }
      ).waitForHealthy = async () => ({ ok: false, detail: 'HTTP 503 (down)' });

      const failedUpgrade = await service.upgradeStack({
        targetDir,
        imageTag: 'v1.2.0',
        healthUrl,
      });
      expect(failedUpgrade.rolledBack).toBe(true);
      expect(failedUpgrade.activeTag).toBe('v1.1.0');
      expect(readFileSync(path.join(targetDir, '.deploy-state'), 'utf8').trim()).toBe('v1.1.0');
    } finally {
      await new Promise<void>((resolve) => mockHealth.close(() => resolve()));
    }

    // Safe uninstall: default preserves secrets/ and .env.production
    const safeStop = service.uninstallStack({ targetDir, purgeData: false });
    expect(safeStop.dataPurged).toBe(false);
    expect(existsSync(path.join(targetDir, 'secrets', 'session_secret.txt'))).toBe(true);
    expect(existsSync(path.join(targetDir, '.env.production'))).toBe(true);

    // Purging without confirmation phrase MUST throw
    expect(() =>
      service.uninstallStack({
        targetDir,
        purgeData: true,
        confirmationPhrase: 'wrong phrase',
      }),
    ).toThrow(UNINSTALL_PURGE_CONFIRMATION);

    // Purging with exact phrase deletes data, secrets, and .env.production
    const purged = service.uninstallStack({
      targetDir,
      purgeData: true,
      confirmationPhrase: UNINSTALL_PURGE_CONFIRMATION,
    });
    expect(purged.dataPurged).toBe(true);
    expect(existsSync(path.join(targetDir, 'secrets'))).toBe(false);
    expect(existsSync(path.join(targetDir, '.env.production'))).toBe(false);
  });

  it('serves loopback setup wizard UI and enforces CSRF + Origin checks on mutating endpoints', async () => {
    const targetDir = makeTempRepo();
    const handle = await startInstallerWizardServer({
      defaultTargetDir: targetDir,
      port: 0,
      probeCommand: () => ({ status: 0, stdout: '27.5.1', stderr: '' }),
    });

    try {
      const pageRes = await fetch(`${handle.url}/`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get('x-frame-options')).toBe('DENY');
      const html = await pageRes.text();
      expect(html).toContain('ADAS CRM production server installer');

      // Missing CSRF token -> 403
      const noCsrf = await fetch(`${handle.url}/api/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetDir, domain: 'adasglobuspro.com' }),
      });
      expect(noCsrf.status).toBe(403);

      // Evil Origin -> 403 even with valid CSRF token
      const badOrigin = await fetch(`${handle.url}/api/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Installer-Csrf': handle.csrfToken,
          Origin: 'https://evil.example',
        },
        body: JSON.stringify({ targetDir, domain: 'adasglobuspro.com' }),
      });
      expect(badOrigin.status).toBe(403);

      // Valid loopback Origin + valid CSRF -> 200 provisioned
      const okRes = await fetch(`${handle.url}/api/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Installer-Csrf': handle.csrfToken,
          Origin: handle.url,
        },
        body: JSON.stringify({ targetDir, domain: 'adasglobuspro.com' }),
      });
      expect(okRes.status).toBe(200);
      const body = (await okRes.json()) as {
        status: string;
        result: { createdSecrets: string[] };
      };
      expect(body.status).toBe('provisioned');
      expect(body.result.createdSecrets).toHaveLength(5);
    } finally {
      await handle.close();
    }
  });

  it('compiles and runs ADAS-CRM-Deployer.exe --provision idempotently on Windows', () => {
    if (process.platform !== 'win32') return;
    const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
    const exePath = path.join(repoRoot, 'dist', 'deployer', 'ADAS-CRM-Deployer.exe');
    if (!existsSync(exePath)) return;

    const targetDir = makeTempRepo();
    // Create package.json + infra/ so ResolveRepoRoot() or current working directory works cleanly
    const infraDir = path.join(targetDir, 'infra');
    writeFileSync(path.join(targetDir, 'package.json'), '{"name":"test"}\n', 'utf8');
    execFileSync('cmd.exe', ['/c', 'mkdir', infraDir]);

    // Copy exe into temp repo so ResolveRepoRoot() targets temp repo (never touching real workspace!)
    const tempExe = path.join(targetDir, 'ADAS-CRM-Deployer.exe');
    writeFileSync(tempExe, readFileSync(exePath));

    const out1 = execFileSync(tempExe, ['--provision', '--domain', 'cpafirm.example'], {
      cwd: targetDir,
      encoding: 'utf8',
    });
    expect(out1).toContain('postgres_admin_password.txt');
    expect(out1).toContain('backup_encryption_key.txt');

    const secretBefore = readFileSync(
      path.join(targetDir, 'secrets', 'postgres_app_password.txt'),
      'utf8',
    );
    const out2 = execFileSync(tempExe, ['--provision', '--domain', 'cpafirm.example'], {
      cwd: targetDir,
      encoding: 'utf8',
    });
    expect(out2).toContain('Existing secret preserved -> postgres_app_password.txt');
    expect(readFileSync(path.join(targetDir, 'secrets', 'postgres_app_password.txt'), 'utf8')).toBe(
      secretBefore,
    );
  });
});
