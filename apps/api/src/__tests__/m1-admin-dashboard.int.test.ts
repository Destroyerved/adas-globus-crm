import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AddressInfo } from 'node:net';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * M1 administration and the role dashboard over real HTTP (PRD 2.1, 2.2, 3.3, 3.4, 4.2,
 * 4.17, 6.6, 14): capability checks in the API, versioned edits, audit entries, lockout
 * guards, and dashboard metrics scoped own / team / all with FX conversion.
 */

const WEB_ORIGIN = 'http://localhost:5174';
type Json = Record<string, unknown>;

let server: ReturnType<typeof createAppServer>['server'];
let db: DatabaseService;
let base: string;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adas-admin-'));
  const secretFile = path.join(dir, 'session_secret.txt');
  writeFileSync(secretFile, 'z'.repeat(64));
  const env = validateEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    PUBLIC_WEB_URL: WEB_ORIGIN,
    SESSION_SECRET_FILE: secretFile,
    ENTRA_CLIENT_SECRET_FILE: path.join(dir, 'missing.txt'),
  });
  db = DatabaseService.forTests();
  ({ server } = createAppServer(env, db));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await db.close();
});

const cookies = new Map<string, string>();

async function as(userId: string) {
  if (!cookies.has(userId)) {
    const res = await fetch(`${base}/api/v1/auth/dev-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
      body: JSON.stringify({ userId }),
    });
    expect(res.status).toBe(200);
    const raw = res.headers.get('set-cookie') ?? '';
    cookies.set(userId, /adas_session=[^;]+/.exec(raw)?.[0] ?? '');
  }
  const cookie = cookies.get(userId) ?? '';
  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}/api/v1${url}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: WEB_ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}) => call('POST', url, body),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
    put: (url: string, body: unknown) => call('PUT', url, body),
    del: (url: string) => call('DELETE', url),
  };
}

const items = (body: Json) => body['items'] as Json[];
const fieldErrors = (body: Json) => (body['fieldErrors'] ?? {}) as Record<string, string[]>;

async function versionOf(table: string, id: string, key = 'id'): Promise<number> {
  const res = await db.query<{ version: number }>(
    `SELECT version FROM ${table} WHERE ${key} = $1`,
    [id],
  );
  return res.rows[0]?.version ?? 0;
}

/** Today's date where the person works. The dashboard reads periods in the viewer's time zone. */
async function localToday(userId: string): Promise<string> {
  const res = await db.query<{ d: string }>(
    `SELECT (NOW() AT TIME ZONE timezone)::date::text AS d FROM users WHERE id = $1`,
    [userId],
  );
  return String(res.rows[0]?.d);
}

async function widget(userId: string, id: string, query = '') {
  return (await as(userId)).get(`/dashboard/widgets/${id}${query}`);
}

describe('Role dashboard (PRD 4.2, 14)', () => {
  it('shows each role its own widgets', async () => {
    const layouts = await Promise.all(
      ['usr_bdr_1', 'usr_mgr_1', 'usr_mkt_1', 'usr_ro_1', 'usr_admin_1'].map(async (u) =>
        (await as(u)).get('/dashboard'),
      ),
    );
    for (const l of layouts) expect(l.status).toBe(200);
    const [bdr, mgr, mkt, ro, admin] = layouts.map((l) => l.body['widgets'] as string[]);
    expect(bdr).toEqual([
      'followups_today',
      'overdue_tasks',
      'sla_inquiries',
      'leads_by_status',
      'pipeline_by_stage',
    ]);
    expect(mgr).toContain('overdue_by_person');
    expect(mgr).toContain('won_lost');
    expect(mkt).toEqual(['outreach_performance', 'leads_by_source_market']);
    expect(ro).toContain('trial_to_win');
    expect(ro).toContain('activity_summary');
    expect(admin).toContain('sla_breaches');
    const range = layouts[0]?.body['defaultRange'] as Json;
    expect(String(range['from'])).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('reports each period as UTC instants in the viewer time zone, so links match the counts', async () => {
    // The seeded manager works in America/New_York: 1 March starts at 05:00 UTC (EST) and the
    // day after 31 March starts at 04:00 UTC (EDT).
    await db.query(`UPDATE users SET timezone = 'America/New_York' WHERE id = 'usr_mgr_1'`);
    const res = await widget('usr_mgr_1', 'won_lost', '?from=2026-03-01&to=2026-03-31');
    expect(res.status).toBe(200);
    expect(res.body['period']).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      start: '2026-03-01T05:00:00Z',
      end: '2026-04-01T04:00:00Z',
    });
  });

  it('pipeline value converts CAD at the latest rate and respects own, team and all scope', async () => {
    // Open deals: Acme 840000 x 12 USD at 50% (manager), Northstar 620000 x 12 CAD at 25%
    // (Canadian BDR), Ridgeway 560000 x 12 USD at 70% (U.S. AE). CAD to USD is 0.74.
    const admin = await widget('usr_admin_1', 'pipeline_by_stage');
    expect(admin.status).toBe(200);
    const all = admin.body['data'] as Json;
    expect(all['count']).toBe(3);
    expect(all['valueMinor']).toBe(String(10_080_000 + 5_505_600 + 6_720_000));
    expect(all['weightedMinor']).toBe(String(5_040_000 + 1_376_400 + 4_704_000));
    expect(all['unconverted']).toEqual([]);

    const team = (await widget('usr_mgr_1', 'pipeline_by_stage')).body['data'] as Json;
    expect(team['count']).toBe(2);
    expect(team['valueMinor']).toBe(String(10_080_000 + 6_720_000));

    const own = (await widget('usr_bdr_1', 'pipeline_by_stage')).body['data'] as Json;
    expect(own['count']).toBe(1);
    expect(own['valueMinor']).toBe('5505600');

    const usOnly = (
      await widget('usr_admin_1', 'pipeline_by_stage', '?from=2026-01-01&to=2026-12-31&market=US')
    ).body['data'] as Json;
    expect(usOnly['count']).toBe(2);
  });

  it('leads by status and by source follow the viewer scope', async () => {
    const own = (await widget('usr_bdr_1', 'leads_by_status')).body['data'] as Json;
    const all = (await widget('usr_admin_1', 'leads_by_status')).body['data'] as Json;
    expect(Number(own['total'])).toBeGreaterThan(0);
    expect(Number(all['total'])).toBeGreaterThan(Number(own['total']));
    const rows = own['rows'] as Json[];
    expect(rows.every((r) => !['Disqualified', 'Converted'].includes(String(r['status'])))).toBe(
      true,
    );

    const owned = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM leads WHERE owner_user_id = 'usr_bdr_1' AND deleted_at IS NULL AND status_category <> 'closed'`,
    );
    expect(own['total']).toBe(owned.rows[0]?.n);

    const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const year = async (userId: string) => `?from=${yearAgo}&to=${await localToday(userId)}`;
    const bySourceTeam = (
      await widget('usr_mgr_1', 'leads_by_source_market', await year('usr_mgr_1'))
    ).body['data'] as Json;
    expect(Object.keys(bySourceTeam['byMarket'] as Json)).not.toContain('CA');
    const bySourceAll = (await widget('usr_ro_1', 'leads_by_source_market', await year('usr_ro_1')))
      .body['data'] as Json;
    expect(Object.keys(bySourceAll['byMarket'] as Json)).toContain('CA');
  });

  it('follow-ups today count the assignee time zone, and overdue tasks group by person within scope', async () => {
    const before = (await widget('usr_mgr_1', 'followups_today')).body['data'] as Json;
    // Just before midnight today in the manager's own time zone (whatever an earlier test set).
    const later = await db.query<{ at: string }>(
      `SELECT (((NOW() AT TIME ZONE timezone)::date + TIME '23:58')::timestamp AT TIME ZONE timezone)::text AS at
       FROM users WHERE id = 'usr_mgr_1'`,
    );
    const mgr = await as('usr_mgr_1');
    const created = await mgr.post('/tasks', {
      title: 'Call back about the trial',
      dueAt: new Date(String(later.rows[0]?.at)).toISOString(),
    });
    expect(created.status).toBe(201);
    const after = (await widget('usr_mgr_1', 'followups_today')).body['data'] as Json;
    expect(after['count']).toBe(Number(before['count']) + 1);

    // Overdue tasks for a U.S. and a Canadian rep.
    await db.query(
      `INSERT INTO tasks (id, title, task_type, status, due_at, assignee_user_id, team_id, created_by_user_id)
       VALUES ('tsk_over_us', 'Overdue US', 'call', 'open', NOW() - INTERVAL '2 days', 'usr_bdr_2', 'team_us', 'usr_bdr_2'),
              ('tsk_over_ca', 'Overdue CA', 'call', 'open', NOW() - INTERVAL '3 days', 'usr_bdr_1', 'team_ca', 'usr_bdr_1')`,
    );
    const team = (await widget('usr_mgr_1', 'overdue_by_person')).body['data'] as Json;
    const teamIds = (team['rows'] as Json[]).map((r) => r['userId']);
    expect(teamIds).toContain('usr_bdr_2');
    expect(teamIds).not.toContain('usr_bdr_1');
    const all = (await widget('usr_admin_1', 'overdue_by_person')).body['data'] as Json;
    expect((all['rows'] as Json[]).map((r) => r['userId'])).toContain('usr_bdr_1');
    const mine = (await widget('usr_bdr_1', 'overdue_tasks')).body['data'] as Json;
    expect(mine['count']).toBeGreaterThanOrEqual(1);
    expect((mine['items'] as Json[]).every((t) => String(t['title']) !== 'Overdue US')).toBe(true);
  });

  it('the first logged call stops the SLA clock and counts as met', async () => {
    const waiting = (await widget('usr_mgr_1', 'sla_inquiries')).body['data'] as Json;
    expect(Number(waiting['waiting'])).toBeGreaterThanOrEqual(1);

    const mgr = await as('usr_mgr_1');
    const call = await mgr.post('/activities', {
      activityType: 'call',
      entityType: 'lead',
      entityId: 'lead_jane',
      detail: 'Called back about the trial request.',
    });
    expect(call.status).toBe(201);
    const task = await db.query<{ status: string; sla_breached: boolean }>(
      `SELECT status, sla_breached FROM tasks WHERE id = 'tsk_sla_1'`,
    );
    expect(task.rows[0]).toMatchObject({ status: 'completed', sla_breached: false });

    const layout = (await mgr.get('/dashboard')).body['defaultRange'] as Json;
    const sla = (
      await widget(
        'usr_mgr_1',
        'sla_breaches',
        `?from=${String(layout['from'])}&to=${String(layout['to'])}`,
      )
    ).body['data'] as Json;
    expect(Number(sla['received'])).toBeGreaterThanOrEqual(1);
    expect(Number(sla['met'])).toBeGreaterThanOrEqual(1);
    expect(sla['metRate']).not.toBeNull();
    expect(sla['medianFirstResponseMinutes']).not.toBeNull();
  });

  it('won and lost, revenue won and trial-to-win use deals closed in the period', async () => {
    const mgr = await as('usr_mgr_1');
    const won = await mgr.post('/deals/deal_acme_tax/move', {
      stageName: 'Won',
      version: await versionOf('deals', 'deal_acme_tax'),
      contractStartDate: '2026-12-01',
    });
    expect(won.status).toBe(200);
    const range = (await mgr.get('/dashboard')).body['defaultRange'] as Json;
    const q = `?from=${String(range['from'])}&to=${String(range['to'])}`;

    const summary = (await widget('usr_mgr_1', 'won_lost', q)).body['data'] as Json;
    expect(Number(summary['won'])).toBeGreaterThanOrEqual(1);
    expect(BigInt(String(summary['revenueWonMinor']))).toBeGreaterThanOrEqual(10_080_000n);
    expect(summary['winRate']).not.toBeNull();

    // Each viewer's period is in their own time zone, so the analyst gets their own range.
    const roRange = (await (await as('usr_ro_1')).get('/dashboard')).body['defaultRange'] as Json;
    const roQ = `?from=${String(roRange['from'])}&to=${String(roRange['to'])}`;
    const trial = (await widget('usr_ro_1', 'trial_to_win', roQ)).body['data'] as Json;
    expect(Number(trial['leftTrial'])).toBeGreaterThanOrEqual(1);
    expect(Number(trial['won'])).toBeGreaterThanOrEqual(1);

    const empty = (await widget('usr_mgr_1', 'won_lost', '?from=2030-01-01&to=2030-01-31')).body[
      'data'
    ] as Json;
    expect(empty).toMatchObject({ won: 0, lost: 0, winRate: null, revenueWonMinor: '0' });

    const backwards = await widget('usr_mgr_1', 'won_lost', '?from=2026-02-01&to=2026-01-01');
    expect(backwards.status).toBe(422);
  });

  it('activity summary lists the team for a manager and everyone for management', async () => {
    const range = (await (await as('usr_mgr_1')).get('/dashboard')).body['defaultRange'] as Json;
    const q = `?from=${String(range['from'])}&to=${String(range['to'])}`;
    const team = (await widget('usr_mgr_1', 'activity_summary', q)).body['data'] as Json;
    const teamRows = team['rows'] as Json[];
    expect(teamRows.map((r) => r['userId'])).not.toContain('usr_bdr_1');
    const me = teamRows.find((r) => r['userId'] === 'usr_mgr_1') as Json;
    expect(Number(me['calls'])).toBeGreaterThanOrEqual(1);
    expect(Number(me['dealsMoved'])).toBeGreaterThanOrEqual(1);
    const all = (await widget('usr_ro_1', 'activity_summary', q)).body['data'] as Json;
    expect((all['rows'] as Json[]).map((r) => r['userId'])).toContain('usr_bdr_1');
  });

  it('marketing sees outreach performance; widgets refuse callers without the capability', async () => {
    const outreach = await widget('usr_mkt_1', 'outreach_performance');
    expect(outreach.status).toBe(200);
    expect((outreach.body['data'] as Json)['channels']).toHaveLength(2);
    expect((await widget('usr_mgr_1', 'nonsense')).status).toBe(404);
  });
});

