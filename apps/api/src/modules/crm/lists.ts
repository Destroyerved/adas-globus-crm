import type { ExportEntity, SessionUser } from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { ValidationDomainError } from '../../platform/errors/index.js';
import {
  SqlParams,
  ilikeAny,
  runList,
  type ListRequest,
  type ListSpec,
  type Page,
} from '../../platform/list/index.js';
import { scopeWhere } from '../../platform/scope/index.js';
import { EXPORT_SPECS, exportHeader } from './export-columns.js';

/**
 * Field registries and list specs for the record lists (PRD 4.3-4.8, 6.7, 6.8).
 * Each registry is the whitelist of what users may filter on; nothing else reaches SQL.
 */

/** Inline tag names for a row. `entity` is a constant written here, never user input. */
const tagsOf = (entity: string, idSql: string) =>
  `ARRAY(SELECT t.name FROM entity_tags et JOIN tags t ON t.id = et.tag_id
         WHERE et.entity_type = '${entity}' AND et.entity_id = ${idSql} ORDER BY t.name) AS tags`;

const ts = (sql: string) => ({ sql, cast: 'timestamptz' as const });
const txt = (sql: string) => ({ sql, cast: 'text' as const });

export const LEAD_LIST: ListSpec = {
  entity: 'leads',
  select: `l.*, ${tagsOf('lead', 'l.id')}`,
  from: 'leads l',
  idSql: 'l.id',
  where: ['l.deleted_at IS NULL'],
  sorts: {
    updatedAt: ts('l.updated_at'),
    createdAt: ts('l.created_at'),
    lastContactedAt: ts(`COALESCE(l.last_contacted_at, 'epoch'::timestamptz)`),
    name: txt('l.full_name'),
    status: txt('l.status'),
    score: { sql: 'l.lead_score', cast: 'int' },
  },
  defaultSort: '-updatedAt',
  registry: {
    status: { sql: 'l.status', type: 'enum' },
    statusCategory: { sql: 'l.status_category', type: 'enum' },
    market: { sql: 'l.market', type: 'enum' },
    source: { sql: 'l.source', type: 'text' },
    ownerId: { sql: 'l.owner_user_id', type: 'user' },
    teamId: { sql: 'l.team_id', type: 'enum' },
    firmName: { sql: 'l.firm_name', type: 'text' },
    email: { sql: 'l.email', type: 'text' },
    title: { sql: 'l.title', type: 'text' },
    stateProvince: { sql: 'l.state_province', type: 'text' },
    staffBand: { sql: 'l.staff_band', type: 'enum' },
    disqualificationReason: { sql: 'l.disqualification_reason', type: 'text' },
    score: { sql: 'l.lead_score', type: 'number' },
    createdAt: { sql: 'l.created_at', type: 'date' },
    updatedAt: { sql: 'l.updated_at', type: 'date' },
    lastContactedAt: { sql: 'l.last_contacted_at', type: 'date' },
    servicesNeeded: { sql: 'l.services_needed', type: 'jsonArray' },
    softwareStack: { sql: 'l.software_stack', type: 'jsonArray' },
    tags: { sql: 'l.id', type: 'tags', tagEntity: 'lead' },
  },
  search: (q, p) => ilikeAny(['l.full_name', 'l.email', 'l.firm_name'], q, p),
};

