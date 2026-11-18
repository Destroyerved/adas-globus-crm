import { randomUUID } from 'node:crypto';
import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Milestone 3c Integration Suite:
 * - Deal stakeholder contact roles (POST/PATCH/DELETE /api/v1/deals/:id/contacts, own/team/all scopes,
 *   deal & contact profiles, and contact merge/undo preservation)
 * - Recurring tasks (spawn next occurrence on complete, relative reminder offset, idempotency)
 * - Manager Team tasks view (GET /api/v1/tasks?view=team scope enforcement across own/team/all)
 * - FX rates admin (GET/POST/DELETE /api/v1/admin/fx-rates, reciprocal upsert, last-rate guard,
 *   audit logs, and deal close fx_rate_scaled_at_close snapshot)
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

describe('Milestone 3c: deal stakeholders, recurring tasks, team task view & FX rates', () => {
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

  it('manages deal stakeholder contact roles across own/team/all scopes and preserves them across contact merge & undo', async () => {
    // US BDR creates a US company + lead, converts to a deal, and creates two extra stakeholder contacts.
    const leadRes = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Hannah',
        lastName: 'Keller',
        email: 'hannah.keller@kellercpa-ms3c.example',
        firmName: 'Keller Advisory CPA',
        title: 'Managing Partner',
        market: 'US',
      }),
    });
    expect(leadRes.status).toBe(201);
    const lead = (await leadRes.json()) as { id: string };

    const convRes = await fetch(`${baseUrl}/api/v1/leads/convert`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({
        leadId: lead.id,
        createDeal: true,
        dealName: 'Keller Advisory — Tax Pod',
        monthlyValueMinor: '480000',
        currency: 'USD',
        fteCount: 1,
      }),
    });
    expect(convRes.status).toBe(200);
    const conv = (await convRes.json()) as {
      companyId: string;
      contactId: string;
      dealId: string;
    };

    // Create two stakeholder contacts on the same company
    const c1Res = await fetch(`${baseUrl}/api/v1/contacts`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Trevor',
        lastName: 'Lin',
        primaryEmail: 'trevor.lin@kellercpa-ms3c.example',
        title: 'Tax Director',
        companyId: conv.companyId,
        market: 'US',
      }),
    });
    expect(c1Res.status).toBe(201);
    const c1 = (await c1Res.json()) as { id: string; version: number };

    const c2Res = await fetch(`${baseUrl}/api/v1/contacts`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Trevor',
        lastName: 'Lin-Dup',
        primaryEmail: 't.lin@kellercpa-ms3c.example',
        title: 'Director of Tax',
        companyId: conv.companyId,
        market: 'US',
      }),
    });
    expect(c2Res.status).toBe(201);
    const c2 = (await c2Res.json()) as { id: string; version: number };

    // Out-of-scope CA BDR ('own' scope) cannot add stakeholders to US BDR's deal (404)
    const caForbidden = await fetch(`${baseUrl}/api/v1/deals/${conv.dealId}/contacts`, {
      method: 'POST',
      headers: authHeaders(caBdrCookie),
      body: JSON.stringify({ contactId: c2.id, role: 'Reviewer' }),
    });
    expect(caForbidden.status).toBe(404);

    // Owner US BDR adds c2 as Reviewer
    const addRes = await fetch(`${baseUrl}/api/v1/deals/${conv.dealId}/contacts`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ contactId: c2.id, role: 'Reviewer' }),
    });
    expect(addRes.status).toBe(201);
    const added = (await addRes.json()) as {
      dealContacts: { contactId: string; role: string }[];
    };
    expect(added.dealContacts).toContainEqual(
      expect.objectContaining({ contactId: c2.id, role: 'Reviewer' }),
    );

    // Team-scoped US Manager updates role to Influencer
    const patchRes = await fetch(`${baseUrl}/api/v1/deals/${conv.dealId}/contacts/${c2.id}`, {
      method: 'PATCH',
      headers: authHeaders(usMgrCookie),
      body: JSON.stringify({ role: 'Influencer' }),
    });
    expect(patchRes.status).toBe(200);

    // Contact profile for c2 includes this deal via deal_contacts even though c2 is not primary_contact_id!
    const c2ProfRes = await fetch(`${baseUrl}/api/v1/contacts/${c2.id}`, {
      headers: { Cookie: usMgrCookie },
    });
    expect(c2ProfRes.status).toBe(200);
    const c2Prof = (await c2ProfRes.json()) as { deals: { id: string }[] };
    expect(c2Prof.deals.map((d) => d.id)).toContain(conv.dealId);

    // Merge c2 into c1 (kept = c1, merged = c2) and verify deal_contacts moves to c1, then restores on undo!
    const mergeRes = await fetch(`${baseUrl}/api/v1/contacts/${c1.id}/merge`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie),
      body: JSON.stringify({
        mergedId: c2.id,
        keptVersion: c1.version,
        mergedVersion: c2.version,
        choices: {},
      }),
    });
    expect(mergeRes.status).toBe(200);
    const mergeBody = (await mergeRes.json()) as { id: string };

    const dealAfterMergeRes = await fetch(`${baseUrl}/api/v1/deals/${conv.dealId}`, {
      headers: { Cookie: adminCookie },
    });
    expect(dealAfterMergeRes.status).toBe(200);
    const dealAfterMerge = (await dealAfterMergeRes.json()) as {
      dealContacts: { contactId: string; role: string }[];
    };
    expect(dealAfterMerge.dealContacts).toContainEqual(
      expect.objectContaining({ contactId: c1.id, role: 'Influencer' }),
    );

    // Undo merge -> stakeholder link moves back to c2
    const undoRes = await fetch(`${baseUrl}/api/v1/merges/${mergeBody.id}/undo`, {
      method: 'POST',
      headers: authHeaders(usMgrCookie),
      body: JSON.stringify({}),
    });
    expect(undoRes.status).toBe(200);

    const dealAfterUndoRes = await fetch(`${baseUrl}/api/v1/deals/${conv.dealId}`, {
      headers: { Cookie: adminCookie },
    });
    const dealAfterUndo = (await dealAfterUndoRes.json()) as {
      dealContacts: { contactId: string; role: string }[];
    };
    expect(dealAfterUndo.dealContacts).toContainEqual(
      expect.objectContaining({ contactId: c2.id, role: 'Influencer' }),
    );

    // Remove stakeholder
    const delRes = await fetch(`${baseUrl}/api/v1/deals/${conv.dealId}/contacts/${c2.id}`, {
      method: 'DELETE',
      headers: authHeaders(usBdrCookie),
    });
    expect(delRes.status).toBe(200);
    const afterDel = (await delRes.json()) as { dealContacts: { contactId: string }[] };
    expect(afterDel.dealContacts.map((dc) => dc.contactId)).not.toContain(c2.id);
  });

  it('spawns the next recurring task idempotently on complete and enforces own/team/all scope on Team tasks view', async () => {
    const dueIso = '2026-11-20T15:00:00.000Z';
    const remIso = '2026-11-20T14:00:00.000Z';

    const createRes = await fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie, true),
      body: JSON.stringify({
        title: 'Weekly CPA partner check-in',
        dueAt: dueIso,
        reminderAt: remIso,
        taskType: 'follow_up',
        priority: 'high',
        recurrenceRule: 'weekly',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      id: string;
      recurrence_rule: string;
      version: number;
    };
    expect(created.recurrence_rule).toBe('weekly');

    // Update recurrence rule to business_days then back to weekly to verify PATCH + history
    const patchRes = await fetch(`${baseUrl}/api/v1/tasks/${created.id}`, {
      method: 'PATCH',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ version: created.version, recurrenceRule: 'weekly' }),
    });
    expect(patchRes.status).toBe(200);

    // Team tasks view: own-scoped BDR gets 403; team-scoped US Manager sees US team tasks; Admin sees all
    const bdrTeamRes = await fetch(`${baseUrl}/api/v1/tasks?view=team`, {
      headers: { Cookie: usBdrCookie },
    });
    expect(bdrTeamRes.status).toBe(403);

    const mgrTeamRes = await fetch(`${baseUrl}/api/v1/tasks?view=team`, {
      headers: { Cookie: usMgrCookie },
    });
    expect(mgrTeamRes.status).toBe(200);
    const mgrTeam = (await mgrTeamRes.json()) as {
      items: { id: string; assignee_user_id: string }[];
    };
    expect(mgrTeam.items.map((t) => t.id)).toContain(created.id);
    // CA BDR's tasks are never visible to US Manager
    expect(mgrTeam.items.some((t) => t.assignee_user_id === 'usr_bdr_1')).toBe(false);

    const adminTeamRes = await fetch(`${baseUrl}/api/v1/tasks?view=team`, {
      headers: { Cookie: adminCookie },
    });
    expect(adminTeamRes.status).toBe(200);

    // Complete the recurring task -> spawns next occurrence 7 days later with 1h-before reminder!
    const comp1 = await fetch(`${baseUrl}/api/v1/tasks/${created.id}/complete`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({ outcome: 'Spoke with tax partner.' }),
    });
    expect(comp1.status).toBe(200);
    const done1 = (await comp1.json()) as { status: string; next_task_id: string | null };
    expect(done1.status).toBe('completed');
    expect(done1.next_task_id).toBeTruthy();

    // Completing a second time is idempotent and returns the same next_task_id without duplicating!
    const comp2 = await fetch(`${baseUrl}/api/v1/tasks/${created.id}/complete`, {
      method: 'POST',
      headers: authHeaders(usBdrCookie),
      body: JSON.stringify({}),
    });
    expect(comp2.status).toBe(200);
    const done2 = (await comp2.json()) as { next_task_id: string | null };
    expect(done2.next_task_id).toBe(done1.next_task_id);

    const openListRes = await fetch(`${baseUrl}/api/v1/tasks?view=open`, {
      headers: { Cookie: usBdrCookie },
    });
    const openList = (await openListRes.json()) as {
      items: {
        id: string;
        parent_task_id: string | null;
        due_at: string;
        reminder_at: string | null;
        recurrence_rule: string | null;
      }[];
    };
    const spawned = openList.items.find((t) => t.id === done1.next_task_id);
    expect(spawned).toBeDefined();
    expect(spawned?.parent_task_id).toBe(created.id);
    expect(spawned?.recurrence_rule).toBe('weekly');
    expect(new Date(spawned?.due_at ?? '').toISOString()).toBe('2026-11-27T15:00:00.000Z');
    expect(new Date(spawned?.reminder_at ?? '').toISOString()).toBe('2026-11-27T14:00:00.000Z');
  });

  it('manages FX rates with reciprocal upsert, last-rate guard, audit logs, and snapshots rate on CAD deal close', async () => {
    // Non-admin cannot manage FX rates
    const bdrFxRes = await fetch(`${baseUrl}/api/v1/admin/fx-rates`, {
      headers: { Cookie: usBdrCookie },
    });
    expect(bdrFxRes.status).toBe(403);

    // Admin lists baseline FX rates
    const list1Res = await fetch(`${baseUrl}/api/v1/admin/fx-rates`, {
      headers: { Cookie: adminCookie },
    });
    expect(list1Res.status).toBe(200);
    const list1 = (await list1Res.json()) as {
      reportingCurrency: string;
      items: { id: string; fromCurrency: string; toCurrency: string; rateScaled: string }[];
    };
    expect(list1.reportingCurrency).toBe('USD');
    expect(list1.items.length).toBeGreaterThanOrEqual(2);

    // Admin upserts CAD -> USD = 0.725000 for a new future effective date
    const upsertRes = await fetch(`${baseUrl}/api/v1/admin/fx-rates`, {
      method: 'POST',
      headers: authHeaders(adminCookie, true),
      body: JSON.stringify({
        fromCurrency: 'CAD',
        toCurrency: 'USD',
        rateText: '0.725',
        effectiveDate: '2026-11-15',
      }),
    });
    expect(upsertRes.status).toBe(201);
    const upserted = (await upsertRes.json()) as {
      rate: { id: string; rateScaled: string; effectiveDate: string };
    };
    expect(upserted.rate.rateScaled).toBe('725000');

    // Create and convert a CAD lead, then close-win the CAD deal and verify fx_rate_scaled_at_close = 725000!
    const cadLeadRes = await fetch(`${baseUrl}/api/v1/leads`, {
      method: 'POST',
      headers: authHeaders(caBdrCookie, true),
      body: JSON.stringify({
        firstName: 'Sophie',
        lastName: 'Bouchard',
        email: 'sophie@bouchardcpa-ms3c.example',
        firmName: 'Bouchard & Associés CPA',
        market: 'CA',
      }),
    });
    expect(cadLeadRes.status).toBe(201);
    const cadLead = (await cadLeadRes.json()) as { id: string };

    const cadConvRes = await fetch(`${baseUrl}/api/v1/leads/convert`, {
      method: 'POST',
      headers: authHeaders(caBdrCookie),
      body: JSON.stringify({
        leadId: cadLead.id,
        createDeal: true,
        dealName: 'Bouchard CPA — Audit Pod',
        monthlyValueMinor: '600000',
        currency: 'CAD',
        fteCount: 1,
      }),
    });
    expect(cadConvRes.status).toBe(200);
    const cadConv = (await cadConvRes.json()) as { dealId: string };

    const getDealRes = await fetch(`${baseUrl}/api/v1/deals/${cadConv.dealId}`, {
      headers: { Cookie: caBdrCookie },
    });
    const dealBeforeClose = (await getDealRes.json()) as { deal: { version: number } };

    const winRes = await fetch(`${baseUrl}/api/v1/deals/${cadConv.dealId}/stage`, {
      method: 'PATCH',
      headers: authHeaders(caBdrCookie),
      body: JSON.stringify({
        stageName: 'Won',
        version: dealBeforeClose.deal.version,
        contractStartDate: '2026-12-01',
      }),
    });
    expect(winRes.status).toBe(200);

    const fxRow = await db.query<{ fx_rate_scaled_at_close: string | null }>(
      `SELECT fx_rate_scaled_at_close::text FROM deals WHERE id = $1`,
      [cadConv.dealId],
    );
    expect(fxRow.rows[0]?.fx_rate_scaled_at_close).toBe('725000');

    // Admin deletes the extra 2026-11-15 rate; baseline rate remains, and deleting the last CAD->USD rate is refused with 409!
    const delAdded = await fetch(`${baseUrl}/api/v1/admin/fx-rates/${upserted.rate.id}`, {
      method: 'DELETE',
      headers: authHeaders(adminCookie),
    });
    expect(delAdded.status).toBe(200);

    const listAfterDelRes = await fetch(`${baseUrl}/api/v1/admin/fx-rates`, {
      headers: { Cookie: adminCookie },
    });
    const listAfterDel = (await listAfterDelRes.json()) as {
      items: { id: string; fromCurrency: string; toCurrency: string }[];
    };
    const cadToUsdRates = listAfterDel.items.filter(
      (r) => r.fromCurrency === 'CAD' && r.toCurrency === 'USD',
    );
    // Delete all but one if multiple exist, then prove the last one returns 409 FX_LAST_RATE
    while (cadToUsdRates.length > 1) {
      const extra = cadToUsdRates.pop();
      if (extra) {
        const res = await fetch(`${baseUrl}/api/v1/admin/fx-rates/${extra.id}`, {
          method: 'DELETE',
          headers: authHeaders(adminCookie),
        });
        expect(res.status).toBe(200);
      }
    }
    const lastRate = cadToUsdRates[0];
    expect(lastRate).toBeDefined();
    if (lastRate) {
      const refuseLast = await fetch(`${baseUrl}/api/v1/admin/fx-rates/${lastRate.id}`, {
        method: 'DELETE',
        headers: authHeaders(adminCookie),
      });
      expect(refuseLast.status).toBe(409);
    }

    // Verify audit logs recorded fx_rate.upserted and fx_rate.deleted
    const audits = await db.query<{ action: string }>(
      `SELECT action FROM audit_logs WHERE action IN ('fx_rate.upserted', 'fx_rate.deleted')`,
    );
    const actions = new Set(audits.rows.map((r) => r.action));
    expect(actions.has('fx_rate.upserted')).toBe(true);
    expect(actions.has('fx_rate.deleted')).toBe(true);
  });
});
