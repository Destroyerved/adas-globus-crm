import { randomUUID } from 'node:crypto';
import {
  CreateStageInputSchema,
  CreateTeamInputSchema,
  InviteUserInputSchema,
  MoveStageInputSchema,
  NUMBER_SETTING_KEYS,
  REFERENCE_LIST_KEYS,
  UpdateRoleCapabilitiesInputSchema,
  UpdateSettingInputSchema,
  UpdateStageInputSchema,
  UpdateTeamInputSchema,
  UpdateUserInputSchema,
  UpsertFxRateInputSchema,
  parseFxRateScaled,
  settingValueSchema,
  type Currency,
  type FxRateView,
  type SessionUser,
  type UserRoleName,
} from '@adas/shared';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import {
  ROLE_CAPABILITY_MATRIX,
  requireCapability,
  type CapabilityScopeValue,
} from '../../platform/scope/index.js';

type Row = Record<string, unknown>;

/** Capabilities the Admin role must keep at "all", so nobody can lock the CRM out. */
const ADMIN_LOCKED_CAPABILITIES = [
  'users.manage',
  'settings.manage',
  'audit.read',
  'privacy.manage',
] as const;
const ADMIN_ROLE_ID = 'role_admin';

const EDITABLE_SETTING_KEYS: readonly string[] = [...REFERENCE_LIST_KEYS, ...NUMBER_SETTING_KEYS];

function conflict(code: string, detail: string, fieldErrors?: Record<string, string[]>) {
  return new DomainError({ status: 409, code, title: 'Conflict', detail, fieldErrors });
}

/**
 * Administration (PRD 2.1, 2.2, 3.3, 3.4, 4.17, 6.6). Every change is checked against the
 * caller's capability in the API, versioned, and written to the audit log (PRD 9).
 */
export class AdminService {
  constructor(private readonly db: DatabaseService) {}

  // -------------------------------------------------------------------------
  // Users (PRD 4.17, 6.6: invite-only, deactivation revokes sessions)
  // -------------------------------------------------------------------------

  async listUsers(actor: SessionUser): Promise<{ items: Row[] }> {
    requireCapability(actor, 'users.manage');
    const res = await this.db.query(
      `SELECT u.id, u.email, u.name, u.role_id, r.name AS role_name, u.team_id,
              t.name AS team_name, u.market_focus, u.status, u.timezone, u.daily_send_cap,
              u.is_break_glass, u.version, u.created_at,
              (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS last_sign_in_at
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN teams t ON t.id = u.team_id
       ORDER BY (u.status = 'disabled'), u.name ASC`,
    );
    return { items: res.rows };
  }

