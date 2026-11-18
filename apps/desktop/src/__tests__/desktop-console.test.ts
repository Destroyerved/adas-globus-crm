import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentOperationsService,
  startServerAgent,
  type ServerAgentHandle,
} from '@adas/server-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopIpcController } from '../main/ipc-controller.js';
import { ServerProfileVault, type OsSafeStorageAdapter } from '../main/profile-vault.js';
import {
  createHardenedWebPreferences,
  DESKTOP_CONTENT_SECURITY_POLICY,
  isAllowedNavigationUrl,
  validateAgentBaseUrl,
} from '../main/security-policy.js';
import { DESKTOP_IPC_CHANNELS } from '../shared/ipc-contract.js';

describe('Milestone 12: Electron Desktop Server Management Console', () => {
  const tempDirs: string[] = [];
  const agents: ServerAgentHandle[] = [];
  const controllers: DesktopIpcController[] = [];

  function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (controllers.length > 0) {
      const c = controllers.pop();
      if (c) await c.close();
    }
    while (agents.length > 0) {
      const a = agents.pop();
      if (a) await a.close();
    }
    while (tempDirs.length > 0) {
      const d = tempDirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  it('enforces BrowserWindow contextIsolation, sandbox, connect-src none CSP, navigation lock, and HTTPS remote URLs', () => {
    const prefs = createHardenedWebPreferences('/app/dist/preload/index.cjs');
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
    expect(prefs.nodeIntegrationInWorker).toBe(false);
    expect(prefs.nodeIntegrationInSubFrames).toBe(false);
    expect(prefs.sandbox).toBe(true);
    expect(prefs.webSecurity).toBe(true);
    expect(prefs.allowRunningInsecureContent).toBe(false);
    expect(prefs.webviewTag).toBe(false);

    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("connect-src 'none'");
    expect(DESKTOP_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");

    const entry = 'file:///opt/adas/dist/renderer/index.html';
    expect(isAllowedNavigationUrl(entry, entry)).toBe(true);
    expect(isAllowedNavigationUrl('https://evil.example/phish', entry)).toBe(false);
    expect(isAllowedNavigationUrl('file:///etc/passwd', entry)).toBe(false);

    // Loopback HTTP is permitted; remote plaintext HTTP is forbidden!
    expect(validateAgentBaseUrl('http://127.0.0.1:3090/')).toBe('http://127.0.0.1:3090');
    expect(validateAgentBaseUrl('https://ops-agent.adasglobuspro.com/')).toBe(
      'https://ops-agent.adasglobuspro.com',
    );
    expect(() => validateAgentBaseUrl('http://203.0.113.42:3090')).toThrow(/Plaintext http/i);
  });

  it('encrypts paired sharedSecret and Cloudflare Access secrets in ServerProfileVault and never leaks them to public summaries', () => {
    const vaultDir = makeTempDir('adas-desktop-vault-');
    const mockKeychain: OsSafeStorageAdapter = {
      isEncryptionAvailable: () => true,
      encryptString: (plain) => Buffer.from(`oswrap:${plain}`, 'utf8'),
      decryptString: (buf) => {
        const str = buf.toString('utf8');
        if (!str.startsWith('oswrap:')) throw new Error('Bad keychain blob');
        return str.slice('oswrap:'.length);
      },
    };

    const vault = new ServerProfileVault(vaultDir, mockKeychain);
    const summary = vault.savePairedProfile({
      name: 'Toronto CPA Prod',
      mode: 'remote',
      agentUrl: 'https://ops-agent.adasglobuspro.com',
      keyId: 'agt_112233445566',
      sharedSecret: 'agtsec_ultra_sensitive_secret_value_999',
      role: 'admin',
      serverName: 'adas-prod-ubuntu',
      cfAccessClientId: 'cf_id_abc',
      cfAccessClientSecret: 'cf_secret_xyz_never_plaintext',
    });

    // Public summary has zero secret properties
    expect(JSON.stringify(summary)).not.toContain('agtsec_ultra_sensitive_secret_value_999');
    expect(JSON.stringify(summary)).not.toContain('cf_secret_xyz_never_plaintext');
    expect(summary.hasCloudflareServiceToken).toBe(true);

    // Raw vault file on disk encrypts secrets with AES-256-GCM
    const rawDisk = readFileSync(path.join(vaultDir, 'profiles.vault.json'), 'utf8');
    expect(rawDisk).not.toContain('agtsec_ultra_sensitive_secret_value_999');
    expect(rawDisk).not.toContain('cf_secret_xyz_never_plaintext');

    // Re-opening vault decrypts cleanly inside main process
    const reopened = new ServerProfileVault(vaultDir, mockKeychain);
    const dec = reopened.getDecryptedProfileForMainProcessOnly(summary.id);
    expect(dec.sharedSecret).toBe('agtsec_ultra_sensitive_secret_value_999');
    expect(dec.cfAccessClientSecret).toBe('cf_secret_xyz_never_plaintext');
  });

  it('pairs via DesktopIpcController with a live @adas/server-agent and executes telemetry, config rotation, diagnostics, and channel guards', async () => {
    const repoRoot = makeTempDir('adas-desktop-repo-');
    const vaultDir = makeTempDir('adas-desktop-ipc-vault-');
    mkdirSync(path.join(repoRoot, 'secrets'), { recursive: true });
    mkdirSync(path.join(repoRoot, 'data', 'backups'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"adas-crm"}\n', 'utf8');
    writeFileSync(
      path.join(repoRoot, '.env.production'),
      'NODE_ENV=production\nADAS_DOMAIN=adasglobuspro.com\nLOG_LEVEL=info\n',
      'utf8',
    );

    const ops = new AgentOperationsService({
      repoRoot,
      exec: () => ({ status: 0, stdout: '[]', stderr: '' }),
    });
    const remoteAgent = await startServerAgent({
      repoRoot,
      port: 0,
      serverName: 'office-16gb-node',
      operations: ops,
    });
    agents.push(remoteAgent);

    const invite = remoteAgent.credentials.issuePairingInvite({
      role: 'admin',
      label: 'Ops Console',
    });

    let exportedBundlePath: string | null = null;
    const vault = new ServerProfileVault(vaultDir);
    const controller = new DesktopIpcController({
      vault,
      defaultRepoRoot: repoRoot,
      saveDiagnosticsFile: async (defaultName, content) => {
        const p = path.join(vaultDir, defaultName);
        writeFileSync(p, content, 'utf8');
        exportedBundlePath = p;
        return p;
      },
    });
    controllers.push(controller);

    // Pair over IPC channel
    const pairedRes = (await controller.invokeChannel(DESKTOP_IPC_CHANNELS.pairRemote, {
      name: 'Office 16GB Server',
      agentUrl: remoteAgent.url,
      pairingCode: invite.pairingCode,
    })) as { profile: { id: string; serverName: string } };
    expect(pairedRes.profile.serverName).toBe('office-16gb-node');
    const profileId = pairedRes.profile.id;

    // Fetch live overview (telemetry + containers)
    const overview = await controller.getOverview({ profileId });
    expect(overview.telemetry.cpuCount).toBeGreaterThanOrEqual(1);
    expect(overview.containers).toHaveLength(7);

    // Update config & rotate a secret slot without exposing secret back
    const rotated = await controller.updateConfig({
      profileId,
      values: { LOG_LEVEL: 'warn' },
      rotateSecrets: { 'apollo_api_key.txt': 'apollo_live_secret_key_987654' },
    });
    expect(rotated.updatedKeys).toContain('LOG_LEVEL');
    expect(rotated.rotatedSecrets).toContain('apollo_api_key.txt');

    const maskedCfg = await controller.getConfig({ profileId });
    expect(maskedCfg.values.LOG_LEVEL).toBe('warn');
    expect(JSON.stringify(maskedCfg)).not.toContain('apollo_live_secret_key_987654');
    const apolloSlot = maskedCfg.secrets.find((s) => s.fileName === 'apollo_api_key.txt');
    expect(apolloSlot?.configured).toBe(true);

    // Export redacted diagnostics bundle
    const diag = await controller.exportDiagnostics({ profileId });
    expect(diag.savedPath).toBe(exportedBundlePath);
    expect(exportedBundlePath && existsSync(exportedBundlePath)).toBe(true);
    expect(JSON.stringify(diag.bundle)).not.toContain('apollo_live_secret_key_987654');

    // Unknown IPC channel is strictly rejected
    await expect(controller.invokeChannel('adas-desktop:shell:exec', {})).rejects.toThrow(
      /Disallowed IPC channel/,
    );
  });
});
