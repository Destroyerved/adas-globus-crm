import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runPreflightChecks, type CommandProbe } from './preflight.js';

/**
 * Idempotent, Non-Destructive Production Provisioning, Upgrade, Rollback, Health & Uninstall
 * Service (`PRD 10.1–10.8`).
 */

export const UNINSTALL_PURGE_CONFIRMATION = 'DELETE ALL CRM DATA';

export const InstallerConfigInputSchema = z.object({
  targetDir: z.string().min(1),
  domain: z
    .string()
    .min(3)
    .default('adasglobuspro.com')
    .transform((raw) =>
      raw
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, ''),
    ),
  tunnelName: z.string().min(2).default('adas-crm-prod-16gb'),
  tunnelToken: z.string().optional().default(''),
  cfAccessTeamDomain: z.string().default('adasglobuspro.cloudflareaccess.com'),
  cfAccessAud: z
    .string()
    .default('0000000000000000000000000000000000000000000000000000000000000000'),
  cfAccessEnforce: z.boolean().default(false),
  entraTenantId: z.string().default('00000000-0000-0000-0000-000000000000'),
  entraClientId: z.string().default('00000000-0000-0000-0000-000000000000'),
  entraClientSecret: z.string().optional().default(''),
  espProvider: z.enum(['postmark', 'resend', 'http_json']).default('postmark'),
  espSendingDomain: z.string().optional(),
  espApiKey: z.string().optional().default(''),
  espWebhookSecret: z.string().optional().default(''),
  apolloApiKey: z.string().optional().default(''),
  bookingsWebhookSecret: z.string().optional().default(''),
  backupS3Endpoint: z.string().optional().default(''),
  backupS3Region: z.string().default('auto'),
  backupS3Bucket: z.string().optional().default(''),
  backupS3AccessKeyId: z.string().optional().default(''),
  backupS3SecretAccessKey: z.string().optional().default(''),
  uptimeKumaPushUrl: z.string().optional().default(''),
  enableAutomationProfile: z.boolean().default(false),
  defaultReportingCurrency: z.enum(['USD', 'CAD']).default('USD'),
});
export type InstallerConfigInput = z.input<typeof InstallerConfigInputSchema>;
export type ParsedInstallerConfig = z.output<typeof InstallerConfigInputSchema>;

export interface ProvisionResult {
  targetDir: string;
  domain: string;
  envFilePath: string;
  cloudflareConfigPath: string;
  dnsZonePath: string;
  createdSecrets: string[];
  preservedSecrets: string[];
  updatedOptionalSecrets: string[];
  backupEnvPath: string | null;
}

export interface CommandExecutor {
  (
    cmd: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): {
    status: number | null;
    stdout: string;
    stderr: string;
  };
}

const defaultExecutor: CommandExecutor = (cmd, args, options = {}) => {
  const res = spawnSync(cmd, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    timeout: 600_000,
  });
  return {
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
};

