import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BackupManager } from '../platform/backup/index.js';
import { DatabaseService } from '../platform/db/index.js';

const testDbUrl = process.env['TEST_DATABASE_URL'];

function resolveLocalMaintenanceUrl(fallbackUrl: string): string {
  // Local dev PostgreSQL (`pnpm db:local`) stores its superuser password in `%LOCALAPPDATA%/adas-crm/pg-dev-superuser-password.txt`
  // because `adas_admin` is created without `CREATEDB` in `create-local-dev-db.sql`.
  const base = path.join(
    process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), '.local', 'share'),
    'adas-crm',
  );
  const pwFile = path.join(base, 'pg-dev-superuser-password.txt');
  if (existsSync(pwFile)) {
    const pw = readFileSync(pwFile, 'utf8').trim();
    const u = new URL(fallbackUrl);
    u.username = 'postgres';
    u.password = pw;
    u.pathname = '/postgres';
    u.searchParams.delete('schema');
    return u.toString();
  }
  return fallbackUrl;
}

describe('Milestone 10 & 14: Encrypted database backup, off-site S3 sync & verified restore drill (PRD 10.5, 12.1 A21)', () => {
  it('records backup telemetry in backup_runs across PGlite and PostgreSQL', async () => {
    const db = DatabaseService.forTests();
    await db.ensureInitialized();
    try {
      await db.query(
        `INSERT INTO backup_runs (id, kind, status, size_bytes, encrypted, offsite_synced, started_at, completed_at, duration_ms)
         VALUES ('bkp_smoke_1', 'pg_dump', 'succeeded', 4096, TRUE, TRUE, NOW(), NOW(), 120)`,
      );
      const res = await db.query<{ status: string; encrypted: boolean }>(
        `SELECT status, encrypted FROM backup_runs WHERE id = 'bkp_smoke_1'`,
      );
      expect(res.rows[0]?.status).toBe('succeeded');
      expect(res.rows[0]?.encrypted).toBe(true);
    } finally {
      await db.close();
    }
  });

  it.skipIf(!testDbUrl)(
    'executes real pg_dump -> AES-256-GCM -> S3 PUT -> S3 GET -> pg_restore -> integrity & immutability drill on PostgreSQL 17',
    async () => {
      const dbUrl = testDbUrl ?? '';
      const db = DatabaseService.forTests();
      await db.ensureInitialized();

      const backupDir = mkdtempSync(path.join(os.tmpdir(), 'adas-drill-e2e-'));
      const s3Objects = new Map<string, Buffer>();
      const kumaPings: string[] = [];

      const mockServer = createServer((req: IncomingMessage, res: ServerResponse) => {
        const reqUrl = req.url ?? '/';
        if (reqUrl.startsWith('/kuma/push')) {
          kumaPings.push(reqUrl);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'PUT') {
          const chunks: Buffer[] = [];
          req.on('data', (c: Buffer) => chunks.push(c));
          req.on('end', () => {
            s3Objects.set(reqUrl, Buffer.concat(chunks));
            res.writeHead(200).end();
          });
          return;
        }
        if (req.method === 'GET') {
          const buf = s3Objects.get(reqUrl);
          if (!buf) {
            res.writeHead(404).end();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
          res.end(buf);
          return;
        }
        res.writeHead(405).end();
      });

      await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
      const mockPort = (mockServer.address() as AddressInfo).port;

      try {
        // Count live rows in source DB before backup
        const [cmpCnt, cntCnt] = await Promise.all([
          db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM companies`),
          db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM contacts`),
        ]);

        const maintUrl = resolveLocalMaintenanceUrl(dbUrl);
        const manager = new BackupManager({
          adminDatabaseUrl: maintUrl.replace(/\/postgres$/, '/adas_crm_test'),
          backupDir,
          encryptionSecret: 'bkkey_pg17_restore_drill_test_secret_2026_valid_32b',
          retentionDays: 14,
          s3: {
            endpoint: `http://127.0.0.1:${mockPort}`,
            region: 'auto',
            bucket: 'adas-offsite-vault',
            accessKeyId: 'r2_test_key',
            secretAccessKey: 'r2_test_secret_value_2026',
          },
          uptimeKumaPushUrl: `http://127.0.0.1:${mockPort}/kuma/push`,
          telemetryDb: db,
        });

        // 1. Run encrypted pg_dump + off-site S3 sync
        const manifest = await manager.createEncryptedDatabaseBackup('pg_dump');
        expect(manifest.format).toBe('ADASBK01');
        expect(manifest.offsiteSynced).toBe(true);
        expect(manifest.sizeBytes).toBeGreaterThan(1000);

        const onDisk = readFileSync(path.join(backupDir, manifest.encryptedFilename));
        expect(onDisk.subarray(0, 8).toString('ascii')).toBe('ADASBK01');
        expect(s3Objects.size).toBe(2); // .dump.enc + .manifest.json

        // 2. Run automated restore drill pulling the encrypted backup from off-site S3!
        const drill = await manager.runRestoreDrill({
          backupId: manifest.id,
          fromOffsite: true,
          maintenanceDatabaseUrl: maintUrl,
          expectedCounts: {
            companies: cmpCnt.rows[0]?.n ?? 0,
            contacts: cntCnt.rows[0]?.n ?? 0,
          },
        });

        expect(drill.foreignKeyOrphans).toBe(0);
        expect(drill.searchTsvIndexedCompanies).toBeGreaterThan(0);
        expect(drill.auditLogImmutableVerified).toBe(true);
        expect(drill.suppressionsNoDeleteVerified).toBe(true);
        expect(kumaPings.length).toBe(2);
        expect(kumaPings.every((u) => u.includes('status=up'))).toBe(true);

        // 3. Verify telemetry rows in backup_runs
        const runs = await db.query<{ kind: string; status: string; offsite_synced: boolean }>(
          `SELECT kind, status, offsite_synced FROM backup_runs WHERE id IN ($1, $2)`,
          [manifest.id, drill.drillRunId],
        );
        expect(runs.rows).toHaveLength(2);
        expect(runs.rows.every((r) => r.status === 'succeeded')).toBe(true);
      } finally {
        await new Promise<void>((resolve) => mockServer.close(() => resolve()));
        rmSync(backupDir, { recursive: true, force: true });
        await db.close();
      }
    },
    60_000,
  );
});
