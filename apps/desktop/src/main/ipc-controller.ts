import { writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ManagedServiceSchema,
  ServiceActionSchema,
  startServerAgent,
  type AgentAuditEntry,
  type BackupArchiveItem,
  type ContainerStatusItem,
  type PairedClientSummary,
  type ServerAgentHandle,
  type TelemetrySnapshot,
} from '@adas/server-agent';
import { z } from 'zod';
import {
  DESKTOP_IPC_CHANNELS,
  type AuditAndClientsPayload,
  type DesktopBridgeApi,
  type MaskedConfigPayload,
  type ServerOverviewPayload,
  type ServerProfileSummary,
} from '../shared/ipc-contract.js';
import { AgentRpcClient } from './agent-rpc-client.js';
import type { ServerProfileVault } from './profile-vault.js';

/**
 * Validated IPC Dispatcher for `@adas/desktop`.
 *
 * Every input coming across Electron's IPC boundary is validated with `zod` before
 * touching `ServerProfileVault` or `AgentRpcClient`.
 */

const ProfileIdSchema = z.object({
  profileId: z.string().min(4).max(100),
});

const ConnectLocalSchema = z.object({
  name: z.string().min(1).max(80).default('Local ADAS Server'),
  repoRoot: z.string().optional(),
});

const PairRemoteSchema = z.object({
  name: z.string().min(1).max(80),
  agentUrl: z.string().url().max(300),
  pairingCode: z.string().min(16).max(200),
  cfAccessClientId: z.string().max(200).optional(),
  cfAccessClientSecret: z.string().max(200).optional(),
});

const ServiceControlInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  service: ManagedServiceSchema,
  action: ServiceActionSchema,
});

const DeployInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  imageTag: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  buildFromSource: z.boolean().optional(),
});

const RollbackInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  targetTag: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/)
    .optional(),
});

const LogsInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  service: ManagedServiceSchema,
  lines: z.number().int().min(1).max(500).optional(),
  level: z.enum(['all', 'info', 'warn', 'error']).optional(),
  query: z.string().max(120).optional(),
});

const RestoreInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  fileName: z.string().min(8).max(180),
  confirmationPhrase: z.string().min(10).max(240),
});

const UpdateConfigInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  values: z.record(z.string(), z.string()).optional(),
  rotateSecrets: z.record(z.string(), z.string()).optional(),
});

const RevokeClientInputSchema = z.object({
  profileId: z.string().min(4).max(100),
  keyId: z.string().regex(/^agt_[a-f0-9]+$/),
});

export class DesktopIpcController implements DesktopBridgeApi {
  private readonly vault: ServerProfileVault;
  private readonly rpc: AgentRpcClient;
  private readonly defaultRepoRoot: string;
  private readonly saveDiagnosticsFile?: (
    defaultFileName: string,
    jsonContent: string,
  ) => Promise<string | null>;
  private embeddedLocalAgent: ServerAgentHandle | null = null;

  constructor(options: {
    vault: ServerProfileVault;
    rpc?: AgentRpcClient;
    defaultRepoRoot: string;
    saveDiagnosticsFile?: (defaultFileName: string, jsonContent: string) => Promise<string | null>;
  }) {
    this.vault = options.vault;
    this.rpc = options.rpc ?? new AgentRpcClient();
    this.defaultRepoRoot = path.resolve(options.defaultRepoRoot);
    this.saveDiagnosticsFile = options.saveDiagnosticsFile;
  }

  async close(): Promise<void> {
    if (this.embeddedLocalAgent) {
      const handle = this.embeddedLocalAgent;
      this.embeddedLocalAgent = null;
      await handle.close();
    }
  }

  async listProfiles(): Promise<{ profiles: ServerProfileSummary[] }> {
    return { profiles: this.vault.listPublicProfiles() };
  }