function writeSecretFileMode600(filePath: string, value: string): void {
  writeFileSync(filePath, `${value.trim()}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS ACLs ignore POSIX chmod
  }
}

function parseEnvMap(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return map;
}

export class InstallerService {
  private readonly exec: CommandExecutor;
  private readonly probe: CommandProbe;

  constructor(options: { exec?: CommandExecutor; probe?: CommandProbe } = {}) {
    this.exec = options.exec ?? defaultExecutor;
    this.probe = options.probe ?? ((c, a) => this.exec(c, a));
  }

  /**
   * Idempotently provisions `secrets/`, `.env.production`, `data/`, and `infra/cloudflare/config.yml`.
   * Existing generated secret files are NEVER overwritten so re-running never invalidates DB passwords
   * or encrypted OAuth/TOTP/Webhook ciphertexts!
   */
  provisionConfiguration(rawInput: InstallerConfigInput): ProvisionResult {
    const cfg = InstallerConfigInputSchema.parse(rawInput);
    const targetDir = path.resolve(cfg.targetDir);

    const secretsDir = path.join(targetDir, 'secrets');
    const filesDir = path.join(targetDir, 'data', 'files');
    const backupsDir = path.join(targetDir, 'data', 'backups');
    const cfDir = path.join(targetDir, 'infra', 'cloudflare');

    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    mkdirSync(filesDir, { recursive: true });
    mkdirSync(backupsDir, { recursive: true });
    mkdirSync(cfDir, { recursive: true });

    const coreSecrets: Array<{ filename: string; prefix: string; bytes: number }> = [
      { filename: 'postgres_admin_password.txt', prefix: 'pgadm_', bytes: 24 },
      { filename: 'postgres_app_password.txt', prefix: 'pgapp_', bytes: 24 },
      { filename: 'session_secret.txt', prefix: 'sess_', bytes: 32 },
      { filename: 'token_encryption_key.txt', prefix: 'tkey_', bytes: 32 },
      { filename: 'backup_encryption_key.txt', prefix: 'bkey_', bytes: 32 },
    ];

    const createdSecrets: string[] = [];
    const preservedSecrets: string[] = [];
    const updatedOptionalSecrets: string[] = [];

    for (const spec of coreSecrets) {
      const fullPath = path.join(secretsDir, spec.filename);
      if (existsSync(fullPath) && readFileSync(fullPath, 'utf8').trim().length >= 16) {
        preservedSecrets.push(spec.filename);
      } else {
        const secret = `${spec.prefix}${randomBytes(spec.bytes).toString('hex')}`;
        writeSecretFileMode600(fullPath, secret);
        createdSecrets.push(spec.filename);
      }
    }

    const optionalSecrets: Array<{ filename: string; value: string | undefined }> = [
      { filename: 'cloudflare_tunnel_token.txt', value: cfg.tunnelToken },
      { filename: 'entra_client_secret.txt', value: cfg.entraClientSecret },
      { filename: 'esp_api_key.txt', value: cfg.espApiKey },
      { filename: 'esp_webhook_secret.txt', value: cfg.espWebhookSecret },
      { filename: 'apollo_api_key.txt', value: cfg.apolloApiKey },
      { filename: 'bookings_webhook_secret.txt', value: cfg.bookingsWebhookSecret },
      { filename: 'backup_s3_secret_key.txt', value: cfg.backupS3SecretAccessKey },
    ];

    for (const opt of optionalSecrets) {
      if (opt.value && opt.value.trim().length > 0) {
        writeSecretFileMode600(path.join(secretsDir, opt.filename), opt.value);
        updatedOptionalSecrets.push(opt.filename);
      }
    }

    const adminPassword = readFileSync(
      path.join(secretsDir, 'postgres_admin_password.txt'),
      'utf8',
    ).trim();
    const appPassword = readFileSync(
      path.join(secretsDir, 'postgres_app_password.txt'),
      'utf8',
    ).trim();

    const envFilePath = path.join(targetDir, '.env.production');
    let backupEnvPath: string | null = null;
    const existingOverrides = new Map<string, string>();
    if (existsSync(envFilePath)) {
      backupEnvPath = `${envFilePath}.bak`;
      copyFileSync(envFilePath, backupEnvPath);
      for (const [k, v] of parseEnvMap(readFileSync(envFilePath, 'utf8'))) {
        existingOverrides.set(k, v);
      }
    }

    // Preserve MAIL_LIVE if previously set by owner; never enable MAIL_LIVE automatically!
    const preservedMailLive = existingOverrides.get('MAIL_LIVE') === 'true' ? 'true' : 'false';
    const sendingDomain = cfg.espSendingDomain?.trim() || `mail.${cfg.domain}`;

    const envEntries: Array<[string, string]> = [
      ['NODE_ENV', 'production'],
      ['PORT', '3000'],
      ['WEB_PORT', '5174'],
      ['ADAS_DOMAIN', cfg.domain],
      ['APP_INTERNAL_HOST', `crm.${cfg.domain}`],
      ['APP_PUBLIC_HOST', `go.${cfg.domain}`],
      ['PUBLIC_WEB_URL', `https://crm.${cfg.domain}`],
      ['PUBLIC_API_URL', `https://crm.${cfg.domain}/api/v1`],
      [
        'DATABASE_URL',
        `postgresql://adas_app:${encodeURIComponent(appPassword)}@postgres:5432/adas_crm?schema=public`,
      ],
      [
        'DATABASE_ADMIN_URL',
        `postgresql://adas_admin:${encodeURIComponent(adminPassword)}@postgres:5432/adas_crm?schema=public`,
      ],
      ['MAIL_LIVE', preservedMailLive],
      ['SESSION_IDLE_TIMEOUT_HOURS', '12'],
      ['SESSION_ABSOLUTE_TIMEOUT_DAYS', '7'],
      ['SESSION_SECRET_FILE', '/app/secrets/session_secret.txt'],
      ['TOKEN_ENCRYPTION_KEY_FILE', '/app/secrets/token_encryption_key.txt'],
      [
        'TOKEN_ENCRYPTION_KEY_VERSION',
        existingOverrides.get('TOKEN_ENCRYPTION_KEY_VERSION') ?? '1',
      ],
      ['ENTRA_TENANT_ID', cfg.entraTenantId],
      ['ENTRA_CLIENT_ID', cfg.entraClientId],
      ['ENTRA_CLIENT_SECRET_FILE', '/app/secrets/entra_client_secret.txt'],
      ['ENTRA_REDIRECT_URI', `https://crm.${cfg.domain}/api/v1/auth/sso/callback`],
      ['ENTRA_MAIL_REDIRECT_URI', `https://crm.${cfg.domain}/api/v1/inbox/oauth/callback`],
      ['CRM_NOTIFICATION_MAILBOX', `crm@${cfg.domain}`],
      ['ESP_PROVIDER', cfg.espProvider],
      ['ESP_SENDING_DOMAIN', sendingDomain],
      ['ESP_API_KEY_FILE', '/app/secrets/esp_api_key.txt'],
      ['ESP_WEBHOOK_SECRET_FILE', '/app/secrets/esp_webhook_secret.txt'],
      ['APOLLO_API_KEY_FILE', '/app/secrets/apollo_api_key.txt'],
      ['BOOKINGS_WEBHOOK_SECRET_FILE', '/app/secrets/bookings_webhook_secret.txt'],
      ['WEBHOOK_ALLOW_PRIVATE_TARGETS', cfg.enableAutomationProfile ? 'true' : 'false'],
      ['CF_ACCESS_TEAM_DOMAIN', cfg.cfAccessTeamDomain],
      ['CF_ACCESS_AUD', cfg.cfAccessAud],
      ['CF_ACCESS_ENFORCE', cfg.cfAccessEnforce ? 'true' : 'false'],
      ['FILE_STORAGE_DRIVER', 'local'],
      ['FILE_STORAGE_LOCAL_PATH', '/app/data/files'],
      ['INQUIRY_CORS_ORIGINS', `https://www.${cfg.domain},https://${cfg.domain}`],
      ['INQUIRY_RATE_LIMIT_PER_10M', '5'],
      ['API_RATE_LIMIT_PER_MIN', '600'],
      ['DEFAULT_REPORTING_CURRENCY', cfg.defaultReportingCurrency],
      ['BACKUP_LOCAL_DIR', '/app/data/backups'],
      ['BACKUP_ENCRYPTION_KEY_FILE', '/app/secrets/backup_encryption_key.txt'],
      ['BACKUP_RETENTION_DAYS', '14'],
      ['BACKUP_S3_ENDPOINT', cfg.backupS3Endpoint ?? ''],
      ['BACKUP_S3_REGION', cfg.backupS3Region],
      ['BACKUP_S3_BUCKET', cfg.backupS3Bucket ?? ''],
      ['BACKUP_S3_ACCESS_KEY_ID', cfg.backupS3AccessKeyId ?? ''],
      ['BACKUP_S3_SECRET_ACCESS_KEY_FILE', '/app/secrets/backup_s3_secret_key.txt'],
      ['UPTIME_KUMA_PUSH_URL', cfg.uptimeKumaPushUrl ?? ''],
      ['LOG_LEVEL', 'info'],
    ];

    const envBody = [
      '# =============================================================================',
      '# ADAS CRM — Production Environment (.env.production)',
      '# Generated idempotently by @adas/installer. Secrets are mounted from ./secrets.',
      '# =============================================================================',
      ...envEntries.map(([k, v]) => `${k}=${v}`),
      '',
    ].join('\n');
    writeSecretFileMode600(envFilePath, envBody.trimEnd());

    // Write Cloudflare Tunnel ingress config (`PRD 10.4`)
    const cloudflareConfigPath = path.join(cfDir, 'config.yml');
    const cfLines = [
      '# ADAS CRM — Outbound Cloudflare Tunnel Ingress (PRD 10.4)',
      `tunnel: ${cfg.tunnelName}`,
      'credentials-file: /etc/cloudflared/credentials.json',
      '',
      'ingress:',
      `  - hostname: crm.${cfg.domain}`,
      '    service: http://api:3000',
      `  - hostname: go.${cfg.domain}`,
      '    service: http://api:3000',
      `  - hostname: status.${cfg.domain}`,
      '    service: http://uptime-kuma:3001',
      ...(cfg.enableAutomationProfile
        ? [`  - hostname: automation.${cfg.domain}`, '    service: http://n8n:5678']
        : []),
      '  - service: http_status:404',
      '',
    ];
    writeFileSync(cloudflareConfigPath, cfLines.join('\n'), 'utf8');

    const dnsZonePath = path.join(cfDir, 'dns-records.bind');
    const dnsLines = [
      '; =============================================================================',
      '; ADAS CRM — Cloudflare Tunnel CNAMEs + SPF/DMARC Anti-Spam Zone (PRD 5.4, 10.4)',
      `; Domain: ${cfg.domain} | Tunnel: ${cfg.tunnelName}`,
      '; =============================================================================',
      `crm.${cfg.domain}.         1   IN  CNAME   ${cfg.tunnelName}.cfargotunnel.com.`,
      `go.${cfg.domain}.          1   IN  CNAME   ${cfg.tunnelName}.cfargotunnel.com.`,
      `status.${cfg.domain}.      1   IN  CNAME   ${cfg.tunnelName}.cfargotunnel.com.`,
      ...(cfg.enableAutomationProfile
        ? [`automation.${cfg.domain}.  1   IN  CNAME   ${cfg.tunnelName}.cfargotunnel.com.`]
        : []),
      '',
      '; Anti-Spam Email Authentication (SPF + DMARC p=quarantine)',
      `${cfg.domain}.                 300 IN  TXT     "v=spf1 include:spf.protection.outlook.com -all"`,
      `${sendingDomain}.            300 IN  TXT     "v=spf1 ~all"`,
      `_dmarc.${cfg.domain}.          300 IN  TXT     "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${cfg.domain}; adkim=s; aspf=s"`,
      `_dmarc.${sendingDomain}.     300 IN  TXT     "v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@${cfg.domain}"`,
      '',
    ];
    writeFileSync(dnsZonePath, dnsLines.join('\n'), 'utf8');

    return {
      targetDir,
      domain: cfg.domain,
      envFilePath,
      cloudflareConfigPath,
      dnsZonePath,
      createdSecrets,
      preservedSecrets,
      updatedOptionalSecrets,
      backupEnvPath,
    };
  }

  /**
   * Full One-Click Production Install:
   * 1. Runs hardware & Docker preflight checks,
   * 2. Idempotently provisions `.env.production`, `secrets/`, and Cloudflare config,
   * 3. Builds image `adas-crm-api:<tag>`, boots `postgres`, runs SQL migrations,
   * 4. Optionally configures break-glass emergency Admin credentials,
   * 5. Starts `api`, `worker`, `backup`, `uptime-kuma` (+ `n8n` if enabled),
   * 6. Verifies `/healthz` readiness and records `.deploy-state`.
   */
  async installStack(params: {
    config: InstallerConfigInput;
    imageTag?: string;
    adminEmail?: string;
    skipHealthWait?: boolean;
  }): Promise<{
    provision: ProvisionResult;
    imageTag: string;
    breakGlassOutput: string | null;
    healthOk: boolean;
  }> {
    const targetDir = path.resolve(params.config.targetDir);
    const preflight = await runPreflightChecks({
      targetDir,
      probeCommand: this.probe,
    });
    if (!preflight.readyForProductionDeploy) {
      const failed = preflight.checks
        .filter((c) => c.status === 'fail')
        .map((c) => `${c.label}: ${c.detail}`)
        .join('; ');
      throw new Error(`Preflight checks failed: ${failed}`);
    }

    const provision = this.provisionConfiguration(params.config);
    const imageTag = params.imageTag?.trim() || 'v1.0.0';
    const composeFile = path.join(targetDir, 'infra', 'compose.prod.yml');
    const composeEnv = { ...process.env, ADAS_IMAGE_TAG: imageTag };

    // 1. Build production runtime image
    const buildRes = this.exec(
      'docker',
      [
        'build',
        '-f',
        path.join(targetDir, 'infra', 'Dockerfile.api'),
        '-t',
        `adas-crm-api:${imageTag}`,
        targetDir,
      ],
      { cwd: targetDir, env: composeEnv },
    );
    if (buildRes.status !== 0) {
      throw new Error(`Docker image build failed: ${buildRes.stderr || buildRes.stdout}`);
    }

    // 2. Start PostgreSQL and run migrations
    const pgUp = this.exec('docker', ['compose', '-f', composeFile, 'up', '-d', 'postgres'], {
      cwd: targetDir,
      env: composeEnv,
    });
    if (pgUp.status !== 0) {
      throw new Error(`Failed to start PostgreSQL container: ${pgUp.stderr}`);
    }

    const migRes = this.exec(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/migrate.js',
      ],
      { cwd: targetDir, env: composeEnv },
    );
    if (migRes.status !== 0) {
      throw new Error(`Database migrations failed: ${migRes.stderr || migRes.stdout}`);
    }

    // 3. Optional initial break-glass Admin setup
    let breakGlassOutput: string | null = null;
    if (params.adminEmail && params.adminEmail.trim()) {
      const bgRes = this.exec(
        'docker',
        [
          'compose',
          '-f',
          composeFile,
          'run',
          '--rm',
          '--no-deps',
          'api',
          'node',
          '--conditions=production-dist',
          'apps/api/dist/cli/break-glass.js',
          'set',
          params.adminEmail.trim(),
        ],
        { cwd: targetDir, env: composeEnv },
      );
      if (bgRes.status === 0) {
        breakGlassOutput = bgRes.stdout;
      }
    }

    // 4. Start core production services
    const profileArgs = params.config.enableAutomationProfile ? ['--profile', 'automation'] : [];
    const services = ['api', 'worker', 'backup', 'uptime-kuma'];
    if (existsSync(path.join(targetDir, 'infra', 'cloudflare', 'credentials.json'))) {
      services.push('cloudflared');
    }
    if (params.config.enableAutomationProfile) {
      services.push('n8n');
    }

    const upRes = this.exec(
      'docker',
      ['compose', '-f', composeFile, ...profileArgs, 'up', '-d', ...services],
      { cwd: targetDir, env: composeEnv },
    );
    if (upRes.status !== 0) {
      throw new Error(`Failed to start production services: ${upRes.stderr}`);
    }

    // 5. Record deploy state & verify /healthz
    const statePath = path.join(targetDir, '.deploy-state');
    if (existsSync(statePath)) {
      copyFileSync(statePath, `${statePath}.prev`);
    }
    writeFileSync(statePath, `${imageTag}\n`, 'utf8');

    let healthOk = true;
    if (!params.skipHealthWait) {
      const health = await this.waitForHealthy('http://127.0.0.1:3000/healthz', 30_000);
      healthOk = health.ok;
      if (!healthOk) {
        throw new Error(`Post-install /healthz check failed: ${health.detail}`);
      }
    }

    return {
      provision,
      imageTag,
      breakGlassOutput,
      healthOk,
    };
  }

  /**
   * Safe Upgrade with pre-upgrade backup, migration, health verification & automatic rollback.
   */
  async upgradeStack(params: {
    targetDir: string;
    imageTag: string;
    buildFromSource?: boolean;
    healthUrl?: string;
  }): Promise<{ previousTag: string | null; activeTag: string; rolledBack: boolean }> {
    const targetDir = path.resolve(params.targetDir);
    const composeFile = path.join(targetDir, 'infra', 'compose.prod.yml');
    const statePath = path.join(targetDir, '.deploy-state');
    const previousTag = existsSync(statePath)
      ? readFileSync(statePath, 'utf8').trim() || null
      : null;

    const composeEnv = { ...process.env, ADAS_IMAGE_TAG: params.imageTag };

    if (params.buildFromSource) {
      const b = this.exec(
        'docker',
        [
          'build',
          '-f',
          path.join(targetDir, 'infra', 'Dockerfile.api'),
          '-t',
          `adas-crm-api:${params.imageTag}`,
          targetDir,
        ],
        { cwd: targetDir, env: composeEnv },
      );
      if (b.status !== 0) {
        throw new Error(`Upgrade image build failed: ${b.stderr}`);
      }
    }

    // 1. Pre-deploy encrypted backup
    this.exec(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/backup.js',
        'backup',
        '--kind=pre_deploy',
      ],
      { cwd: targetDir, env: composeEnv },
    );

    // 2. Apply migrations
    const mig = this.exec(
      'docker',
      [
        'compose',
        '-f',
        composeFile,
        'run',
        '--rm',
        '--no-deps',
        'api',
        'node',
        '--conditions=production-dist',
        'apps/api/dist/cli/migrate.js',
      ],
      { cwd: targetDir, env: composeEnv },
    );
    if (mig.status !== 0) {
      if (previousTag) {
        this.rollbackStack({ targetDir, targetTag: previousTag });
      }
      throw new Error(`Migration failed during upgrade: ${mig.stderr}`);
    }

    // 3. Recreate services
    const up = this.exec(
      'docker',
      ['compose', '-f', composeFile, 'up', '-d', '--no-deps', 'api', 'worker', 'backup'],
      { cwd: targetDir, env: composeEnv },
    );
    if (up.status !== 0) {
      if (previousTag) {
        this.rollbackStack({ targetDir, targetTag: previousTag });
      }
      throw new Error(`Service update failed: ${up.stderr}`);
    }

    // 4. Health check with automatic rollback on failure
    if (params.healthUrl !== 'skip') {
      const check = await this.waitForHealthy(
        params.healthUrl ?? 'http://127.0.0.1:3000/healthz',
        30_000,
      );
      if (!check.ok) {
        if (previousTag) {
          this.rollbackStack({ targetDir, targetTag: previousTag });
          return { previousTag, activeTag: previousTag, rolledBack: true };
        }
        throw new Error(`Post-upgrade health check failed: ${check.detail}`);
      }
    }

    if (previousTag) {
      writeFileSync(`${statePath}.prev`, `${previousTag}\n`, 'utf8');
    }
    writeFileSync(statePath, `${params.imageTag}\n`, 'utf8');

    return { previousTag, activeTag: params.imageTag, rolledBack: false };
  }

  /**
   * Rolls `api`, `worker`, and `backup` back to `.deploy-state.prev` or an explicit `targetTag`.
   */
  rollbackStack(params: { targetDir: string; targetTag?: string }): { restoredTag: string } {
    const targetDir = path.resolve(params.targetDir);
    const composeFile = path.join(targetDir, 'infra', 'compose.prod.yml');
    const prevPath = path.join(targetDir, '.deploy-state.prev');
    const statePath = path.join(targetDir, '.deploy-state');

    const restoredTag =
      params.targetTag?.trim() ||
      (existsSync(prevPath) ? readFileSync(prevPath, 'utf8').trim() : '');
    if (!restoredTag) {
      throw new Error(
        'No rollback target tag specified and no previous deployment recorded in .deploy-state.prev.',
      );
    }

    const res = this.exec(
      'docker',
      ['compose', '-f', composeFile, 'up', '-d', '--no-deps', 'api', 'worker', 'backup'],
      { cwd: targetDir, env: { ...process.env, ADAS_IMAGE_TAG: restoredTag } },
    );
    if (res.status !== 0) {
      throw new Error(`Rollback failed: ${res.stderr}`);
    }

    writeFileSync(statePath, `${restoredTag}\n`, 'utf8');
    return { restoredTag };
  }

  async checkStackHealth(baseUrl = 'http://127.0.0.1:3000'): Promise<{
    ok: boolean;
    httpStatus: number | null;
    readiness: Record<string, unknown> | null;
    detail: string;
  }> {
    try {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json()) as Record<string, unknown>;
      const ok = res.status === 200 && (body['status'] === 'ok' || body['status'] === 'degraded');
      return {
        ok,
        httpStatus: res.status,
        readiness: body,
        detail: `HTTP ${res.status} (${String(body['status'] ?? 'unknown')})`,
      };
    } catch (err) {
      return {
        ok: false,
        httpStatus: null,
        readiness: null,
        detail: err instanceof Error ? err.message : 'unreachable',
      };
    }
  }

  /**
   * Safe Uninstaller:
   * - By default (`purgeData: false`), stops and removes containers ONLY while preserving
   *   PostgreSQL volumes, `data/files`, `data/backups`, `secrets/`, and `.env.production`!
   * - Destructive data deletion (`purgeData: true`) is refused unless `confirmationPhrase`
   *   equals `"DELETE ALL CRM DATA"`.
   */
  uninstallStack(params: { targetDir: string; purgeData?: boolean; confirmationPhrase?: string }): {
    containersStopped: boolean;
    dataPurged: boolean;
  } {
    const targetDir = path.resolve(params.targetDir);
    const composeFile = path.join(targetDir, 'infra', 'compose.prod.yml');
    const purge = Boolean(params.purgeData);

    if (purge && params.confirmationPhrase !== UNINSTALL_PURGE_CONFIRMATION) {
      throw new Error(
        `Refusing to delete CRM database volumes and backups without exact confirmation phrase "${UNINSTALL_PURGE_CONFIRMATION}".`,
      );
    }

    const downArgs = ['compose', '-f', composeFile, '--profile', 'automation', 'down'];
    if (purge) downArgs.push('--volumes');

    const res = this.exec('docker', downArgs, { cwd: targetDir });
    if (res.status !== 0 && existsSync(composeFile)) {
      throw new Error(`Failed to stop Docker Compose stack: ${res.stderr}`);
    }

    if (purge) {
      rmSync(path.join(targetDir, 'data'), { recursive: true, force: true });
      rmSync(path.join(targetDir, 'secrets'), { recursive: true, force: true });
      rmSync(path.join(targetDir, '.env.production'), { force: true });
      rmSync(path.join(targetDir, '.deploy-state'), { force: true });
      rmSync(path.join(targetDir, '.deploy-state.prev'), { force: true });
    }

    return {
      containersStopped: true,
      dataPurged: purge,
    };
  }

  private async waitForHealthy(
    healthUrl: string,
    timeoutMs: number,
  ): Promise<{ ok: boolean; detail: string }> {
    const deadline = Date.now() + timeoutMs;
    let lastDetail = 'waiting';
    while (Date.now() < deadline) {
      const check = await this.checkStackHealth(healthUrl.replace(/\/healthz$/, ''));
      lastDetail = check.detail;
      if (check.ok) return { ok: true, detail: check.detail };
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return { ok: false, detail: lastDetail };
  }
}
