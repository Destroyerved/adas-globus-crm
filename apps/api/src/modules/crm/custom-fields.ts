import { randomUUID } from 'node:crypto';
import {
  CreateCustomFieldInputSchema,
  CustomFieldMoneyValueSchema,
  RecordEntityTypeSchema,
  SetCustomFieldsInputSchema,
  UpdateCustomFieldInputSchema,
  type CustomFieldDefinitionView,
  type CustomFieldType,
  type RecordEntityType,
  type SessionUser,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
  VersionConflictError,
} from '../../platform/errors/index.js';
import { getCapabilityScope, requireCapability } from '../../platform/scope/index.js';
import { RECORD_TABLES, requireRecord } from './access.js';

/**
 * Custom field definitions and typed JSONB record values (PRD 4.3-4.6, 4.17, 6.8, 9).
 */

type Row = Record<string, unknown>;

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
}

function validateFieldValue(
  def: CustomFieldDefinitionView,
  raw: unknown,
): { empty: boolean; value: unknown } {
  if (raw === null || raw === undefined || raw === '') {
    return { empty: true, value: null };
  }
  switch (def.fieldType) {
    case 'text': {
      if (typeof raw !== 'string' || raw.length > 2000) {
        throw new ValidationDomainError(`Invalid value for "${def.label}".`, {
          [def.fieldKey]: ['Enter up to 2,000 characters.'],
        });
      }
      const trimmed = raw.trim();
      return trimmed ? { empty: false, value: trimmed } : { empty: true, value: null };
    }
    case 'url': {
      if (typeof raw !== 'string') {
        throw new ValidationDomainError(`Enter a valid URL for "${def.label}".`, {
          [def.fieldKey]: ['Enter an https:// or http:// URL.'],
        });
      }
      const trimmed = raw.trim();
      if (!trimmed) return { empty: true, value: null };
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
          throw new Error('bad protocol');
        }
        return { empty: false, value: parsed.toString() };
      } catch {
        throw new ValidationDomainError(`Enter a valid URL for "${def.label}".`, {
          [def.fieldKey]: ['Enter an https:// or http:// URL.'],
        });
      }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) {
        throw new ValidationDomainError(`Enter a number for "${def.label}".`, {
          [def.fieldKey]: ['Enter a valid number.'],
        });
      }
      return { empty: false, value: n };
    }
    case 'boolean': {
      if (typeof raw !== 'boolean') {
        throw new ValidationDomainError(`Choose Yes or No for "${def.label}".`, {
          [def.fieldKey]: ['Must be true or false.'],
        });
      }
      return { empty: false, value: raw };
    }
    case 'date': {
      const s = String(raw).trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
        throw new ValidationDomainError(`Enter a valid date for "${def.label}".`, {
          [def.fieldKey]: ['Use YYYY-MM-DD format.'],
        });
      }
      return { empty: false, value: s };
    }
    case 'select': {
      const s = String(raw).trim();
      if (!def.options.includes(s)) {
        throw new ValidationDomainError(`Choose a valid option for "${def.label}".`, {
          [def.fieldKey]: [`Choose one of: ${def.options.join(', ')}.`],
        });
      }
      return { empty: false, value: s };
    }
    case 'multi_select': {
      if (!Array.isArray(raw)) {
        throw new ValidationDomainError(`Choose options for "${def.label}".`, {
          [def.fieldKey]: ['Expected a list of selected options.'],
        });
      }
      const items = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
      if (items.length === 0) return { empty: true, value: [] };
      const invalid = items.find((item) => !def.options.includes(item));
      if (invalid) {
        throw new ValidationDomainError(`"${invalid}" is not a valid option for "${def.label}".`, {
          [def.fieldKey]: [`Choose from: ${def.options.join(', ')}.`],
        });
      }
      return { empty: false, value: items };
    }
    case 'money': {
      const parsed = CustomFieldMoneyValueSchema.safeParse(raw);
      if (!parsed.success) {
        throw new ValidationDomainError(`Enter a valid amount and currency for "${def.label}".`, {
          [def.fieldKey]: ['Provide amountMinor and USD or CAD currency.'],
        });
      }
      return { empty: false, value: parsed.data };
    }
  }
}

export class CustomFieldService {
  constructor(private readonly db: DatabaseService) {}

