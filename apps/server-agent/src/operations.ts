import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InstallerService, runPreflightChecks, type CommandExecutor } from '@adas/installer';
import { z } from 'zod';
import type { AgentAuditEntry } from './audit-log.js';
import { redactSensitiveText } from './redact.js';

/**
 * Narrowly Scoped Server Operations Service (`@adas/server-agent`).
 *
 * Security Invariants:
 * - ZERO arbitrary shell execution: never invokes `sh -c`, `cmd /c`, or user-supplied commands.
 * - Service names, actions, log queries, backup filenames, and `.env.production` keys are
 *   strictly allowlisted via `zod` schemas.
 * - Secret values are NEVER returned by `getMaskedConfig()` or `buildDiagnosticsBundle()`.
 */

export const ALLOWLISTED_SERVICES = [
  'postgres',
  'api',
  'worker',
  'backup',
  'uptime-kuma',
  'cloudflared',
  'n8n',
] as const;
export type ManagedServiceName = (typeof ALLOWLISTED_SERVICES)[number];
export const ManagedServiceSchema = z.enum(ALLOWLISTED_SERVICES);

export const ALLOWLISTED_ACTIONS = ['start', 'stop', 'restart'] as const;
export type ServiceAction = (typeof ALLOWLISTED_ACTIONS)[number];
export const ServiceActionSchema = z.enum(ALLOWLISTED_ACTIONS);

export const ALLOWLISTED_CONFIG_KEYS = [
  'ADAS_DOMAIN',
  'APP_INTERNAL_HOST',
  'APP_PUBLIC_HOST',
  'PUBLIC_WEB_URL',
  'PUBLIC_API_URL',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD',
  'CF_ACCESS_ENFORCE',
  'ENTRA_TENANT_ID',
  'ENTRA_CLIENT_ID',
  'CRM_NOTIFICATION_MAILBOX',
  'ESP_PROVIDER',
  'ESP_SENDING_DOMAIN',
  'BACKUP_RETENTION_DAYS',
  'BACKUP_S3_ENDPOINT',
  'BACKUP_S3_REGION',
  'BACKUP_S3_BUCKET',
  'BACKUP_S3_ACCESS_KEY_ID',
  'UPTIME_KUMA_PUSH_URL',
  'DEFAULT_REPORTING_CURRENCY',
  'LOG_LEVEL',
] as const;
export type AllowlistedConfigKey = (typeof ALLOWLISTED_CONFIG_KEYS)[number];

export const ALLOWLISTED_SECRET_FILES = [
  'postgres_admin_password.txt',
  'postgres_app_password.txt',
  'session_secret.txt',
  'token_encryption_key.txt',
  'backup_encryption_key.txt',
  'cloudflare_tunnel_token.txt',
  'entra_client_secret.txt',
  'esp_api_key.txt',
  'esp_webhook_secret.txt',
  'apollo_api_key.txt',
  'bookings_webhook_secret.txt',
  'backup_s3_secret_key.txt',
] as const;
export type AllowlistedSecretFile = (typeof ALLOWLISTED_SECRET_FILES)[number];

const SAFE_BACKUP_FILENAME_REGEX = /^[A-Za-z0-9._-]+\.adasbk$/;

export interface ContainerStatusItem {
  service: ManagedServiceName;
  state: 'running' | 'stopped' | 'degraded' | 'not_deployed';
  statusDetail: string;
  image: string;
}

export interface BackupArchiveItem {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  hasValidMagicHeader: boolean;
}

export interface SecretSlotStatus {
  fileName: AllowlistedSecretFile;
  configured: boolean;
  updatedAt: string | null;
}

export interface TelemetrySnapshot {
  collectedAt: string;
  hostname: string;
  platform: NodeJS.Platform;
  release: string;
  uptimeSeconds: number;
  cpuCount: number;
  loadAvg1m: number;
  memoryTotalBytes: number;
  memoryFreeBytes: number;
  memoryUsedPercent: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPercent: number | null;
  activeReleaseTag: string | null;
  previousReleaseTag: string | null;
  cloudflaredConfigured: boolean;
  crmHealth: {
    ok: boolean;
    httpStatus: number | null;
    readiness: Record<string, unknown> | null;
    detail: string;
  };
}