export const CONTACT_LIST: ListSpec = {
  entity: 'contacts',
  select: `c.*, cmp.name AS company_name, cmp.domain AS company_domain, ${tagsOf('contact', 'c.id')}`,
  from: 'contacts c LEFT JOIN companies cmp ON cmp.id = c.company_id',
  idSql: 'c.id',
  where: ['c.deleted_at IS NULL'],
  sorts: {
    updatedAt: ts('c.updated_at'),
    createdAt: ts('c.created_at'),
    lastContactedAt: ts(`COALESCE(c.last_contacted_at, 'epoch'::timestamptz)`),
    name: txt('c.full_name'),
    company: txt(`COALESCE(cmp.name, '')`),
  },
  defaultSort: '-updatedAt',
  registry: {
    market: { sql: 'c.market', type: 'enum' },
    ownerId: { sql: 'c.owner_user_id', type: 'user' },
    teamId: { sql: 'c.team_id', type: 'enum' },
    companyId: { sql: 'c.company_id', type: 'enum' },
    companyName: { sql: 'cmp.name', type: 'text' },
    title: { sql: 'c.title', type: 'text' },
    seniority: { sql: 'c.seniority', type: 'enum' },
    email: { sql: 'c.primary_email', type: 'text' },
    emailStatus: { sql: 'c.email_verification_status', type: 'enum' },
    doNotContact: { sql: 'c.do_not_contact', type: 'boolean' },
    score: { sql: 'c.lead_score', type: 'number' },
    createdAt: { sql: 'c.created_at', type: 'date' },
    updatedAt: { sql: 'c.updated_at', type: 'date' },
    lastContactedAt: { sql: 'c.last_contacted_at', type: 'date' },
    tags: { sql: 'c.id', type: 'tags', tagEntity: 'contact' },
  },
  search: (q, p) => ilikeAny(['c.full_name', 'c.primary_email', 'cmp.name'], q, p),
};

export const COMPANY_LIST: ListSpec = {
  entity: 'companies',
  select: `c.*, ${tagsOf('company', 'c.id')},
    (SELECT COUNT(*)::int FROM contacts x WHERE x.company_id = c.id AND x.deleted_at IS NULL) AS contact_count,
    (SELECT COUNT(*)::int FROM deals d WHERE d.company_id = c.id AND d.deleted_at IS NULL AND d.stage_category = 'open') AS open_deal_count`,
  from: 'companies c',
  idSql: 'c.id',
  where: ['c.deleted_at IS NULL'],
  sorts: {
    updatedAt: ts('c.updated_at'),
    createdAt: ts('c.created_at'),
    lastContactedAt: ts(`COALESCE(c.last_contacted_at, 'epoch'::timestamptz)`),
    name: txt('c.name'),
  },
  defaultSort: '-updatedAt',
  registry: {
    market: { sql: 'c.market', type: 'enum' },
    ownerId: { sql: 'c.owner_user_id', type: 'user' },
    teamId: { sql: 'c.team_id', type: 'enum' },
    accountStatus: { sql: 'c.account_status', type: 'enum' },
    firmType: { sql: 'c.firm_type', type: 'enum' },
    staffBand: { sql: 'c.staff_band', type: 'enum' },
    stateProvince: { sql: 'c.state_province', type: 'text' },
    city: { sql: 'c.city', type: 'text' },
    name: { sql: 'c.name', type: 'text' },
    domain: { sql: 'c.domain', type: 'text' },
    software: { sql: 'c.accounting_software', type: 'jsonArray' },
    servicesNeeded: { sql: 'c.services_needed', type: 'jsonArray' },
    createdAt: { sql: 'c.created_at', type: 'date' },
    updatedAt: { sql: 'c.updated_at', type: 'date' },
    lastContactedAt: { sql: 'c.last_contacted_at', type: 'date' },
    tags: { sql: 'c.id', type: 'tags', tagEntity: 'company' },
  },
  search: (q, p) => ilikeAny(['c.name', 'c.domain'], q, p),
};

