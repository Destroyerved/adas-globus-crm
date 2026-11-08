import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AddressInfo } from 'node:net';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * M1 over real HTTP: paged lists with search and filters (PRD 6.7, 6.8), scope on every
 * list (own, team, all), editing with versions and history, assignment, notes, tags,
 * logged activities and the timeline (PRD 3.1, 3.2, 4.3-4.7).
 */

const WEB_ORIGIN = 'http://localhost:5174';
type Json = Record<string, unknown>;

let server: ReturnType<typeof createAppServer>['server'];
let db: DatabaseService;
let base: string;

beforeAll(async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'adas-m1-'));
  const secretFile = path.join(dir, 'session_secret.txt');
  writeFileSync(secretFile, 'y'.repeat(64));
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
  const call = async (method: string, url: string, body?: unknown, headers: Json = {}) => {
    const res = await fetch(`${base}/api/v1${url}`, {
      method,
      headers: {
        Cookie: cookie,
        Origin: WEB_ORIGIN,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(headers as Record<string, string>),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}, headers: Json = {}) => call('POST', url, body, headers),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
    put: (url: string, body: unknown) => call('PUT', url, body),
    del: (url: string) => call('DELETE', url),
  };
}

const ids = (page: Json) => (page['items'] as Json[]).map((r) => r['id']);
const enc = (filter: unknown) => encodeURIComponent(JSON.stringify(filter));

describe('paged lists (PRD 6.7, 6.8)', () => {
  it('applies own, team and all scope to every list', async () => {
    const admin = await as('usr_admin_1');
    const manager = await as('usr_mgr_1');
    const bdr = await as('usr_bdr_1');
    const all = await admin.get('/leads');
    const team = await manager.get('/leads');
    const own = await bdr.get('/leads');
    expect(all.body['total']).toBe(4);
    expect(new Set(ids(team.body))).toEqual(new Set(['lead_jane', 'lead_elena']));
    expect(new Set(ids(own.body))).toEqual(new Set(['lead_marcus', 'lead_sophie']));
    for (const entity of ['contacts', 'companies', 'deals', 'tasks']) {
      const a = await admin.get(`/${entity}?view=all`);
      const o = await bdr.get(`/${entity}?view=all`);
      expect(a.status, entity).toBe(200);
      expect(Number(a.body['total']), entity).toBeGreaterThanOrEqual(Number(o.body['total']));
      for (const row of o.body['items'] as Json[]) {
        expect(row[entity === 'tasks' ? 'assignee_user_id' : 'owner_user_id'], entity).toBe(
          'usr_bdr_1',
        );
      }
    }
  });

  it('pages with a cursor, in order, without repeats', async () => {
    const admin = await as('usr_admin_1');
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const page = await admin.get(`/leads?limit=1&sort=name${qs}`);
      expect(page.status).toBe(200);
      seen.push(...(page.body['items'] as Json[]).map((r) => String(r['full_name'])));
      cursor = page.body['nextCursor'] as string | null;
    } while (cursor);
    expect(seen).toEqual(['Elena Rostova', 'Jane Patel', 'Marcus Vance', 'Sophie Tremblay']);
  });

  it('searches and filters on the server', async () => {
    const admin = await as('usr_admin_1');
    expect(ids((await admin.get('/leads?q=ridgeway')).body)).toEqual(['lead_elena']);
    expect(ids((await admin.get('/contacts?q=northstarcpa')).body)).toEqual(['cnt_marcus']);
    const ca = await admin.get(`/leads?filter=${enc({ field: 'market', op: 'eq', value: 'CA' })}`);
    expect(ca.body['total']).toBe(2);
    const mine = await (
      await as('usr_mgr_1')
    ).get(`/leads?filter=${enc({ field: 'ownerId', op: 'eq', value: '@me' })}`);
    expect(ids(mine.body)).toEqual(['lead_jane']);
    const nested = await admin.get(
      `/companies?filter=${enc({
        and: [
          { field: 'market', op: 'eq', value: 'US' },
          {
            or: [
              { field: 'software', op: 'hasAny', value: ['Drake Tax'] },
              { field: 'staffBand', op: 'eq', value: '51–100' },
            ],
          },
        ],
      })}`,
    );
    expect(new Set(ids(nested.body))).toEqual(new Set(['cmp_clearwater', 'cmp_ridgeway']));
  });

  it('rejects unknown filter fields, operators and sorts', async () => {
    const admin = await as('usr_admin_1');
    const field = await admin.get(
      `/leads?filter=${enc({ field: 'password_hash', op: 'eq', value: 'x' })}`,
    );
    expect(field.status).toBe(400);
    expect(field.body['code']).toBe('INVALID_FILTER');
    const op = await admin.get(
      `/leads?filter=${enc({ field: 'market', op: 'contains', value: 'U' })}`,
    );
    expect(op.status).toBe(400);
    const injection = await admin.get(`/leads?sort=${encodeURIComponent('name;DROP TABLE leads')}`);
    expect(injection.status).toBe(422);
    expect((await admin.get('/leads')).body['total']).toBe(4);
  });

  it('shows task views in the assignee time zone and rejects unknown views', async () => {
    const admin = await as('usr_admin_1');
    const open = await admin.get('/tasks?view=open');
    expect(open.body['total']).toBe(3);
    expect((await admin.get('/tasks?view=done')).body['total']).toBe(0);
    expect((await admin.get('/tasks?view=bogus')).status).toBe(422);
  });

  it('returns the Kanban board with counts and totals per stage', async () => {
    const manager = await as('usr_mgr_1');
    const board = await manager.get('/pipelines/pipeline_new_business/board');
    expect(board.status).toBe(200);
    const stages = board.body['stages'] as Json[];
    expect(stages.map((s) => s['name'])).toContain('Free Trial (3-Day)');
    const trial = stages.find((s) => s['name'] === 'Free Trial (3-Day)') as Json;
    expect(trial['count']).toBe(1);
    expect((trial['deals'] as Json[])[0]?.['id']).toBe('deal_acme_tax');
  });
});