  async connectLocalServer(rawInput: {
    name: string;
    repoRoot?: string;
  }): Promise<{ profile: ServerProfileSummary }> {
    const parsed = ConnectLocalSchema.parse(rawInput);
    const repoRoot = path.resolve(parsed.repoRoot?.trim() || this.defaultRepoRoot);

    if (!this.embeddedLocalAgent) {
      this.embeddedLocalAgent = await startServerAgent({
        repoRoot,
        host: '127.0.0.1',
        port: 0,
        serverName: `${os.hostname()} (local)`,
      });
    }

    const invite = this.embeddedLocalAgent.credentials.issuePairingInvite({
      role: 'admin',
      label: parsed.name,
      ttlSeconds: 120,
    });

    const paired = await this.rpc.pairWithAgent({
      agentUrl: this.embeddedLocalAgent.url,
      pairingCode: invite.pairingCode,
      clientName: `Desktop (${os.hostname()})`,
    });

    const profile = this.vault.savePairedProfile({
      name: parsed.name,
      mode: 'local',
      agentUrl: paired.normalizedUrl,
      keyId: paired.keyId,
      sharedSecret: paired.sharedSecret,
      role: paired.role,
      serverName: paired.serverName,
    });

    return { profile };
  }

  async pairRemoteServer(rawInput: {
    name: string;
    agentUrl: string;
    pairingCode: string;
    cfAccessClientId?: string;
    cfAccessClientSecret?: string;
  }): Promise<{ profile: ServerProfileSummary }> {
    const parsed = PairRemoteSchema.parse(rawInput);
    const paired = await this.rpc.pairWithAgent({
      agentUrl: parsed.agentUrl,
      pairingCode: parsed.pairingCode,
      clientName: `Desktop (${os.hostname()})`,
      cfAccessClientId: parsed.cfAccessClientId,
      cfAccessClientSecret: parsed.cfAccessClientSecret,
    });

    const profile = this.vault.savePairedProfile({
      name: parsed.name,
      mode: 'remote',
      agentUrl: paired.normalizedUrl,
      keyId: paired.keyId,
      sharedSecret: paired.sharedSecret,
      role: paired.role,
      serverName: paired.serverName,
      cfAccessClientId: parsed.cfAccessClientId,
      cfAccessClientSecret: parsed.cfAccessClientSecret,
    });

    return { profile };
  }

