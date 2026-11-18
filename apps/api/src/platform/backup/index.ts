import { spawnSync } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { type DatabaseService } from '../db/index.js';
import { getS3Object, putS3Object, type S3BackupConfig } from './s3-sigv4.js';

export * from './s3-sigv4.js';

/**
 * Encrypted PostgreSQL Backup, Off-Site Sync & Verified Restore Drill Engine (`PRD 10.5`, `A21`).
 *
 * Envelope format (`ADASBK01`):
 *   - Bytes 0..7   : ASCII magic `"ADASBK01"`
 *   - Bytes 8..19  : 12-byte random AES-256-GCM IV
 *   - Bytes 20..35 : 16-byte AES-256-GCM authentication tag
 *   - Bytes 36..N  : Ciphertext of `pg_dump --format=custom` archive
 */

const MAGIC = Buffer.from('ADASBK01', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + IV_BYTES + TAG_BYTES;

export interface BackupManifest {
  format: 'ADASBK01';
  id: string;
  kind: 'pg_dump' | 'pre_deploy';
  createdAt: string;
  encryptedFilename: string;
  sizeBytes: number;
  encryptedSha256: string;
  plaintextSha256: string;
  offsiteSynced: boolean;
  offsiteKey: string | null;
}

export interface RestoreDrillResult {
  drillRunId: string;
  backupId: string;
  durationMs: number;
  tableCounts: Record<string, number>;
  searchTsvIndexedCompanies: number;
  foreignKeyOrphans: number;
  auditLogImmutableVerified: boolean;
  suppressionsNoDeleteVerified: boolean;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function deriveBackupKey(rawSecret: string): Buffer {
  const trimmed = rawSecret.trim();
  if (trimmed.length < 32) {
    throw new Error('Backup encryption key must contain at least 32 non-whitespace characters.');
  }
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(trimmed, 'utf8'),
      Buffer.from('adas-crm-backup-salt-v1', 'utf8'),
      Buffer.from('adas-crm-backup-aes-256-gcm', 'utf8'),
      32,
    ),
  );
}

