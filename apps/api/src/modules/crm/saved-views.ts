import { randomUUID } from 'node:crypto';
import {
  CreateSavedViewInputSchema,
  SavedViewEntitySchema,
  UpdateSavedViewInputSchema,
  type SavedView,
  type SavedViewEntity,
  type SessionUser,
  type TableDensity,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import {
  ForbiddenScopeError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { SqlParams, compileFilter, type ListSpec } from '../../platform/list/index.js';
import { getCapabilityScope, requireCapability } from '../../platform/scope/index.js';
import { COMPANY_LIST, CONTACT_LIST, DEAL_LIST, LEAD_LIST } from './lists.js';

/**
 * Saved views (PRD 4.8): private or team-shared list views with filter, URL params, sort,
 * column chooser and comfortable/compact density.
 */

const ENTITY_META: Record<SavedViewEntity, { read: string; write: string; spec: ListSpec }> = {
  lead: { read: 'leads.read', write: 'leads.write', spec: LEAD_LIST },
  contact: { read: 'contacts.read', write: 'contacts.write', spec: CONTACT_LIST },
  company: { read: 'companies.read', write: 'companies.write', spec: COMPANY_LIST },
  deal: { read: 'deals.read', write: 'deals.write', spec: DEAL_LIST },
};

type Row = Record<string, unknown>;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function isNonEmptyFilter(filter: unknown): boolean {
  if (filter === null || filter === undefined) return false;
  if (typeof filter === 'object' && Object.keys(filter as object).length === 0) return false;
  return true;
}

function validateSortAndFilter(
  spec: ListSpec,
  sort: string,
  filter: unknown,
  userId: string,
): { sortField: string; sortDir: 'asc' | 'desc' } {
  const desc = sort.startsWith('-');
  const sortKey = desc ? sort.slice(1) : sort;
  if (!(sortKey in spec.sorts)) {
    throw new ValidationDomainError(`Unknown sort field "${sortKey}".`, {
      sort: [`Choose one of: ${Object.keys(spec.sorts).join(', ')}.`],
    });
  }
  if (isNonEmptyFilter(filter)) {
    compileFilter(filter, spec.registry, new SqlParams(), {
      userId,
      customFieldsSql: spec.customFieldsSql,
    });
  }
  return { sortField: sortKey, sortDir: desc ? 'desc' : 'asc' };
}

function canShareForEntity(user: SessionUser, entity: SavedViewEntity): boolean {
  if (getCapabilityScope(user, 'settings.manage') === 'all') return true;
  const { read, write } = ENTITY_META[entity];
  const readScope = getCapabilityScope(user, read);
  const writeScope = getCapabilityScope(user, write);
  return (
    writeScope === 'team' || writeScope === 'all' || (readScope === 'all' && writeScope !== 'none')
  );
}

export class SavedViewService {
  constructor(private readonly db: DatabaseService) {}

  async list(user: SessionUser, rawEntity: string): Promise<{ items: SavedView[] }> {
    const entity = SavedViewEntitySchema.parse(rawEntity);
    const meta = ENTITY_META[entity];
    const readScope = requireCapability(user, meta.read);
    const isAdminOrAll =
      readScope === 'all' || getCapabilityScope(user, 'settings.manage') === 'all';

    const res = await this.db.query<Row>(
      `SELECT sv.*, u.name AS owner_name
       FROM saved_views sv
       JOIN users u ON u.id = sv.owner_user_id
       WHERE sv.entity_type = $1
         AND (
           sv.owner_user_id = $2
           OR (
             sv.is_shared = TRUE
             AND ($3::boolean OR sv.team_id IS NULL OR sv.team_id = $4)
           )
         )
       ORDER BY (sv.owner_user_id = $2) DESC, sv.name ASC, sv.created_at DESC`,
      [entity, user.id, isAdminOrAll, user.teamId],
    );

    return { items: res.rows.map((r) => this.toView(r, user)) };
  }

  async create(user: SessionUser, raw: unknown, ipAddress: string | null): Promise<SavedView> {
    const input = CreateSavedViewInputSchema.parse(raw);
    const meta = ENTITY_META[input.entityType];
    requireCapability(user, meta.read);

    if (input.isShared && !canShareForEntity(user, input.entityType)) {
      throw new ForbiddenScopeError(meta.write);
    }

    const { sortField, sortDir } = validateSortAndFilter(
      meta.spec,
      input.sort,
      input.filter,
      user.id,
    );
    const id = `sv_${randomUUID()}`;
    const writeScope = getCapabilityScope(user, meta.write);
    const isOrgAdmin =
      getCapabilityScope(user, 'settings.manage') === 'all' || writeScope === 'all';
    const teamId = input.isShared
      ? isOrgAdmin
        ? (user.teamId ?? null)
        : user.teamId
      : user.teamId;

    return this.db.transaction(async (tx) => {
      const inserted = await tx.query<Row>(
        `INSERT INTO saved_views (
           id, entity_type, name, owner_user_id, team_id, is_shared,
           filter_json, params_json, sort_field, sort_dir, sort_spec,
           columns_json, density, version
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7::jsonb, $8::jsonb, $9, $10, $11,
           $12::jsonb, $13, 1
         ) RETURNING *`,
        [
          id,
          input.entityType,
          input.name,
          user.id,
          teamId,
          input.isShared,
          JSON.stringify(isNonEmptyFilter(input.filter) ? input.filter : {}),
          JSON.stringify(input.params),
          sortField,
          sortDir,
          input.sort,
          JSON.stringify(input.columns),
          input.density,
        ],
      );
      if (input.isShared) {
        await this.db.writeAuditLog(tx, {
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'saved_view.shared',
          entityType: 'saved_view',
          entityId: id,
          metadata: { entityType: input.entityType, teamId },
          ipAddress,
        });
      }
      const row = inserted.rows[0] as Row;
      return this.toView({ ...row, owner_name: user.name }, user);
    });
  }

  async update(
    user: SessionUser,
    viewId: string,
    raw: unknown,
    ipAddress: string | null,
  ): Promise<SavedView> {
    const input = UpdateSavedViewInputSchema.parse(raw);

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<Row>(
        `SELECT sv.*, u.name AS owner_name
         FROM saved_views sv
         JOIN users u ON u.id = sv.owner_user_id
         WHERE sv.id = $1
         FOR UPDATE OF sv`,
        [viewId],
      );
      const cur = existing.rows[0];
      if (!cur) throw new NotFoundDomainError('Saved view', viewId);

      const entity = SavedViewEntitySchema.parse(cur['entity_type']);
      const meta = ENTITY_META[entity];
      requireCapability(user, meta.read);

      const isAdmin = getCapabilityScope(user, 'settings.manage') === 'all';
      const isOwner = cur['owner_user_id'] === user.id;
      if (!isOwner && !isAdmin) {
        throw new NotFoundDomainError('Saved view', viewId);
      }
      if (cur['version'] !== input.version) {
        throw new VersionConflictError('Saved view', viewId);
      }

      const nextShared = input.isShared ?? Boolean(cur['is_shared']);
      if (nextShared && !canShareForEntity(user, entity)) {
        throw new ForbiddenScopeError(meta.write);
      }

      const nextSort = input.sort ?? String(cur['sort_spec'] ?? '-updatedAt');
      const nextFilter = input.filter !== undefined ? input.filter : cur['filter_json'];
      const { sortField, sortDir } = validateSortAndFilter(
        meta.spec,
        nextSort,
        nextFilter,
        user.id,
      );

      const nextName = input.name ?? String(cur['name']);
      const nextParams = input.params ?? (cur['params_json'] as Record<string, string>);
      const nextColumns = input.columns ?? (cur['columns_json'] as string[]);
      const nextDensity = input.density ?? (cur['density'] as TableDensity);

      const updated = await tx.query<Row>(
        `UPDATE saved_views SET
           name = $3,
           is_shared = $4,
           filter_json = $5::jsonb,
           params_json = $6::jsonb,
           sort_field = $7,
           sort_dir = $8,
           sort_spec = $9,
           columns_json = $10::jsonb,
           density = $11,
           version = version + 1,
           updated_at = NOW()
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [
          viewId,
          input.version,
          nextName,
          nextShared,
          JSON.stringify(isNonEmptyFilter(nextFilter) ? nextFilter : {}),
          JSON.stringify(nextParams),
          sortField,
          sortDir,
          nextSort,
          JSON.stringify(nextColumns),
          nextDensity,
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Saved view', viewId);

      if (nextShared !== Boolean(cur['is_shared'])) {
        await this.db.writeAuditLog(tx, {
          actorUserId: user.id,
          actorEmail: user.email,
          action: nextShared ? 'saved_view.shared' : 'saved_view.unshared',
          entityType: 'saved_view',
          entityId: viewId,
          metadata: { entityType: entity },
          ipAddress,
        });
      }

      return this.toView({ ...next, owner_name: cur['owner_name'] }, user);
    });
  }

  async remove(
    user: SessionUser,
    viewId: string,
    ipAddress: string | null,
  ): Promise<{ id: string; deleted: true }> {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<Row>(`SELECT * FROM saved_views WHERE id = $1 FOR UPDATE`, [
        viewId,
      ]);
      const cur = existing.rows[0];
      if (!cur) throw new NotFoundDomainError('Saved view', viewId);

      const entity = SavedViewEntitySchema.parse(cur['entity_type']);
      requireCapability(user, ENTITY_META[entity].read);

      const isAdmin = getCapabilityScope(user, 'settings.manage') === 'all';
      const isOwner = cur['owner_user_id'] === user.id;
      if (!isOwner && !isAdmin) {
        throw new NotFoundDomainError('Saved view', viewId);
      }

      await tx.query(`DELETE FROM saved_views WHERE id = $1`, [viewId]);
      if (cur['is_shared']) {
        await this.db.writeAuditLog(tx, {
          actorUserId: user.id,
          actorEmail: user.email,
          action: 'saved_view.deleted',
          entityType: 'saved_view',
          entityId: viewId,
          metadata: { entityType: entity },
          ipAddress,
        });
      }
      return { id: viewId, deleted: true as const };
    });
  }

  private toView(row: Row, viewer: SessionUser): SavedView {
    const isAdmin = getCapabilityScope(viewer, 'settings.manage') === 'all';
    const isOwner = row['owner_user_id'] === viewer.id;
    const rawFilter = row['filter_json'];
    const filter = isNonEmptyFilter(rawFilter) ? rawFilter : null;
    const params =
      row['params_json'] && typeof row['params_json'] === 'object'
        ? (row['params_json'] as Record<string, string>)
        : {};
    const columns = Array.isArray(row['columns_json'])
      ? (row['columns_json'] as unknown[]).map(String)
      : [];
    const density = row['density'] === 'compact' ? 'compact' : 'comfortable';
    const fallbackSort = `${row['sort_dir'] === 'asc' ? '' : '-'}${String(row['sort_field'] ?? 'updatedAt')}`;
    return {
      id: String(row['id']),
      entityType: row['entity_type'] as SavedViewEntity,
      name: String(row['name']),
      ownerUserId: String(row['owner_user_id']),
      ownerName: String(row['owner_name'] ?? '—'),
      teamId: (row['team_id'] as string | null) ?? null,
      isShared: Boolean(row['is_shared']),
      params,
      filter,
      sort: String(row['sort_spec'] ?? fallbackSort),
      columns,
      density,
      version: Number(row['version'] ?? 1),
      canEdit: isOwner || isAdmin,
      createdAt: iso(row['created_at']),
      updatedAt: iso(row['updated_at'] ?? row['created_at']),
    };
  }
}
