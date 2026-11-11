import { formatNumber, type SessionUser } from '@adas/shared';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { CrmListService, CrmService, CrmTimelineService } from '../modules/crm/index.js';
import { DashboardService } from '../modules/dashboard/index.js';
import { DataQualityService } from '../modules/data-quality/index.js';
import { DuplicateService } from '../modules/duplicates/index.js';
import { type DatabaseService } from '../platform/db/index.js';

/**
 * Query plans for the screens' real queries (AGENTS.md section 8; PRD 12.2).
 *
 * Every scenario calls the same service method the API route calls, as a signed-in person
 * with all, team or own scope. Each SELECT it runs is first explained with
 * EXPLAIN (ANALYZE), so the plan is for exactly the SQL and parameters the app uses. A
 * scenario is flagged when a query that returns one page (it has a LIMIT) reads a large
 * table from end to end, or when its database time alone is more than half of the screen's
 * whole budget. Counts and totals are judged on time only: an exact row count has to read
 * every row the person can see.
 *
 * Run it on the large seed (`pnpm db:seed --size=large`, then `pnpm db:plans`). The times are
 * database time only; PRD 12.2's budgets are for the whole API call on the production server.
 */

/** Tables that hold tens of thousands of rows or more at the design size. */
const LARGE_TABLES = new Set([
  'companies',
  'contacts',
  'contact_emails',
  'leads',
  'deals',
  'tasks',
  'activities',
  'entity_tags',
  'notes',
]);

/**
 * A full scan that reads at least this many rows counts as a finding. Below it, reading the
 * whole table takes a few milliseconds and is often the plan PostgreSQL rightly prefers.
 */
const SCAN_ROWS = 20_000;

export interface QueryPlan {
  /** The statement's first line or two, for the report. It holds no values (they are bound). */
  sql: string;
  ms: number;
  scans: { table: string; rows: number }[];
  /** Returns one page (has a LIMIT), so it should never need a whole large table. */
  paged: boolean;
}

export interface ScenarioResult {
  group: string;
  name: string;
  budgetMs: number;
  queries: QueryPlan[];
  ms: number;
  flags: string[];
}

interface PlanNode {
  'Node Type'?: string;
  'Relation Name'?: string;
  'Actual Rows'?: number;
  'Actual Loops'?: number;
  'Rows Removed by Filter'?: number;
  Plans?: PlanNode[];
}

function readPlan(sql: string, raw: unknown): QueryPlan {
  const parsed = (typeof raw === 'string' ? JSON.parse(raw) : raw) as
    { Plan?: PlanNode; 'Execution Time'?: number; 'Planning Time'?: number }[] | undefined;
  const top = parsed?.[0];
  const scans = new Map<string, number>();
  const walk = (node: PlanNode | undefined): void => {
    if (!node) return;
    const type = node['Node Type'] ?? '';
    const table = node['Relation Name'];
    if ((type === 'Seq Scan' || type === 'Parallel Seq Scan') && table) {
      const loops = node['Actual Loops'] ?? 1;
      const rows = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * loops;
      scans.set(table, (scans.get(table) ?? 0) + rows);
    }
    (node.Plans ?? []).forEach(walk);
  };
  walk(top?.Plan);
  return {
    sql: sql.replace(/\s+/g, ' ').trim().slice(0, 160),
    ms: (top?.['Execution Time'] ?? 0) + (top?.['Planning Time'] ?? 0),
    scans: [...scans].map(([table, rows]) => ({ table, rows })),
    paged: /\bLIMIT\b/i.test(sql),
  };
}

