/**
 * Compiled production & dev encrypted backup / restore-drill CLI
 * (`node --conditions=production-dist apps/api/dist/cli/backup.js`).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BackupManager, type S3BackupConfig } from '../platform/backup/index.js';
import { loadDotEnv, resolveConfigPath, validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

loadDotEnv();
const env = validateEnv();
const cmd = process.argv[2] ?? 'backup';

function ensureOrReadBackupKey(): string {
  const keyPath = resolveConfigPath(env.BACKUP_ENCRYPTION_KEY_FILE);
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf8').trim();
  }
  if (env.NODE_ENV === 'production') {
    throw new Error(
      `BACKUP_ENCRYPTION_KEY_FILE not found at ${keyPath}. Provision a 32+ byte secret file before running backups in production.`,
    );
  }
  mkdirSync(path.dirname(keyPath), { recursive: true });
  const generated = `bkkey_dev_${randomBytes(32).toString('hex')}`;
  writeFileSync(keyPath, `${generated}\n`, { mode: 0o600 });
  return generated;
}

function resolveS3Config(): S3BackupConfig | null {
  if (!env.BACKUP_S3_ENDPOINT || !env.BACKUP_S3_BUCKET || !env.BACKUP_S3_ACCESS_KEY_ID) {
    return null;
  }
  const secretPath = resolveConfigPath(env.BACKUP_S3_SECRET_ACCESS_KEY_FILE);
  if (!existsSync(secretPath)) {
    throw new Error(`BACKUP_S3_SECRET_ACCESS_KEY_FILE missing at ${secretPath}`);
  }
  return {
    endpoint: env.BACKUP_S3_ENDPOINT,
    region: env.BACKUP_S3_REGION,
    bucket: env.BACKUP_S3_BUCKET,
    accessKeyId: env.BACKUP_S3_ACCESS_KEY_ID,
    secretAccessKey: readFileSync(secretPath, 'utf8').trim(),
  };
}

const telemetryDb = DatabaseService.connect(env.DATABASE_URL);
const manager = new BackupManager({
  adminDatabaseUrl: env.DATABASE_ADMIN_URL,
  backupDir: resolveConfigPath(env.BACKUP_LOCAL_DIR),
  encryptionSecret: ensureOrReadBackupKey(),
  retentionDays: env.BACKUP_RETENTION_DAYS,
  s3: resolveS3Config(),
  uptimeKumaPushUrl: env.UPTIME_KUMA_PUSH_URL || undefined,
  telemetryDb,
});

try {
  await telemetryDb.ensureInitialized();

  if (cmd === 'backup') {
    const kindArg = process.argv.find((a) => a.startsWith('--kind='))?.slice('--kind='.length);
    const kind = kindArg === 'pre_deploy' ? 'pre_deploy' : 'pg_dump';
    const manifest = await manager.createEncryptedDatabaseBackup(kind);
    console.log(JSON.stringify({ status: 'ok', action: 'backup', manifest }, null, 2));
  } else if (cmd === 'drill') {
    const backupId = process.argv
      .find((a) => a.startsWith('--backup-id='))
      ?.slice('--backup-id='.length);
    const fromOffsite = process.argv.includes('--from-offsite');
    const maintUrl = process.env['PG_MAINTENANCE_URL'] || env.DATABASE_ADMIN_URL;
    const drill = await manager.runRestoreDrill({
      backupId,
      fromOffsite,
      maintenanceDatabaseUrl: maintUrl,
    });
    console.log(JSON.stringify({ status: 'ok', action: 'drill', drill }, null, 2));
  } else if (cmd === 'list') {
    const items = manager.listLocalBackups();
    console.log(JSON.stringify({ status: 'ok', action: 'list', items }, null, 2));
  } else {
    console.error(`Unknown command "${cmd}". Expected: backup | drill | list`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`[backup-cli] ${cmd} failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await telemetryDb.close().catch(() => undefined);
}
