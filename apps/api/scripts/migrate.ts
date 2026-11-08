/**
 * Applies prisma/migrations/<name>/migration.sql files in order, once each, as the
 * admin role (DATABASE_ADMIN_URL). Records each in schema_migrations with a checksum and
 * refuses to continue if an applied migration was edited afterwards (AGENTS.md section 5).
 *
 *   pnpm db:migrate
 */
import { createHash } from 'node:crypto';
import pg from 'pg';
import { readMigrations } from '../src/platform/db/index.js';
import { loadDotEnv, validateEnv } from '../src/platform/config/index.js';
import { installJobs } from '../src/platform/jobs/index.js';
import { JOB_QUEUES } from '../src/jobs.js';

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

  // The job queue schema belongs to pg-boss, which installs and upgrades it itself. It runs
  // here, as the admin role, so the app role never needs schema rights (PRD 6.9, ADR 0006).
  await installJobs({ connectionString: env.DATABASE_ADMIN_URL }, [...JOB_QUEUES]);
  await client.query(`GRANT USAGE ON SCHEMA pgboss TO adas_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO adas_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO adas_app;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO adas_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO adas_app;`);
  console.log(`[migrate] job queues ready: ${JOB_QUEUES.join(', ')}`);
} catch (err) {
  console.error(`[migrate] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