export function encryptBackupBuffer(plaintext: Buffer, rawSecret: string): Buffer {
  const key = deriveBackupKey(rawSecret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

export function decryptBackupBuffer(envelope: Buffer, rawSecret: string): Buffer {
  if (envelope.length < HEADER_BYTES) {
    throw new Error('Invalid encrypted backup: file is truncated.');
  }
  const magic = envelope.subarray(0, MAGIC.length);
  if (!magic.equals(MAGIC)) {
    throw new Error('Invalid encrypted backup: unrecognized magic header.');
  }
  const iv = envelope.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = envelope.subarray(MAGIC.length + IV_BYTES, HEADER_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES);
  const key = deriveBackupKey(rawSecret);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** Resolves `pg_dump` / `pg_restore` across Linux (`/usr/bin`), `PG_BIN`, Windows PostgreSQL 17, or `PATH`. */
export function resolvePgTool(toolName: 'pg_dump' | 'pg_restore'): string {
  const exe = process.platform === 'win32' ? `${toolName}.exe` : toolName;
  if (process.env['PG_BIN']) {
    const candidate = path.join(process.env['PG_BIN'], exe);
    if (existsSync(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    const pgRoot = path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'PostgreSQL');
    if (existsSync(pgRoot)) {
      const versions = readdirSync(pgRoot)
        .filter((v) => /^\d+$/.test(v) && existsSync(path.join(pgRoot, v, 'bin', exe)))
        .sort((a, b) => Number(b) - Number(a));
      if (versions[0]) {
        return path.join(pgRoot, versions[0], 'bin', exe);
      }
    }
  }
  return exe;
}

/** Replaces the database name in a `postgresql://` connection string while stripping `?schema=...` for `pg_dump`/`pg_restore`/`pg.Client`. */
export function replacePgDatabaseInUrl(connectionUrl: string, dbName: string): string {
  const parsed = new URL(connectionUrl);
  parsed.pathname = `/${dbName}`;
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

export function cleanPgCliUrl(connectionUrl: string): string {
  const parsed = new URL(connectionUrl);
  parsed.searchParams.delete('schema');
  return parsed.toString();
}

async function pingUptimeKuma(
  pushUrl: string | undefined,
  status: 'up' | 'down',
  msg: string,
  pingMs?: number,
): Promise<void> {
  if (!pushUrl || !pushUrl.trim()) return;
  try {
    const u = new URL(pushUrl.trim());
    u.searchParams.set('status', status);
    u.searchParams.set('msg', msg.slice(0, 200));
    if (pingMs !== undefined) u.searchParams.set('ping', String(Math.round(pingMs)));
    await fetch(u, { method: 'GET', signal: AbortSignal.timeout(10_000) });
  } catch {
    // Non-fatal: monitoring push failure must not abort a completed backup or drill.
  }
}

async function recordBackupTelemetry(
  db: DatabaseService | undefined,
  row: {
    id: string;
    kind: 'pg_dump' | 'pre_deploy' | 'restore_drill';
    status: 'running' | 'succeeded' | 'failed';
    artifactKey?: string | null;
    sizeBytes?: number | null;
    checksumSha256?: string | null;
    encrypted?: boolean;
    offsiteSynced?: boolean;
    startedAt: Date;
    completedAt?: Date | null;
    durationMs?: number | null;
    errorCode?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  if (!db) return;
  await db.query(
    `INSERT INTO backup_runs (
       id, kind, status, artifact_key, size_bytes, checksum_sha256,
       encrypted, offsite_synced, started_at, completed_at, duration_ms, error_code, details
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
     ON CONFLICT (id) DO UPDATE
     SET status = EXCLUDED.status,
         artifact_key = COALESCE(EXCLUDED.artifact_key, backup_runs.artifact_key),
         size_bytes = COALESCE(EXCLUDED.size_bytes, backup_runs.size_bytes),
         checksum_sha256 = COALESCE(EXCLUDED.checksum_sha256, backup_runs.checksum_sha256),
         offsite_synced = EXCLUDED.offsite_synced,
         completed_at = EXCLUDED.completed_at,
         duration_ms = EXCLUDED.duration_ms,
         error_code = EXCLUDED.error_code,
         details = EXCLUDED.details`,
    [
      row.id,
      row.kind,
      row.status,
      row.artifactKey ?? null,
      row.sizeBytes ?? null,
      row.checksumSha256 ?? null,
      row.encrypted ?? true,
      row.offsiteSynced ?? false,
      row.startedAt.toISOString(),
      row.completedAt ? row.completedAt.toISOString() : null,
      row.durationMs ?? null,
      row.errorCode ?? null,
      JSON.stringify(row.details ?? {}),
    ],
  );
}

export class BackupManager {
  constructor(
    private readonly options: {
      adminDatabaseUrl: string;
      backupDir: string;
      encryptionSecret: string;
      retentionDays?: number;
      s3?: S3BackupConfig | null;
      uptimeKumaPushUrl?: string;
      telemetryDb?: DatabaseService;
    },
  ) {}

  async createEncryptedDatabaseBackup(
    kind: 'pg_dump' | 'pre_deploy' = 'pg_dump',
  ): Promise<BackupManifest> {
    const startedAt = new Date();
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const id = `bkp_${stamp}_${randomUUID().slice(0, 8)}`;
    const encryptedFilename = `${id}.dump.enc`;
    const manifestFilename = `${id}.manifest.json`;

    mkdirSync(this.options.backupDir, { recursive: true });
    const tempDir = path.join(tmpdir(), `adas-pgdump-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const rawDumpPath = path.join(tempDir, 'adas_crm.dump');

    await recordBackupTelemetry(this.options.telemetryDb, {
      id,
      kind,
      status: 'running',
      startedAt,
    });

    try {
      const pgDumpBin = resolvePgTool('pg_dump');
      const dumpRes = spawnSync(
        pgDumpBin,
        [
          '--format=custom',
          '--no-owner',
          '--no-acl',
          `--file=${rawDumpPath}`,
          cleanPgCliUrl(this.options.adminDatabaseUrl),
        ],
        { encoding: 'utf8' },
      );

      if (dumpRes.status !== 0) {
        throw new Error(
          `pg_dump exited with code ${dumpRes.status ?? -1}: ${(dumpRes.stderr || dumpRes.error?.message || '').trim()}`,
        );
      }

      const plaintext = readFileSync(rawDumpPath);
      const plaintextSha256 = sha256Hex(plaintext);
      const encrypted = encryptBackupBuffer(plaintext, this.options.encryptionSecret);
      const encryptedSha256 = sha256Hex(encrypted);

      const encryptedPath = path.join(this.options.backupDir, encryptedFilename);
      const manifestPath = path.join(this.options.backupDir, manifestFilename);
      writeFileSync(encryptedPath, encrypted, { mode: 0o600 });

      let offsiteSynced = false;
      let offsiteKey: string | null = null;
      if (this.options.s3) {
        const prefix = `db/${startedAt.toISOString().slice(0, 10)}`;
        offsiteKey = `${prefix}/${encryptedFilename}`;
        await putS3Object({
          config: this.options.s3,
          objectKey: offsiteKey,
          body: encrypted,
          contentType: 'application/octet-stream',
        });
        offsiteSynced = true;
      }

      const manifest: BackupManifest = {
        format: 'ADASBK01',
        id,
        kind,
        createdAt: startedAt.toISOString(),
        encryptedFilename,
        sizeBytes: encrypted.length,
        encryptedSha256,
        plaintextSha256,
        offsiteSynced,
        offsiteKey,
      };
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

      if (this.options.s3 && offsiteKey) {
        await putS3Object({
          config: this.options.s3,
          objectKey: offsiteKey.replace(/\.dump\.enc$/, '.manifest.json'),
          body: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'),
          contentType: 'application/json',
        });
      }

      const pruned = this.pruneExpiredLocalBackups(this.options.retentionDays ?? 14);
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();

      await recordBackupTelemetry(this.options.telemetryDb, {
        id,
        kind,
        status: 'succeeded',
        artifactKey: offsiteKey ?? encryptedFilename,
        sizeBytes: encrypted.length,
        checksumSha256: encryptedSha256,
        encrypted: true,
        offsiteSynced,
        startedAt,
        completedAt,
        durationMs,
        details: { prunedLocalCount: pruned },
      });

      await pingUptimeKuma(
        this.options.uptimeKumaPushUrl,
        'up',
        `Backup ${id} succeeded (${encrypted.length} bytes)`,
        durationMs,
      );

      return manifest;
    } catch (err) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const errorCode = (err as Error).name || 'BackupError';
      await recordBackupTelemetry(this.options.telemetryDb, {
        id,
        kind,
        status: 'failed',
        startedAt,
        completedAt,
        durationMs,
        errorCode,
      }).catch(() => undefined);

      await pingUptimeKuma(this.options.uptimeKumaPushUrl, 'down', `Backup failed: ${errorCode}`);
      throw err;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  listLocalBackups(): BackupManifest[] {
    if (!existsSync(this.options.backupDir)) return [];
    const files = readdirSync(this.options.backupDir)
      .filter((f) => f.endsWith('.manifest.json'))
      .sort()
      .reverse();
    const manifests: BackupManifest[] = [];
    for (const f of files) {
      try {
        const parsed = JSON.parse(
          readFileSync(path.join(this.options.backupDir, f), 'utf8'),
        ) as BackupManifest;
        manifests.push(parsed);
      } catch {
        // Ignore unreadable partial files
      }
    }
    return manifests;
  }

  pruneExpiredLocalBackups(retentionDays: number): number {
    if (!existsSync(this.options.backupDir)) return 0;
    const cutoffMs = Date.now() - retentionDays * 86_400_000;
    let removed = 0;
    for (const name of readdirSync(this.options.backupDir)) {
      if (!name.endsWith('.dump.enc') && !name.endsWith('.manifest.json')) continue;
      const fullPath = path.join(this.options.backupDir, name);
      try {
        const st = statSync(fullPath);
        if (st.mtimeMs < cutoffMs) {
          rmSync(fullPath, { force: true });
          removed += 1;
        }
      } catch {
        // Ignore race if already removed
      }
    }
    return removed;
  }

  /**
   * Executes a full automated restore drill (`PRD 10.5`, `12.1 A21`):
   * 1. Loads encrypted `.dump.enc` from disk (or downloads from off-site S3 when `fromOffsite` is set),
   * 2. Verifies SHA-256 manifest integrity & AES-256-GCM authentication tag,
   * 3. Creates an isolated throw-away PostgreSQL database (`adas_crm_drill_<rand>`),
   * 4. Runs `pg_restore --exit-on-error`,
   * 5. Verifies row counts, generated `search_tsv` columns, 0 FK orphans, and both append-only
   *    security triggers (`audit_logs` and `suppressions`),
   * 6. Drops the throw-away database in `finally` and records telemetry in `backup_runs`.
   */
  async runRestoreDrill(
    params: {
      backupId?: string;
      fromOffsite?: boolean;
      expectedCounts?: Partial<Record<string, number>>;
      maintenanceDatabaseUrl?: string;
    } = {},
  ): Promise<RestoreDrillResult> {
    const startedAt = new Date();
    const drillRunId = `drl_${startedAt.toISOString().replace(/[:.]/g, '-')}_${randomUUID().slice(0, 8)}`;

    await recordBackupTelemetry(this.options.telemetryDb, {
      id: drillRunId,
      kind: 'restore_drill',
      status: 'running',
      startedAt,
    });

    const tempDir = path.join(tmpdir(), `adas-drill-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const drillDbName = `adas_crm_drill_${randomBytes(4).toString('hex')}`;
    const maintUrl = cleanPgCliUrl(params.maintenanceDatabaseUrl ?? this.options.adminDatabaseUrl);

    const adminClient = new pg.Client({ connectionString: maintUrl });

    try {
      const manifests = this.listLocalBackups();
      const manifest = params.backupId
        ? manifests.find((m) => m.id === params.backupId)
        : manifests[0];
      if (!manifest) {
        throw new Error('No backup manifest found to run restore drill.');
      }

      let encryptedBuf: Buffer;
      if (params.fromOffsite) {
        if (!this.options.s3 || !manifest.offsiteKey) {
          throw new Error('Off-site S3 restore requested, but backup has no off-site S3 key.');
        }
        encryptedBuf = await getS3Object({
          config: this.options.s3,
          objectKey: manifest.offsiteKey,
        });
      } else {
        const encPath = path.join(this.options.backupDir, manifest.encryptedFilename);
        encryptedBuf = readFileSync(encPath);
      }

      const actualEncSha = sha256Hex(encryptedBuf);
      if (actualEncSha !== manifest.encryptedSha256) {
        throw new Error(
          `Encrypted backup checksum mismatch: expected ${manifest.encryptedSha256}, got ${actualEncSha}`,
        );
      }

      const decryptedBuf = decryptBackupBuffer(encryptedBuf, this.options.encryptionSecret);
      const actualPlainSha = sha256Hex(decryptedBuf);
      if (actualPlainSha !== manifest.plaintextSha256) {
        throw new Error(
          `Decrypted archive checksum mismatch: expected ${manifest.plaintextSha256}, got ${actualPlainSha}`,
        );
      }

      const decryptedDumpPath = path.join(tempDir, 'restored.dump');
      writeFileSync(decryptedDumpPath, decryptedBuf, { mode: 0o600 });

      await adminClient.connect();
      await adminClient.query(`CREATE DATABASE ${drillDbName}`);

      const drillUrl = replacePgDatabaseInUrl(this.options.adminDatabaseUrl, drillDbName);

      // Pre-install required C extensions (`pg_trgm`, `unaccent`) if current role can, before pg_restore
      const prepClient = new pg.Client({ connectionString: drillUrl });
      await prepClient.connect();
      try {
        await prepClient.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => undefined);
        await prepClient.query(`CREATE EXTENSION IF NOT EXISTS unaccent`).catch(() => undefined);
      } finally {
        await prepClient.end();
      }

      const pgRestoreBin = resolvePgTool('pg_restore');
      const restoreRes = spawnSync(
        pgRestoreBin,
        ['--no-owner', '--no-acl', '--exit-on-error', `--dbname=${drillUrl}`, decryptedDumpPath],
        { encoding: 'utf8' },
      );

      if (restoreRes.status !== 0) {
        throw new Error(
          `pg_restore exited with code ${restoreRes.status ?? -1}: ${(restoreRes.stderr || restoreRes.error?.message || '').trim()}`,
        );
      }

      // Run SQL integrity, generated-column, FK, and append-only immutability checks on the restored DB
      const verifyClient = new pg.Client({ connectionString: drillUrl });
      await verifyClient.connect();
      try {
        const tables = [
          'users',
          'roles',
          'companies',
          'contacts',
          'leads',
          'deals',
          'tasks',
          'activities',
          'audit_logs',
          'suppressions',
        ];
        const tableCounts: Record<string, number> = {};
        for (const t of tables) {
          const r = await verifyClient.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`);
          tableCounts[t] = r.rows[0]?.n ?? 0;
        }

        if (params.expectedCounts) {
          for (const [tbl, expected] of Object.entries(params.expectedCounts)) {
            if (expected !== undefined && tableCounts[tbl] !== expected) {
              throw new Error(
                `Restored row count mismatch on ${tbl}: expected ${expected}, got ${tableCounts[tbl]}`,
              );
            }
          }
        }

        const tsvRes = await verifyClient.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM companies WHERE search_tsv IS NOT NULL`,
        );
        const searchTsvIndexedCompanies = tsvRes.rows[0]?.n ?? 0;
        if ((tableCounts['companies'] ?? 0) > 0 && searchTsvIndexedCompanies === 0) {
          throw new Error(
            'Generated search_tsv column on companies did not populate after restore.',
          );
        }

        const fkRes = await verifyClient.query<{ orphans: number }>(
          `SELECT (
             (SELECT COUNT(*)::int FROM contacts c WHERE c.company_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = c.company_id)) +
             (SELECT COUNT(*)::int FROM deals d WHERE NOT EXISTS (SELECT 1 FROM companies co WHERE co.id = d.company_id)) +
             (SELECT COUNT(*)::int FROM contact_emails ce WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = ce.contact_id))
           )::int AS orphans`,
        );
        const foreignKeyOrphans = fkRes.rows[0]?.orphans ?? 0;
        if (foreignKeyOrphans !== 0) {
          throw new Error(
            `Restored database contains ${foreignKeyOrphans} broken foreign-key links.`,
          );
        }

        // Verify append-only trigger on audit_logs (`trg_audit_logs_immutable`)
        await verifyClient.query('BEGIN');
        await verifyClient.query(
          `INSERT INTO audit_logs (id, action, entity_type, entity_id, metadata)
           VALUES ('aud_drill_probe', 'drill.probe', 'system', 'drill', '{}'::jsonb)`,
        );
        let auditBlocked = false;
        await verifyClient.query('SAVEPOINT sp_audit');
        try {
          await verifyClient.query(`DELETE FROM audit_logs WHERE id = 'aud_drill_probe'`);
        } catch {
          auditBlocked = true;
          await verifyClient.query('ROLLBACK TO SAVEPOINT sp_audit');
        }
        await verifyClient.query('ROLLBACK');
        if (!auditBlocked) {
          throw new Error('Restored database failed audit_logs append-only DELETE trigger check.');
        }

        // Verify non-delete trigger on suppressions (`trg_suppressions_no_delete`)
        await verifyClient.query('BEGIN');
        await verifyClient.query(
          `INSERT INTO suppressions (id, email, email_sha256, reason, source)
           VALUES ('sup_drill_probe', 'drill.probe@example.com', repeat('a', 64), 'manual_dnc', 'admin')`,
        );
        let suppressionBlocked = false;
        await verifyClient.query('SAVEPOINT sp_sup');
        try {
          await verifyClient.query(`DELETE FROM suppressions WHERE id = 'sup_drill_probe'`);
        } catch {
          suppressionBlocked = true;
          await verifyClient.query('ROLLBACK TO SAVEPOINT sp_sup');
        }
        await verifyClient.query('ROLLBACK');
        if (!suppressionBlocked) {
          throw new Error('Restored database failed suppressions non-delete trigger check.');
        }

        const completedAt = new Date();
        const durationMs = completedAt.getTime() - startedAt.getTime();

        await recordBackupTelemetry(this.options.telemetryDb, {
          id: drillRunId,
          kind: 'restore_drill',
          status: 'succeeded',
          artifactKey: manifest.encryptedFilename,
          sizeBytes: manifest.sizeBytes,
          checksumSha256: manifest.encryptedSha256,
          encrypted: true,
          offsiteSynced: manifest.offsiteSynced,
          startedAt,
          completedAt,
          durationMs,
          details: {
            backupId: manifest.id,
            tableCounts,
            searchTsvIndexedCompanies,
            foreignKeyOrphans,
          },
        });

        await pingUptimeKuma(
          this.options.uptimeKumaPushUrl,
          'up',
          `Restore drill ${drillRunId} passed (${durationMs} ms)`,
          durationMs,
        );

        return {
          drillRunId,
          backupId: manifest.id,
          durationMs,
          tableCounts,
          searchTsvIndexedCompanies,
          foreignKeyOrphans,
          auditLogImmutableVerified: true,
          suppressionsNoDeleteVerified: true,
        };
      } finally {
        await verifyClient.end().catch(() => undefined);
      }
    } catch (err) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - startedAt.getTime();
      const errorCode = (err as Error).name || 'RestoreDrillError';
      await recordBackupTelemetry(this.options.telemetryDb, {
        id: drillRunId,
        kind: 'restore_drill',
        status: 'failed',
        startedAt,
        completedAt,
        durationMs,
        errorCode,
      }).catch(() => undefined);

      await pingUptimeKuma(
        this.options.uptimeKumaPushUrl,
        'down',
        `Restore drill failed: ${errorCode}`,
      );
      throw err;
    } finally {
      try {
        await adminClient.query(`DROP DATABASE IF EXISTS ${drillDbName} WITH (FORCE)`);
      } catch {
        // Ignore cleanup failure if connection never opened
      }
      await adminClient.end().catch(() => undefined);
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
