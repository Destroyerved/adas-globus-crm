import { type SessionUser } from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { containsPattern } from '../../platform/list/index.js';
import { getCapabilityScope, requireCapability, scopeWhere } from '../../platform/scope/index.js';

export interface GlobalSearchResult {
  companies: Record<string, unknown>[];
  contacts: Record<string, unknown>[];
  leads: Record<string, unknown>[];
  deals: Record<string, unknown>[];
  notes?: Record<string, unknown>[];
  emailThreads?: Record<string, unknown>[];
}

export class DataQualityService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Global search across companies, contacts, leads, deals, notes and email threads (PRD 6.10):
   * one query per entity type in parallel, each scoped in SQL and capped at 8 results.
   *
   * Combines:
   * - Exact/substring matching (`ILIKE` with literal `%`/`_` escaping via trigram GIN indexes),
   * - Fuzzy typo tolerance (`pg_trgm` `%` similarity operator),
   * - Accent-folded full-text search (`search_tsv @@ websearch_to_tsquery('simple', immutable_unaccent($1))`)
   *   across record fields, attached notes (`notes.search_tsv`), and email subjects/snippets
   *   (`email_threads.search_tsv`).
   *
   * Every branch lives inside `ANY(ARRAY(... UNION ALL ...))` so PostgreSQL evaluates each
   * GIN index once and never falls back to a sequential scan even if table statistics are stale
   * (ADR 0011).
   */
  async globalSearch(
    user: SessionUser,
    queryText: string,
    options: { includeExtended?: boolean } = {},
  ): Promise<GlobalSearchResult> {
    const q = queryText.trim();
    const hasLexeme = /[\p{L}\p{N}]/u.test(q);
    if (!q || !hasLexeme) {
      return options.includeExtended
        ? { companies: [], contacts: [], leads: [], deals: [], notes: [], emailThreads: [] }
        : { companies: [], contacts: [], leads: [], deals: [] };
    }
    const likePattern = containsPattern(q);
    const tsQueryExpr = `websearch_to_tsquery('pg_catalog.simple'::pg_catalog.regconfig, public.immutable_unaccent($1))`;

    const queryCompanies = async (): Promise<Record<string, unknown>[]> => {
      if (getCapabilityScope(user, 'companies.read') === 'none') return [];
      const cmpScope = scopeWhere(user, 'companies.read', { alias: 'c', startParamIndex: 3 });
      const res = await this.db.query(
        `SELECT c.id, c.name, c.domain, c.market, c.account_status,
                GREATEST(
                  similarity(c.name, $1),
                  ts_rank_cd(c.search_tsv, ${tsQueryExpr})
                ) AS score
         FROM companies c
         WHERE c.deleted_at IS NULL
           AND c.id = ANY(ARRAY(
             SELECT x.id FROM companies x
             WHERE x.deleted_at IS NULL AND (x.name ILIKE $2 OR x.domain ILIKE $2)
             UNION ALL
             SELECT x.id FROM companies x
             WHERE x.deleted_at IS NULL AND x.name % $1
             UNION ALL
             SELECT x.id FROM companies x
             WHERE x.deleted_at IS NULL AND x.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT n.entity_id FROM notes n
             WHERE n.deleted_at IS NULL AND n.entity_type = 'company' AND n.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT t.company_id FROM email_threads t
             WHERE t.company_id IS NOT NULL AND t.search_tsv @@ ${tsQueryExpr}
           ))
           AND ${cmpScope.sql}
         ORDER BY score DESC, c.name ASC
         LIMIT 8`,
        [q, likePattern, ...cmpScope.params],
      );
      return res.rows;
    };

    const queryContacts = async (): Promise<Record<string, unknown>[]> => {
      if (getCapabilityScope(user, 'contacts.read') === 'none') return [];
      const cntScope = scopeWhere(user, 'contacts.read', { alias: 'c', startParamIndex: 3 });
      const res = await this.db.query(
        `SELECT c.id, c.full_name, c.primary_email, c.title, c.market,
                GREATEST(
                  similarity(c.full_name, $1),
                  ts_rank_cd(c.search_tsv, ${tsQueryExpr})
                ) AS score
         FROM contacts c
         WHERE c.deleted_at IS NULL
           AND c.id = ANY(ARRAY(
             SELECT x.id FROM contacts x
             WHERE x.deleted_at IS NULL AND (x.full_name ILIKE $2 OR x.primary_email ILIKE $2)
             UNION ALL
             SELECT x.id FROM contacts x
             WHERE x.deleted_at IS NULL AND x.full_name % $1
             UNION ALL
             SELECT x.id FROM contacts x
             WHERE x.deleted_at IS NULL AND x.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT n.entity_id FROM notes n
             WHERE n.deleted_at IS NULL AND n.entity_type = 'contact' AND n.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT t.contact_id FROM email_threads t
             WHERE t.contact_id IS NOT NULL AND t.search_tsv @@ ${tsQueryExpr}
           ))
           AND ${cntScope.sql}
         ORDER BY score DESC, c.full_name ASC
         LIMIT 8`,
        [q, likePattern, ...cntScope.params],
      );
      return res.rows;
    };

    const queryLeads = async (): Promise<Record<string, unknown>[]> => {
      if (getCapabilityScope(user, 'leads.read') === 'none') return [];
      const leadScope = scopeWhere(user, 'leads.read', { alias: 'l', startParamIndex: 3 });
      const res = await this.db.query(
        `SELECT l.id, l.full_name, l.email, l.firm_name, l.status, l.market,
                GREATEST(
                  similarity(l.full_name, $1),
                  ts_rank_cd(l.search_tsv, ${tsQueryExpr})
                ) AS score
         FROM leads l
         WHERE l.deleted_at IS NULL
           AND l.id = ANY(ARRAY(
             SELECT x.id FROM leads x
             WHERE x.deleted_at IS NULL
               AND (x.full_name ILIKE $2 OR x.firm_name ILIKE $2 OR x.email ILIKE $2)
             UNION ALL
             SELECT x.id FROM leads x
             WHERE x.deleted_at IS NULL AND x.full_name % $1
             UNION ALL
             SELECT x.id FROM leads x
             WHERE x.deleted_at IS NULL AND x.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT n.entity_id FROM notes n
             WHERE n.deleted_at IS NULL AND n.entity_type = 'lead' AND n.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT t.lead_id FROM email_threads t
             WHERE t.lead_id IS NOT NULL AND t.search_tsv @@ ${tsQueryExpr}
           ))
           AND ${leadScope.sql}
         ORDER BY score DESC, l.full_name ASC
         LIMIT 8`,
        [q, likePattern, ...leadScope.params],
      );
      return res.rows;
    };

    const queryDeals = async (): Promise<Record<string, unknown>[]> => {
      if (getCapabilityScope(user, 'deals.read') === 'none') return [];
      const dealScope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: 3 });
      const res = await this.db.query(
        `SELECT d.id, d.name, d.stage_name, d.monthly_value_minor, d.currency,
                GREATEST(
                  similarity(d.name, $1),
                  ts_rank_cd(d.search_tsv, ${tsQueryExpr})
                ) AS score
         FROM deals d
         WHERE d.deleted_at IS NULL
           AND d.id = ANY(ARRAY(
             SELECT x.id FROM deals x
             WHERE x.deleted_at IS NULL AND x.name ILIKE $2
             UNION ALL
             SELECT x.id FROM deals x
             WHERE x.deleted_at IS NULL AND x.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT n.entity_id FROM notes n
             WHERE n.deleted_at IS NULL AND n.entity_type = 'deal' AND n.search_tsv @@ ${tsQueryExpr}
             UNION ALL
             SELECT t.deal_id FROM email_threads t
             WHERE t.deal_id IS NOT NULL AND t.search_tsv @@ ${tsQueryExpr}
           ))
           AND ${dealScope.sql}
         ORDER BY score DESC, d.updated_at DESC
         LIMIT 8`,
        [q, likePattern, ...dealScope.params],
      );
      return res.rows;
    };

    const queryNotes = async (): Promise<Record<string, unknown>[]> => {
      if (!options.includeExtended) return [];
      const params: unknown[] = [q];
      const entityChecks: string[] = [];

      const pushEntityCheck = (
        entityType: 'company' | 'contact' | 'lead' | 'deal',
        table: string,
        capability: string,
      ) => {
        if (getCapabilityScope(user, capability) === 'none') return;
        const sc = scopeWhere(user, capability, {
          alias: 'p',
          startParamIndex: params.length + 1,
        });
        params.push(...sc.params);
        entityChecks.push(
          `(n.entity_type = '${entityType}' AND EXISTS (
             SELECT 1 FROM ${table} p
             WHERE p.id = n.entity_id AND p.deleted_at IS NULL AND ${sc.sql}
           ))`,
        );
      };

      pushEntityCheck('company', 'companies', 'companies.read');
      pushEntityCheck('contact', 'contacts', 'contacts.read');
      pushEntityCheck('lead', 'leads', 'leads.read');
      pushEntityCheck('deal', 'deals', 'deals.read');

      if (entityChecks.length === 0) return [];

      const res = await this.db.query(
        `SELECT n.id, n.entity_type, n.entity_id,
                LEFT(n.body, 120) AS snippet,
                n.created_at
         FROM notes n
         WHERE n.deleted_at IS NULL
           AND n.search_tsv @@ ${tsQueryExpr}
           AND (${entityChecks.join(' OR ')})
         ORDER BY ts_rank_cd(n.search_tsv, ${tsQueryExpr}) DESC, n.created_at DESC
         LIMIT 8`,
        params,
      );
      return res.rows;
    };

    const queryEmailThreads = async (): Promise<Record<string, unknown>[]> => {
      if (!options.includeExtended) return [];
      if (getCapabilityScope(user, 'inbox.read') === 'none') return [];
      const inboxScope = scopeWhere(user, 'inbox.read', { alias: 't', startParamIndex: 2 });
      const res = await this.db.query(
        `SELECT t.id, t.subject, LEFT(t.snippet, 120) AS snippet,
                t.contact_id, t.company_id, t.deal_id, t.lead_id, t.last_message_at
         FROM email_threads t
         WHERE t.search_tsv @@ ${tsQueryExpr}
           AND ${inboxScope.sql}
         ORDER BY ts_rank_cd(t.search_tsv, ${tsQueryExpr}) DESC, t.last_message_at DESC
         LIMIT 8`,
        [q, ...inboxScope.params],
      );
      return res.rows;
    };

    const [companies, contacts, leads, deals, notes, emailThreads] = await Promise.all([
      queryCompanies(),
      queryContacts(),
      queryLeads(),
      queryDeals(),
      queryNotes(),
      queryEmailThreads(),
    ]);

    if (options.includeExtended) {
      return { companies, contacts, leads, deals, notes, emailThreads };
    }
    return { companies, contacts, leads, deals };
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