describe('editing records (PRD 3.2, 4.3-4.7)', () => {
  it('needs a listed reason to disqualify, bumps the version and keeps history', async () => {
    const manager = await as('usr_mgr_1');
    const noReason = await manager.patch('/leads/lead_elena', {
      version: 1,
      status: 'Disqualified',
    });
    expect(noReason.status).toBe(422);
    expect(noReason.body['fieldErrors']).toHaveProperty('disqualificationReason');
    const ok = await manager.patch('/leads/lead_elena', {
      version: 1,
      status: 'Disqualified',
      disqualificationReason: 'Bad data',
    });
    expect(ok.status).toBe(200);
    expect(ok.body['version']).toBe(2);
    expect(ok.body['status_category']).toBe('closed');
    const stale = await manager.patch('/leads/lead_elena', { version: 1, title: 'Partner' });
    expect(stale.status).toBe(409);
    const history = await db.query(
      `SELECT field_name FROM record_history WHERE entity_type = 'lead' AND entity_id = 'lead_elena'`,
    );
    expect(history.rows.map((r) => r['field_name'])).toEqual(
      expect.arrayContaining(['status', 'disqualification_reason']),
    );
    const converted = await manager.patch('/leads/lead_elena', { version: 2, status: 'Converted' });
    expect(converted.status).toBe(422);
  });

  it('assigns within the team, notifies the new owner, and refuses outside it', async () => {
    const manager = await as('usr_mgr_1');
    const ae = await as('usr_ae_1');
    const outside = await manager.patch('/leads/lead_jane', {
      version: 1,
      ownerUserId: 'usr_bdr_1',
    });
    expect(outside.status).toBe(403);
    expect(outside.body['code']).toBe('ASSIGNEE_OUTSIDE_TEAM');
    const ok = await manager.patch('/leads/lead_jane', { version: 1, ownerUserId: 'usr_ae_1' });
    expect(ok.status).toBe(200);
    const inbox = await ae.get('/notifications');
    expect(inbox.body['unreadCount']).toBe(1);
    const note = (inbox.body['items'] as Json[])[0] as Json;
    expect(note['entity_id']).toBe('lead_jane');
    expect((await ae.post('/notifications/read', {})).body['updated']).toBe(1);
    // A rep without leads.assign can't hand leads to someone else.
    const bdr = await as('usr_bdr_1');
    const denied = await bdr.patch('/leads/lead_sophie', { version: 1, ownerUserId: 'usr_mgr_1' });
    expect(denied.status).toBe(403);
  });

  it('refuses a contact email that belongs to another contact, naming the other contact', async () => {
    const admin = await as('usr_admin_1');
    const res = await admin.patch('/contacts/cnt_david', {
      version: 1,
      primaryEmail: 'elena@ridgewaycpa.example.com',
    });
    expect(res.status).toBe(409);
    expect(String(res.body['detail'])).toContain('Elena Rostova');
  });

  it('rejects free-mail company domains and suppresses the domain on do not contact', async () => {
    const admin = await as('usr_admin_1');
    const freeMail = await admin.patch('/companies/cmp_laurentian', {
      version: 1,
      websiteOrDomain: 'gmail.com',
    });
    expect(freeMail.status).toBe(422);
    const dnc = await admin.patch('/companies/cmp_laurentian', {
      version: 1,
      accountStatus: 'do_not_contact',
    });
    expect(dnc.status).toBe(200);
    const sup = await db.query(
      `SELECT domain FROM suppressed_domains WHERE domain = 'laurentian-cpa.example.ca'`,
    );
    expect(sup.rows).toHaveLength(1);
  });

  it('overrides probability, computes contract value and closes Lost deals with a listed reason', async () => {
    const ae = await as('usr_ae_1');
    const edit = await ae.patch('/deals/deal_ridgeway_audit', {
      version: 1,
      probability: 65,
      termMonths: 24,
      oneTimeValueMinor: '100000',
    });
    expect(edit.status).toBe(200);
    expect(edit.body['probability']).toBe(65);
    const list = await ae.get(
      `/deals?filter=${enc({ field: 'stage', op: 'eq', value: 'Proposal Sent' })}`,
    );
    const row = (list.body['items'] as Json[]).find(
      (d) => d['id'] === 'deal_ridgeway_audit',
    ) as Json;
    expect(String(row['contract_value_minor'])).toBe(String(560000 * 24 + 100000));
    const badReason = await ae.patch('/deals/deal_ridgeway_audit/stage', {
      stageName: 'Lost',
      version: 2,
      lostReason: 'They hated us',
    });
    expect(badReason.status).toBe(422);
    const lost = await ae.post('/deals/deal_ridgeway_audit/move', {
      stageName: 'Lost',
      version: 2,
      lostReason: 'Price',
    });
    expect(lost.status).toBe(200);
    expect(lost.body['closed_at']).not.toBeNull();
    const reopened = await ae.post('/deals/deal_ridgeway_audit/move', {
      stageName: 'Proposal Sent',
      version: 3,
    });
    expect(reopened.body['closed_at']).toBeNull();
  });
});

