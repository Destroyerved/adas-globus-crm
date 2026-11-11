import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  collectQueryPlans,
  renderQueryPlanReport,
  type ScenarioResult,
} from '../perf/query-plans.js';
import { DatabaseService } from '../platform/db/index.js';
import { LARGE_SEED_SIZE, seedLarge, type LargeSeedSize } from '../platform/db/seed-large.js';

/**
 * The query-plan tool (AGENTS.md section 8; PRD 12.2).
 *
 * Every run checks, on a small data set, that each scenario still runs through the real
 * services and that its plans are read. Small tables are always scanned whole, so plans are
 * only judged at full size:
 *
 *   pnpm db:plans:test
 *
 * loads the full large seed into the test database, writes the report to docs/perf/ and
 * fails if a page query reads a large table whole. Times are judged only on real PostgreSQL:
 * use `pnpm db:plans` there.
 */

const LARGE = process.env['QUERY_PLANS'] === 'large';
/** TEST_DATABASE_URL points the tests at real PostgreSQL; only there are times judged. */
const REAL_SERVER = Boolean(process.env['TEST_DATABASE_URL']);
const SMALL: LargeSeedSize = {
  companies: 300,
  contacts: 900,
  activities: 4_500,
  leads: 180,
  deals: 100,
  tasks: 120,
};

/** From infra/postgres/postgresql.conf (PRD 10.3). */
const PRODUCTION_PLANNER = {
  random_page_cost: '1.1',
  effective_cache_size: '8GB',
  work_mem: '16MB',
};

let db: DatabaseService;
let rows: Record<string, number>;
let results: ScenarioResult[];

beforeAll(
  async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    rows = await seedLarge(
      { exec: (sql) => db.exec(sql), query: <T>(sql: string) => db.query<T>(sql) },
      LARGE ? LARGE_SEED_SIZE : SMALL,
    );
    // The test database doesn't read infra/postgres/postgresql.conf, so the planner gets the
    // production settings that change which plan it picks.
    results = await collectQueryPlans(db, {
      plannerSettings: PRODUCTION_PLANNER,
      judgeTime: REAL_SERVER,
    });
  },
  LARGE ? 3_600_000 : 180_000,
);

afterAll(async () => {
  await db.close();
});

describe('query plans (PRD 12.2)', () => {
  it('runs every scenario through the real services and reads its plans', () => {
    expect(results.length).toBeGreaterThan(70);
    expect([...new Set(results.map((r) => r.group))]).toEqual([
      'Lists',
      'Search',
      'Profiles',
      'Deals board',
      'Duplicates',
      'Dashboard',
    ]);
    for (const r of results) {
      expect(r.queries.length, r.name).toBeGreaterThan(0);
      expect(r.ms, r.name).toBeGreaterThan(0);
    }
    // Plans are read: at this size the planner scans the small tables whole.
    expect(results.some((r) => r.queries.some((q) => q.scans.length > 0))).toBe(true);
  });

  it('writes a report with a table per group and no values from any record', () => {
    const report = renderQueryPlanReport(results, {
      engine: 'test database',
      rows,
      date: '2026-11-11',
    });
    expect(report).toContain('# Query plans, 2026-11-11');
    expect(report).toContain('## Lists');
    expect(report).toContain('| contacts: first page, newest first (team scope) |');
    expect(report).toContain('## Dashboard');
    expect(report).not.toMatch(/@[a-z0-9]+\.example\./);
  });

  it.runIf(LARGE)('at full size, no page query reads a large table whole', async () => {
    const version = await db.query<{ v: string }>(`SELECT version() AS v`);
    const engine = process.env['TEST_DATABASE_URL']
      ? String(version.rows[0]?.v).split(' on ')[0]
      : `PGlite, in memory (${String(version.rows[0]?.v).split(' on ')[0]}). Plans are PostgreSQL's own; times are slower than a server's and only show which queries stand out.`;
    const report = renderQueryPlanReport(results, {
      engine: engine ?? 'PostgreSQL',
      rows,
      date: new Date().toISOString().slice(0, 10),
      judgeTime: REAL_SERVER,
      settings: process.env['TEST_DATABASE_URL']
        ? undefined
        : `${Object.entries(PRODUCTION_PLANNER)
            .map(([name, value]) => `\`${name} = ${value}\``)
            .join(', ')}, as in \`infra/postgres/postgresql.conf\``,
    });
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/perf');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(
        dir,
        process.env['TEST_DATABASE_URL'] ? 'query-plans-postgres.md' : 'query-plans-pglite.md',
      ),
      report,
      'utf8',
    );
    const flagged = results.filter((r) => r.flags.length > 0);
    expect(flagged.map((r) => `${r.group}: ${r.name}: ${r.flags.join('; ')}`)).toEqual([]);
  });
});
