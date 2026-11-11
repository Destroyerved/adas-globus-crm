import { type SessionUser } from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { containsPattern } from '../../platform/list/index.js';
import { requireCapability, scopeWhere } from '../../platform/scope/index.js';

export class DataQualityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Global search across companies, contacts, leads and deals (PRD 6.10): one query per
   * record type, in parallel, each scoped in SQL.
   *
   * A record matches when the text is part of its name, email or domain, or when its name is
   * similar to the text (pg_trgm's `%` operator, so a typo still finds it). Both are written
   * as indexed lookups that fill an array; a single OR with similarity() can't use the
   * trigram indexes and reads every row. PostgreSQL always computes the array once, even
   * when a table's statistics are out of date (docs/perf, ADR 0011).
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
    const likePattern = containsPattern(q);

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
           AND c.id = ANY(ARRAY(
             SELECT x.id FROM companies x WHERE x.name ILIKE $2 OR x.domain ILIKE $2
             UNION ALL
             SELECT x.id FROM companies x WHERE x.name % $1))
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
           AND c.id = ANY(ARRAY(
             SELECT x.id FROM contacts x WHERE x.full_name ILIKE $2 OR x.primary_email ILIKE $2
             UNION ALL
             SELECT x.id FROM contacts x WHERE x.full_name % $1))
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
           AND l.id = ANY(ARRAY(
             SELECT x.id FROM leads x
             WHERE x.full_name ILIKE $2 OR x.firm_name ILIKE $2 OR x.email ILIKE $2
             UNION ALL
             SELECT x.id FROM leads x WHERE x.full_name % $1))
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