describe('timeline, notes, tags and logged activities (PRD 3.1, 3.2, 4.7)', () => {
  it('logging a call moves a New lead to Contacted and shows on the timeline', async () => {
    const bdr = await as('usr_bdr_1');
    const call = await bdr.post('/activities', {
      activityType: 'call',
      entityType: 'lead',
      entityId: 'lead_sophie',
      detail: 'Left a voicemail about the 3-day trial.',
      outcome: 'Voicemail',
    });
    expect(call.status).toBe(201);
    const lead = await bdr.get('/leads/lead_sophie');
    expect((lead.body['lead'] as Json)['status']).toBe('Contacted');
    expect((lead.body['lead'] as Json)['last_contacted_at']).not.toBeNull();
    const tl = await bdr.get('/timeline?entityType=lead&entityId=lead_sophie');
    const kinds = (tl.body['items'] as Json[]).map((i) => i['kind']);
    expect(kinds).toEqual(expect.arrayContaining(['call', 'status_change']));
    // The contact and company timelines show the same call without duplicating it.
    const contactTl = await bdr.get('/timeline?entityType=contact&entityId=cnt_sophie');
    expect((contactTl.body['items'] as Json[]).filter((i) => i['kind'] === 'call')).toHaveLength(1);

    // Paging one item at a time returns every item exactly once, including the call and
    // the status change that share a timestamp.
    const all = (tl.body['items'] as Json[]).map((i) => i['id']);
    const paged: unknown[] = [];
    let before: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page = await bdr.get(
        `/timeline?entityType=lead&entityId=lead_sophie&limit=1${before ? `&before=${encodeURIComponent(before)}` : ''}`,
      );
      paged.push(...(page.body['items'] as Json[]).map((item) => item['id']));
      before = page.body['nextBefore'] as string | null;
      if (!before) break;
    }
    expect(paged).toEqual(all);
  });

  it('keeps note edit history and blocks read-only users from writing', async () => {
    const manager = await as('usr_mgr_1');
    const created = await manager.post('/notes', {
      entityType: 'company',
      entityId: 'cmp_acme',
      body: 'Prefers calls after 2 pm Central.',
    });
    expect(created.status).toBe(201);
    const edited = await manager.patch(`/notes/${String(created.body['id'])}`, {
      version: 1,
      body: 'Prefers calls after 3 pm Central.',
    });
    expect(edited.body['version']).toBe(2);
    const tl = await manager.get('/timeline?entityType=company&entityId=cmp_acme');
    expect(
      (tl.body['items'] as Json[]).some((i) => i['detail'] === 'Prefers calls after 3 pm Central.'),
    ).toBe(true);
    const analyst = await as('usr_ro_1');
    expect(
      (await analyst.post('/notes', { entityType: 'company', entityId: 'cmp_acme', body: 'x' }))
        .status,
    ).toBe(403);
    const otherUser = await as('usr_ae_1');
    // Another rep can't even see the note's company (own scope) -> 404.
    expect(
      (await otherUser.patch(`/notes/${String(created.body['id'])}`, { version: 2, body: 'y' }))
        .status,
    ).toBe(404);
  });

  it('sets tags and filters lists by tag', async () => {
    const admin = await as('usr_admin_1');
    const set = await admin.put('/tags/company/cmp_acme', {
      tags: ['Tax-Season-2027', 'priority'],
    });
    expect(set.body['tags']).toEqual(['priority', 'tax-season-2027']);
    const list = await admin.get(
      `/companies?filter=${enc({ field: 'tags', op: 'hasAny', value: ['tax-season-2027'] })}`,
    );
    expect(ids(list.body)).toEqual(['cmp_acme']);
    const bad = await admin.put('/tags/company/cmp_acme', { tags: ['<script>'] });
    expect(bad.status).toBe(422);
  });
});

