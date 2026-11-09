import { type SessionUser } from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';

export class DataQualityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * PRD §6.8 — Global trigram + full-text search across Companies, Contacts, Leads, and Deals.
   */
  async globalSearch(
    user: SessionUser,
    queryText: string,
  ): Promise<{
    companies: Record<string, unknown>[];
    contacts: Record<string, unknown>[];
    leads: Record<string, unknown>[];
    deals: Record<string, unknown>[];
  }> {
    const q = queryText.trim();
    if (!q) {
      return { companies: [], contacts: [], leads: [], deals: [] };
    }
    const likePattern = `%${q}%`;

    const cmpScope = scopeWhere(user, 'companies.read', { alias: 'c', startParamIndex: 3 });
    const cntScope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 3 });
    const leadScope = scopeWhere(user, 'leads.read', { alias: 'l', startParamIndex: 3 });
    const dealScope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: 2 });

    const [companies, contacts, leads, deals] = await Promise.all([
      this.db.query(
        `SELECT c.id, c.name, c.domain, c.market, c.account_status,
                similarity(c.name, $1) AS score
         FROM companies c
         WHERE c.deleted_at IS NULL
           AND (c.name ILIKE $2 OR c.domain ILIKE $2 OR similarity(c.name, $1) > 0.2)
           AND ${cmpScope.sql}
         ORDER BY score DESC, c.name ASC
         LIMIT 10`,
        [q, likePattern, ...cmpScope.params],
      ),
      this.db.query(
        `SELECT c.id, c.full_name, c.primary_email, c.title, c.market,
                similarity(c.full_name, $1) AS score
         FROM contacts c
         WHERE c.deleted_at IS NULL
           AND (c.full_name ILIKE $2 OR c.primary_email ILIKE $2 OR similarity(c.full_name, $1) > 0.2)
           AND ${cntScope.sql}
         ORDER BY score DESC, c.full_name ASC
         LIMIT 10`,
        [q, likePattern, ...cntScope.params],
      ),
      this.db.query(
        `SELECT l.id, l.full_name, l.email, l.firm_name, l.status, l.market,
                similarity(l.full_name, $1) AS score
         FROM leads l
         WHERE l.deleted_at IS NULL
           AND (l.full_name ILIKE $2 OR l.firm_name ILIKE $2 OR l.email ILIKE $2 OR similarity(l.full_name, $1) > 0.2)
           AND ${leadScope.sql}
         ORDER BY score DESC, l.full_name ASC
         LIMIT 10`,
        [q, likePattern, ...leadScope.params],
      ),
      this.db.query(
        `SELECT d.id, d.name, d.stage_name, d.monthly_value_minor, d.currency
         FROM deals d
         WHERE d.deleted_at IS NULL
           AND d.name ILIKE $1
           AND ${dealScope.sql}
         ORDER BY d.updated_at DESC
         LIMIT 10`,
        [likePattern, ...dealScope.params],
      ),
    ]);

    return {
      companies: companies.rows,
      contacts: contacts.rows,
      leads: leads.rows,
      deals: deals.rows,
    };
  }

  /**
   * PRD §10 — Bigin Migration reconciliation check.
   */
  async reconcileBiginMigration(
    user: SessionUser,
    sourceInventory: {
      companiesCount: number;
      contactsCount: number;
      openDealsCount: number;
      totalMonthlyPipelineMinor: string;
    },
  ): Promise<{
    reconciled: boolean;
    crmCompaniesCount: number;
    crmContactsCount: number;
    crmOpenDealsCount: number;
    crmTotalMonthlyPipelineMinor: string;
    discrepancies: string[];
  }> {
    requireCapability(user, 'imports.run');

    const [cmpRes, cntRes, dealRes] = await Promise.all([
      this.db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM companies WHERE deleted_at IS NULL`,
      ),
      this.db.query<{ cnt: number }>(
        `SELECT COUNT(*)::int AS cnt FROM contacts WHERE deleted_at IS NULL`,
      ),
      this.db.query<{ cnt: number; sum_minor: string }>(
        `SELECT COUNT(*)::int AS cnt, COALESCE(SUM(monthly_value_minor), 0)::text AS sum_minor
         FROM deals WHERE deleted_at IS NULL AND stage_category = 'open'`,
      ),
    ]);

    const crmCompaniesCount = cmpRes.rows[0]?.cnt ?? 0;
    const crmContactsCount = cntRes.rows[0]?.cnt ?? 0;
    const crmOpenDealsCount = dealRes.rows[0]?.cnt ?? 0;
    const crmTotalMonthlyPipelineMinor = dealRes.rows[0]?.sum_minor ?? '0';

    const discrepancies: string[] = [];
    if (crmCompaniesCount !== sourceInventory.companiesCount) {
      discrepancies.push(
        `Companies mismatch: expected ${sourceInventory.companiesCount}, found ${crmCompaniesCount}`,
      );
    }
    if (crmContactsCount !== sourceInventory.contactsCount) {
      discrepancies.push(
        `Contacts mismatch: expected ${sourceInventory.contactsCount}, found ${crmContactsCount}`,
      );
    }
    if (crmOpenDealsCount !== sourceInventory.openDealsCount) {
      discrepancies.push(
        `Open deals mismatch: expected ${sourceInventory.openDealsCount}, found ${crmOpenDealsCount}`,
      );
    }
    if (crmTotalMonthlyPipelineMinor !== sourceInventory.totalMonthlyPipelineMinor) {
      discrepancies.push(
        `Pipeline total mismatch: expected ${sourceInventory.totalMonthlyPipelineMinor}, found ${crmTotalMonthlyPipelineMinor}`,
      );
    }

    return {
      reconciled: discrepancies.length === 0,
      crmCompaniesCount,
      crmContactsCount,
      crmOpenDealsCount,
      crmTotalMonthlyPipelineMinor,
      discrepancies,
    };
  }
}
