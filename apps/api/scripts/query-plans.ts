/**
 * Explains the screens' real queries on the configured database and writes a report
 * (AGENTS.md section 8; PRD 12.2). It only reads. Load the large seed first:
 *
 *   pnpm db:seed --size=large
 *   pnpm db:plans                 writes docs/perf/query-plans-postgres.md
 *
 * Exits with 1 when a scenario is flagged. Refuses to run against production.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectQueryPlans, renderQueryPlanReport } from '../src/perf/query-plans.js';
import { loadDotEnv, validateEnv } from '../src/platform/config/index.js';
import { DatabaseService } from '../src/platform/db/index.js';

loadDotEnv();
const env = validateEnv();
if (env.NODE_ENV === 'production') {
  console.error('[plans] Refusing to run against a production database.');
  process.exit(1);
}

const db = DatabaseService.connect(env.DATABASE_URL);
try {
  const rows: Record<string, number> = {};
  for (const table of ['companies', 'contacts', 'leads', 'deals', 'tasks', 'activities']) {
    const res = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
    rows[table] = res.rows[0]?.n ?? 0;
  }
  if ((rows['contacts'] ?? 0) < 50_000) {
    console.warn(
      '[plans] Fewer than 50,000 contacts: small tables are always read whole, so these plans say little. Run `pnpm db:seed --size=large` first.',
    );
  }
  const version = await db.query<{ v: string }>(`SELECT version() AS v`);
  const results = await collectQueryPlans(db);
  const report = renderQueryPlanReport(results, {
    engine: String(version.rows[0]?.v ?? 'PostgreSQL').split(' on ')[0] ?? 'PostgreSQL',
    rows,
    date: new Date().toISOString().slice(0, 10),
  });
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/perf');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'query-plans-postgres.md');
  writeFileSync(file, report, 'utf8');

  const flagged = results.filter((r) => r.flags.length > 0);
  console.log(`[plans] ${results.length} scenarios, ${flagged.length} flagged. Report: ${file}`);
  for (const r of flagged) console.log(`[plans]   ${r.group}: ${r.name}: ${r.flags.join('; ')}`);
  if (flagged.length > 0) process.exitCode = 1;
} catch (err) {
  console.error(`[plans] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
