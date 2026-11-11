/**
 * Loads synthetic development data into the database (never real personal data).
 * Refuses to run against production.
 *
 *   pnpm db:seed                the small baseline; does nothing if users already exist
 *   pnpm db:seed --size=large   also 20,000 companies, 60,000 contacts and 300,000 timeline
 *                               entries for performance work (PRD 12.2); safe to run again
 */
import pg from 'pg';
import { loadDotEnv, validateEnv } from '../src/platform/config/index.js';
import { seedSyntheticBaseline } from '../src/platform/db/seed.js';
import { seedLarge } from '../src/platform/db/seed-large.js';

const sizeArg = process.argv.find((arg) => arg.startsWith('--size='))?.slice('--size='.length);
if (sizeArg !== undefined && sizeArg !== 'large' && sizeArg !== 'small') {
  console.error(`[seed] Unknown size "${sizeArg}". Use --size=large, or leave it out.`);
  process.exit(1);
}

loadDotEnv();
const env = validateEnv();
if (env.NODE_ENV === 'production') {
  console.error('[seed] Refusing to load demo data into a production database.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
const target = {
  exec: async (sql: string) => {
    await client.query(sql);
  },
  query: async <T>(sql: string) => ({ rows: (await client.query(sql)).rows as T[] }),
};
try {
  await client.connect();
  const loaded = await seedSyntheticBaseline(target);
  console.log(
    loaded ? '[seed] synthetic data loaded' : '[seed] data already present; nothing to do',
  );
  if (sizeArg === 'large') {
    const started = Date.now();
    const counts = await seedLarge(target, undefined, (message) =>
      console.log(`[seed] ${message}`),
    );
    const seconds = Math.round((Date.now() - started) / 1000);
    console.log(`[seed] large data set ready in ${seconds} s:`, counts);
  }
} catch (err) {
  console.error(`[seed] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
