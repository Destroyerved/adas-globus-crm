import { randomUUID } from 'node:crypto';
import {
  CreateScoringRuleInputSchema,
  UpdateScoringRuleInputSchema,
  type ScoreBreakdownItem,
  type ScoringCategory,
  type ScoringFieldPath,
  type ScoringOperator,
  type ScoringRuleView,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { requireCapability } from '../../platform/scope/index.js';

/**
 * Configurable, explainable rule-based scoring for Leads and Contacts (PRD 4.5, 4.16, 4.17, 9).
 * Fit + engagement + negative rules; email opens are never scored.
 */

type Row = Record<string, unknown>;

interface EvalSignals {
  staffBand: string;
  title: string;
  market: string;
  source: string;
  softwareStack: string[];
  servicesNeeded: string[];
  hasCallOrMeeting: boolean;
  missingDomain: boolean;
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function validateOperatorTarget(operator: ScoringOperator, targetValue: unknown): void {
  if (operator === 'isTrue') {
    if (typeof targetValue !== 'boolean') {
      throw new ValidationDomainError('Boolean rules require true or false.', {
        targetValue: ['Choose true or false.'],
      });
    }
    return;
  }
  if (operator === 'in') {
    if (!Array.isArray(targetValue) || targetValue.length === 0) {
      throw new ValidationDomainError('List rules require at least one value.', {
        targetValue: ['Enter at least one comma-separated value.'],
      });
    }
    return;
  }
  if (operator === 'gt') {
    if (typeof targetValue !== 'number' || !Number.isFinite(targetValue)) {
      throw new ValidationDomainError('Numeric rules require a number.', {
        targetValue: ['Enter a number.'],
      });
    }
    return;
  }
  if (typeof targetValue !== 'string' || targetValue.trim().length === 0) {
    throw new ValidationDomainError('Enter a target value to match.', {
      targetValue: ['Enter a non-empty text value.'],
    });
  }
}

export function evaluateRules(
  rules: readonly ScoringRuleView[],
  signals: EvalSignals,
): { score: number; breakdown: ScoreBreakdownItem[] } {
  let rawTotal = 0;
  const breakdown: ScoreBreakdownItem[] = [];

  for (const rule of rules) {
    if (!rule.active) continue;
    let matched = false;
    const target = rule.targetValue;

    const fieldVal = (() => {
      switch (rule.fieldPath) {
        case 'staffBand':
          return signals.staffBand;
        case 'title':
          return signals.title;
        case 'market':
          return signals.market;
        case 'source':
          return signals.source;
        case 'softwareStack':
          return signals.softwareStack;
        case 'servicesNeeded':
          return signals.servicesNeeded;
        case 'hasCallOrMeeting':
          return signals.hasCallOrMeeting;
        case 'missingDomain':
          return signals.missingDomain;
      }
    })();

    if (rule.operator === 'isTrue') {
      matched = Boolean(fieldVal) === Boolean(target);
    } else if (rule.operator === 'eq') {
      const targetStr = String(target).toLowerCase();
      matched = Array.isArray(fieldVal)
        ? fieldVal.some((v) => v.toLowerCase() === targetStr)
        : String(fieldVal).toLowerCase() === targetStr;
    } else if (rule.operator === 'contains') {
      const needle = String(target).toLowerCase();
      matched = Array.isArray(fieldVal)
        ? fieldVal.some((v) => v.toLowerCase().includes(needle))
        : String(fieldVal).toLowerCase().includes(needle);
    } else if (rule.operator === 'in' && Array.isArray(target)) {
      const allowed = new Set(target.map((v) => String(v).toLowerCase()));
      matched = Array.isArray(fieldVal)
        ? fieldVal.some((v) => allowed.has(v.toLowerCase()))
        : allowed.has(String(fieldVal).toLowerCase());
    } else if (rule.operator === 'gt') {
      const n = Number(fieldVal);
      matched = Number.isFinite(n) && n > Number(target);
    }

    if (matched) {
      rawTotal += rule.points;
      breakdown.push({
        ruleId: rule.id,
        ruleName: rule.name,
        category: rule.category,
        points: rule.points,
      });
    }
  }

  return {
    score: Math.max(0, Math.min(100, rawTotal)),
    breakdown,
  };
}

export class LeadScoringService {
  constructor(private readonly db: DatabaseService) {}

  async listRules(user: SessionUser): Promise<{ items: ScoringRuleView[] }> {
    requireCapability(user, 'settings.manage');
    const res = await this.db.query<Row>(
      `SELECT * FROM scoring_rules ORDER BY active DESC, points DESC, created_at ASC`,
    );
    return { items: res.rows.map((r) => this.toView(r)) };
  }

  async createRule(
    user: SessionUser,
    raw: unknown,
    ipAddress: string | null,
  ): Promise<ScoringRuleView> {
    requireCapability(user, 'settings.manage');
    const input = CreateScoringRuleInputSchema.parse(raw);
    validateOperatorTarget(input.operator, input.targetValue);

    const id = `scr_${randomUUID()}`;
    const created = await this.db.transaction(async (tx) => {
      const res = await tx.query<Row>(
        `INSERT INTO scoring_rules (
           id, name, category, field_path, operator, target_value, points, active, version
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 1)
         RETURNING *`,
        [
          id,
          input.name,
          input.category,
          input.fieldPath,
          input.operator,
          JSON.stringify(input.targetValue),
          input.points,
          input.active,
        ],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'scoring_rule.created',
        entityType: 'scoring_rule',
        entityId: id,
        metadata: {
          category: input.category,
          fieldPath: input.fieldPath,
          points: input.points,
        },
        ipAddress,
      });
      return this.toView(res.rows[0] as Row);
    });

    await this.recalculateAll();
    return created;
  }

  async updateRule(
    user: SessionUser,
    id: string,
    raw: unknown,
    ipAddress: string | null,
  ): Promise<ScoringRuleView> {
    requireCapability(user, 'settings.manage');
    const input = UpdateScoringRuleInputSchema.parse(raw);

    const updatedRule = await this.db.transaction(async (tx) => {
      const existing = await tx.query<Row>(`SELECT * FROM scoring_rules WHERE id = $1 FOR UPDATE`, [
        id,
      ]);
      const cur = existing.rows[0];
      if (!cur) throw new NotFoundDomainError('Scoring rule', id);
      if (cur['version'] !== input.version) throw new VersionConflictError('Scoring rule', id);

      const nextOp = (input.operator ?? cur['operator']) as ScoringOperator;
      const nextTarget = input.targetValue !== undefined ? input.targetValue : cur['target_value'];
      validateOperatorTarget(nextOp, nextTarget);

      const res = await tx.query<Row>(
        `UPDATE scoring_rules SET
           name = $3,
           category = $4,
           field_path = $5,
           operator = $6,
           target_value = $7::jsonb,
           points = $8,
           active = $9,
           version = version + 1,
           updated_at = NOW()
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [
          id,
          input.version,
          input.name ?? cur['name'],
          input.category ?? cur['category'],
          input.fieldPath ?? cur['field_path'],
          nextOp,
          JSON.stringify(nextTarget),
          input.points ?? cur['points'],
          input.active ?? cur['active'],
        ],
      );
      const next = res.rows[0];
      if (!next) throw new VersionConflictError('Scoring rule', id);

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'scoring_rule.updated',
        entityType: 'scoring_rule',
        entityId: id,
        metadata: {
          points: next['points'],
          active: next['active'],
        },
        ipAddress,
      });
      return this.toView(next);
    });

    await this.recalculateAll();
    return updatedRule;
  }

  async deleteRule(
    user: SessionUser,
    id: string,
    ipAddress: string | null,
  ): Promise<{ id: string; deleted: true }> {
    requireCapability(user, 'settings.manage');
    await this.db.transaction(async (tx) => {
      const res = await tx.query(`DELETE FROM scoring_rules WHERE id = $1 RETURNING id`, [id]);
      if (res.rowCount === 0) throw new NotFoundDomainError('Scoring rule', id);
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'scoring_rule.deleted',
        entityType: 'scoring_rule',
        entityId: id,
        ipAddress,
      });
    });
    await this.recalculateAll();
    return { id, deleted: true as const };
  }

  async recalculateForAdmin(
    user: SessionUser,
  ): Promise<{ leadsUpdated: number; contactsUpdated: number }> {
    requireCapability(user, 'settings.manage');
    const res = await this.recalculateAll();
    return { leadsUpdated: res.leads, contactsUpdated: res.contacts };
  }

  async evaluateLead(q: Pick<DbTx, 'query'>, leadId: string): Promise<void> {
    const rules = await this.activeRules(q);
    const leadRes = await q.query<Row>(
      `SELECT l.*,
              EXISTS (
                SELECT 1 FROM activities a
                WHERE a.lead_id = l.id AND a.activity_type IN ('call', 'meeting')
              ) AS has_call
       FROM leads l
       WHERE l.id = $1 AND l.deleted_at IS NULL`,
      [leadId],
    );
    const lead = leadRes.rows[0];
    if (!lead) return;
    const evalRes = evaluateRules(rules, {
      staffBand: String(lead['staff_band'] ?? ''),
      title: String(lead['title'] ?? ''),
      market: String(lead['market'] ?? 'US'),
      source: String(lead['source'] ?? ''),
      softwareStack: Array.isArray(lead['software_stack'])
        ? (lead['software_stack'] as unknown[]).map(String)
        : [],
      servicesNeeded: Array.isArray(lead['services_needed'])
        ? (lead['services_needed'] as unknown[]).map(String)
        : [],
      hasCallOrMeeting: Boolean(lead['has_call']),
      missingDomain: !lead['domain'],
    });
    await q.query(
      `UPDATE leads SET lead_score = $2, lead_score_breakdown = $3::jsonb WHERE id = $1`,
      [leadId, evalRes.score, JSON.stringify(evalRes.breakdown)],
    );
  }

  async evaluateContact(q: Pick<DbTx, 'query'>, contactId: string): Promise<void> {
    const rules = await this.activeRules(q);
    const ctRes = await q.query<Row>(
      `SELECT c.*, cmp.staff_band AS cmp_staff_band, cmp.domain AS cmp_domain,
              cmp.accounting_software AS cmp_software, cmp.services_needed AS cmp_services,
              EXISTS (
                SELECT 1 FROM activities a
                WHERE a.contact_id = c.id AND a.activity_type IN ('call', 'meeting')
              ) AS has_call
       FROM contacts c
       LEFT JOIN companies cmp ON cmp.id = c.company_id
       WHERE c.id = $1 AND c.deleted_at IS NULL`,
      [contactId],
    );
    const ct = ctRes.rows[0];
    if (!ct) return;
    const evalRes = evaluateRules(rules, {
      staffBand: String(ct['cmp_staff_band'] ?? ''),
      title: String(ct['title'] ?? ''),
      market: String(ct['market'] ?? 'US'),
      source: String(ct['source'] ?? ''),
      softwareStack: Array.isArray(ct['cmp_software'])
        ? (ct['cmp_software'] as unknown[]).map(String)
        : [],
      servicesNeeded: Array.isArray(ct['cmp_services'])
        ? (ct['cmp_services'] as unknown[]).map(String)
        : [],
      hasCallOrMeeting: Boolean(ct['has_call']),
      missingDomain: !ct['cmp_domain'],
    });
    await q.query(
      `UPDATE contacts SET lead_score = $2, lead_score_breakdown = $3::jsonb WHERE id = $1`,
      [contactId, evalRes.score, JSON.stringify(evalRes.breakdown)],
    );
  }

  async recalculateAll(): Promise<{ leads: number; contacts: number }> {
    const rules = await this.activeRules(this.db);
    const [leadsRes, contactsRes] = await Promise.all([
      this.db.query<Row>(
        `SELECT l.id, l.staff_band, l.title, l.market, l.source, l.software_stack,
                l.services_needed, l.domain,
                EXISTS (
                  SELECT 1 FROM activities a
                  WHERE a.lead_id = l.id AND a.activity_type IN ('call', 'meeting')
                ) AS has_call
         FROM leads l
         WHERE l.deleted_at IS NULL`,
      ),
      this.db.query<Row>(
        `SELECT c.id, c.title, c.market, c.source,
                cmp.staff_band AS cmp_staff_band, cmp.domain AS cmp_domain,
                cmp.accounting_software AS cmp_software, cmp.services_needed AS cmp_services,
                EXISTS (
                  SELECT 1 FROM activities a
                  WHERE a.contact_id = c.id AND a.activity_type IN ('call', 'meeting')
                ) AS has_call
         FROM contacts c
         LEFT JOIN companies cmp ON cmp.id = c.company_id
         WHERE c.deleted_at IS NULL`,
      ),
    ]);

    for (const l of leadsRes.rows) {
      const r = evaluateRules(rules, {
        staffBand: String(l['staff_band'] ?? ''),
        title: String(l['title'] ?? ''),
        market: String(l['market'] ?? 'US'),
        source: String(l['source'] ?? ''),
        softwareStack: Array.isArray(l['software_stack'])
          ? (l['software_stack'] as unknown[]).map(String)
          : [],
        servicesNeeded: Array.isArray(l['services_needed'])
          ? (l['services_needed'] as unknown[]).map(String)
          : [],
        hasCallOrMeeting: Boolean(l['has_call']),
        missingDomain: !l['domain'],
      });
      await this.db.query(
        `UPDATE leads SET lead_score = $2, lead_score_breakdown = $3::jsonb WHERE id = $1`,
        [l['id'], r.score, JSON.stringify(r.breakdown)],
      );
    }

    for (const c of contactsRes.rows) {
      const r = evaluateRules(rules, {
        staffBand: String(c['cmp_staff_band'] ?? ''),
        title: String(c['title'] ?? ''),
        market: String(c['market'] ?? 'US'),
        source: String(c['source'] ?? ''),
        softwareStack: Array.isArray(c['cmp_software'])
          ? (c['cmp_software'] as unknown[]).map(String)
          : [],
        servicesNeeded: Array.isArray(c['cmp_services'])
          ? (c['cmp_services'] as unknown[]).map(String)
          : [],
        hasCallOrMeeting: Boolean(c['has_call']),
        missingDomain: !c['cmp_domain'],
      });
      await this.db.query(
        `UPDATE contacts SET lead_score = $2, lead_score_breakdown = $3::jsonb WHERE id = $1`,
        [c['id'], r.score, JSON.stringify(r.breakdown)],
      );
    }

    return { leads: leadsRes.rows.length, contacts: contactsRes.rows.length };
  }

  private async activeRules(q: Pick<DbTx, 'query'>): Promise<ScoringRuleView[]> {
    const res = await q.query<Row>(
      `SELECT * FROM scoring_rules WHERE active = TRUE ORDER BY points DESC, created_at ASC`,
    );
    return res.rows.map((r) => this.toView(r));
  }

  private toView(row: Row): ScoringRuleView {
    return {
      id: String(row['id']),
      name: String(row['name']),
      category: row['category'] as ScoringCategory,
      fieldPath: row['field_path'] as ScoringFieldPath,
      operator: row['operator'] as ScoringOperator,
      targetValue: row['target_value'],
      points: Number(row['points']),
      active: Boolean(row['active']),
      version: Number(row['version'] ?? 1),
      createdAt: iso(row['created_at']),
      updatedAt: iso(row['updated_at'] ?? row['created_at']),
    };
  }
}