const defaultExec: CommandExecutor = (cmd, args, options = {}) => {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 600_000,
    shell: false,
  });
  return {
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
};

export class AgentOperationsService {
  private readonly repoRoot: string;
  private readonly healthBaseUrl: string;
  private readonly exec: CommandExecutor;
  private readonly installer: InstallerService;

  constructor(options: { repoRoot: string; healthBaseUrl?: string; exec?: CommandExecutor }) {
    this.repoRoot = path.resolve(options.repoRoot);
    this.healthBaseUrl = options.healthBaseUrl ?? 'http://127.0.0.1:3000';
    this.exec = options.exec ?? defaultExec;
    this.installer = new InstallerService({
      exec: this.exec,
      probe: (c, a) => this.exec(c, a),
    });
  }

  private get composeFile(): string {
    return path.join(this.repoRoot, 'infra', 'compose.prod.yml');
  }

  async getTelemetry(): Promise<TelemetrySnapshot> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMemPct = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0;

    let diskTotal: number | null = null;
    let diskFree: number | null = null;
    let diskUsedPct: number | null = null;
    try {
      const st = statfsSync(this.repoRoot);
      diskTotal = Number(st.blocks) * Number(st.bsize);
      diskFree = Number(st.bavail) * Number(st.bsize);
      if (diskTotal > 0) {
        diskUsedPct = Math.round(((diskTotal - diskFree) / diskTotal) * 1000) / 10;
      }
    } catch {
      diskTotal = null;
    }

    const stateFile = path.join(this.repoRoot, '.deploy-state');
    const prevFile = path.join(this.repoRoot, '.deploy-state.prev');
    const activeReleaseTag = existsSync(stateFile)
      ? readFileSync(stateFile, 'utf8').trim() || null
      : null;
    const previousReleaseTag = existsSync(prevFile)
      ? readFileSync(prevFile, 'utf8').trim() || null
      : null;

    const cfTokenPath = path.join(this.repoRoot, 'secrets', 'cloudflare_tunnel_token.txt');
    const cfCredsPath = path.join(this.repoRoot, 'infra', 'cloudflare', 'credentials.json');
    const cloudflaredConfigured = existsSync(cfTokenPath) || existsSync(cfCredsPath);

    const crmHealth = await this.installer.checkStackHealth(this.healthBaseUrl);