describe('delete, idempotency and errors', () => {
  it('soft-deletes only with records.delete and writes an audit entry', async () => {
    const ae = await as('usr_ae_1');
    expect((await ae.del('/contacts/cnt_david')).status).toBe(403);
    const admin = await as('usr_admin_1');
    expect((await admin.del('/contacts/cnt_david')).status).toBe(200);
    expect((await admin.get('/contacts/cnt_david')).status).toBe(404);
    const audit = await db.query(
      `SELECT action FROM audit_logs WHERE entity_id = 'cnt_david' AND action = 'record.deleted'`,
    );
    expect(audit.rows).toHaveLength(1);
  });

  it('replays a create with the same Idempotency-Key instead of duplicating it', async () => {
    const manager = await as('usr_mgr_1');
    const body = {
      title: 'Send proposal draft',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const first = await manager.post('/tasks', body, { 'Idempotency-Key': 'task-key-1' });
    const second = await manager.post('/tasks', body, { 'Idempotency-Key': 'task-key-1' });
    expect(first.status).toBe(201);
    expect(second.body['id']).toBe(first.body['id']);
    const count = await db.query(
      `SELECT COUNT(*)::int AS n FROM tasks WHERE title = 'Send proposal draft'`,
    );
    expect(count.rows[0]?.['n']).toBe(1);
  });

  it('completing a task logs an activity with the outcome', async () => {
    const manager = await as('usr_mgr_1');
    const done = await manager.post('/tasks/tsk_trial_d1/complete', {
      outcome: 'Candidate started well.',
    });
    expect(done.body['status']).toBe('completed');
    const tl = await manager.get('/timeline?entityType=deal&entityId=deal_acme_tax');
    const entry = (tl.body['items'] as Json[]).find((i) => i['kind'] === 'task_completed') as Json;
    expect(entry['detail']).toBe('Candidate started well.');
  });
});
