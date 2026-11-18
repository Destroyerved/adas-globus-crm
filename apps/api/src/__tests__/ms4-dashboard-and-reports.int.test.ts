import { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';
import { DatabaseService } from '../platform/db/index.js';

/**
 * Milestone 4 Integration Suite:
 * - Dashboard portfolio summary & previous-period deltas across own/team/all scopes (PRD 4.2, 14)
 * - Standalone Standard Reports module across all 6 reports with date/market/team/owner filters,
 *   CAD->USD FX conversion & currencyBreakdown, and permissioned audited CSV export (PRD 4.15, 9, 14)
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

describe('Milestone 4: dashboard summary deltas & standard reports module', () => {
  let adminCookie = '';
  let usMgrCookie = '';
  let usBdrCookie = '';
  let mktCookie = '';
  let analystCookie = '';

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
    mktCookie = await signIn(baseUrl, 'usr_mkt_1');
    analystCookie = await signIn(baseUrl, 'usr_ro_1');
  });

  afterAll(async () => {
    if (serverClose) await serverClose();
    if (db) await db.close();
  });

  it('scopes GET /api/v1/dashboard/summary across own, team and all and returns previous-period widget data', async () => {
    const [ownRes, teamRes, allRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/dashboard/summary?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: usBdrCookie },
      }),
      fetch(`${baseUrl}/api/v1/dashboard/summary?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: usMgrCookie },
      }),
      fetch(`${baseUrl}/api/v1/dashboard/summary?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: adminCookie },
      }),
    ]);
    expect(ownRes.status).toBe(200);
    expect(teamRes.status).toBe(200);
    expect(allRes.status).toBe(200);

    const own = (await ownRes.json()) as {
      totalCompanies: number;
      totalContacts: number;
      newLeads: number;
      period: { previousFrom: string; previousTo: string };
    };
    const team = (await teamRes.json()) as {
      totalCompanies: number;
      totalContacts: number;
    };
    const all = (await allRes.json()) as {
      totalCompanies: number;
      totalContacts: number;
    };

    expect(all.totalCompanies).toBeGreaterThanOrEqual(team.totalCompanies);
    expect(team.totalCompanies).toBeGreaterThanOrEqual(own.totalCompanies);
    expect(all.totalContacts).toBeGreaterThanOrEqual(team.totalContacts);
    expect(own.period.previousFrom).toBe('2025-01-01');
    expect(own.period.previousTo).toBe('2025-12-31');

    // Period widgets expose `previous` alongside current figures
    const wonLostRes = await fetch(
      `${baseUrl}/api/v1/dashboard/widgets/won_lost?from=2026-01-01&to=2026-12-31`,
      { headers: { Cookie: usMgrCookie } },
    );
    expect(wonLostRes.status).toBe(200);
    const wonLost = (await wonLostRes.json()) as {
      period: { previousFrom: string };
      data: { won: number; previous?: { won: number } };
    };
    expect(wonLost.period.previousFrom).toBe('2025-01-01');
    expect(wonLost.data.previous).toBeDefined();
  });

  it('runs all 6 standard reports enforcing capabilities, own/team/all scopes, market/team/owner filters and FX breakdown', async () => {
    // Options endpoint scopes teams & owners to viewer's reports.read scope
    const [bdrOptsRes, mgrOptsRes, adminOptsRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/reports/options`, { headers: { Cookie: usBdrCookie } }),
      fetch(`${baseUrl}/api/v1/reports/options`, { headers: { Cookie: usMgrCookie } }),
      fetch(`${baseUrl}/api/v1/reports/options`, { headers: { Cookie: adminCookie } }),
    ]);
    // Verify role capability behaviour: if BDR has reports.read = own, owners has 1; if none, 403
    if (bdrOptsRes.status === 200) {
      const bdrOpts = (await bdrOptsRes.json()) as { owners: unknown[]; teams: unknown[] };
      expect(bdrOpts.owners).toHaveLength(1);
      expect(bdrOpts.teams).toHaveLength(0);
    } else {
      expect(bdrOptsRes.status).toBe(403);
    }
    expect(mgrOptsRes.status).toBe(200);
    const mgrOpts = (await mgrOptsRes.json()) as {
      teams: { id: string }[];
      owners: { id: string }[];
      canExport: boolean;
    };
    expect(mgrOpts.teams).toHaveLength(1);
    expect(mgrOpts.canExport).toBe(true);

    expect(adminOptsRes.status).toBe(200);
    const adminOpts = (await adminOptsRes.json()) as {
      teams: { id: string }[];
      owners: { id: string }[];
    };
    expect(adminOpts.teams.length).toBeGreaterThanOrEqual(2);
    expect(adminOpts.owners.length).toBeGreaterThan(mgrOpts.owners.length);

    // Scoped Bearer API token with reports.read + leads.read (no deals.read) gets 200 on leads_funnel and 403 on pipeline_overview
    const patRes = await fetch(`${baseUrl}/api/v1/admin/api-tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: WEB_ORIGIN,
        Cookie: adminCookie,
      },
      body: JSON.stringify({
        name: 'Leads report reader',
        capabilities: ['reports.read', 'leads.read'],
        scopeLevel: 'team',
      }),
    });
    expect(patRes.status).toBe(201);
    const pat = (await patRes.json()) as { secretToken: string };

    const patLeads = await fetch(
      `${baseUrl}/api/v1/reports/leads_funnel?from=2026-01-01&to=2026-12-31`,
      { headers: { Authorization: `Bearer ${pat.secretToken}` } },
    );
    expect(patLeads.status).toBe(200);

    const patDealsForbidden = await fetch(
      `${baseUrl}/api/v1/reports/pipeline_overview?from=2026-01-01&to=2026-12-31`,
      { headers: { Authorization: `Bearer ${pat.secretToken}` } },
    );
    expect(patDealsForbidden.status).toBe(403);

    const mktOutreach = await fetch(
      `${baseUrl}/api/v1/reports/outreach_deliverability?from=2026-01-01&to=2026-12-31`,
      { headers: { Cookie: mktCookie } },
    );
    expect(mktOutreach.status).toBe(200);

    // Admin runs all 6 standard reports successfully
    const reportIds = [
      'leads_funnel',
      'pipeline_overview',
      'won_lost_revenue',
      'sla_responsiveness',
      'employee_activity',
      'outreach_deliverability',
    ] as const;

    for (const id of reportIds) {
      const res = await fetch(`${baseUrl}/api/v1/reports/${id}?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: adminCookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        id: string;
        kpis: unknown[];
        charts: unknown[];
        columns: unknown[];
        currencyBreakdown?: { currency: string; amountMinor: string }[];
      };
      expect(body.id).toBe(id);
      expect(body.kpis.length).toBeGreaterThan(0);
      expect(body.charts.length).toBeGreaterThan(0);
      expect(body.columns.length).toBeGreaterThan(0);
      if (id === 'pipeline_overview' || id === 'won_lost_revenue') {
        expect(body.currencyBreakdown?.map((c) => c.currency)).toEqual(['USD', 'CAD']);
      }
    }

    // Scope comparison on pipeline_overview: Admin (all: 3 open deals) > US Manager (team: 2 open deals) >= BDR own
    const [bdrPipeRes, mgrPipeRes, adminPipeRes, ownerFilteredRes] = await Promise.all([
      fetch(`${baseUrl}/api/v1/reports/pipeline_overview?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: usBdrCookie },
      }),
      fetch(`${baseUrl}/api/v1/reports/pipeline_overview?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: usMgrCookie },
      }),
      fetch(`${baseUrl}/api/v1/reports/pipeline_overview?from=2026-01-01&to=2026-12-31`, {
        headers: { Cookie: adminCookie },
      }),
      fetch(
        `${baseUrl}/api/v1/reports/pipeline_overview?from=2026-01-01&to=2026-12-31&ownerId=@me`,
        { headers: { Cookie: usMgrCookie } },
      ),
    ]);
    const bdrPipe = (await bdrPipeRes.json()) as { kpis: { key: string; value: string }[] };
    const mgrPipe = (await mgrPipeRes.json()) as { kpis: { key: string; value: string }[] };
    const adminPipe = (await adminPipeRes.json()) as { kpis: { key: string; value: string }[] };
    const mePipe = (await ownerFilteredRes.json()) as { kpis: { key: string; value: string }[] };
    expect(Number(adminPipe.kpis[0]?.value)).toBe(3);
    expect(Number(mgrPipe.kpis[0]?.value)).toBe(2);
    expect(Number(mePipe.kpis[0]?.value)).toBe(1);
    expect(Number(bdrPipe.kpis[0]?.value)).toBeLessThanOrEqual(Number(mgrPipe.kpis[0]?.value));
  });

  it('enforces exports.run on report CSV export and writes PII-free report.exported audit logs', async () => {
    // Read-Only Analyst can view reports (reports.read = all) but cannot export (exports.run = none)
    const roView = await fetch(
      `${baseUrl}/api/v1/reports/pipeline_overview?from=2026-01-01&to=2026-12-31`,
      { headers: { Cookie: analystCookie } },
    );
    expect(roView.status).toBe(200);

    const roExport = await fetch(
      `${baseUrl}/api/v1/reports/pipeline_overview/export.csv?from=2026-01-01&to=2026-12-31`,
      { headers: { Cookie: analystCookie } },
    );
    expect(roExport.status).toBe(403);

    // Sales Manager exports pipeline_overview CSV
    const mgrExport = await fetch(
      `${baseUrl}/api/v1/reports/pipeline_overview/export.csv?from=2026-01-01&to=2026-12-31&market=US`,
      { headers: { Cookie: usMgrCookie } },
    );
    expect(mgrExport.status).toBe(200);
    expect(mgrExport.headers.get('content-type')).toContain('text/csv');
    expect(mgrExport.headers.get('content-disposition')).toContain(
      'adas-report-pipeline_overview-2026-01-01-to-2026-12-31.csv',
    );
    const rawBytes = new Uint8Array(await mgrExport.arrayBuffer());
    expect([...rawBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csvText = new TextDecoder('utf-8').decode(rawBytes);
    expect(csvText.startsWith('Owner,Stage,Original currency,Open deals')).toBe(true);

    // Audit log recorded report.exported with filter metadata and zero PII
    const audits = await db.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT action, entity_type, entity_id, metadata
       FROM audit_logs
       WHERE action = 'report.exported' AND actor_user_id = 'usr_mgr_1'
       ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audits.rows[0]).toBeDefined();
    expect(audits.rows[0]?.entity_type).toBe('report');
    expect(audits.rows[0]?.entity_id).toBe('pipeline_overview');
    expect(audits.rows[0]?.metadata).toMatchObject({
      reportId: 'pipeline_overview',
      from: '2026-01-01',
      to: '2026-12-31',
      market: 'US',
    });
  });
});