/** The same database, but every SELECT is explained first and its plan kept in `sink`. */
function recordingDb(db: DatabaseService, sink: QueryPlan[]): DatabaseService {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'query') {
        return async (sql: string, params: unknown[] = []) => {
          if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
            const explained = await target.query<Record<string, unknown>>(
              `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`,
              params,
            );
            sink.push(readPlan(sql, Object.values(explained.rows[0] ?? {})[0]));
          }
          return target.query(sql, params);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

interface Services {
  lists: CrmListService;
  crm: CrmService;
  timeline: CrmTimelineService;
  search: DataQualityService;
  dashboard: DashboardService;
  duplicates: DuplicateService;
}

interface People {
  admin: SessionUser;
  manager: SessionUser;
  rep: SessionUser;
}

interface Scenario {
  group: string;
  name: string;
  budgetMs: number;
  /**
   * A search for text that thousands of records contain. Reading the table is then the right
   * plan, so the scenario is judged on time only.
   */
  broad?: boolean;
  run: (s: Services, people: People) => Promise<unknown>;
}

/** PRD 12.2 budgets (p95, whole API call). */
const BUDGET = { list: 400, search: 300, profile: 500, board: 1_500, widget: 800 };

const page = (
  sort: string,
  extra: { q?: string; filter?: unknown; cursor?: string | null } = {},
) => ({
  limit: 50,
  cursor: extra.cursor ?? null,
  sort,
  q: extra.q ?? '',
  filter: extra.filter ?? null,
});

const SCOPES: [keyof People, string][] = [
  ['admin', 'all scope'],
  ['manager', 'team scope'],
  ['rep', 'own scope'],
];

/**
 * Search text taken from the data itself, so the scenarios search for people and firms that
 * exist. Without the large seed they fall back to names from the small one.
 */
interface SearchTerms {
  contactName: string;
  firstName: string;
  leadName: string;
  firmWord: string;
}

async function searchTerms(db: DatabaseService): Promise<SearchTerms> {
  const one = async (sql: string, fallback: string): Promise<string> =>
    (await db.query<{ v: string | null }>(sql)).rows[0]?.v ?? fallback;
  return {
    contactName: await one(
      `SELECT full_name AS v FROM contacts WHERE id = 'cnt_l_3'`,
      'Jane Patel',
    ),
    firstName: await one(`SELECT first_name AS v FROM contacts WHERE id = 'cnt_l_3'`, 'Jane'),
    leadName: await one(`SELECT full_name AS v FROM leads WHERE id = 'lead_l_2'`, 'Elena Rostova'),
    firmWord: await one(
      `SELECT split_part(name, ' ', 1) AS v FROM deals WHERE id = 'deal_l_1'`,
      'Tax',
    ),
  };
}

function listScenarios(terms: SearchTerms): Scenario[] {
  const out: Scenario[] = [];
  const entities = [
    { entity: 'leads', q: terms.leadName, what: 'a full name' },
    { entity: 'contacts', q: terms.contactName, what: 'a full name' },
    { entity: 'companies', q: 'acme', what: '"acme"' },
    { entity: 'deals', q: terms.firmWord, what: 'a firm name' },
  ] as const;
  for (const { entity, q, what } of entities) {
    for (const [who, label] of SCOPES) {
      out.push({
        group: 'Lists',
        name: `${entity}: first page, newest first (${label})`,
        budgetMs: BUDGET.list,
        run: (s, p) => s.lists.list(entity, p[who], page('-updatedAt')),
      });
    }
    out.push(
      {
        group: 'Lists',
        name: `${entity}: sorted by name (all scope)`,
        budgetMs: BUDGET.list,
        run: (s, p) => s.lists.list(entity, p.admin, page('name')),
      },
      {
        group: 'Lists',
        name: `${entity}: a later page by cursor (all scope)`,
        budgetMs: BUDGET.list,
        run: async (s, p) => {
          const first = await s.lists.list(entity, p.admin, { ...page('-updatedAt'), limit: 200 });
          return s.lists.list(entity, p.admin, page('-updatedAt', { cursor: first.nextCursor }));
        },
      },
      {
        group: 'Lists',
        name: `${entity}: search for ${what} (all scope)`,
        budgetMs: BUDGET.list,
        run: (s, p) => s.lists.list(entity, p.admin, page('-updatedAt', { q })),
      },
      {
        group: 'Lists',
        name: `${entity}: search for ${what} (team scope)`,
        budgetMs: BUDGET.list,
        run: (s, p) => s.lists.list(entity, p.manager, page('-updatedAt', { q })),
      },
      {
        group: 'Lists',
        name: `${entity}: Canada only (all scope)`,
        budgetMs: BUDGET.list,
        run: (s, p) =>
          s.lists.list(
            entity,
            p.admin,
            page('-updatedAt', { filter: { field: 'market', op: 'eq', value: 'CA' } }),
          ),
      },
      {
        group: 'Lists',
        name: `${entity}: mine only (team scope)`,
        budgetMs: BUDGET.list,
        run: (s, p) =>
          s.lists.list(
            entity,
            p.manager,
            page('-updatedAt', { filter: { field: 'ownerId', op: 'eq', value: '@me' } }),
          ),
      },
    );
  }
  out.push(
    {
      group: 'Lists',
      name: 'contacts: search for a first name, a broad search: about 1 in 40 matches (all scope)',
      budgetMs: BUDGET.list,
      broad: true,
      run: (s, p) => s.lists.list('contacts', p.admin, page('-updatedAt', { q: terms.firstName })),
    },
    {
      group: 'Lists',
      name: 'companies: search "cpa", a broad search: about half the firms match (all scope)',
      budgetMs: BUDGET.list,
      broad: true,
      run: (s, p) => s.lists.list('companies', p.admin, page('-updatedAt', { q: 'cpa' })),
    },
    {
      group: 'Lists',
      name: 'contacts: search by company name "acme" (all scope)',
      budgetMs: BUDGET.list,
      run: (s, p) => s.lists.list('contacts', p.admin, page('-updatedAt', { q: 'acme' })),
    },
    {
      group: 'Lists',
      name: 'contacts: not contacted for 90 days, oldest first (all scope)',
      budgetMs: BUDGET.list,
      run: (s, p) =>
        s.lists.list(
          'contacts',
          p.admin,
          page('lastContactedAt', {
            filter: { field: 'lastContactedAt', op: 'before', value: { relative: '-90d' } },
          }),
        ),
    },
    {
      group: 'Lists',
      name: 'contacts: with a tag (all scope)',
      budgetMs: BUDGET.list,
      run: (s, p) =>
        s.lists.list(
          'contacts',
          p.admin,
          page('-updatedAt', { filter: { field: 'tags', op: 'hasAny', value: ['referral'] } }),
        ),
    },
    {
      group: 'Lists',
      name: 'companies: clients using QuickBooks (all scope)',
      budgetMs: BUDGET.list,
      run: (s, p) =>
        s.lists.list(
          'companies',
          p.admin,
          page('name', {
            filter: {
              and: [
                { field: 'accountStatus', op: 'eq', value: 'client' },
                { field: 'software', op: 'hasAny', value: ['QuickBooks'] },
              ],
            },
          }),
        ),
    },
    {
      group: 'Lists',
      name: 'deals: won, closed in the last 90 days (team scope)',
      budgetMs: BUDGET.list,
      run: (s, p) =>
        s.lists.list(
          'deals',
          p.manager,
          page('-updatedAt', {
            filter: {
              and: [
                { field: 'stageCategory', op: 'eq', value: 'won' },
                { field: 'closedAt', op: 'after', value: { relative: '-90d' } },
              ],
            },
          }),
        ),
    },
  );
  for (const view of ['today', 'overdue', 'upcoming', 'done']) {
    for (const [who, label] of SCOPES.slice(0, 2)) {
      out.push({
        group: 'Lists',
        name: `tasks: ${view} (${label})`,
        budgetMs: BUDGET.list,
        run: (s, p) =>
          s.lists.list('tasks', p[who], page(view === 'done' ? '-completedAt' : 'dueAt'), {
            taskView: view,
          }),
      });
    }
  }
  out.push({
    group: 'Lists',
    name: 'tasks: search for a contact’s name, open tasks (all scope)',
    budgetMs: BUDGET.list,
    run: (s, p) =>
      s.lists.list('tasks', p.admin, page('dueAt', { q: terms.contactName }), { taskView: 'open' }),
  });
  out.push({
    group: 'Lists',
    name: 'export: first 1,000 contacts with the count (all scope)',
    budgetMs: BUDGET.list,
    run: (s, p) =>
      s.lists.exportPage(
        'contact',
        p.admin,
        { q: '' },
        { cursor: null, limit: 1_000, withTotal: true },
        'UTC',
      ),
  });
  return out;
}

function otherScenarios(terms: SearchTerms): Scenario[] {
  const out: Scenario[] = [];
  for (const [who, label] of SCOPES) {
    out.push(
      {
        group: 'Search',
        name: `global search "acme" (${label})`,
        budgetMs: BUDGET.search,
        run: (s, p) => s.search.globalSearch(p[who], 'acme'),
      },
      {
        group: 'Search',
        name: `global search for a full name (${label})`,
        budgetMs: BUDGET.search,
        run: (s, p) => s.search.globalSearch(p[who], terms.contactName),
      },
    );
  }
  out.push({
    group: 'Search',
    name: 'global search for a first name, a broad search: about 1 contact in 40 matches (all scope)',
    budgetMs: BUDGET.search,
    broad: true,
    run: (s, p) => s.search.globalSearch(p.admin, terms.firstName),
  });
  out.push(
    {
      group: 'Profiles',
      name: 'contact profile',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.timeline.contactProfile(p.admin, 'cnt_l_3'),
    },
    {
      group: 'Profiles',
      name: 'company profile',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.crm.getCompanyProfile(p.admin, 'cmp_l_3'),
    },
    {
      group: 'Profiles',
      name: 'lead profile',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.timeline.leadProfile(p.admin, 'lead_l_2'),
    },
    {
      group: 'Profiles',
      name: 'deal profile',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.timeline.dealProfile(p.admin, 'deal_l_1'),
    },
    {
      group: 'Profiles',
      name: 'contact timeline, first page',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.timeline.timeline(p.admin, 'contact', 'cnt_l_3'),
    },
    {
      group: 'Profiles',
      name: 'company timeline, first page',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.timeline.timeline(p.admin, 'company', 'cmp_l_3'),
    },
    {
      group: 'Profiles',
      name: 'lead timeline, first page',
      budgetMs: BUDGET.profile,
      run: (s, p) => s.timeline.timeline(p.admin, 'lead', 'lead_l_2'),
    },
  );
  for (const [who, label] of SCOPES) {
    out.push({
      group: 'Deals board',
      name: `board, default pipeline (${label})`,
      budgetMs: BUDGET.board,
      run: (s, p) => s.lists.board(p[who], 'pipeline_new_business'),
    });
  }
  out.push(
    {
      group: 'Deals board',
      name: 'board with a search (all scope)',
      budgetMs: BUDGET.board,
      run: (s, p) => s.lists.board(p.admin, 'pipeline_new_business', { q: terms.firmWord }),
    },
    {
      group: 'Duplicates',
      name: 'contact queue, first page (all scope)',
      budgetMs: BUDGET.list,
      run: (s, p) => s.duplicates.list(p.admin, new URLSearchParams({ entity: 'contact' })),
    },
    {
      group: 'Duplicates',
      name: 'company queue, first page (team scope)',
      budgetMs: BUDGET.list,
      run: (s, p) => s.duplicates.list(p.manager, new URLSearchParams({ entity: 'company' })),
    },
  );
  return out;
}

/** One scenario per dashboard widget each person's role shows. */
async function dashboardScenarios(
  dashboard: DashboardService,
  people: People,
): Promise<Scenario[]> {
  const out: Scenario[] = [];
  for (const [who, label] of SCOPES) {
    const layout = await dashboard.layout(people[who]);
    for (const widget of layout.widgets) {
      out.push({
        group: 'Dashboard',
        name: `${widget} (${label})`,
        budgetMs: BUDGET.widget,
        run: (s, p) => s.dashboard.widget(p[who], widget, new URLSearchParams()),
      });
    }
  }
  return out;
}

/**
 * Runs every scenario once and returns its plans. `rep` should be someone with own scope on
 * records (an account executive); `manager` someone with team scope.
 */
export async function collectQueryPlans(
  db: DatabaseService,
  options: {
    userIds?: { admin: string; manager: string; rep: string };
    /**
     * Planner settings to apply first, for a single-connection test database that doesn't
     * read infra/postgres/postgresql.conf. A real server already has its own.
     */
    plannerSettings?: Record<string, string>;
    /**
     * False on the in-memory test database, which is several times slower than a server:
     * its times show which queries stand out, but can't be held against the budgets.
     */
    judgeTime?: boolean;
    /** Unmeasured runs of each scenario first (default 1). */
    warmups?: number;
    /** Measured runs of each scenario; the middle one is reported (default 3). */
    runs?: number;
  } = {},
): Promise<ScenarioResult[]> {
  const userIds = options.userIds ?? {
    admin: 'usr_admin_1',
    manager: 'usr_mgr_1',
    rep: 'usr_ae_1',
  };
  for (const [name, value] of Object.entries(options.plannerSettings ?? {})) {
    if (!/^[a-z_]+$/.test(name) || !/^[A-Za-z0-9.]+$/.test(value)) {
      throw new Error(`Bad planner setting: ${name}`);
    }
    await db.exec(`SET ${name} = '${value}';`);
  }
  const auth = new AuthAndUsersService(db);
  const people: People = {
    admin: await auth.resolveSessionUser(userIds.admin),
    manager: await auth.resolveSessionUser(userIds.manager),
    rep: await auth.resolveSessionUser(userIds.rep),
  };
  const terms = await searchTerms(db);
  const scenarios = [
    ...listScenarios(terms),
    ...otherScenarios(terms),
    ...(await dashboardScenarios(new DashboardService(db), people)),
  ];

  const results: ScenarioResult[] = [];
  const runOnce = async (scenario: Scenario): Promise<{ queries: QueryPlan[]; ms: number }> => {
    const queries: QueryPlan[] = [];
    const recorded = recordingDb(db, queries);
    const services: Services = {
      lists: new CrmListService(recorded),
      crm: new CrmService(recorded),
      timeline: new CrmTimelineService(recorded),
      search: new DataQualityService(recorded),
      dashboard: new DashboardService(recorded),
      duplicates: new DuplicateService(recorded),
    };
    await scenario.run(services, people);
    return { queries, ms: queries.reduce((sum, q) => sum + q.ms, 0) };
  };
  // A first use of a table on a new database connection loads its catalogue and can take
  // 100 ms by itself. A running API's connections are warm, so each scenario is warmed up
  // and then measured several times; the middle run is kept.
  const warmups = options.warmups ?? 1;
  const runs = Math.max(1, options.runs ?? 3);

  for (const scenario of scenarios) {
    for (let i = 0; i < warmups; i += 1) await runOnce(scenario);
    const measured: { queries: QueryPlan[]; ms: number }[] = [];
    for (let i = 0; i < runs; i += 1) measured.push(await runOnce(scenario));
    measured.sort((a, b) => a.ms - b.ms);
    const middle = measured[Math.floor(measured.length / 2)] ?? { queries: [], ms: 0 };
    const { queries, ms } = middle;
    const flags: string[] = [];
    for (const q of queries.filter((x) => x.paged && !scenario.broad)) {
      for (const scan of q.scans) {
        if (LARGE_TABLES.has(scan.table) && scan.rows >= SCAN_ROWS) {
          flags.push(`reads all of ${scan.table} (${formatNumber(scan.rows)} rows)`);
        }
      }
    }
    if (options.judgeTime !== false && ms > scenario.budgetMs / 2) {
      flags.push(`database time is over half of the ${formatNumber(scenario.budgetMs)} ms budget`);
    }
    results.push({
      group: scenario.group,
      name: scenario.name,
      budgetMs: scenario.budgetMs,
      queries,
      ms,
      flags: [...new Set(flags)],
    });
  }
  return results;
}

/** The report as Markdown: a table per group, then the flagged scenarios with their SQL. */
export function renderQueryPlanReport(
  results: ScenarioResult[],
  context: {
    engine: string;
    rows: Record<string, number>;
    date: string;
    settings?: string;
    judgeTime?: boolean;
  },
): string {
  const lines: string[] = [
    `# Query plans, ${context.date}`,
    '',
    `- **Database:** ${context.engine}`,
    `- **Rows:** ${Object.entries(context.rows)
      .map(([table, n]) => `${formatNumber(n)} ${table}`)
      .join(', ')}`,
    '- **What the times are:** database time for each screen’s queries (planning plus execution, from `EXPLAIN (ANALYZE)`). Each scenario runs once to warm up and then three times, and the middle run is shown. The budgets are PRD 12.2’s p95 for the whole API call on the production server, so they are a yardstick here, not a pass mark.',
    `- **Flagged:** a query that returns one page but reads ${formatNumber(SCAN_ROWS)} rows or more of a table from end to end${context.judgeTime === false ? '' : ', or database time over half the budget'}. Row counts, totals and broad searches are judged on time only, because they have to read every row the person can see.`,
    ...(context.judgeTime === false
      ? [
          '- **Times are not judged here:** this database is several times slower than a server. They show which queries stand out; the budgets are checked on real PostgreSQL with `pnpm db:plans`.',
        ]
      : []),
    ...(context.settings ? [`- **Planner settings:** ${context.settings}`] : []),
    '',
  ];
  const flagged = results.filter((r) => r.flags.length > 0);
  lines.push(
    flagged.length === 0
      ? `**Result:** ${results.length} scenarios, none flagged.`
      : `**Result:** ${results.length} scenarios, ${flagged.length} flagged.`,
    '',
  );
  for (const group of [...new Set(results.map((r) => r.group))]) {
    lines.push(
      `## ${group}`,
      '',
      '| Scenario | Queries | Database time | Budget | Flag |',
      '|---|---|---|---|---|',
    );
    for (const r of results.filter((x) => x.group === group)) {
      lines.push(
        `| ${r.name} | ${r.queries.length} | ${r.ms.toFixed(1)} ms | ${formatNumber(r.budgetMs)} ms | ${r.flags.join('; ') || 'none'} |`,
      );
    }
    lines.push('');
  }
  if (flagged.length > 0) {
    lines.push('## Flagged queries', '');
    for (const r of flagged) {
      lines.push(`### ${r.group}: ${r.name}`, '');
      for (const q of r.queries.filter((x) => x.ms > 20 || (x.paged && x.scans.length > 0))) {
        const scans = q.scans
          .filter((s) => LARGE_TABLES.has(s.table))
          .map((s) => `${s.table} ${formatNumber(s.rows)} rows`)
          .join(', ');
        lines.push(`- ${q.ms.toFixed(1)} ms${scans ? `, full scan: ${scans}` : ''}: \`${q.sql}\``);
      }
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