export const DEAL_LIST: ListSpec = {
  entity: 'deals',
  select: `d.*, cmp.name AS company_name, cmp.market AS company_market,
    pc.full_name AS primary_contact_name,
    (d.monthly_value_minor * d.term_months + d.one_time_value_minor) AS contract_value_minor,
    ${tagsOf('deal', 'd.id')}`,
  from: `deals d JOIN companies cmp ON cmp.id = d.company_id
    LEFT JOIN contacts pc ON pc.id = d.primary_contact_id`,
  idSql: 'd.id',
  where: ['d.deleted_at IS NULL'],
  sorts: {
    updatedAt: ts('d.updated_at'),
    createdAt: ts('d.created_at'),
    name: txt('d.name'),
    value: { sql: 'd.monthly_value_minor', cast: 'bigint' },
    closeDate: txt(`COALESCE(NULLIF(d.expected_close_date, ''), '9999-12-31')`),
  },
  defaultSort: '-updatedAt',
  registry: {
    pipelineId: { sql: 'd.pipeline_id', type: 'enum' },
    stage: { sql: 'd.stage_name', type: 'enum' },
    stageId: { sql: 'd.stage_id', type: 'enum' },
    stageCategory: { sql: 'd.stage_category', type: 'enum' },
    market: { sql: 'cmp.market', type: 'enum' },
    ownerId: { sql: 'd.owner_user_id', type: 'user' },
    teamId: { sql: 'd.team_id', type: 'enum' },
    companyId: { sql: 'd.company_id', type: 'enum' },
    currency: { sql: 'd.currency', type: 'enum' },
    engagementModel: { sql: 'd.engagement_model', type: 'enum' },
    monthlyValue: { sql: 'd.monthly_value_minor', type: 'number' },
    services: { sql: 'd.services', type: 'jsonArray' },
    expectedCloseDate: { sql: `NULLIF(d.expected_close_date, '')::date`, type: 'date' },
    closedAt: { sql: 'd.closed_at', type: 'date' },
    createdAt: { sql: 'd.created_at', type: 'date' },
    updatedAt: { sql: 'd.updated_at', type: 'date' },
    tags: { sql: 'd.id', type: 'tags', tagEntity: 'deal' },
  },
  search: (q, p) => ilikeAny(['d.name', 'cmp.name'], q, p),
};

export const TASK_LIST: ListSpec = {
  entity: 'tasks',
  select: `t.*, au.name AS assignee_name, au.timezone AS assignee_timezone,
    cmp.name AS company_name, ct.full_name AS contact_name, ld.full_name AS lead_name,
    dl.name AS deal_name`,
  from: `tasks t JOIN users au ON au.id = t.assignee_user_id
    LEFT JOIN companies cmp ON cmp.id = t.company_id
    LEFT JOIN contacts ct ON ct.id = t.contact_id
    LEFT JOIN leads ld ON ld.id = t.lead_id
    LEFT JOIN deals dl ON dl.id = t.deal_id`,
  idSql: 't.id',
  where: ['t.deleted_at IS NULL'],
  sorts: {
    dueAt: ts('t.due_at'),
    updatedAt: ts('t.updated_at'),
    createdAt: ts('t.created_at'),
    completedAt: ts(`COALESCE(t.completed_at, 'epoch'::timestamptz)`),
    priority: {
      sql: `CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END`,
      cast: 'int',
    },
  },
  defaultSort: 'dueAt',
  registry: {
    status: { sql: 't.status', type: 'enum' },
    priority: { sql: 't.priority', type: 'enum' },
    taskType: { sql: 't.task_type', type: 'enum' },
    assigneeId: { sql: 't.assignee_user_id', type: 'user' },
    teamId: { sql: 't.team_id', type: 'enum' },
    dueAt: { sql: 't.due_at', type: 'date' },
    companyId: { sql: 't.company_id', type: 'enum' },
    contactId: { sql: 't.contact_id', type: 'enum' },
    leadId: { sql: 't.lead_id', type: 'enum' },
    dealId: { sql: 't.deal_id', type: 'enum' },
    createdAt: { sql: 't.created_at', type: 'date' },
  },
  search: (q, p) => ilikeAny(['t.title', 'cmp.name', 'ct.full_name', 'ld.full_name'], q, p),
};