  async listDefinitions(
    user: SessionUser,
    rawEntity?: string | null,
    includeArchived = false,
  ): Promise<{ items: CustomFieldDefinitionView[] }> {
    const canSeeArchived = includeArchived && getCapabilityScope(user, 'settings.manage') === 'all';
    const params: unknown[] = [];
    const wheres: string[] = [];

    if (rawEntity) {
      const entity = RecordEntityTypeSchema.parse(rawEntity);
      requireCapability(user, RECORD_TABLES[entity].read);
      params.push(entity);
      wheres.push(`entity_type = $${params.length}`);
    } else {
      requireCapability(user, 'settings.manage');
    }

    if (!canSeeArchived) {
      wheres.push('archived_at IS NULL');
    }

    const whereSql = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
    const res = await this.db.query<Row>(
      `SELECT * FROM custom_field_definitions
       ${whereSql}
       ORDER BY entity_type ASC, sort_order ASC, created_at ASC`,
      params,
    );
    return { items: res.rows.map((r) => this.toView(r)) };
  }

  async createDefinition(
    user: SessionUser,
    raw: unknown,
    ipAddress: string | null,
  ): Promise<CustomFieldDefinitionView> {
    requireCapability(user, 'settings.manage');
    const input = CreateCustomFieldInputSchema.parse(raw);

    return this.db.transaction(async (tx) => {
      const dup = await tx.query<{ id: string }>(
        `SELECT id FROM custom_field_definitions WHERE entity_type = $1 AND field_key = $2`,
        [input.entityType, input.fieldKey],
      );
      if (dup.rows[0]) {
        throw new DomainError({
          status: 409,
          code: 'DUPLICATE_CUSTOM_FIELD_KEY',
          title: 'Field key already exists',
          detail: `A custom field with key "${input.fieldKey}" already exists on ${input.entityType}s.`,
          fieldErrors: { fieldKey: ['This key is already used on this record type.'] },
        });
      }

      const id = `cfd_${randomUUID()}`;
      const inserted = await tx.query<Row>(
        `INSERT INTO custom_field_definitions (
           id, entity_type, field_key, label, field_type, options_json, is_required, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING *`,
        [
          id,
          input.entityType,
          input.fieldKey,
          input.label,
          input.fieldType,
          JSON.stringify(input.options),
          input.isRequired,
          input.sortOrder,
        ],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: 'custom_field.created',
        entityType: 'custom_field',
        entityId: id,
        metadata: {
          targetEntity: input.entityType,
          fieldKey: input.fieldKey,
          fieldType: input.fieldType,
          isRequired: input.isRequired,
        },
        ipAddress,
      });
      return this.toView(inserted.rows[0] as Row);
    });
  }

  async updateDefinition(
    user: SessionUser,
    id: string,
    raw: unknown,
    ipAddress: string | null,
  ): Promise<CustomFieldDefinitionView> {
    requireCapability(user, 'settings.manage');
    const input = UpdateCustomFieldInputSchema.parse(raw);

    return this.db.transaction(async (tx) => {
      const existing = await tx.query<Row>(
        `SELECT * FROM custom_field_definitions WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const cur = existing.rows[0];
      if (!cur) throw new NotFoundDomainError('Custom field', id);
      if (cur['version'] !== input.version) throw new VersionConflictError('Custom field', id);

      const fieldType = cur['field_type'] as CustomFieldType;
      const nextOptions =
        input.options ??
        (Array.isArray(cur['options_json']) ? (cur['options_json'] as string[]) : []);
      if ((fieldType === 'select' || fieldType === 'multi_select') && nextOptions.length === 0) {
        throw new ValidationDomainError('Keep at least one option.', {
          options: ['Keep at least one option for select fields.'],
        });
      }

      const nextArchivedAt =
        input.archived === undefined
          ? cur['archived_at']
          : input.archived
            ? (cur['archived_at'] ?? new Date().toISOString())
            : null;

      const updated = await tx.query<Row>(
        `UPDATE custom_field_definitions SET
           label = $3,
           options_json = $4::jsonb,
           is_required = $5,
           sort_order = $6,
           archived_at = $7,
           version = version + 1,
           updated_at = NOW()
         WHERE id = $1 AND version = $2
         RETURNING *`,
        [
          id,
          input.version,
          input.label ?? cur['label'],
          JSON.stringify(nextOptions),
          input.isRequired ?? cur['is_required'],
          input.sortOrder ?? cur['sort_order'],
          nextArchivedAt,
        ],
      );
      const next = updated.rows[0];
      if (!next) throw new VersionConflictError('Custom field', id);

      await this.db.writeAuditLog(tx, {
        actorUserId: user.id,
        actorEmail: user.email,
        action: input.archived ? 'custom_field.archived' : 'custom_field.updated',
        entityType: 'custom_field',
        entityId: id,
        metadata: {
          targetEntity: cur['entity_type'],
          fieldKey: cur['field_key'],
        },
        ipAddress,
      });
      return this.toView(next);
    });
  }

  async setRecordValues(
    user: SessionUser,
    rawEntity: string,
    recordId: string,
    raw: unknown,
  ): Promise<{ customFields: Record<string, unknown>; version: number }> {
    const entity = RecordEntityTypeSchema.parse(rawEntity);
    const input = SetCustomFieldsInputSchema.parse(raw);
    const table = RECORD_TABLES[entity].table;

    return this.db.transaction(async (tx) => {
      const cur = await requireRecord<Row>(tx, user, entity, recordId, 'write', {
        forUpdate: true,
      });
      if (cur['version'] !== input.version) {
        throw new VersionConflictError(RECORD_TABLES[entity].label, recordId);
      }

      const defsRes = await tx.query<Row>(
        `SELECT * FROM custom_field_definitions WHERE entity_type = $1`,
        [entity],
      );
      const defs = defsRes.rows.map((r) => this.toView(r));
      const activeByKey = new Map(
        defs.filter((d) => d.archivedAt === null).map((d) => [d.fieldKey, d]),
      );
      const allKnownKeys = new Set(defs.map((d) => d.fieldKey));

      const beforeObj =
        cur['custom_fields'] && typeof cur['custom_fields'] === 'object'
          ? { ...(cur['custom_fields'] as Record<string, unknown>) }
          : {};
      const nextEntries = new Map<string, unknown>(Object.entries(beforeObj));

      for (const [key, val] of Object.entries(input.values)) {
        const def = activeByKey.get(key);
        if (!def) {
          if (allKnownKeys.has(key) && (val === null || val === undefined || val === '')) {
            nextEntries.delete(key);
            continue;
          }
          throw new ValidationDomainError(`Unknown custom field "${key}".`, {
            [key]: ['This custom field is not active on this record type.'],
          });
        }
        const checked = validateFieldValue(def, val);
        if (checked.empty) {
          nextEntries.delete(key);
        } else {
          nextEntries.set(key, checked.value);
        }
      }

      for (const def of activeByKey.values()) {
        if (def.isRequired && !nextEntries.has(def.fieldKey)) {
          throw new ValidationDomainError(`"${def.label}" is required.`, {
            [def.fieldKey]: [`Enter a value for "${def.label}".`],
          });
        }
      }

      const nextObj = Object.fromEntries(nextEntries);
      const updated = await tx.query<Row>(
        `UPDATE ${table}
         SET custom_fields = $3::jsonb, version = version + 1, updated_at = NOW()
         WHERE id = $1 AND version = $2 AND deleted_at IS NULL
         RETURNING custom_fields, version`,
        [recordId, input.version, JSON.stringify(nextObj)],
      );
      const row = updated.rows[0];
      if (!row) throw new VersionConflictError(RECORD_TABLES[entity].label, recordId);

      const changedKeys = new Set([...Object.keys(beforeObj), ...Object.keys(nextObj)]);
      for (const k of changedKeys) {
        if (JSON.stringify(beforeObj[k] ?? null) !== JSON.stringify(nextObj[k] ?? null)) {
          await this.db.writeRecordHistory(tx, {
            entityType: entity,
            entityId: recordId,
            fieldName: `custom.${k}`,
            oldValue: beforeObj[k] ?? null,
            newValue: nextObj[k] ?? null,
            changedByUserId: user.id,
          });
        }
      }

      return {
        customFields: (row['custom_fields'] as Record<string, unknown>) ?? {},
        version: Number(row['version']),
      };
    });
  }

  private toView(row: Row): CustomFieldDefinitionView {
    return {
      id: String(row['id']),
      entityType: row['entity_type'] as RecordEntityType,
      fieldKey: String(row['field_key']),
      label: String(row['label']),
      fieldType: row['field_type'] as CustomFieldType,
      options: Array.isArray(row['options_json'])
        ? (row['options_json'] as unknown[]).map(String)
        : [],
      isRequired: Boolean(row['is_required']),
      sortOrder: Number(row['sort_order'] ?? 0),
      archivedAt: row['archived_at'] ? iso(row['archived_at']) : null,
      version: Number(row['version'] ?? 1),
      createdAt: iso(row['created_at']),
      updatedAt: iso(row['updated_at'] ?? row['created_at']),
    };
  }
}
