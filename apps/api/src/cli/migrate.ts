/**
 * Compiled production & dev migration runner (`node --conditions=production-dist apps/api/dist/cli/migrate.js`).
 * Applies `prisma/migrations/<name>/migration.sql` files in order, once each, as `DATABASE_ADMIN_URL`,
 * verifies SHA-256 checksums, installs pg-boss queues, and enforces `adas_app` least-privilege grants.
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { JOB_QUEUES } from '../jobs.js';
import { loadDotEnv, validateEnv } from '../platform/config/index.js';
import { readMigrations } from '../platform/db/index.js';
import { installJobs } from '../platform/jobs/index.js';

loadDotEnv();
const env = validateEnv();
const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });

try {
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const applied = new Map(
    (
      await client.query<{ name: string; checksum: string }>(
        'SELECT name, checksum FROM schema_migrations',
      )
    ).rows.map((r) => [r.name, r.checksum]),
  );

  let ran = 0;
  for (const migration of readMigrations()) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const previous = applied.get(migration.name);
    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${migration.name} was edited after it was applied. Add a new migration instead.`,
        );
      }
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        migration.name,
        checksum,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    console.log(`[migrate] applied ${migration.name}`);
    ran += 1;
  }
  console.log(
    ran === 0 ? '[migrate] database is up to date' : `[migrate] ${ran} migration(s) applied`,
  );

  await installJobs({ connectionString: env.DATABASE_ADMIN_URL }, [...JOB_QUEUES]);
  await client.query(`
    GRANT USAGE ON SCHEMA public TO adas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO adas_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_logs FROM adas_app;
    REVOKE DELETE, TRUNCATE ON TABLE suppressions FROM adas_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE schema_migrations FROM adas_app;
    GRANT USAGE ON SCHEMA pgboss TO adas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO adas_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO adas_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO adas_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adas_app;
  `);
  console.log(`[migrate] job queues ready: ${JOB_QUEUES.join(', ')}`);
} catch (err) {
  console.error(`[migrate] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