/** Task views (PRD 4.7). "Today" and "upcoming" use the assignee's time zone. */
const TASK_VIEWS: Record<string, string> = {
  open: `t.status = 'open'`,
  today: `t.status = 'open' AND (t.due_at AT TIME ZONE au.timezone)::date = (NOW() AT TIME ZONE au.timezone)::date`,
  overdue: `t.status = 'open' AND t.due_at < NOW()`,
  upcoming: `t.status = 'open' AND (t.due_at AT TIME ZONE au.timezone)::date > (NOW() AT TIME ZONE au.timezone)::date`,
  done: `t.status = 'completed'`,
  all: '1 = 1',
};

const SPECS = {
  leads: { spec: LEAD_LIST, capability: 'leads.read', alias: 'l', ownerColumn: 'owner_user_id' },
  contacts: {
    spec: CONTACT_LIST,
    capability: 'contacts.read',
    alias: 'c',
    ownerColumn: 'owner_user_id',
  },
  companies: {
    spec: COMPANY_LIST,
    capability: 'companies.read',
    alias: 'c',
    ownerColumn: 'owner_user_id',
  },
  deals: { spec: DEAL_LIST, capability: 'deals.read', alias: 'd', ownerColumn: 'owner_user_id' },
  tasks: {
    spec: TASK_LIST,
    capability: 'tasks.read',
    alias: 't',
    ownerColumn: 'assignee_user_id',
  },
} as const;

export type ListEntity = keyof typeof SPECS;

export class CrmListService {
  constructor(private readonly db: DatabaseService) {}

  async list(
    entity: ListEntity,
    user: SessionUser,
    req: ListRequest,
    options: {
      taskView?: string;
      /** A second capability whose scope also applies (exports: `exports.run`). */
      alsoCapability?: string;
      /** Developer-written SQL added to the select (export columns). */
      extraSelect?: string;
      withTotal?: boolean;
    } = {},
  ): Promise<Page<Record<string, unknown>>> {
    const { spec: baseSpec, capability, alias, ownerColumn } = SPECS[entity];
    const params = new SqlParams();
    const scope = scopeWhere(user, capability, {
      alias,
      ownerColumn,
      startParamIndex: params.next,
    });
    scope.params.forEach((v) => params.add(v));
    let scopeSql = scope.sql;
    if (options.alsoCapability) {
      const also = scopeWhere(user, options.alsoCapability, {
        alias,
        ownerColumn,
        startParamIndex: params.next,
      });
      also.params.forEach((v) => params.add(v));
      scopeSql = `${scopeSql} AND ${also.sql}`;
    }

    let spec = options.extraSelect
      ? { ...baseSpec, select: `${baseSpec.select}, ${options.extraSelect}` }
      : baseSpec;
    if (entity === 'tasks') {
      const view = TASK_VIEWS[options.taskView ?? 'open'];
      if (!view) {
        throw new ValidationDomainError('Unknown task view.', {
          view: ['Use open, today, overdue, upcoming, done or all.'],
        });
      }
      spec = { ...spec, where: [...spec.where, view] };
    }
    return runList(this.db, spec, req, params, scopeSql, user.id, {
      withTotal: options.withTotal ?? true,
    });
  }

  /**
   * One page of a CSV export (PRD 2.3, 4.9): the list's own query, filters and read scope,
   * with the `exports.run` scope applied on top, so an export never holds a row the person
   * couldn't export. Rows come back as the CSV cells.
   */
  async exportPage(
    entity: ExportEntity,
    user: SessionUser,
    view: { q: string; sort?: string; filter?: unknown },
    page: { cursor: string | null; limit: number; withTotal: boolean },
    timeZone: string,
  ): Promise<{ rows: string[][]; nextCursor: string | null; total: number }> {
    const exportSpec = EXPORT_SPECS[entity];
    const result = await this.list(
      exportSpec.list,
      user,
      {
        q: view.q,
        sort: view.sort ?? SPECS[exportSpec.list].spec.defaultSort,
        filter: view.filter ?? null,
        cursor: page.cursor,
        limit: page.limit,
      },
      {
        alsoCapability: 'exports.run',
        extraSelect: exportSpec.extraSelect,
        withTotal: page.withTotal,
      },
    );
    return {
      rows: result.items.map((row) => exportSpec.columns.map((c) => c.value(row, timeZone))),
      nextCursor: result.nextCursor,
      total: result.total,
    };
  }