  async removeProfile(rawInput: { profileId: string }): Promise<{ removed: boolean }> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    return { removed: this.vault.removeProfile(profileId) };
  }

  async getOverview(rawInput: { profileId: string }): Promise<ServerOverviewPayload> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    const [telemetry, containersRes] = await Promise.all([
      this.rpc.requestJson<TelemetrySnapshot>(decrypted, 'GET', '/agent/v1/telemetry'),
      this.rpc.requestJson<{ containers: ContainerStatusItem[] }>(
        decrypted,
        'GET',
        '/agent/v1/containers',
      ),
    ]);
    this.vault.touchLastConnected(profileId);
    const {
      sharedSecret: _s,
      cfAccessClientId: _cid,
      cfAccessClientSecret: _csec,
      ...publicSummary
    } = decrypted;
    return {
      profile: publicSummary,
      telemetry,
      containers: containersRes.containers,
    };
  }

  async controlService(rawInput: {
    profileId: string;
    service: z.infer<typeof ManagedServiceSchema>;
    action: z.infer<typeof ServiceActionSchema>;
  }): Promise<{
    service: z.infer<typeof ManagedServiceSchema>;
    action: z.infer<typeof ServiceActionSchema>;
    output: string;
  }> {
    const parsed = ServiceControlInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    return this.rpc.requestJson(
      decrypted,
      'POST',
      `/agent/v1/services/${parsed.service}/${parsed.action}`,
      {},
    );
  }

  async deployRelease(rawInput: {
    profileId: string;
    imageTag: string;
    buildFromSource?: boolean;
  }): Promise<{ previousTag: string | null; activeTag: string; rolledBack: boolean }> {
    const parsed = DeployInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    return this.rpc.requestJson(decrypted, 'POST', '/agent/v1/deploy', {
      imageTag: parsed.imageTag,
      buildFromSource: parsed.buildFromSource,
    });
  }

  async rollbackRelease(rawInput: {
    profileId: string;
    targetTag?: string;
  }): Promise<{ restoredTag: string }> {
    const parsed = RollbackInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    return this.rpc.requestJson(decrypted, 'POST', '/agent/v1/rollback', {
      targetTag: parsed.targetTag,
    });
  }

  async runMigrations(rawInput: { profileId: string }): Promise<{ output: string }> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    return this.rpc.requestJson(decrypted, 'POST', '/agent/v1/migrate', {});
  }

  async getLogs(rawInput: {
    profileId: string;
    service: z.infer<typeof ManagedServiceSchema>;
    lines?: number;
    level?: 'all' | 'info' | 'warn' | 'error';
    query?: string;
  }): Promise<{ service: z.infer<typeof ManagedServiceSchema>; lines: string[] }> {
    const parsed = LogsInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    const qs = new URLSearchParams({
      service: parsed.service,
      lines: String(parsed.lines ?? 120),
      level: parsed.level ?? 'all',
    });
    if (parsed.query) qs.set('q', parsed.query);
    return this.rpc.requestJson(decrypted, 'GET', `/agent/v1/logs?${qs.toString()}`);
  }

  async exportDiagnostics(rawInput: {
    profileId: string;
  }): Promise<{ savedPath: string | null; bundle: Record<string, unknown> }> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    const bundle = await this.rpc.requestJson<Record<string, unknown>>(
      decrypted,
      'GET',
      '/agent/v1/diagnostics',
    );
    const jsonText = JSON.stringify(bundle, null, 2);
    const defaultName = `adas-diagnostics-${decrypted.serverName.replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.json`;

    let savedPath: string | null = null;
    if (this.saveDiagnosticsFile) {
      savedPath = await this.saveDiagnosticsFile(defaultName, jsonText);
    } else {
      const outPath = path.join(os.tmpdir(), defaultName);
      writeFileSync(outPath, jsonText, 'utf8');
      savedPath = outPath;
    }
    return { savedPath, bundle };
  }

  async getBackups(rawInput: { profileId: string }): Promise<{ backups: BackupArchiveItem[] }> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    return this.rpc.requestJson(decrypted, 'GET', '/agent/v1/backups');
  }

  async runBackup(rawInput: { profileId: string }): Promise<{ output: string }> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    return this.rpc.requestJson(decrypted, 'POST', '/agent/v1/backups/run', {});
  }

  async runRestoreDrill(rawInput: { profileId: string }): Promise<{ output: string }> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    return this.rpc.requestJson(decrypted, 'POST', '/agent/v1/backups/drill', {});
  }

  async restoreBackup(rawInput: {
    profileId: string;
    fileName: string;
    confirmationPhrase: string;
  }): Promise<{ restoredFile: string; output: string }> {
    const parsed = RestoreInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    return this.rpc.requestJson(decrypted, 'POST', '/agent/v1/backups/restore', {
      fileName: parsed.fileName,
      confirmationPhrase: parsed.confirmationPhrase,
    });
  }

  async getConfig(rawInput: { profileId: string }): Promise<MaskedConfigPayload> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    return this.rpc.requestJson(decrypted, 'GET', '/agent/v1/config');
  }

  async updateConfig(rawInput: {
    profileId: string;
    values?: Record<string, string>;
    rotateSecrets?: Record<string, string>;
  }): Promise<{ updatedKeys: string[]; rotatedSecrets: string[] }> {
    const parsed = UpdateConfigInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    return this.rpc.requestJson(decrypted, 'PUT', '/agent/v1/config', {
      values: parsed.values,
      rotateSecrets: parsed.rotateSecrets,
    });
  }

  async getAuditAndClients(rawInput: { profileId: string }): Promise<AuditAndClientsPayload> {
    const { profileId } = ProfileIdSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(profileId);
    const auditRes = await this.rpc.requestJson<{
      integrity: { valid: boolean; checkedCount: number; brokenAtIndex: number | null };
      entries: AgentAuditEntry[];
    }>(decrypted, 'GET', '/agent/v1/audit?limit=80');

    let clients: PairedClientSummary[] = [];
    if (decrypted.role === 'admin') {
      const clientsRes = await this.rpc.requestJson<{ clients: PairedClientSummary[] }>(
        decrypted,
        'GET',
        '/agent/v1/clients',
      );
      clients = clientsRes.clients;
    }

    return {
      integrity: auditRes.integrity,
      entries: auditRes.entries,
      clients,
    };
  }

  async revokeClient(rawInput: {
    profileId: string;
    keyId: string;
  }): Promise<{ revoked: boolean; keyId: string }> {
    const parsed = RevokeClientInputSchema.parse(rawInput);
    const decrypted = this.vault.getDecryptedProfileForMainProcessOnly(parsed.profileId);
    return this.rpc.requestJson(decrypted, 'DELETE', `/agent/v1/clients/${parsed.keyId}`);
  }

  async invokeChannel(channel: string, payload: unknown): Promise<unknown> {
    switch (channel) {
      case DESKTOP_IPC_CHANNELS.listProfiles:
        return this.listProfiles();
      case DESKTOP_IPC_CHANNELS.connectLocal:
        return this.connectLocalServer(payload as { name: string; repoRoot?: string });
      case DESKTOP_IPC_CHANNELS.pairRemote:
        return this.pairRemoteServer(
          payload as {
            name: string;
            agentUrl: string;
            pairingCode: string;
            cfAccessClientId?: string;
            cfAccessClientSecret?: string;
          },
        );
      case DESKTOP_IPC_CHANNELS.removeProfile:
        return this.removeProfile(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.getOverview:
        return this.getOverview(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.controlService:
        return this.controlService(
          payload as {
            profileId: string;
            service: z.infer<typeof ManagedServiceSchema>;
            action: z.infer<typeof ServiceActionSchema>;
          },
        );
      case DESKTOP_IPC_CHANNELS.deployRelease:
        return this.deployRelease(
          payload as { profileId: string; imageTag: string; buildFromSource?: boolean },
        );
      case DESKTOP_IPC_CHANNELS.rollbackRelease:
        return this.rollbackRelease(payload as { profileId: string; targetTag?: string });
      case DESKTOP_IPC_CHANNELS.runMigrations:
        return this.runMigrations(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.getLogs:
        return this.getLogs(
          payload as {
            profileId: string;
            service: z.infer<typeof ManagedServiceSchema>;
            lines?: number;
            level?: 'all' | 'info' | 'warn' | 'error';
            query?: string;
          },
        );
      case DESKTOP_IPC_CHANNELS.exportDiagnostics:
        return this.exportDiagnostics(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.getBackups:
        return this.getBackups(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.runBackup:
        return this.runBackup(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.runRestoreDrill:
        return this.runRestoreDrill(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.restoreBackup:
        return this.restoreBackup(
          payload as { profileId: string; fileName: string; confirmationPhrase: string },
        );
      case DESKTOP_IPC_CHANNELS.getConfig:
        return this.getConfig(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.updateConfig:
        return this.updateConfig(
          payload as {
            profileId: string;
            values?: Record<string, string>;
            rotateSecrets?: Record<string, string>;
          },
        );
      case DESKTOP_IPC_CHANNELS.getAuditAndClients:
        return this.getAuditAndClients(payload as { profileId: string });
      case DESKTOP_IPC_CHANNELS.revokeClient:
        return this.revokeClient(payload as { profileId: string; keyId: string });
      default:
        throw new Error(`Disallowed IPC channel: ${channel}`);
    }
  }
}