  async inviteUser(actor: SessionUser, raw: unknown, ip: string | null): Promise<Row> {
    requireCapability(actor, 'users.manage');
    const input = InviteUserInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const existing = await tx.query(`SELECT id FROM users WHERE LOWER(email) = $1`, [
        input.email,
      ]);
      if (existing.rows.length > 0) {
        throw conflict('USER_EXISTS', 'Someone with this email is already a CRM user.', {
          email: ['This email is already a CRM user.'],
        });
      }
      await this.requireRoleAndTeam(tx, input.roleId, input.teamId);
      const id = `usr_${randomUUID()}`;
      await tx.query(
        `INSERT INTO users (id, email, name, role_id, team_id, market_focus, timezone, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'invited')`,
        [
          id,
          input.email,
          input.name,
          input.roleId,
          input.teamId,
          input.marketFocus,
          input.timezone,
        ],
      );
      await this.audit(tx, actor, ip, 'user.invited', 'user', id, {
        roleId: input.roleId,
        teamId: input.teamId,
      });
      return this.userRow(tx, id);
    });
  }

  async updateUser(actor: SessionUser, userId: string, raw: unknown, ip: string | null) {
    requireCapability(actor, 'users.manage');
    const input = UpdateUserInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{
          id: string;
          name: string;
          role_id: string;
          team_id: string | null;
          market_focus: string;
          timezone: string;
          daily_send_cap: number;
          status: string;
          version: number;
          entra_object_id: string | null;
          is_break_glass: boolean;
        }>(`SELECT * FROM users WHERE id = $1 FOR UPDATE`, [userId])
      ).rows[0];
      if (!current) throw new NotFoundDomainError('User', userId);
      if (current.version !== input.version) throw new VersionConflictError('User', userId);

      const self = userId === actor.id;
      const roleChanges = input.roleId !== undefined && input.roleId !== current.role_id;
      const deactivating = input.status === 'disabled' && current.status !== 'disabled';
      const reactivating = input.status === 'active' && current.status === 'disabled';
      if (self && (roleChanges || deactivating)) {
        throw new ValidationDomainError("You can't change your own role or deactivate yourself.", {
          [roleChanges ? 'roleId' : 'status']: ['Ask another admin to make this change.'],
        });
      }
      if (current.role_id === ADMIN_ROLE_ID && (roleChanges || deactivating)) {
        const others = await tx.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM users
           WHERE role_id = $1 AND status = 'active' AND id <> $2`,
          [ADMIN_ROLE_ID, userId],
        );
        if (Number(others.rows[0]?.n ?? 0) === 0) {
          throw new ValidationDomainError('The CRM needs at least one active admin.', {
            [roleChanges ? 'roleId' : 'status']: ['Make someone else an admin first.'],
          });
        }
      }
      const teamChanges = input.teamId !== undefined && input.teamId !== current.team_id;
      if (roleChanges || teamChanges) {
        await this.requireRoleAndTeam(
          tx,
          input.roleId ?? current.role_id,
          input.teamId === undefined ? current.team_id : input.teamId,
        );
      }

      const nextStatus = deactivating
        ? 'disabled'
        : reactivating
          ? current.entra_object_id || current.is_break_glass
            ? 'active'
            : 'invited'
          : current.status;
      const next = {
        name: input.name ?? current.name,
        role_id: input.roleId ?? current.role_id,
        team_id: input.teamId === undefined ? current.team_id : input.teamId,
        market_focus: input.marketFocus ?? current.market_focus,
        timezone: input.timezone ?? current.timezone,
        daily_send_cap: input.dailySendCap ?? current.daily_send_cap,
        status: nextStatus,
      };
      const changed = (Object.keys(next) as (keyof typeof next)[]).filter(
        (k) => next[k] !== current[k],
      );
      if (changed.length === 0) return this.userRow(tx, userId);

      await tx.query(
        `UPDATE users SET name = $3, role_id = $4, team_id = $5, market_focus = $6, timezone = $7,
                daily_send_cap = $8, status = $9, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2`,
        [
          userId,
          input.version,
          next.name,
          next.role_id,
          next.team_id,
          next.market_focus,
          next.timezone,
          next.daily_send_cap,
          next.status,
        ],
      );

      let revokedSessions = 0;
      if (deactivating) {
        // PRD 6.6: deactivating a user revokes all their sessions at once.
        const revoked = await tx.query(
          `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
          [userId],
        );
        revokedSessions = revoked.rowCount ?? 0;
      }

      let movedRecords: Record<string, number> = {};
      if (teamChanges) {
        // Team scope follows the owner (PRD 2.2): records move with the person to the new team.
        movedRecords = await this.moveOwnedRecordsToTeam(tx, userId, next.team_id);
      }

      const fields = changed.filter((k) => k !== 'status' && k !== 'role_id');
      if (fields.length > 0) {
        await this.audit(tx, actor, ip, 'user.updated', 'user', userId, {
          fields,
          ...(teamChanges
            ? { fromTeamId: current.team_id, toTeamId: next.team_id, movedRecords }
            : {}),
        });
      }
      if (roleChanges) {
        await this.audit(tx, actor, ip, 'user.role_changed', 'user', userId, {
          fromRoleId: current.role_id,
          toRoleId: next.role_id,
        });
      }
      if (deactivating) {
        await this.audit(tx, actor, ip, 'user.deactivated', 'user', userId, { revokedSessions });
      }
      if (reactivating) {
        await this.audit(tx, actor, ip, 'user.reactivated', 'user', userId, {});
      }
      return this.userRow(tx, userId);
    });
  }

  private async moveOwnedRecordsToTeam(
    tx: DbTx,
    userId: string,
    teamId: string | null,
  ): Promise<Record<string, number>> {
    const moved: Record<string, number> = {};
    for (const [table, column] of [
      ['leads', 'owner_user_id'],
      ['contacts', 'owner_user_id'],
      ['companies', 'owner_user_id'],
      ['deals', 'owner_user_id'],
      ['tasks', 'assignee_user_id'],
    ] as const) {
      const res = await tx.query(
        `UPDATE ${table} SET team_id = $2 WHERE ${column} = $1 AND team_id IS DISTINCT FROM $2`,
        [userId, teamId],
      );
      moved[table] = res.rowCount ?? 0;
    }
    return moved;
  }

  private async userRow(tx: DbTx, id: string): Promise<Row> {
    const res = await tx.query(
      `SELECT u.id, u.email, u.name, u.role_id, r.name AS role_name, u.team_id,
              t.name AS team_name, u.market_focus, u.status, u.timezone, u.daily_send_cap,
              u.is_break_glass, u.version, u.created_at
       FROM users u JOIN roles r ON r.id = u.role_id LEFT JOIN teams t ON t.id = u.team_id
       WHERE u.id = $1`,
      [id],
    );
    return res.rows[0] ?? { id };
  }

  private async requireRoleAndTeam(tx: DbTx, roleId: string, teamId: string | null) {
    const role = await tx.query(`SELECT id FROM roles WHERE id = $1`, [roleId]);
    if (role.rows.length === 0) {
      throw new ValidationDomainError('Choose a role from the list.', {
        roleId: ['Choose a role from the list.'],
      });
    }
    if (teamId !== null) {
      const team = await tx.query(`SELECT id FROM teams WHERE id = $1`, [teamId]);
      if (team.rows.length === 0) {
        throw new ValidationDomainError('Choose a team from the list.', {
          teamId: ['Choose a team from the list.'],
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Teams (PRD 2.1)
  // -------------------------------------------------------------------------

  async listTeams(actor: SessionUser): Promise<{ items: Row[] }> {
    requireCapability(actor, 'users.manage');
    const res = await this.db.query(
      `SELECT t.id, t.name, t.market, t.version, t.created_at,
              (SELECT COUNT(*)::int FROM users u WHERE u.team_id = t.id AND u.status <> 'disabled') AS member_count
       FROM teams t ORDER BY t.name`,
    );
    return { items: res.rows };
  }

  async createTeam(actor: SessionUser, raw: unknown, ip: string | null): Promise<Row> {
    requireCapability(actor, 'users.manage');
    const input = CreateTeamInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      await this.requireUniqueTeamName(tx, input.name, null);
      const id = `team_${randomUUID()}`;
      const res = await tx.query(
        `INSERT INTO teams (id, name, market) VALUES ($1, $2, $3) RETURNING *`,
        [id, input.name, input.market],
      );
      await this.audit(tx, actor, ip, 'team.created', 'team', id, { market: input.market });
      return { ...res.rows[0], member_count: 0 };
    });
  }

  async updateTeam(actor: SessionUser, teamId: string, raw: unknown, ip: string | null) {
    requireCapability(actor, 'users.manage');
    const input = UpdateTeamInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      if (input.name !== undefined) await this.requireUniqueTeamName(tx, input.name, teamId);
      const res = await tx.query(
        `UPDATE teams SET name = COALESCE($3, name), market = COALESCE($4, market),
                version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 RETURNING *`,
        [teamId, input.version, input.name ?? null, input.market ?? null],
      );
      if (!res.rows[0]) {
        const exists = await tx.query(`SELECT id FROM teams WHERE id = $1`, [teamId]);
        if (exists.rows.length === 0) throw new NotFoundDomainError('Team', teamId);
        throw new VersionConflictError('Team', teamId);
      }
      await this.audit(tx, actor, ip, 'team.updated', 'team', teamId, {
        fields: Object.keys(input).filter((k) => k !== 'version'),
      });
      return res.rows[0];
    });
  }

  private async requireUniqueTeamName(tx: DbTx, name: string, exceptId: string | null) {
    const dup = await tx.query(
      `SELECT id FROM teams WHERE LOWER(name) = LOWER($1) AND id IS DISTINCT FROM $2`,
      [name, exceptId],
    );
    if (dup.rows.length > 0) {
      throw conflict('TEAM_EXISTS', 'A team with this name already exists.', {
        name: ['A team with this name already exists.'],
      });
    }
  }

  // -------------------------------------------------------------------------
  // Roles and capabilities (PRD 2.1, 2.2)
  // -------------------------------------------------------------------------

  async listRoles(actor: SessionUser): Promise<{ items: Row[]; capabilities: string[] }> {
    requireCapability(actor, 'users.manage');
    const [roles, overrides] = await Promise.all([
      this.db.query<{ id: string; name: string; description: string; user_count: number }>(
        `SELECT r.id, r.name, r.description,
                (SELECT COUNT(*)::int FROM users u WHERE u.role_id = r.id AND u.status <> 'disabled') AS user_count
         FROM roles r ORDER BY r.created_at, r.name`,
      ),
      this.db.query<{ role_id: string; capability: string; scope: CapabilityScopeValue }>(
        `SELECT role_id, capability, scope FROM role_capabilities`,
      ),
    ]);
    const capabilities = Object.keys(ROLE_CAPABILITY_MATRIX.Admin);
    const items = roles.rows.map((role) => {
      const defaults = ROLE_CAPABILITY_MATRIX[role.name as UserRoleName] ?? {};
      const grants: Record<string, CapabilityScopeValue> = {};
      for (const cap of capabilities) grants[cap] = defaults[cap] ?? 'none';
      const changed: string[] = [];
      for (const o of overrides.rows) {
        if (o.role_id !== role.id) continue;
        grants[o.capability] = o.scope;
        if ((defaults[o.capability] ?? 'none') !== o.scope) changed.push(o.capability);
      }
      return {
        ...role,
        grants,
        changed,
        locked: role.id === ADMIN_ROLE_ID ? [...ADMIN_LOCKED_CAPABILITIES] : [],
      };
    });
    return { items, capabilities };
  }

  async updateRoleCapabilities(
    actor: SessionUser,
    roleId: string,
    raw: unknown,
    ip: string | null,
  ) {
    requireCapability(actor, 'users.manage');
    const input = UpdateRoleCapabilitiesInputSchema.parse(raw);
    const known = new Set(Object.keys(ROLE_CAPABILITY_MATRIX.Admin));
    const unknown = Object.keys(input.grants).filter((c) => !known.has(c));
    if (unknown.length > 0) {
      throw new ValidationDomainError(`Unknown capability: ${unknown.join(', ')}.`);
    }
    if (roleId === ADMIN_ROLE_ID) {
      const lowered = ADMIN_LOCKED_CAPABILITIES.filter(
        (c) => input.grants[c] !== undefined && input.grants[c] !== 'all',
      );
      if (lowered.length > 0) {
        throw new ValidationDomainError(
          'The Admin role must keep full access to users, settings and the audit log, so no one is locked out.',
        );
      }
    }
    await this.db.transaction(async (tx) => {
      const role = await tx.query<{ name: string }>(`SELECT name FROM roles WHERE id = $1`, [
        roleId,
      ]);
      const name = role.rows[0]?.name;
      if (!name) throw new NotFoundDomainError('Role', roleId);
      const defaults = ROLE_CAPABILITY_MATRIX[name as UserRoleName] ?? {};
      const before = await tx.query<{ capability: string; scope: string }>(
        `SELECT capability, scope FROM role_capabilities WHERE role_id = $1`,
        [roleId],
      );
      const previous = new Map(before.rows.map((r) => [r.capability, r.scope]));
      const changes: { capability: string; from: string; to: string }[] = [];
      for (const [capability, scope] of Object.entries(input.grants)) {
        const from = previous.get(capability) ?? defaults[capability] ?? 'none';
        if (from === scope) continue;
        changes.push({ capability, from, to: scope });
        if ((defaults[capability] ?? 'none') === scope) {
          await tx.query(`DELETE FROM role_capabilities WHERE role_id = $1 AND capability = $2`, [
            roleId,
            capability,
          ]);
        } else {
          await tx.query(
            `INSERT INTO role_capabilities (role_id, capability, scope) VALUES ($1, $2, $3)
             ON CONFLICT (role_id, capability) DO UPDATE SET scope = EXCLUDED.scope`,
            [roleId, capability, scope],
          );
        }
      }
      if (changes.length > 0) {
        await this.audit(tx, actor, ip, 'role.capabilities_changed', 'role', roleId, { changes });
      }
    });
    const roles = await this.listRoles(actor);
    return roles.items.find((r) => r['id'] === roleId) ?? { id: roleId };
  }

  // -------------------------------------------------------------------------
  // Pipelines and stages (PRD 3.3)
  // -------------------------------------------------------------------------

  async listPipelines(actor: SessionUser): Promise<{ items: Row[] }> {
    requireCapability(actor, 'settings.manage');
    const [pipelines, stages] = await Promise.all([
      this.db.query(`SELECT id, name, is_default FROM pipelines ORDER BY is_default DESC, name`),
      this.db.query(
        `SELECT s.id, s.pipeline_id, s.name, s.category, s.probability, s.stage_order,
                s.required_fields, s.idle_days, s.is_trial, s.version,
                (SELECT COUNT(*)::int FROM deals d WHERE d.stage_id = s.id AND d.deleted_at IS NULL) AS deal_count
         FROM pipeline_stages s ORDER BY s.pipeline_id, s.stage_order`,
      ),
    ]);
    return {
      items: pipelines.rows.map((p) => ({
        ...p,
        stages: stages.rows.filter((s) => s['pipeline_id'] === p['id']),
      })),
    };
  }

  async updateStage(actor: SessionUser, stageId: string, raw: unknown, ip: string | null) {
    requireCapability(actor, 'settings.manage');
    const input = UpdateStageInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const stage = await this.lockStage(tx, stageId, input.version);
      if (input.name !== undefined && input.name !== stage.name) {
        const dup = await tx.query(
          `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND LOWER(name) = LOWER($2) AND id <> $3`,
          [stage.pipeline_id, input.name, stageId],
        );
        if (dup.rows.length > 0) {
          throw conflict('STAGE_EXISTS', 'This pipeline already has a stage with that name.', {
            name: ['This pipeline already has a stage with that name.'],
          });
        }
      }
      if (input.requiredFields && stage.category === 'lost') {
        if (!input.requiredFields.includes('lost_reason')) {
          throw new ValidationDomainError('Lost stages always need a reason.', {
            requiredFields: ['Lost stages always need a reason.'],
          });
        }
      }
      if (input.isTrial && stage.category !== 'open') {
        throw new ValidationDomainError('Only an open stage can be the free trial stage.', {
          isTrial: ['Only an open stage can be the free trial stage.'],
        });
      }
      if (input.probability !== undefined && stage.category !== 'open') {
        const fixed = stage.category === 'won' ? 100 : 0;
        if (input.probability !== fixed) {
          throw new ValidationDomainError(`${stage.name} is always ${fixed}%.`, {
            probability: [`Won stages are 100% and lost stages are 0%.`],
          });
        }
      }

      const res = await tx.query(
        `UPDATE pipeline_stages
         SET name = COALESCE($2, name), probability = COALESCE($3, probability),
             idle_days = COALESCE($4, idle_days),
             required_fields = COALESCE($5::jsonb, required_fields),
             is_trial = COALESCE($6, is_trial),
             version = version + 1, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [
          stageId,
          input.name ?? null,
          input.probability ?? null,
          input.idleDays ?? null,
          input.requiredFields ? JSON.stringify(input.requiredFields) : null,
          input.isTrial ?? null,
        ],
      );
      if (input.isTrial) {
        // One free trial stage per pipeline.
        await tx.query(
          `UPDATE pipeline_stages SET is_trial = FALSE, version = version + 1, updated_at = NOW()
           WHERE pipeline_id = $1 AND id <> $2 AND is_trial`,
          [stage.pipeline_id, stageId],
        );
      }
      const effects: Record<string, number> = {};
      if (input.name !== undefined && input.name !== stage.name) {
        // deals.stage_name is a copy for fast lists; keep it in step.
        const renamed = await tx.query(`UPDATE deals SET stage_name = $2 WHERE stage_id = $1`, [
          stageId,
          input.name,
        ]);
        effects['dealsRenamed'] = renamed.rowCount ?? 0;
      }
      if (input.probability !== undefined && input.probability !== stage.probability) {
        // Open deals follow the stage default unless someone set their own probability.
        const reprobabled = await tx.query(
          `UPDATE deals SET probability = $2
           WHERE stage_id = $1 AND probability_override = FALSE AND deleted_at IS NULL`,
          [stageId, input.probability],
        );
        effects['dealsReweighted'] = reprobabled.rowCount ?? 0;
      }
      await this.audit(tx, actor, ip, 'pipeline.stage_updated', 'pipeline_stage', stageId, {
        pipelineId: stage.pipeline_id,
        fields: Object.keys(input).filter((k) => k !== 'version'),
        ...effects,
      });
      return res.rows[0] ?? { id: stageId };
    });
  }

  async createStage(actor: SessionUser, pipelineId: string, raw: unknown, ip: string | null) {
    requireCapability(actor, 'settings.manage');
    const input = CreateStageInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const pipeline = await tx.query(`SELECT id FROM pipelines WHERE id = $1 FOR UPDATE`, [
        pipelineId,
      ]);
      if (pipeline.rows.length === 0) throw new NotFoundDomainError('Pipeline', pipelineId);
      const dup = await tx.query(
        `SELECT id FROM pipeline_stages WHERE pipeline_id = $1 AND LOWER(name) = LOWER($2)`,
        [pipelineId, input.name],
      );
      if (dup.rows.length > 0) {
        throw conflict('STAGE_EXISTS', 'This pipeline already has a stage with that name.', {
          name: ['This pipeline already has a stage with that name.'],
        });
      }
      // New stages are open and go just before the first won or lost stage.
      const position = await tx.query<{ pos: number | null }>(
        `SELECT MIN(stage_order) AS pos FROM pipeline_stages
         WHERE pipeline_id = $1 AND category <> 'open'`,
        [pipelineId],
      );
      const fallback = await tx.query<{ pos: number | null }>(
        `SELECT COALESCE(MAX(stage_order), 0) + 1 AS pos FROM pipeline_stages WHERE pipeline_id = $1`,
        [pipelineId],
      );
      const order = position.rows[0]?.pos ?? fallback.rows[0]?.pos ?? 1;
      await tx.query(
        `UPDATE pipeline_stages SET stage_order = stage_order + 1
         WHERE pipeline_id = $1 AND stage_order >= $2`,
        [pipelineId, order],
      );
      const id = `stg_${randomUUID()}`;
      const res = await tx.query(
        `INSERT INTO pipeline_stages (id, pipeline_id, name, category, probability, stage_order, idle_days)
         VALUES ($1, $2, $3, 'open', $4, $5, $6) RETURNING *`,
        [id, pipelineId, input.name, input.probability, order, input.idleDays],
      );
      await this.audit(tx, actor, ip, 'pipeline.stage_added', 'pipeline_stage', id, {
        pipelineId,
      });
      return { ...res.rows[0], deal_count: 0 };
    });
  }

  async moveStage(actor: SessionUser, stageId: string, raw: unknown, ip: string | null) {
    requireCapability(actor, 'settings.manage');
    const input = MoveStageInputSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const stage = await this.lockStage(tx, stageId, input.version);
      if (stage.category !== 'open') {
        throw new ValidationDomainError('Won and lost stages stay at the end of the pipeline.');
      }
      const neighbour = await tx.query<{ id: string; stage_order: number }>(
        `SELECT id, stage_order FROM pipeline_stages
         WHERE pipeline_id = $1 AND category = 'open'
           AND stage_order ${input.direction === 'up' ? '<' : '>'} $2
         ORDER BY stage_order ${input.direction === 'up' ? 'DESC' : 'ASC'} LIMIT 1 FOR UPDATE`,
        [stage.pipeline_id, stage.stage_order],
      );
      const other = neighbour.rows[0];
      if (!other) return { id: stageId, moved: false };
      await tx.query(
        `UPDATE pipeline_stages SET stage_order = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
        [stageId, other.stage_order],
      );
      await tx.query(
        `UPDATE pipeline_stages SET stage_order = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
        [other.id, stage.stage_order],
      );
      await this.audit(tx, actor, ip, 'pipeline.stage_reordered', 'pipeline_stage', stageId, {
        pipelineId: stage.pipeline_id,
        direction: input.direction,
      });
      return { id: stageId, moved: true };
    });
  }

  async deleteStage(actor: SessionUser, stageId: string, ip: string | null) {
    requireCapability(actor, 'settings.manage');
    return this.db.transaction(async (tx) => {
      const stage = (
        await tx.query<{ pipeline_id: string; category: string; name: string }>(
          `SELECT pipeline_id, category, name FROM pipeline_stages WHERE id = $1 FOR UPDATE`,
          [stageId],
        )
      ).rows[0];
      if (!stage) throw new NotFoundDomainError('Stage', stageId);
      if (stage.category !== 'open') {
        throw new ValidationDomainError('Every pipeline keeps its won and lost stages.');
      }
      const deals = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM deals WHERE stage_id = $1`,
        [stageId],
      );
      if ((deals.rows[0]?.n ?? 0) > 0) {
        throw conflict(
          'STAGE_IN_USE',
          `Move the deals out of ${stage.name} before removing it. Deleted deals still count, because they can be restored.`,
        );
      }
      const open = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM pipeline_stages WHERE pipeline_id = $1 AND category = 'open'`,
        [stage.pipeline_id],
      );
      if ((open.rows[0]?.n ?? 0) <= 1) {
        throw new ValidationDomainError('A pipeline needs at least one open stage.');
      }
      await tx.query(`DELETE FROM pipeline_stages WHERE id = $1`, [stageId]);
      await this.audit(tx, actor, ip, 'pipeline.stage_deleted', 'pipeline_stage', stageId, {
        pipelineId: stage.pipeline_id,
        name: stage.name,
      });
      return { id: stageId, deleted: true };
    });
  }

  private async lockStage(tx: DbTx, stageId: string, version: number) {
    const stage = (
      await tx.query<{
        id: string;
        pipeline_id: string;
        name: string;
        category: string;
        probability: number;
        stage_order: number;
        version: number;
      }>(`SELECT * FROM pipeline_stages WHERE id = $1 FOR UPDATE`, [stageId])
    ).rows[0];
    if (!stage) throw new NotFoundDomainError('Stage', stageId);
    if (stage.version !== version) throw new VersionConflictError('Stage', stageId);
    return stage;
  }

  // -------------------------------------------------------------------------
  // Reference lists and defaults (PRD 3.4, 4.17)
  // -------------------------------------------------------------------------

  async listSettings(actor: SessionUser): Promise<{ items: Row[] }> {
    requireCapability(actor, 'settings.manage');
    const res = await this.db.query(
      `SELECT s.key, s.value_json AS value, s.version, s.updated_at, u.name AS updated_by_name
       FROM settings s LEFT JOIN users u ON u.id = s.updated_by_user_id
       WHERE s.key = ANY($1::text[]) ORDER BY s.key`,
      [EDITABLE_SETTING_KEYS],
    );
    return { items: res.rows };
  }

  async updateSetting(actor: SessionUser, key: string, raw: unknown, ip: string | null) {
    requireCapability(actor, 'settings.manage');
    const schema = settingValueSchema(key);
    if (!schema) throw new NotFoundDomainError('Setting', key);
    const input = UpdateSettingInputSchema.parse(raw);
    const parsed = schema.safeParse(input.value);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'Check the value.';
      throw new ValidationDomainError(message, { value: [message] });
    }
    return this.db.transaction(async (tx) => {
      const current = (
        await tx.query<{ value_json: unknown; version: number }>(
          `SELECT value_json, version FROM settings WHERE key = $1 FOR UPDATE`,
          [key],
        )
      ).rows[0];
      if (!current) throw new NotFoundDomainError('Setting', key);
      if (current.version !== input.version) throw new VersionConflictError('Setting', key);
      const res = await tx.query(
        `UPDATE settings SET value_json = $2::jsonb, updated_by_user_id = $3, version = version + 1,
                updated_at = NOW()
         WHERE key = $1 RETURNING key, value_json AS value, version, updated_at`,
        [key, JSON.stringify(parsed.data), actor.id],
      );
      await this.audit(tx, actor, ip, 'settings.changed', 'setting', key, {
        before: current.value_json,
        after: parsed.data,
      });
      return { ...res.rows[0], updated_by_name: actor.name };
    });
  }

  // -------------------------------------------------------------------------
  // Audit log viewer (PRD 4.17, 9)
  // -------------------------------------------------------------------------

  async listAuditLogs(
    actor: SessionUser,
    query: URLSearchParams,
  ): Promise<{ items: Row[]; nextCursor: string | null }> {
    const scope = requireCapability(actor, 'audit.read');
    const limitRaw = Number(query.get('limit') ?? 50);
    const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: (p: string) => string, value: unknown) => {
      params.push(value);
      where.push(sql(`$${params.length}`));
    };
    // Managers hold audit.read with team scope: their own team's actions only.
    if (scope !== 'all')
      add((p) => `a.actor_user_id = ANY(${p}::text[])`, [actor.id, ...actor.teamMemberIds]);
    const action = query.get('action');
    if (action) add((p) => `a.action = ${p}`, action.slice(0, 80));
    const actorId = query.get('actor');
    if (actorId) add((p) => `a.actor_user_id = ${p}`, actorId.slice(0, 80));
    const entityType = query.get('entityType');
    if (entityType) add((p) => `a.entity_type = ${p}`, entityType.slice(0, 40));
    const entityId = query.get('entityId');
    if (entityId) add((p) => `a.entity_id = ${p}`, entityId.slice(0, 80));
    const tz = actor.timezone ?? 'UTC';
    const from = query.get('from');
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      params.push(tz);
      const tzParam = `$${params.length}`;
      add((p) => `a.created_at >= (${p}::date)::timestamp AT TIME ZONE ${tzParam}`, from);
    }
    const to = query.get('to');
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      params.push(tz);
      const tzParam = `$${params.length}`;
      add((p) => `a.created_at < ((${p}::date) + 1)::timestamp AT TIME ZONE ${tzParam}`, to);
    }
    const cursor = query.get('cursor');
    if (cursor) {
      const [at, id] = cursor.split('|');
      if (!at || !id || Number.isNaN(Date.parse(at))) {
        throw new ValidationDomainError('The page cursor is not valid. Reload the list.');
      }
      params.push(at);
      const atParam = `$${params.length}`;
      add((p) => `(a.created_at, a.id) < (${atParam}::timestamptz, ${p}::text)`, id);
    }
    params.push(limit + 1);
    const res = await this.db.query<Row & { at_cursor: string; id: string }>(
      `SELECT a.id, a.actor_user_id, a.actor_email, u.name AS actor_name, a.action, a.entity_type,
              a.entity_id, a.metadata, a.ip_address, a.created_at, a.created_at::text AS at_cursor
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, limit);
    const last = rows[rows.length - 1];
    return {
      items: rows.map(({ at_cursor: _cursor, ...rest }) => rest),
      nextCursor: res.rows.length > limit && last ? `${last.at_cursor}|${last.id}` : null,
    };
  }

  async auditActions(actor: SessionUser): Promise<{ items: string[] }> {
    requireCapability(actor, 'audit.read');
    const res = await this.db.query<{ action: string }>(
      `SELECT DISTINCT action FROM audit_logs ORDER BY action`,
    );
    return { items: res.rows.map((r) => r.action) };
  }

  async listFxRates(
    actor: SessionUser,
  ): Promise<{ reportingCurrency: Currency; items: FxRateView[] }> {
    requireCapability(actor, 'settings.manage');
    const [ratesRes, repRes] = await Promise.all([
      this.db.query<{
        id: string;
        from_currency: Currency;
        to_currency: Currency;
        rate_scaled: string | number;
        effective_date: string;
        created_at: Date | string;
      }>(
        `SELECT id, from_currency, to_currency, rate_scaled::text AS rate_scaled, effective_date, created_at
         FROM fx_rates
         WHERE from_currency <> to_currency
         ORDER BY effective_date DESC, from_currency ASC`,
      ),
      this.db.query<{ value_json: unknown }>(
        `SELECT value_json FROM settings WHERE key = 'reporting.currency'`,
      ),
    ]);
    const reportingCurrency: Currency = repRes.rows[0]?.value_json === 'CAD' ? 'CAD' : 'USD';
    return {
      reportingCurrency,
      items: ratesRes.rows.map((r) => ({
        id: r.id,
        fromCurrency: r.from_currency,
        toCurrency: r.to_currency,
        rateScaled: String(r.rate_scaled),
        effectiveDate: r.effective_date,
        createdAt:
          r.created_at instanceof Date
            ? r.created_at.toISOString()
            : new Date(String(r.created_at)).toISOString(),
      })),
    };
  }

  async upsertFxRate(
    actor: SessionUser,
    raw: unknown,
    ip: string | null,
  ): Promise<{ rate: FxRateView }> {
    requireCapability(actor, 'settings.manage');
    const input = UpsertFxRateInputSchema.parse(raw);
    const scaled = parseFxRateScaled(input.rateText);
    if (scaled === null) {
      throw new ValidationDomainError('Enter a valid positive exchange rate.', {
        rateText: ['Enter a positive rate with up to 6 decimal places.'],
      });
    }
    const reciprocalScaled = (1_000_000_000_000n + scaled / 2n) / scaled;

    return this.db.transaction(async (tx) => {
      const id = `fx_${randomUUID()}`;
      const res = await tx.query<{
        id: string;
        from_currency: Currency;
        to_currency: Currency;
        rate_scaled: string;
        effective_date: string;
        created_at: Date | string;
      }>(
        `INSERT INTO fx_rates (id, from_currency, to_currency, rate_scaled, effective_date, created_by_user_id)
         VALUES ($1, $2, $3, $4::bigint, $5, $6)
         ON CONFLICT (from_currency, to_currency, effective_date)
         DO UPDATE SET rate_scaled = EXCLUDED.rate_scaled, created_by_user_id = EXCLUDED.created_by_user_id
         RETURNING id, from_currency, to_currency, rate_scaled::text AS rate_scaled, effective_date, created_at`,
        [
          id,
          input.fromCurrency,
          input.toCurrency,
          scaled.toString(),
          input.effectiveDate,
          actor.id,
        ],
      );
      const saved = res.rows[0];
      if (!saved) throw new NotFoundDomainError('FX rate', id);

      if (reciprocalScaled > 0n) {
        await tx.query(
          `INSERT INTO fx_rates (id, from_currency, to_currency, rate_scaled, effective_date, created_by_user_id)
           VALUES ($1, $2, $3, $4::bigint, $5, $6)
           ON CONFLICT (from_currency, to_currency, effective_date) DO NOTHING`,
          [
            `fx_${randomUUID()}`,
            input.toCurrency,
            input.fromCurrency,
            reciprocalScaled.toString(),
            input.effectiveDate,
            actor.id,
          ],
        );
      }

      await this.audit(tx, actor, ip, 'fx_rate.upserted', 'fx_rate', saved.id, {
        fromCurrency: input.fromCurrency,
        toCurrency: input.toCurrency,
        rateScaled: scaled.toString(),
        effectiveDate: input.effectiveDate,
      });

      return {
        rate: {
          id: saved.id,
          fromCurrency: saved.from_currency,
          toCurrency: saved.to_currency,
          rateScaled: saved.rate_scaled,
          effectiveDate: saved.effective_date,
          createdAt:
            saved.created_at instanceof Date
              ? saved.created_at.toISOString()
              : new Date(String(saved.created_at)).toISOString(),
        },
      };
    });
  }

  async deleteFxRate(
    actor: SessionUser,
    rateId: string,
    ip: string | null,
  ): Promise<{ id: string; deleted: true }> {
    requireCapability(actor, 'settings.manage');
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{
        id: string;
        from_currency: Currency;
        to_currency: Currency;
        effective_date: string;
      }>(
        `SELECT id, from_currency, to_currency, effective_date
         FROM fx_rates WHERE id = $1 FOR UPDATE`,
        [rateId],
      );
      const row = existing.rows[0];
      if (!row) throw new NotFoundDomainError('FX rate', rateId);
      if (row.from_currency === row.to_currency) {
        throw new ValidationDomainError('Base 1:1 currency rows cannot be deleted.');
      }

      const remaining = await tx.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM fx_rates
         WHERE from_currency = $1 AND to_currency = $2 AND id <> $3`,
        [row.from_currency, row.to_currency, rateId],
      );
      if ((remaining.rows[0]?.n ?? 0) === 0) {
        throw new DomainError({
          status: 409,
          code: 'FX_LAST_RATE',
          title: 'Cannot remove last exchange rate',
          detail: `Keep at least one ${row.from_currency} → ${row.to_currency} exchange rate so pipeline and revenue conversions stay accurate.`,
        });
      }

      await tx.query(`DELETE FROM fx_rates WHERE id = $1`, [rateId]);
      await this.audit(tx, actor, ip, 'fx_rate.deleted', 'fx_rate', rateId, {
        fromCurrency: row.from_currency,
        toCurrency: row.to_currency,
        effectiveDate: row.effective_date,
      });
      return { id: rateId, deleted: true as const };
    });
  }

  private async audit(
    tx: DbTx,
    actor: SessionUser,
    ip: string | null,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.db.writeAuditLog(tx, {
      actorUserId: actor.id,
      actorEmail: actor.email,
      action,
      entityType,
      entityId,
      metadata,
      ipAddress: ip,
    });
  }
}
