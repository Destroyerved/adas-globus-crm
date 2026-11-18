import type {
  AgentAuditEntry,
  AgentRole,
  AllowlistedConfigKey,
  AllowlistedSecretFile,
  BackupArchiveItem,
  ContainerStatusItem,
  ManagedServiceName,
  PairedClientSummary,
  SecretSlotStatus,
  ServiceAction,
  TelemetrySnapshot,
} from '@adas/server-agent';

/**
 * Strictly Typed Preload <-> Renderer <-> Main Process IPC Contract (`@adas/desktop`).
 *
 * Security Invariants:
 * - Paired `sharedSecret` and `cfAccessClientSecret` values NEVER appear in any summary or
 *   response returned to the renderer process.
 * - Every IPC channel name is explicitly enumerated in `DESKTOP_IPC_CHANNELS`.
 */

export const DESKTOP_IPC_CHANNELS = {
  listProfiles: 'adas-desktop:profiles:list',
  connectLocal: 'adas-desktop:profiles:connect-local',
  pairRemote: 'adas-desktop:profiles:pair-remote',
  removeProfile: 'adas-desktop:profiles:remove',
  getOverview: 'adas-desktop:server:overview',
  controlService: 'adas-desktop:server:service-control',
  deployRelease: 'adas-desktop:server:deploy',
  rollbackRelease: 'adas-desktop:server:rollback',
  runMigrations: 'adas-desktop:server:migrate',
  getLogs: 'adas-desktop:server:logs',
  exportDiagnostics: 'adas-desktop:server:diagnostics',
  getBackups: 'adas-desktop:server:backups-list',
  runBackup: 'adas-desktop:server:backup-run',
  runRestoreDrill: 'adas-desktop:server:backup-drill',
  restoreBackup: 'adas-desktop:server:backup-restore',
  getConfig: 'adas-desktop:server:config-get',
  updateConfig: 'adas-desktop:server:config-update',
  getAuditAndClients: 'adas-desktop:server:audit-clients',
  revokeClient: 'adas-desktop:server:revoke-client',
} as const;

export type DesktopIpcChannel = (typeof DESKTOP_IPC_CHANNELS)[keyof typeof DESKTOP_IPC_CHANNELS];

export interface ServerProfileSummary {
  id: string;
  name: string;
  mode: 'local' | 'remote';
  agentUrl: string;
  keyId: string;
  role: AgentRole;
  serverName: string;
  hasCloudflareServiceToken: boolean;
  createdAt: string;
  lastConnectedAt: string | null;
}

export interface ServerOverviewPayload {
  profile: ServerProfileSummary;
  telemetry: TelemetrySnapshot;
  containers: ContainerStatusItem[];
}

export interface MaskedConfigPayload {
  envFileExists: boolean;
  values: Record<AllowlistedConfigKey, string>;
  secrets: SecretSlotStatus[];
}

export interface AuditAndClientsPayload {
  integrity: { valid: boolean; checkedCount: number; brokenAtIndex: number | null };
  entries: AgentAuditEntry[];
  clients: PairedClientSummary[];
}

export interface DesktopBridgeApi {
  listProfiles(): Promise<{ profiles: ServerProfileSummary[] }>;
  connectLocalServer(input: {
    name: string;
    repoRoot?: string;
  }): Promise<{ profile: ServerProfileSummary }>;
  pairRemoteServer(input: {
    name: string;
    agentUrl: string;
    pairingCode: string;
    cfAccessClientId?: string;
    cfAccessClientSecret?: string;
  }): Promise<{ profile: ServerProfileSummary }>;
  removeProfile(input: { profileId: string }): Promise<{ removed: boolean }>;
  getOverview(input: { profileId: string }): Promise<ServerOverviewPayload>;
  controlService(input: {
    profileId: string;
    service: ManagedServiceName;
    action: ServiceAction;
  }): Promise<{ service: ManagedServiceName; action: ServiceAction; output: string }>;
  deployRelease(input: {
    profileId: string;
    imageTag: string;
    buildFromSource?: boolean;
  }): Promise<{ previousTag: string | null; activeTag: string; rolledBack: boolean }>;
  rollbackRelease(input: {
    profileId: string;
    targetTag?: string;
  }): Promise<{ restoredTag: string }>;
  runMigrations(input: { profileId: string }): Promise<{ output: string }>;
  getLogs(input: {
    profileId: string;
    service: ManagedServiceName;
    lines?: number;
    level?: 'all' | 'info' | 'warn' | 'error';
    query?: string;
  }): Promise<{ service: ManagedServiceName; lines: string[] }>;
  exportDiagnostics(input: {
    profileId: string;
  }): Promise<{ savedPath: string | null; bundle: Record<string, unknown> }>;
  getBackups(input: { profileId: string }): Promise<{ backups: BackupArchiveItem[] }>;
  runBackup(input: { profileId: string }): Promise<{ output: string }>;
  runRestoreDrill(input: { profileId: string }): Promise<{ output: string }>;
  restoreBackup(input: {
    profileId: string;
    fileName: string;
    confirmationPhrase: string;
  }): Promise<{ restoredFile: string; output: string }>;
  getConfig(input: { profileId: string }): Promise<MaskedConfigPayload>;
  updateConfig(input: {
    profileId: string;
    values?: Partial<Record<AllowlistedConfigKey, string>>;
    rotateSecrets?: Partial<Record<AllowlistedSecretFile, string>>;
  }): Promise<{ updatedKeys: string[]; rotatedSecrets: string[] }>;
  getAuditAndClients(input: { profileId: string }): Promise<AuditAndClientsPayload>;
  revokeClient(input: {
    profileId: string;
    keyId: string;
  }): Promise<{ revoked: boolean; keyId: string }>;
}
