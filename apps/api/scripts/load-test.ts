/**
 * Cross-platform 20-VU Concurrent HTTP Load Runner (`PRD 12.2`).
 *
 * Boots a real `createAppServer()` HTTP server over PostgreSQL (`DATABASE_URL`), signs in
 * 20 concurrent virtual users across Admin, Sales Manager, Account Executive, and BDR roles,
 * executes realistic concurrent HTTP traffic against the large seed (20,000 companies,
 * 60,000 contacts, 300,000 activities), verifies every `PRD 12.2` p95 latency budget and
 * the `< 0.5%` error budget, and writes `docs/perf/load-test-postgres.md`.
 *
 * Usage:
 *   pnpm db:seed --size=large
 *   pnpm perf:load                   (defaults to 20 VUs for 30s; pass --duration=900 for 15m)
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { type AddressInfo } from 'node:net';
import { cpus } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { formatNumber } from '@adas/shared';
import { createAppServer } from '../src/main.js';
import { loadDotEnv, validateEnv } from '../src/platform/config/index.js';
import { SecretBox } from '../src/platform/crypto/index.js';
import { DatabaseService } from '../src/platform/db/index.js';

interface BucketStats {
  label: string;
  budgetP95Ms: number;
  samplesMs: number[];
  errors: number;
}

function parseArgInt(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  const parsed = Number.parseInt(hit.slice(prefix.length), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

loadDotEnv();
const baseEnv = validateEnv();
if (baseEnv.NODE_ENV === 'production') {
  console.error('[load-test] Refusing to run load test with NODE_ENV=production.');
  process.exit(1);
}

const vus = parseArgInt('vus', 20);
const durationSec = parseArgInt('duration', 30);

const env = validateEnv({
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: 'error',
  PUBLIC_WEB_URL: 'http://localhost:5174',
  // 20 automated VUs share 5 synthetic user IDs at ~400+ req/s; raise per-user cap so we measure DB/API saturation rather than synthetic user-ID sharing.
  API_RATE_LIMIT_PER_MIN: '10000',
});

const db = DatabaseService.connect(env.DATABASE_URL);

try {
  await db.ensureInitialized();
  // Apply PRD 10.3 SSD random_page_cost on the benchmark pool session
  await db.query(`SET random_page_cost = 1.1`);

  const counts: Record<string, number> = {};
  for (const table of ['companies', 'contacts', 'leads', 'deals', 'tasks', 'activities']) {
    const res = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
    counts[table] = res.rows[0]?.n ?? 0;
  }

  if ((counts['contacts'] ?? 0) < 50_000) {
    console.warn(
      `[load-test] Warning: only ${counts['contacts'] ?? 0} contacts loaded. Run 'pnpm db:seed --size=large' first for PRD 12.2 scale.`,
    );
  }

  const versionRes = await db.query<{ v: string }>(`SELECT version() AS v`);
  const pgEngine = String(versionRes.rows[0]?.v ?? 'PostgreSQL').split(' on ')[0] ?? 'PostgreSQL';

  // Fetch real visible record IDs so profile requests hit live rows
  const [cmpSample, cntSample, leadSample, dealSample] = await Promise.all([
    db.query<{ id: string }>(
      `SELECT id FROM companies WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 40`,
    ),
    db.query<{ id: string }>(
      `SELECT id FROM contacts WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 40`,
    ),
    db.query<{ id: string }>(
      `SELECT id FROM leads WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 40`,
    ),
    db.query<{ id: string }>(
      `SELECT id FROM deals WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 40`,
    ),
  ]);

  const companyIds = cmpSample.rows.map((r) => r.id);
  const contactIds = cntSample.rows.map((r) => r.id);
  const leadIds = leadSample.rows.map((r) => r.id);
  const dealIds = dealSample.rows.map((r) => r.id);

  const app = createAppServer(env, db, { secretBox: SecretBox.ephemeral() });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = (app.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Authenticate 20 distinct server sessions across roles and discover each role's allowed dashboard widgets
    const rolePool = ['usr_admin_1', 'usr_mgr_1', 'usr_ae_1', 'usr_bdr_1', 'usr_bdr_2'];
    const vuSessions: Array<{ cookie: string; widgets: string[] }> = [];
    for (let i = 0; i < vus; i += 1) {
      const userId = rolePool[i % rolePool.length] ?? 'usr_admin_1';
      const loginRes = await fetch(`${baseUrl}/api/v1/auth/dev-login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://localhost:5174',
          Host: 'crm.adasglobuspro.com',
        },
        body: JSON.stringify({ userId }),
      });
      if (loginRes.status !== 200) {
        throw new Error(`Dev login failed for ${userId}: HTTP ${loginRes.status}`);
      }
      const cookie =
        (loginRes.headers.getSetCookie?.()[0] ?? loginRes.headers.get('set-cookie') ?? '').split(
          ';',
        )[0] ?? '';

      const dashRes = await fetch(`${baseUrl}/api/v1/dashboard`, {
        headers: { Cookie: cookie, Host: 'crm.adasglobuspro.com' },
      });
      const dashBody = (await dashRes.json()) as { widgets?: Array<{ id: string }> };
      const widgets = (dashBody.widgets ?? []).map((w) => w.id);
      vuSessions.push({
        cookie,
        widgets: widgets.length > 0 ? widgets : ['pipeline_by_stage'],
      });
    }

    const buckets: Record<string, BucketStats> = {
      list_page: {
        label: 'List page API (filtered, sorted, 50 rows)',
        budgetP95Ms: 400,
        samplesMs: [],
        errors: 0,
      },
      global_search: {
        label: 'Global search (trigram + full-text + extended)',
        budgetP95Ms: 300,
        samplesMs: [],
        errors: 0,
      },
      record_profile: {
        label: 'Record profile API (company / contact / lead / deal)',
        budgetP95Ms: 500,
        samplesMs: [],
        errors: 0,
      },
      deals_kanban: {
        label: 'Kanban board API (open deals + totals)',
        budgetP95Ms: 1500,
        samplesMs: [],
        errors: 0,
      },
      dashboard_widget: {
        label: 'Dashboard widget API',
        budgetP95Ms: 800,
        samplesMs: [],
        errors: 0,
      },
    };

    const usFilter = encodeURIComponent(JSON.stringify({ field: 'market', op: 'eq', value: 'US' }));
    const listUrls = [
      '/api/v1/contacts?limit=50&sort=-updatedAt',
      `/api/v1/companies?limit=50&sort=name&filter=${usFilter}`,
      '/api/v1/leads?limit=50&sort=-score',
      '/api/v1/deals?limit=50&sort=-updatedAt',
      '/api/v1/tasks?limit=50&sort=dueAt',
    ];
    const searchUrls = [
      '/api/v1/search?q=acme&extended=1',
      '/api/v1/search?q=ridgeway&extended=1',
      '/api/v1/search?q=tax%20advisory&extended=1',
      '/api/v1/search?q=northstar&extended=1',
      '/api/v1/search?q=patel',
    ];

    const hit = async (
      cookie: string,
      bucketKey: keyof typeof buckets | null,
      urlPath: string,
      allow404 = false,
    ) => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${baseUrl}${urlPath}`, {
          headers: {
            Cookie: cookie,
            Host: 'crm.adasglobuspro.com',
            Accept: 'application/json',
          },
        });
        await res.arrayBuffer();
        const elapsed = performance.now() - t0;
        if (bucketKey) {
          const b = buckets[bucketKey];
          if (b) {
            b.samplesMs.push(elapsed);
            if (res.status !== 200 && !(allow404 && res.status === 404)) {
              b.errors += 1;
            }
          }
        }
      } catch {
        if (bucketKey) {
          const b = buckets[bucketKey];
          if (b) b.errors += 1;
        }
      }
    };

    // 2-second warm-up (connection pool + JIT/plan cache)
    console.log(`[load-test] Warming up ${vus} virtual users against ${baseUrl}...`);
    const warmUntil = Date.now() + 2_000;
    await Promise.all(
      vuSessions.map(async ({ cookie }, vuIdx) => {
        let step = 0;
        while (Date.now() < warmUntil) {
          await hit(cookie, null, listUrls[(vuIdx + step) % listUrls.length] ?? '/healthz');
          await hit(cookie, null, searchUrls[(vuIdx + step) % searchUrls.length] ?? '/healthz');
          step += 1;
        }
      }),
    );

    console.log(
      `[load-test] Running ${vus} concurrent virtual users for ${durationSec}s on ${formatNumber(counts['contacts'] ?? 0)} contacts...`,
    );
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    const runUntil = Date.now() + durationSec * 1000;
    let peakRssBytes = process.memoryUsage().rss;

    const memSampler = setInterval(() => {
      const rss = process.memoryUsage().rss;
      if (rss > peakRssBytes) peakRssBytes = rss;
    }, 500);
    memSampler.unref();

    await Promise.all(
      vuSessions.map(async ({ cookie, widgets }, vuIdx) => {
        let iter = 0;
        while (Date.now() < runUntil) {
          const idx = vuIdx + iter;
          await hit(cookie, 'list_page', listUrls[idx % listUrls.length] ?? listUrls[0] ?? '/');
          await hit(
            cookie,
            'global_search',
            searchUrls[idx % searchUrls.length] ?? searchUrls[0] ?? '/',
          );

          const profileType = idx % 4;
          const profilePath =
            profileType === 0 && companyIds.length > 0
              ? `/api/v1/companies/${companyIds[idx % companyIds.length]}`
              : profileType === 1 && contactIds.length > 0
                ? `/api/v1/contacts/${contactIds[idx % contactIds.length]}`
                : profileType === 2 && leadIds.length > 0
                  ? `/api/v1/leads/${leadIds[idx % leadIds.length]}`
                  : `/api/v1/deals/${dealIds[idx % Math.max(1, dealIds.length)] ?? 'deal_1'}`;
          await hit(cookie, 'record_profile', profilePath, true);

          if (iter % 2 === 0) {
            await hit(cookie, 'deals_kanban', '/api/v1/pipelines/pipeline_new_business/board');
          }

          const widgetId = widgets[idx % widgets.length] ?? 'pipeline_by_stage';
          await hit(
            cookie,
            'dashboard_widget',
            `/api/v1/dashboard/widgets/${widgetId}?from=2026-10-01&to=2026-11-30`,
          );

          iter += 1;
          await new Promise((r) => setTimeout(r, 80));
        }
      }),
    );

    clearInterval(memSampler);
    const wallElapsedMs = performance.now() - wallStart;
    const cpuDelta = process.cpuUsage(cpuStart);
    const logicalCores = Math.max(1, cpus().length);
    const apiCpuPct =
      ((cpuDelta.user + cpuDelta.system) / 1000 / (wallElapsedMs * logicalCores)) * 100;

    let totalRequests = 0;
    let totalErrors = 0;
    const breaches: string[] = [];

    const tableRows: string[] = [];
    for (const b of Object.values(buckets)) {
      const sorted = [...b.samplesMs].sort((a, c) => a - c);
      const count = sorted.length;
      totalRequests += count;
      totalErrors += b.errors;
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      const p99 = percentile(sorted, 99);
      const max = sorted[sorted.length - 1] ?? 0;
      const pass = p95 <= b.budgetP95Ms;
      if (!pass) {
        breaches.push(`${b.label} p95 ${p95.toFixed(1)} ms exceeded ${b.budgetP95Ms} ms budget`);
      }
      tableRows.push(
        `| ${b.label} | ${formatNumber(count)} | ${b.errors} | ${p50.toFixed(1)} ms | **${p95.toFixed(1)} ms** | ${p99.toFixed(1)} ms | ${max.toFixed(1)} ms | ${formatNumber(b.budgetP95Ms)} ms | ${pass ? 'PASS' : 'FAIL'} |`,
      );
    }

    const overallErrorPct = totalRequests > 0 ? (totalErrors / totalRequests) * 100 : 0;
    if (overallErrorPct >= 0.5) {
      breaches.push(`Overall error rate ${overallErrorPct.toFixed(3)}% >= 0.5% budget`);
    }
    const rps = totalRequests / (wallElapsedMs / 1000);

    const reportDate = new Date().toISOString().slice(0, 10);
    const reportLines = [
      `# Concurrent HTTP Load Test Report (${reportDate})`,
      '',
      `- **Database engine:** ${pgEngine}`,
      `- **Dataset scale:** ${Object.entries(counts)
        .map(([t, n]) => `${formatNumber(n)} ${t}`)
        .join(', ')}`,
      `- **Concurrency:** ${vus} concurrent virtual users (Admin, Sales Manager, Account Executive, BDR sessions)`,
      `- **Measured window:** ${(wallElapsedMs / 1000).toFixed(1)} s (+ 2.0 s warm-up)`,
      `- **Total HTTP requests:** ${formatNumber(totalRequests)} (${rps.toFixed(1)} req/s)`,
      `- **Error rate:** ${overallErrorPct.toFixed(3)}% (${totalErrors} errors; budget < 0.500%)`,
      `- **API Node process CPU (normalized across ${logicalCores} logical threads):** ${apiCpuPct.toFixed(1)}% (budget < 80%)`,
      `- **Peak API RSS memory:** ${(peakRssBytes / (1024 * 1024)).toFixed(1)} MB (container limit 1,024 MB)`,
      '',
      breaches.length === 0
        ? '**Result:** PASS — All PRD 12.2 p95 latency and error-rate budgets met under 20-VU concurrent load.'
        : `**Result:** FAIL — ${breaches.join('; ')}`,
      '',
      '## Latency Distribution vs PRD 12.2 Budgets',
      '',
      '| Operation | Requests | Errors | p50 | p95 | p99 | Max | PRD 12.2 p95 Budget | Status |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---|',
      ...tableRows,
      '',
      '## Reproducing',
      '',
      '```bash',
      'pnpm db:seed --size=large',
      'pnpm perf:load',
      '# Or with k6 CLI for a 15-minute soak:',
      'k6 run -e BASE_URL=http://127.0.0.1:3000 -e API_TOKEN=<token> infra/k6/crm-load.js',
      '```',
      '',
    ];

    const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/perf');
    mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'load-test-postgres.md');
    writeFileSync(outFile, reportLines.join('\n'), 'utf8');

    console.log(
      `[load-test] Completed ${formatNumber(totalRequests)} requests (${rps.toFixed(1)} req/s), errors=${overallErrorPct.toFixed(3)}%. Report: ${outFile}`,
    );
    for (const row of tableRows) console.log(`  ${row}`);

    if (breaches.length > 0) {
      for (const b of breaches) console.error(`[load-test] BREACH: ${b}`);
      process.exitCode = 1;
    }
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
  }
} finally {
  await db.close();
}