  exportHeader(entity: ExportEntity, timeZone: string): string[] {
    return exportHeader(entity, timeZone);
  }

  exportPlural(entity: ExportEntity): string {
    return EXPORT_SPECS[entity].plural;
  }

  /**
   * Kanban board for one pipeline (PRD 4.6, DESIGN 6.8): every stage with its count and
   * value per currency, the 50 most recently updated cards per open stage, and deals closed
   * in the last 90 days for the Won and Lost columns. Cards carry an idle flag (PRD 4.6).
   */
  async board(
    user: SessionUser,
    pipelineId: string,
    options: { ownerId?: string | null; q?: string } = {},
  ): Promise<Record<string, unknown>> {
    const params = new SqlParams();
    const scope = scopeWhere(user, 'deals.read', { alias: 'd', startParamIndex: params.next });
    scope.params.forEach((v) => params.add(v));
    const pipeline = params.add(pipelineId);
    const extra: string[] = [];
    if (options.ownerId) {
      extra.push(
        `d.owner_user_id = ${params.add(options.ownerId === '@me' ? user.id : options.ownerId)}`,
      );
    }
    if (options.q) extra.push(ilikeAny(['d.name', 'cmp.name'], options.q, params));
    const where = [
      'd.deleted_at IS NULL',
      `d.pipeline_id = ${pipeline}`,
      scope.sql,
      `(d.stage_category = 'open' OR d.closed_at > NOW() - INTERVAL '90 days')`,
      ...extra,
    ].join(' AND ');

    const [stages, totals, cards] = await Promise.all([
      this.db.query(
        `SELECT id, name, category, probability, stage_order, required_fields, idle_days
         FROM pipeline_stages WHERE pipeline_id = $1 ORDER BY stage_order`,
        [pipelineId],
      ),
      this.db.query<{ stage_id: string; currency: string; n: number; monthly: string }>(
        `SELECT d.stage_id, d.currency, COUNT(*)::int AS n, SUM(d.monthly_value_minor)::text AS monthly
         FROM deals d JOIN companies cmp ON cmp.id = d.company_id
         WHERE ${where} GROUP BY d.stage_id, d.currency`,
        params.values,
      ),
      this.db.query(
        `SELECT * FROM (
           SELECT d.id, d.name, d.stage_id, d.stage_name, d.stage_category, d.company_id,
                  d.primary_contact_id, d.monthly_value_minor, d.currency, d.fte_count,
                  d.probability, d.expected_close_date, d.owner_user_id, d.version,
                  d.updated_at, d.trial_ends_at, d.closed_at, d.last_activity_at,
                  cmp.name AS company_name, cmp.market AS company_market,
                  (d.stage_category = 'open' AND d.last_activity_at < NOW() - make_interval(days => s.idle_days)) AS is_idle,
                  FLOOR(EXTRACT(EPOCH FROM (NOW() - d.last_activity_at)) / 86400)::int AS idle_days,
                  ROW_NUMBER() OVER (PARTITION BY d.stage_id ORDER BY d.updated_at DESC, d.id DESC) AS rn
           FROM deals d
           JOIN companies cmp ON cmp.id = d.company_id
           JOIN pipeline_stages s ON s.id = d.stage_id
           WHERE ${where}
         ) ranked WHERE rn <= 50
         ORDER BY updated_at DESC`,
        params.values,
      ),
    ]);

    return {
      pipelineId,
      stages: stages.rows.map((stage) => {
        const rows = totals.rows.filter((t) => t.stage_id === stage['id']);
        return {
          ...stage,
          count: rows.reduce((sum, r) => sum + r.n, 0),
          totals: rows.map((r) => ({ currency: r.currency, monthlyValueMinor: r.monthly })),
          deals: cards.rows.filter((c) => c['stage_id'] === stage['id']),
        };
      }),
    };
  }
}
