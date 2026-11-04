/**
 * Loads synthetic development data into the database (never real personal data).
 * Does nothing if users already exist. Refuses to run against production.
 *
 *   pnpm db:seed
 */
import pg from 'pg';
import { loadDotEnv, validateEnv } from '../src/platform/config/index.js';
import { seedSyntheticBaseline } from '../src/platform/db/seed.js';

loadDotEnv();
const env = validateEnv();
if (env.NODE_ENV === 'production') {
  console.error('[seed] Refusing to load demo data into a production database.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
try {
  await client.connect();
  const loaded = await seedSyntheticBaseline({
    exec: async (sql) => {
      await client.query(sql);
    },
    query: async <T>(sql: string) => ({ rows: (await client.query(sql)).rows as T[] }),
  });
  console.log(
    loaded ? '[seed] synthetic data loaded' : '[seed] data already present; nothing to do',
  );
} catch (err) {
  console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