    return {
      collectedAt: new Date().toISOString(),
      hostname: os.hostname(),
      platform: process.platform,
      release: os.release(),
      uptimeSeconds: Math.floor(os.uptime()),
      cpuCount: os.cpus().length,
      loadAvg1m: Math.round((os.loadavg()[0] ?? 0) * 100) / 100,
      memoryTotalBytes: totalMem,
      memoryFreeBytes: freeMem,
      memoryUsedPercent: usedMemPct,
      diskTotalBytes: diskTotal,
      diskFreeBytes: diskFree,
      diskUsedPercent: diskUsedPct,
      activeReleaseTag,
      previousReleaseTag,
      cloudflaredConfigured,
      crmHealth,
    };
  }

  listContainers(): ContainerStatusItem[] {
    const res = this.exec(
      'docker',
      ['compose', '-f', this.composeFile, '--profile', 'automation', 'ps', '--format', 'json'],
      { cwd: this.repoRoot },
    );

    const byService = new Map<string, { state: string; status: string; image: string }>();
    if (res.status === 0 && res.stdout) {
      for (const rawLine of res.stdout.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          const items = Array.isArray(parsed) ? parsed : [parsed];
          for (const item of items) {
            const rec = item as Record<string, unknown>;
            const svc = String(rec['Service'] ?? rec['Name'] ?? '');
            if (svc) {
              byService.set(svc, {
                state: String(rec['State'] ?? 'unknown').toLowerCase(),
                status: String(rec['Status'] ?? rec['State'] ?? ''),
                image: String(rec['Image'] ?? ''),
              });
            }
          }
        } catch {
          // Ignore non-JSON warning lines
        }
      }
    }

    return ALLOWLISTED_SERVICES.map((svc) => {
      const found = byService.get(svc);
      if (!found) {
        return {
          service: svc,
          state: 'not_deployed',
          statusDetail: res.status === 0 ? 'Not started' : 'Docker daemon unavailable',
          image: '',
        };
      }
      const mappedState: ContainerStatusItem['state'] =
        found.state === 'running'
          ? found.status.toLowerCase().includes('unhealthy')
            ? 'degraded'
            : 'running'
          : found.state === 'restarting'
            ? 'degraded'
            : 'stopped';
      return {
        service: svc,
        state: mappedState,
        statusDetail: found.status,
        image: found.image,
      };
    });
  }

  controlService(
    rawService: string,
    rawAction: string,
  ): { service: ManagedServiceName; action: ServiceAction; output: string } {
    const service = ManagedServiceSchema.parse(rawService);
    const action = ServiceActionSchema.parse(rawAction);
    const profileArgs = service === 'n8n' ? ['--profile', 'automation'] : [];

    const res = this.exec(
      'docker',
      ['compose', '-f', this.composeFile, ...profileArgs, action, service],
      { cwd: this.repoRoot },
    );
    if (res.status !== 0) {
      throw new Error(
        redactSensitiveText(`Service ${action} on ${service} failed: ${res.stderr || res.stdout}`),
      );
    }
    return {
      service,
      action,
      output: redactSensitiveText(res.stdout || `${service}: ${action} completed`),
    };
  }

  async deployRelease(params: {
    imageTag: string;
    buildFromSource?: boolean;
  }): Promise<{ previousTag: string | null; activeTag: string; rolledBack: boolean }> {
    const cleanTag = z
      .string()
      .regex(/^[A-Za-z0-9._-]{1,64}$/, 'Invalid Docker image tag')
      .parse(params.imageTag);
    return this.installer.upgradeStack({
      targetDir: this.repoRoot,
      imageTag: cleanTag,
      buildFromSource: params.buildFromSource,
      healthUrl: `${this.healthBaseUrl}/healthz`,
    });
  }

  rollbackRelease(params: { targetTag?: string }): { restoredTag: string } {
    const cleanTag = params.targetTag
      ? z
          .string()
          .regex(/^[A-Za-z0-9._-]{1,64}$/)
          .parse(params.targetTag)
      : undefined;
    return this.installer.rollbackStack({
      targetDir: this.repoRoot,
      targetTag: cleanTag,
    });
  }

  runMigrations(): { output: string } {
    const res = this.exec(
      'docker',
      [
        'compose',
        '-f',
        this.composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/migrate.js',
      ],
      { cwd: this.repoRoot },
    );
    if (res.status !== 0) {
      throw new Error(redactSensitiveText(`Migration run failed: ${res.stderr || res.stdout}`));
    }
    return { output: redactSensitiveText(res.stdout || 'Migrations up to date.') };
  }

  getLogs(params: {
    service: ManagedServiceName;
    lines?: number;
    level?: 'all' | 'info' | 'warn' | 'error';
    query?: string;
  }): { service: ManagedServiceName; lines: string[] } {
    const service = ManagedServiceSchema.parse(params.service);
    const tailCount = Math.max(1, Math.min(500, params.lines ?? 120));
    const res = this.exec(
      'docker',
      [
        'compose',
        '-f',
        this.composeFile,
        '--profile',
        'automation',
        'logs',
        '--no-color',
        '--timestamps',
        '--tail',
        String(tailCount),
        service,
      ],
      { cwd: this.repoRoot },
    );

    const rawCombined = [res.stdout, res.stderr].filter(Boolean).join('\n');
    let lines = rawCombined
      .split(/\r?\n/)
      .filter((l) => l.trim().length > 0)
      .map((l) => redactSensitiveText(l));

    const level = params.level ?? 'all';
    if (level !== 'all') {
      const needle = level.toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(needle));
    }

    if (params.query && params.query.trim()) {
      const q = params.query.trim().toLowerCase();
      lines = lines.filter((l) => l.toLowerCase().includes(q));
    }

    return { service, lines };
  }

  listBackups(): BackupArchiveItem[] {
    const backupDir = path.join(this.repoRoot, 'data', 'backups');
    if (!existsSync(backupDir)) return [];

    const files = readdirSync(backupDir).filter((f) => SAFE_BACKUP_FILENAME_REGEX.test(f));
    const items: BackupArchiveItem[] = [];

    for (const fileName of files) {
      const fullPath = path.join(backupDir, fileName);
      const st = statSync(fullPath);
      let hasValidMagicHeader = false;
      try {
        const buf = readFileSync(fullPath);
        hasValidMagicHeader = buf.subarray(0, 8).toString('ascii') === 'ADASBK01';
      } catch {
        hasValidMagicHeader = false;
      }
      items.push({
        fileName,
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
        hasValidMagicHeader,
      });
    }

    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  runManualBackup(): { output: string } {
    const res = this.exec(
      'docker',
      [
        'compose',
        '-f',
        this.composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/backup.js',
        'backup',
        '--kind=manual',
      ],
      { cwd: this.repoRoot },
    );
    if (res.status !== 0) {
      throw new Error(redactSensitiveText(`Manual backup failed: ${res.stderr || res.stdout}`));
    }
    return { output: redactSensitiveText(res.stdout || 'Encrypted backup completed.') };
  }

  runRestoreDrill(): { output: string } {
    const res = this.exec(
      'docker',
      [
        'compose',
        '-f',
        this.composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/backup.js',
        'drill',
      ],
      { cwd: this.repoRoot },
    );
    if (res.status !== 0) {
      throw new Error(redactSensitiveText(`Restore drill failed: ${res.stderr || res.stdout}`));
    }
    return { output: redactSensitiveText(res.stdout || 'Restore drill passed.') };
  }

  restoreDatabaseFromBackup(params: { fileName: string; confirmationPhrase: string }): {
    restoredFile: string;
    output: string;
  } {
    if (!SAFE_BACKUP_FILENAME_REGEX.test(params.fileName)) {
      throw new Error('Invalid backup archive filename.');
    }
    const expectedPhrase = `RESTORE DATABASE ${params.fileName}`;
    if (params.confirmationPhrase !== expectedPhrase) {
      throw new Error(
        `Destructive restore requires exact confirmation phrase "${expectedPhrase}".`,
      );
    }

    const hostArchivePath = path.join(this.repoRoot, 'data', 'backups', params.fileName);
    if (!existsSync(hostArchivePath)) {
      throw new Error(`Backup archive not found: ${params.fileName}`);
    }

    const res = this.exec(
      'docker',
      [
        'compose',
        '-f',
        this.composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/backup.js',
        'restore',
        `--file=/app/data/backups/${params.fileName}`,
        '--confirm=RESTORE_PRODUCTION_DATABASE',
      ],
      { cwd: this.repoRoot },
    );
    if (res.status !== 0) {
      throw new Error(redactSensitiveText(`Database restore failed: ${res.stderr || res.stdout}`));
    }
    return {
      restoredFile: params.fileName,
      output: redactSensitiveText(res.stdout || `Restored ${params.fileName}`),
    };
  }

  getMaskedConfig(): {
    envFileExists: boolean;
    values: Record<AllowlistedConfigKey, string>;
    secrets: SecretSlotStatus[];
  } {
    const envPath = path.join(this.repoRoot, '.env.production');
    const rawMap = new Map<string, string>();
    if (existsSync(envPath)) {
      for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq > 0) {
          rawMap.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
        }
      }
    }

    const values = {} as Record<AllowlistedConfigKey, string>;
    for (const key of ALLOWLISTED_CONFIG_KEYS) {
      values[key] = rawMap.get(key) ?? '';
    }

    const secretsDir = path.join(this.repoRoot, 'secrets');
    const secrets: SecretSlotStatus[] = ALLOWLISTED_SECRET_FILES.map((fileName) => {
      const fullPath = path.join(secretsDir, fileName);
      if (!existsSync(fullPath)) {
        return { fileName, configured: false, updatedAt: null };
      }
      const st = statSync(fullPath);
      const nonEmpty = readFileSync(fullPath, 'utf8').trim().length > 0;
      return {
        fileName,
        configured: nonEmpty,
        updatedAt: nonEmpty ? st.mtime.toISOString() : null,
      };
    });

    return {
      envFileExists: existsSync(envPath),
      values,
      secrets,
    };
  }

  updateConfig(params: {
    values?: Partial<Record<AllowlistedConfigKey, string>>;
    rotateSecrets?: Partial<Record<AllowlistedSecretFile, string>>;
  }): { updatedKeys: string[]; rotatedSecrets: string[] } {
    const envPath = path.join(this.repoRoot, '.env.production');
    const existingLines = existsSync(envPath)
      ? readFileSync(envPath, 'utf8').split(/\r?\n/)
      : [
          '# ADAS CRM — Production Environment (.env.production)',
          'NODE_ENV=production',
          'MAIL_LIVE=false',
        ];

    if (existsSync(envPath)) {
      copyFileSync(envPath, `${envPath}.bak`);
    }

    const updatedKeys: string[] = [];
    const allowSet = new Set<string>(ALLOWLISTED_CONFIG_KEYS);

    for (const [rawKey, rawVal] of Object.entries(params.values ?? {})) {
      if (!allowSet.has(rawKey)) {
        throw new Error(`Configuration key "${rawKey}" is not editable via remote agent.`);
      }
      if (typeof rawVal !== 'string' || /[\r\n]/.test(rawVal)) {
        throw new Error(`Invalid configuration value for "${rawKey}".`);
      }
      const cleanVal = rawVal.trim();
      const idx = existingLines.findIndex((l) => l.startsWith(`${rawKey}=`));
      if (idx >= 0) {
        existingLines[idx] = `${rawKey}=${cleanVal}`;
      } else {
        existingLines.push(`${rawKey}=${cleanVal}`);
      }
      updatedKeys.push(rawKey);
    }

    if (updatedKeys.length > 0) {
      writeFileSync(
        envPath,
        `${existingLines.filter((l, i, a) => i < a.length - 1 || l !== '').join('\n')}\n`,
        {
          encoding: 'utf8',
          mode: 0o600,
        },
      );
      try {
        chmodSync(envPath, 0o600);
      } catch {
        // Windows NTFS ACLs ignore POSIX chmod
      }
    }

    const rotatedSecrets: string[] = [];
    const secretAllowSet = new Set<string>(ALLOWLISTED_SECRET_FILES);
    const secretsDir = path.join(this.repoRoot, 'secrets');
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

    for (const [fileName, newSecret] of Object.entries(params.rotateSecrets ?? {})) {
      if (!secretAllowSet.has(fileName)) {
        throw new Error(`Secret slot "${fileName}" is not allowlisted.`);
      }
      if (typeof newSecret !== 'string' || newSecret.trim().length < 12) {
        throw new Error(`Secret "${fileName}" must be at least 12 characters.`);
      }
      const fullPath = path.join(secretsDir, fileName);
      writeFileSync(fullPath, `${newSecret.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        chmodSync(fullPath, 0o600);
      } catch {
        // Windows NTFS ACLs ignore POSIX chmod
      }
      rotatedSecrets.push(fileName);
    }

    return { updatedKeys, rotatedSecrets };
  }

  async buildDiagnosticsBundle(auditEntries: AgentAuditEntry[]): Promise<Record<string, unknown>> {
    const [telemetry, preflight] = await Promise.all([
      this.getTelemetry(),
      runPreflightChecks({
        targetDir: this.repoRoot,
        probeCommand: (c, a) => this.exec(c, a),
      }),
    ]);
    const containers = this.listContainers();
    const config = this.getMaskedConfig();
    const backups = this.listBackups();
    const apiLogs = this.getLogs({ service: 'api', lines: 80 });
    const workerLogs = this.getLogs({ service: 'worker', lines: 80 });

    return {
      bundleVersion: 1,
      generatedAt: new Date().toISOString(),
      telemetry,
      preflight,
      containers,
      maskedConfig: config,
      backups,
      recentLogs: {
        api: apiLogs.lines,
        worker: workerLogs.lines,
      },
      recentAuditTrail: auditEntries.slice(0, 50),
    };
  }
}