describe('Administration (PRD 2.1, 2.2, 3.3, 3.4, 4.17, 6.6)', () => {
  it('only admins manage users, and invites are validated and audited', async () => {
    expect((await (await as('usr_mgr_1')).get('/admin/users')).status).toBe(403);
    const admin = await as('usr_admin_1');
    const list = await admin.get('/admin/users');
    expect(list.status).toBe(200);
    expect(items(list.body).length).toBeGreaterThanOrEqual(7);

    const invite = {
      email: 'New.Hire@AdasGlobusPro.example.com',
      name: 'Neha Kulkarni',
      roleId: 'role_bdr',
      teamId: 'team_us',
      marketFocus: 'US',
      timezone: 'America/New_York',
    };
    const created = await admin.post('/admin/users', invite);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      email: 'new.hire@adasglobuspro.example.com',
      status: 'invited',
      timezone: 'America/New_York',
    });
    const dup = await admin.post('/admin/users', invite);
    expect(dup.status).toBe(409);
    expect(fieldErrors(dup.body)['email']).toBeDefined();
    const badZone = await admin.post('/admin/users', {
      ...invite,
      email: 'other@adasglobuspro.example.com',
      timezone: 'Mars/Olympus',
    });
    expect(badZone.status).toBe(422);
    expect(fieldErrors(badZone.body)['timezone']).toBeDefined();

    const audit = await admin.get('/audit-logs?action=user.invited');
    expect(items(audit.body).some((a) => a['entity_id'] === created.body['id'])).toBe(true);
  });

  it('moving a person to another team moves their records, and deactivating revokes their sessions', async () => {
    const admin = await as('usr_admin_1');
    const bdr2 = await as('usr_bdr_2');
    expect((await bdr2.get('/auth/me')).status).toBe(200);

    const moved = await admin.patch('/admin/users/usr_bdr_2', {
      version: await versionOf('users', 'usr_bdr_2'),
      teamId: 'team_ca',
    });
    expect(moved.status).toBe(200);
    const leads = await db.query<{ team_id: string }>(
      `SELECT DISTINCT team_id FROM leads WHERE owner_user_id = 'usr_bdr_2'`,
    );
    for (const row of leads.rows) expect(row.team_id).toBe('team_ca');
    const tasks = await db.query<{ team_id: string }>(
      `SELECT team_id FROM tasks WHERE id = 'tsk_over_us'`,
    );
    expect(tasks.rows[0]?.team_id).toBe('team_ca');

    const stale = await admin.patch('/admin/users/usr_bdr_2', { version: 1, name: 'Kabir R.' });
    expect(stale.status).toBe(409);

    const off = await admin.patch('/admin/users/usr_bdr_2', {
      version: await versionOf('users', 'usr_bdr_2'),
      status: 'disabled',
    });
    expect(off.status).toBe(200);
    expect(off.body['status']).toBe('disabled');
    expect((await bdr2.get('/auth/me')).status).toBe(401);
    const audit = items((await admin.get('/audit-logs?action=user.deactivated')).body);
    expect((audit[0]?.['metadata'] as Json)['revokedSessions']).toBeGreaterThanOrEqual(1);

    // Admins can't deactivate themselves
    const self = await admin.patch('/admin/users/usr_admin_1', {
      version: await versionOf('users', 'usr_admin_1'),
      status: 'disabled',
    });
    expect(self.status).toBe(422);
  });

  it('role changes take effect on the next request, and the Admin role keeps its safety capabilities', async () => {
    const admin = await as('usr_admin_1');
    const roles = await admin.get('/admin/roles');
    expect(roles.status).toBe(200);
    const analyst = items(roles.body).find((r) => r['id'] === 'role_analyst') as Json;
    expect((analyst['grants'] as Json)['reports.read']).toBe('all');

    const off = await admin.put('/admin/roles/role_analyst/capabilities', {
      grants: { 'reports.read': 'none' },
    });
    expect(off.status).toBe(200);
    expect(off.body['changed']).toEqual(['reports.read']);
    const ro = await as('usr_ro_1');
    expect((await ro.get('/dashboard')).body['widgets']).toEqual(['pipeline_by_stage']);
    expect((await ro.get('/dashboard/widgets/won_lost')).status).toBe(403);

    const back = await admin.put('/admin/roles/role_analyst/capabilities', {
      grants: { 'reports.read': 'all' },
    });
    expect(back.body['changed']).toEqual([]);
    const overrides = await db.query(
      `SELECT 1 FROM role_capabilities WHERE role_id = 'role_analyst'`,
    );
    expect(overrides.rows).toHaveLength(0);

    const lockout = await admin.put('/admin/roles/role_admin/capabilities', {
      grants: { 'users.manage': 'team' },
    });
    expect(lockout.status).toBe(422);

    // A manager given users.manage still can't remove the last active admin.
    await admin.put('/admin/roles/role_sales_mgr/capabilities', {
      grants: { 'users.manage': 'all' },
    });
    const mgr = await as('usr_mgr_1');
    const demote = await mgr.patch('/admin/users/usr_admin_1', {
      version: await versionOf('users', 'usr_admin_1'),
      roleId: 'role_bdr',
    });
    expect(demote.status).toBe(422);
    expect(fieldErrors(demote.body)['roleId']).toBeDefined();
    await admin.put('/admin/roles/role_sales_mgr/capabilities', {
      grants: { 'users.manage': 'none' },
    });
    expect((await mgr.get('/admin/users')).status).toBe(403);
  });

  it('teams are unique by name and versioned', async () => {
    const admin = await as('usr_admin_1');
    const created = await admin.post('/admin/teams', { name: 'Canada Expansion', market: 'CA' });
    expect(created.status).toBe(201);
    expect(
      (await admin.post('/admin/teams', { name: 'canada expansion', market: 'CA' })).status,
    ).toBe(409);
    const id = String(created.body['id']);
    const renamed = await admin.patch(`/admin/teams/${id}`, { version: 1, name: 'Canada Growth' });
    expect(renamed.status).toBe(200);
    expect((await admin.patch(`/admin/teams/${id}`, { version: 1, name: 'Again' })).status).toBe(
      409,
    );
  });

  it('stages can be renamed, reweighted, required, added, reordered and removed safely', async () => {
    const admin = await as('usr_admin_1');
    expect((await (await as('usr_mgr_1')).get('/admin/pipelines')).status).toBe(403);
    const pipelines = items((await admin.get('/admin/pipelines')).body);
    const nb = pipelines.find((p) => p['id'] === 'pipeline_new_business') as Json;
    const stages = nb['stages'] as Json[];
    expect(stages.find((s) => s['id'] === 'stg_trial')?.['is_trial']).toBe(true);

    // Rename and reweight: deals in the stage follow
    const renamed = await admin.patch('/admin/stages/stg_prop', {
      version: await versionOf('pipeline_stages', 'stg_prop'),
      name: 'Proposal out',
      probability: 65,
    });
    expect(renamed.status).toBe(200);
    const ridgeway = await db.query<{ stage_name: string; probability: number }>(
      `SELECT stage_name, probability FROM deals WHERE id = 'deal_ridgeway_audit'`,
    );
    expect(ridgeway.rows[0]).toEqual({ stage_name: 'Proposal out', probability: 65 });

    // Required detail is enforced on the move
    await admin.patch('/admin/stages/stg_neg', {
      version: await versionOf('pipeline_stages', 'stg_neg'),
      requiredFields: ['contract_start_date'],
    });
    const blocked = await admin.post('/deals/deal_ridgeway_audit/move', {
      stageName: 'Negotiation / MSA',
      version: await versionOf('deals', 'deal_ridgeway_audit'),
    });
    expect(blocked.status).toBe(422);
    expect(fieldErrors(blocked.body)['contractStartDate']).toBeDefined();

    // Lost stages always need a reason; won and lost probabilities are fixed
    const noReason = await admin.patch('/admin/stages/stg_lost', {
      version: await versionOf('pipeline_stages', 'stg_lost'),
      requiredFields: [],
    });
    expect(noReason.status).toBe(422);
    const wonAt50 = await admin.patch('/admin/stages/stg_won', {
      version: await versionOf('pipeline_stages', 'stg_won'),
      probability: 50,
    });
    expect(wonAt50.status).toBe(422);

    // The trial stage keeps working after a rename: entering it creates check-ins
    await admin.patch('/admin/stages/stg_trial', {
      version: await versionOf('pipeline_stages', 'stg_trial'),
      name: 'Free trial (3 days)',
    });
    const intoTrial = await admin.post('/deals/deal_northstar_ca/move', {
      stageName: 'Free trial (3 days)',
      version: await versionOf('deals', 'deal_northstar_ca'),
      trialCandidateRole: 'T1 preparer',
    });
    expect(intoTrial.status).toBe(200);
    expect(intoTrial.body['trial_started_at']).not.toBeNull();
    const checkins = await db.query(
      `SELECT 1 FROM tasks WHERE deal_id = 'deal_northstar_ca' AND task_type = 'trial_checkin'`,
    );
    expect(checkins.rows).toHaveLength(3);

    // Add, reorder and remove
    const added = await admin.post('/admin/pipelines/pipeline_new_business/stages', {
      name: 'Security review',
      probability: 80,
    });
    expect(added.status).toBe(201);
    const wonOrder = await db.query<{ stage_order: number }>(
      `SELECT stage_order FROM pipeline_stages WHERE id = 'stg_won'`,
    );
    expect(Number(added.body['stage_order'])).toBeLessThan(wonOrder.rows[0]?.stage_order ?? 0);
    const newId = String(added.body['id']);
    const up = await admin.post(`/admin/stages/${newId}/move`, { version: 1, direction: 'up' });
    expect(up.body['moved']).toBe(true);
    expect((await admin.del('/admin/stages/stg_prop')).status).toBe(409);
    expect((await admin.del('/admin/stages/stg_won')).status).toBe(422);
    expect((await admin.del(`/admin/stages/${newId}`)).status).toBe(200);

    const audit = items((await admin.get('/audit-logs?entityType=pipeline_stage')).body);
    expect(audit.map((a) => a['action'])).toEqual(
      expect.arrayContaining([
        'pipeline.stage_updated',
        'pipeline.stage_added',
        'pipeline.stage_deleted',
      ]),
    );
  });

  it('reference lists and defaults are validated, versioned and used straight away', async () => {
    const admin = await as('usr_admin_1');
    const settings = items((await admin.get('/admin/settings')).body);
    const lost = settings.find((s) => s['key'] === 'reference.lost_reasons') as Json;
    expect(Array.isArray(lost['value'])).toBe(true);
    const version = Number(lost['version']);

    const dup = await admin.put('/admin/settings/reference.lost_reasons', {
      version,
      value: ['Price', 'price'],
    });
    expect(dup.status).toBe(422);
    const next = [...(lost['value'] as string[]), 'Went with an offshore competitor'];
    const saved = await admin.put('/admin/settings/reference.lost_reasons', {
      version,
      value: next,
    });
    expect(saved.status).toBe(200);
    const refs = await admin.get('/reference-lists');
    expect(refs.body['lost_reasons']).toContain('Went with an offshore competitor');
    expect(
      (await admin.put('/admin/settings/reference.lost_reasons', { version, value: next })).status,
    ).toBe(409);

    const sla = await admin.put('/admin/settings/sla.first_response_business_days', {
      version: 1,
      value: 40,
    });
    expect(sla.status).toBe(422);
    expect((await admin.put('/admin/settings/secret.thing', { version: 1, value: 1 })).status).toBe(
      404,
    );
    expect((await (await as('usr_mgr_1')).get('/admin/settings')).status).toBe(403);

    const audit = items((await admin.get('/audit-logs?action=settings.changed')).body);
    expect((audit[0]?.['metadata'] as Json)['after']).toEqual(next);
  });

  it('the audit log pages without gaps and managers see only their team', async () => {
    const admin = await as('usr_admin_1');
    const first = await admin.get('/audit-logs?limit=3');
    expect(items(first.body)).toHaveLength(3);
    const cursor = String(first.body['nextCursor']);
    const second = await admin.get(`/audit-logs?limit=3&cursor=${encodeURIComponent(cursor)}`);
    const ids = [...items(first.body), ...items(second.body)].map((a) => a['id']);
    expect(new Set(ids).size).toBe(ids.length);

    const team = items((await (await as('usr_mgr_1')).get('/audit-logs?limit=200')).body);
    const teamUs = await db.query<{ id: string }>(`SELECT id FROM users WHERE team_id = 'team_us'`);
    const allowedIds = new Set(teamUs.rows.map((r) => r.id));
    expect(team.every((a) => allowedIds.has(String(a['actor_user_id'])))).toBe(true);
    expect((await (await as('usr_bdr_1')).get('/audit-logs')).status).toBe(403);
  });

  it('people set their own time zone', async () => {
    const ae = await as('usr_ae_1');
    expect((await ae.patch('/me/preferences', { timezone: 'America/Toronto' })).status).toBe(200);
    expect((await ae.get('/auth/me')).body['timezone']).toBe('America/Toronto');
    expect((await ae.patch('/me/preferences', { timezone: 'Nowhere/Land' })).status).toBe(422);
  });
});
