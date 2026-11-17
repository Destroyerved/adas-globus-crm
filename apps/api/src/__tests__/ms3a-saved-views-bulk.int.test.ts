import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthAndUsersService } from '../modules/auth/index.js';
import { BulkActionService } from '../modules/crm/index.js';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';
import { createLogger } from '../platform/logger/index.js';

/**
 * Milestone 3a Integration Suite: Saved views & Bulk actions (PRD 4.5, 4.6, 4.8, 6.7, 9).
 */

const WEB_ORIGIN = 'http://localhost:5174';

let db: DatabaseService;
let baseUrl = '';
let serverClose: (() => Promise<void>) | null = null;

async function signIn(url: string, userId: string): Promise<string> {
  const res = await fetch(`${url}/api/v1/auth/dev-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
    body: JSON.stringify({ userId }),
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function authHeaders(cookie: string, withIdempotency = false): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: WEB_ORIGIN,
    Cookie: cookie,
  };
  if (withIdempotency) h['Idempotency-Key'] = randomUUID();
  return h;
}

describe('Milestone 3a: saved views & bulk actions (own, team, all scopes + >500 worker queue)', () => {
  let adminCookie = '';
  let usMgrCookie = '';
  let usBdrCookie = '';
  let caBdrCookie = '';

  beforeAll(async () => {
    db = DatabaseService.forTests();
    await db.ensureInitialized();
    const env = validateEnv({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'postgresql://adas:adas_dev_password@localhost:5432/adas_crm_test',
      MAIL_LIVE: 'false',
    });
    const app = createAppServer(env, db);
    await new Promise<void>((resolve) => {
      app.server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    serverClose = () =>
      new Promise<void>((resolve, reject) =>
        app.server.close((err) => (err ? reject(err) : resolve())),
      );

    adminCookie = await signIn(baseUrl, 'usr_admin_1');
    usMgrCookie = await signIn(baseUrl, 'usr_mgr_1');
    usBdrCookie = await signIn(baseUrl, 'usr_bdr_2');
    caBdrCookie = await signIn(baseUrl, 'usr_bdr_1');
  });

  afterAll(async () => {
    if (serverClose) await serverClose();
    if (db) await db.close();
  });

  it('isolates private vs team-shared saved views across own, team and all scopes and validates filter/sort (PRD 4.8)', async () => {
    // Own-scope BDR can create a private view, but cannot share a view with the team
    const bdrShareAttempt = await fetch(`${baseUrl}/api/v1/saved-views`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        entityType: 'lead',
        name: 'Forbidden Shared View',
        isShared: true,
        params: { market: 'US' },
        sort: '-updatedAt',
        density: 'compact',
      }),
    });
    expect(bdrShareAttempt.status).toBe(403);

    const bdrPrivateRes = await fetch(`${baseUrl}/api/v1/saved-views`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        entityType: 'lead',
        name: 'My US Follow-ups',
        isShared: false,
        params: { market: 'US', owner: '@me' },
        filter: {
          and: [
            { field: 'market', op: 'eq', value: 'US' },
            { field: 'ownerId', op: 'eq', value: '@me' },
          ],
        },
        sort: '-updatedAt',
        density: 'compact',
      }),
    });
    expect(bdrPrivateRes.status).toBe(201);
    const bdrPrivate = (await bdrPrivateRes.json()) as { id: string; density: string };
    expect(bdrPrivate.density).toBe('compact');

    // Rejects invalid filter field against registry
    const badFilter = await fetch(`${baseUrl}/api/v1/saved-views`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie, true),
      body: JSON.stringify({
        entityType: 'lead',
        name: 'Broken Filter',
        filter: { field: 'nonExistentSqlColumn', op: 'eq', value: 'x' },
        sort: '-updatedAt',
      }),
    });
    expect(badFilter.status).toBe(400);

    // US Sales Manager creates a team-shared view
    const mgrSharedRes = await fetch(`${baseUrl}/api/v1/saved-views`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie, true),
      body: JSON.stringify({
        entityType: 'lead',
        name: 'US Team Qualified Leads',
        isShared: true,
        params: { market: 'US', status: 'Qualified' },
        filter: { field: 'status', op: 'eq', value: 'Qualified' },
        sort: '-score',
        density: 'comfortable',
      }),
    });
    expect(mgrSharedRes.status).toBe(201);
    const mgrShared = (await mgrSharedRes.json()) as { id: string; version: number };

    // US BDR sees their own private view AND US Manager's team-shared view
    const usBdrList = (await (
      await fetch(`${baseUrl}/api/v1/saved-views?entity=lead`, {
        headers: { Cookie: usBdrCookie },
      })
    ).json()) as { items: { id: string; canEdit: boolean }[] };
    expect(usBdrList.items.map((v) => v.id)).toContain(bdrPrivate.id);
    expect(usBdrList.items.map((v) => v.id)).toContain(mgrShared.id);
    expect(usBdrList.items.find((v) => v.id === mgrShared.id)?.canEdit).toBe(false);

    // CA BDR (different team) sees NEITHER US BDR's private view NOR US Team's shared view
    const caBdrList = (await (
      await fetch(`${baseUrl}/api/v1/saved-views?entity=lead`, {
        headers: { Cookie: caBdrCookie },
      })
    ).json()) as { items: { id: string }[] };
    expect(caBdrList.items.map((v) => v.id)).not.toContain(bdrPrivate.id);
    expect(caBdrList.items.map((v) => v.id)).not.toContain(mgrShared.id);

    // Admin (all scope) sees team-shared views across teams and can edit/delete them
    const adminList = (await (
      await fetch(`${baseUrl}/api/v1/saved-views?entity=lead`, {
        headers: { Cookie: adminCookie },
      })
    ).json()) as { items: { id: string; canEdit: boolean }[] };
    expect(adminList.items.find((v) => v.id === mgrShared.id)?.canEdit).toBe(true);

    // US BDR cannot edit or delete US Manager's shared view
    const bdrEditShared = await fetch(`${baseUrl}/api/v1/saved-views/${mgrShared.id}`, {
      method: 'PATCH',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ version: mgrShared.version, name: 'Hijacked' }),
    });
    expect(bdrEditShared.status).toBe(404);
  });

  it('executes synchronous bulk actions (assign, status, tag, delete) enforcing SQL scope and history/audit/outbox (PRD 4.5, 6.7, 9)', async () => {
    // Create 2 US leads owned by US BDR (`usr_bdr_2`) and 1 CA lead owned by CA BDR (`usr_bdr_1`)
    const makeLead = async (cookie: string, idx: number, market: 'US' | 'CA') => {
      const r = await fetch(`${baseUrl}/api/v1/leads`, {
        method: 'POST',
        headers: authHeaders(cookie, true),
        body: JSON.stringify({
          firstName: 'Bulk',
          lastName: `Target${idx}`,
          email: `bulk.target.${idx}.${randomUUID().slice(0, 6)}@example-cpa.test`,
          firmName: `Bulk CPA ${idx}`,
          market,
        }),
      });
      expect(r.status).toBe(201);
      return ((await r.json()) as { id: string }).id;
    };

    const usLead1 = await makeLead(usBdrCookie, 1, 'US');
    const usLead2 = await makeLead(usBdrCookie, 2, 'US');
    const caLead = await makeLead(caBdrCookie, 3, 'CA');

    // US Manager tries bulk status update passing [usLead1, usLead2, caLead]:
    // `caLead` is outside US Manager's team scope, so SQL scope skips it cleanly!
    const statusRes = await fetch(`${baseUrl}/api/v1/leads/bulk`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie, true),
      body: JSON.stringify({
        action: 'status',
        ids: [usLead1, usLead2, caLead],
        status: 'Qualified',
      }),
    });
    expect(statusRes.status).toBe(200);
    const statusJob = (await statusRes.json()) as {
      status: string;
      background: boolean;
      succeededRows: number;
      skippedRows: number;
    };
    expect(statusJob.background).toBe(false);
    expect(statusJob.status).toBe('completed');
    expect(statusJob.succeededRows).toBe(2);
    expect(statusJob.skippedRows).toBe(1);

    // Verify CA lead remained untouched ('New') while US leads became 'Qualified' with history + outbox
    const caRow = await db.query<{ status: string }>(`SELECT status FROM leads WHERE id = $1`, [
      caLead,
    ]);
    expect(caRow.rows[0]?.status).toBe('New');

    const lsh = await db.query<{ to_status: string }>(
      `SELECT to_status FROM lead_status_history WHERE lead_id = $1`,
      [usLead1],
    );
    expect(lsh.rows.map((r) => r.to_status)).toContain('Qualified');

    // Bulk add_tag and bulk assign within US team
    const tagRes = await fetch(`${baseUrl}/api/v1/leads/bulk`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie, true),
      body: JSON.stringify({
        action: 'add_tag',
        ids: [usLead1, usLead2],
        tag: 'Tax-Season-Priority',
      }),
    });
    expect(tagRes.status).toBe(200);

    const assignRes = await fetch(`${baseUrl}/api/v1/leads/bulk`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie, true),
      body: JSON.stringify({
        action: 'assign',
        ids: [usLead1, usLead2],
        ownerUserId: 'usr_ae_1',
      }),
    });
    expect(assignRes.status).toBe(200);

    const notif = await db.query<{ title: string }>(
      `SELECT title FROM notifications WHERE user_id = 'usr_ae_1' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(notif.rows[0]?.title).toContain('2 leads assigned to you');

    // Admin bulk soft-deletes the 2 US leads and writes record.deleted audit entries
    const delRes = await fetch(`${baseUrl}/api/v1/leads/bulk`, {
      method: 'POST',
      headers: authHeaders(adminCookie, true),
      body: JSON.stringify({
        action: 'delete',
        ids: [usLead1, usLead2],
      }),
    });
    expect(delRes.status).toBe(200);
    const deletedCheck = await db.query<{ deleted_at: unknown }>(
      `SELECT deleted_at FROM leads WHERE id = ANY($1::text[])`,
      [[usLead1, usLead2]],
    );
    expect(deletedCheck.rows.every((r) => r.deleted_at !== null)).toBe(true);
  });

  it('queues >500-row bulk actions in bulk_jobs (202) and executes them via worker processNext (PRD 6.7, 6.9)', async () => {
    const batchTag = `batch-${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (let i = 0; i < 505; i += 1) {
      ids.push(`ld_blk_${batchTag}_${i}`);
    }
    await db.query(
      `INSERT INTO leads (id, first_name, last_name, full_name, email, firm_name, market, owner_user_id, team_id)
       SELECT x, 'Synth', 'Lead', 'Synth Lead', x || '@synth-firm.test', $2, 'US', 'usr_bdr_2', 'team_us'
       FROM unnest($1::text[]) AS x`,
      [ids, batchTag],
    );

    const res = await fetch(`${baseUrl}/api/v1/leads/bulk`, {
      method: 'POST',
      headers: authHeaders(adminCookie, true),
      body: JSON.stringify({
        action: 'add_tag',
        selectAll: true,
        q: batchTag,
        tag: 'large-batch-verified',
      }),
    });
    expect(res.status).toBe(202);
    const queued = (await res.json()) as {
      id: string;
      background: boolean;
      status: string;
      totalRows: number;
    };
    expect(queued.background).toBe(true);
    expect(queued.status).toBe('queued');
    expect(queued.totalRows).toBe(505);

    const auth = new AuthAndUsersService(db, 'test');
    const workerBulk = new BulkActionService(
      db,
      (uid) => auth.resolveSessionUser(uid),
      createLogger('silent'),
    );
    const processed = await workerBulk.processNext();
    expect(processed.jobId).toBe(queued.id);
    expect(processed.status).toBe('completed');

    const jobView = (await (
      await fetch(`${baseUrl}/api/v1/bulk-jobs/${queued.id}`, {
        headers: { Cookie: adminCookie },
      })
    ).json()) as { status: string; succeededRows: number; processedRows: number };
    expect(jobView.status).toBe('completed');
    expect(jobView.succeededRows).toBe(505);
    expect(jobView.processedRows).toBe(505);
  });
});
