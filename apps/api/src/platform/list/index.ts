import { FilterClauseSchema, type FilterClause, type FilterCondition } from '@adas/shared';
import { DomainError, ValidationDomainError } from '../errors/index.js';

/**
 * Lists, filters and keyset pagination (PRD 6.7, 6.8).
 *
 * - Every filterable field is declared in a per-entity field registry with its SQL
 *   expression and type. User input only ever becomes bind parameters, never SQL text.
 * - Pagination is keyset (cursor) based on (sort expression, id), so pages stay fast and
 *   stable at 60k+ rows.
 */

/** Collects bind parameters and hands back `$n` placeholders. */
export class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
  get next(): number {
    return this.values.length + 1;
  }
}

export type FieldType =
  'text' | 'enum' | 'number' | 'date' | 'boolean' | 'user' | 'jsonArray' | 'tags';

export interface FieldDef {
  /** SQL expression, written by developers only. */
  sql: string;
  type: FieldType;
  /** For `tags`: the entity_tags.entity_type value and the row's id expression. */
  tagEntity?: string;
}

export type FieldRegistry = Record<string, FieldDef>;

const OPS_BY_TYPE: Record<FieldType, readonly FilterCondition['op'][]> = {
  text: ['eq', 'neq', 'in', 'nin', 'contains', 'startsWith', 'isEmpty', 'isNotEmpty'],
  enum: ['eq', 'neq', 'in', 'nin', 'isEmpty', 'isNotEmpty'],
  user: ['eq', 'neq', 'in', 'nin', 'isEmpty', 'isNotEmpty'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'isEmpty', 'isNotEmpty'],
  date: ['before', 'after', 'between', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  boolean: ['eq', 'neq'],
  jsonArray: ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty'],
  tags: ['hasAny', 'hasAll', 'isEmpty', 'isNotEmpty'],
};

const MAX_CONDITIONS = 40;
const MAX_DEPTH = 4;

function badFilter(detail: string): never {
  throw new DomainError({ status: 400, code: 'INVALID_FILTER', title: 'Invalid filter', detail });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Turns `{relative: '-90d'}` or an ISO date string into a Date. */
function toDate(value: unknown, now: Date): Date {
  if (value && typeof value === 'object' && 'relative' in value) {
    const m = /^([+-]?)(\d+)([dhmw])$/.exec(String((value as { relative: string }).relative));
    if (!m) badFilter('Relative dates look like -90d or +7d.');
    const sign = m[1] === '-' ? -1 : 1;
    const n = Number(m[2]);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[3] as 'm'];
    return new Date(now.getTime() + sign * n * unitMs);
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value);
  return badFilter('Dates must be ISO dates or relative values like -30d.');
}

function scalar(value: unknown): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return badFilter('This filter needs a single value.');
}

function list(value: unknown): (string | number)[] {
  if (Array.isArray(value) && value.length > 0 && value.length <= 200) {
    return value as (string | number)[];
  }
  return badFilter('This filter needs a list of 1 to 200 values.');
}

export interface CompileOptions {
  userId: string;
  now?: Date;
  /** Developer-written SQL column for custom_fields JSONB (e.g. 'c.custom_fields'). */
  customFieldsSql?: string;
}

const CUSTOM_FIELD_PATH_RE = /^custom\.([a-z][a-z0-9_]{1,39})$/;

/**
 * Compiles a filter-language clause (PRD 6.8) to a SQL boolean expression, adding values
 * to `params`. The special value `@me` on user fields means the signed-in user.
 */
export function compileFilter(
  rawClause: unknown,
  registry: FieldRegistry,
  params: SqlParams,
  options: CompileOptions,
): string {
  const parsed = FilterClauseSchema.safeParse(rawClause);
  if (!parsed.success) badFilter('The filter is not in the expected format.');
  let count = 0;
  const now = options.now ?? new Date();

  const walk = (clause: FilterClause, depth: number): string => {
    if (depth > MAX_DEPTH) badFilter('Filters can nest at most 4 levels.');
    if ('and' in clause) return `(${clause.and.map((c) => walk(c, depth + 1)).join(' AND ')})`;
    if ('or' in clause) return `(${clause.or.map((c) => walk(c, depth + 1)).join(' OR ')})`;
    count += 1;
    if (count > MAX_CONDITIONS) badFilter(`Filters can have at most ${MAX_CONDITIONS} conditions.`);
    return condition(clause);
  };

  const condition = ({ field, op, value }: FilterCondition): string => {
    if (options.customFieldsSql && field.startsWith('custom.')) {
      const m = CUSTOM_FIELD_PATH_RE.exec(field);
      if (!m || !m[1]) badFilter(`Invalid custom field "${field}".`);
      const key = m[1];
      const cfSql = options.customFieldsSql;
      if (op === 'eq') {
        const sv = scalar(value);
        return `${cfSql} @> ${params.add(JSON.stringify({ [key]: sv }))}::jsonb`;
      }
      if (op === 'hasAny' || op === 'hasAll') {
        const vals = list(value).map(String);
        const keyParam = params.add(key);
        return op === 'hasAny'
          ? `(${cfSql} -> ${keyParam}) ?| ${params.add(vals)}::text[]`
          : `(${cfSql} -> ${keyParam}) ?& ${params.add(vals)}::text[]`;
      }
      const keyParam = params.add(key);
      const extracted = `(${cfSql} ->> ${keyParam})`;
      if (op === 'isEmpty') return `NULLIF(${extracted}, '') IS NULL`;
      if (op === 'isNotEmpty') return `NULLIF(${extracted}, '') IS NOT NULL`;
      if (op === 'neq') return `${extracted} IS DISTINCT FROM ${params.add(String(scalar(value)))}`;
      if (op === 'in') return `${extracted} = ANY(${params.add(list(value).map(String))}::text[])`;
      if (op === 'contains') {
        return `${extracted} ILIKE ${params.add(`%${escapeLike(String(scalar(value)))}%`)}`;
      }
      if (op === 'startsWith') {
        return `${extracted} ILIKE ${params.add(`${escapeLike(String(scalar(value)))}%`)}`;
      }
      if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
        const num = Number(scalar(value));
        if (!Number.isFinite(num)) badFilter(`"${field}" needs a number.`);
        const sqlOp = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
        return `(CASE WHEN ${extracted} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${extracted})::numeric ELSE NULL END) ${sqlOp} ${params.add(num)}`;
      }
      return badFilter(`"${op}" isn't available for "${field}".`);
    }

    const def = registry[field];
    if (!def) badFilter(`You can't filter on "${field}".`);
    if (!OPS_BY_TYPE[def.type].includes(op)) {
      badFilter(`"${op}" isn't available for "${field}".`);
    }
    const col = def.sql;
    const resolve = (v: string | number | boolean) =>
      def.type === 'user' && v === '@me' ? options.userId : v;

    switch (def.type) {
      case 'jsonArray':
      case 'tags': {
        if (op === 'isEmpty' || op === 'isNotEmpty') {
          const empty =
            def.type === 'tags'
              ? `NOT EXISTS (SELECT 1 FROM entity_tags et WHERE et.entity_type = ${params.add(def.tagEntity)} AND et.entity_id = ${col})`
              : `jsonb_array_length(COALESCE(${col}, '[]'::jsonb)) = 0`;
          return op === 'isEmpty' ? empty : `NOT (${empty})`;
        }
        const values = list(value).map(String);
        if (def.type === 'tags') {
          // A semi-join from the tag side: one pass over the tagged rows, instead of a
          // sub-query for every record in the list (docs/perf, ADR 0011).
          const wanted = [...new Set(values.map((v) => v.trim().toLowerCase()))];
          const tagged = `SELECT et.entity_id FROM entity_tags et JOIN tags t ON t.id = et.tag_id
            WHERE et.entity_type = ${params.add(def.tagEntity)} AND t.name = ANY(${params.add(wanted)}::text[])`;
          return op === 'hasAny'
            ? `${col} IN (${tagged})`
            : `${col} IN (${tagged} GROUP BY et.entity_id HAVING COUNT(DISTINCT t.name) = ${params.add(wanted.length)})`;
        }
        const arr = params.add(values);
        return op === 'hasAny' ? `${col} ?| ${arr}::text[]` : `${col} ?& ${arr}::text[]`;
      }
      default:
        break;
    }

    if (op === 'isEmpty')
      return def.type === 'text' ? `NULLIF(${col}, '') IS NULL` : `${col} IS NULL`;
    if (op === 'isNotEmpty')
      return def.type === 'text' ? `NULLIF(${col}, '') IS NOT NULL` : `${col} IS NOT NULL`;

    if (def.type === 'date') {
      if (op === 'between') {
        const [from, to] = list(value);
        return `${col} >= ${params.add(toDate(from, now).toISOString())}::timestamptz AND ${col} < ${params.add(toDate(to, now).toISOString())}::timestamptz`;
      }
      const at = `${params.add(toDate(value, now).toISOString())}::timestamptz`;
      const sqlOp = { before: '<', lt: '<', lte: '<=', after: '>', gt: '>', gte: '>=' }[
        op as 'before'
      ];
      if (!sqlOp) badFilter(`"${op}" isn't available for dates.`);
      return `${col} ${sqlOp} ${at}`;
    }

    if (def.type === 'number') {
      if (op === 'between') {
        const [lo, hi] = list(value).map(Number);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) badFilter('Between needs two numbers.');
        return `${col} BETWEEN ${params.add(lo)} AND ${params.add(hi)}`;
      }
      const n = Number(scalar(value));
      if (!Number.isFinite(n)) badFilter(`"${field}" needs a number.`);
      const sqlOp = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[op as 'eq'];
      return `${col} ${sqlOp} ${params.add(n)}`;
    }

    if (def.type === 'boolean') {
      const b = scalar(value) === true || scalar(value) === 'true';
      return op === 'eq' ? `${col} = ${params.add(b)}` : `${col} <> ${params.add(b)}`;
    }

    // text, enum, user
    switch (op) {
      case 'eq':
        return `${col} = ${params.add(String(resolve(scalar(value))))}`;
      case 'neq':
        return `${col} IS DISTINCT FROM ${params.add(String(resolve(scalar(value))))}`;
      case 'in':
        return `${col} = ANY(${params.add(list(value).map((v) => String(resolve(v))))}::text[])`;
      case 'nin':
        return `NOT (${col} = ANY(${params.add(list(value).map((v) => String(resolve(v))))}::text[]))`;
      case 'contains':
        return `${col} ILIKE ${params.add(`%${escapeLike(String(scalar(value)))}%`)}`;
      case 'startsWith':
        return `${col} ILIKE ${params.add(`${escapeLike(String(scalar(value)))}%`)}`;
      default:
        return badFilter(`"${op}" isn't available for "${field}".`);
    }
  };

  return walk(parsed.data as FilterClause, 0);
}

// ---------------------------------------------------------------------------
// Keyset pagination
// ---------------------------------------------------------------------------

export interface SortDef {
  sql: string;
  /** Postgres type used to cast the cursor value back. */
  cast: 'timestamptz' | 'text' | 'int' | 'bigint' | 'numeric' | 'date';
}

export interface ListSpec {
  entity: string;
  select: string;
  from: string;
  idSql: string;
  where: string[];
  sorts: Record<string, SortDef>;
  defaultSort: string;
  registry: FieldRegistry;
  /** Optional JSONB column holding custom field values (e.g. 'l.custom_fields'). */
  customFieldsSql?: string;
  /** Builds the free-text search condition. */
  search?: (q: string, params: SqlParams) => string;
}

export interface ListRequest {
  limit: number;
  cursor: string | null;
  sort: string;
  q: string;
  filter: unknown;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export const MAX_LIST_LIMIT = 200;

export function parseListRequest(query: URLSearchParams, defaultSort: string): ListRequest {
  const limitRaw = Number(query.get('limit') ?? 50);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), MAX_LIST_LIMIT) : 50;
  let filter: unknown = null;
  const rawFilter = query.get('filter');
  if (rawFilter) {
    try {
      filter = JSON.parse(rawFilter);
    } catch {
      badFilter('The filter must be valid JSON.');
    }
  }
  return {
    limit,
    cursor: query.get('cursor'),
    sort: query.get('sort') ?? defaultSort,
    q: (query.get('q') ?? '').trim().slice(0, 200),
    filter,
  };
}

function encodeCursor(value: string | null, id: string): string {
  return Buffer.from(JSON.stringify([value, id])).toString('base64url');
}

function decodeCursor(cursor: string): [string | null, string] {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      (typeof parsed[0] === 'string' || parsed[0] === null) &&
      typeof parsed[1] === 'string'
    ) {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  return badFilter('The page cursor is not valid. Reload the list.');
}

interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Runs a scoped, filtered, sorted, keyset-paginated list query.
 * `scopeSql` is built by the caller (scopeWhere) against the same `params` object.
 * With `withTotal: false` (exports paging through every row) the count query is skipped and
 * `total` is -1.
 */
export async function runList<T extends Record<string, unknown>>(
  db: Queryable,
  spec: ListSpec,
  req: ListRequest,
  params: SqlParams,
  scopeSql: string,
  userId: string,
  options: { withTotal?: boolean } = {},
): Promise<Page<T>> {
  const desc = req.sort.startsWith('-');
  const sortKey = desc ? req.sort.slice(1) : req.sort;
  const sort = spec.sorts[sortKey];
  if (!sort) {
    throw new ValidationDomainError(`You can't sort ${spec.entity} by "${sortKey}".`, {
      sort: ['Unknown sort field'],
    });
  }

  const where = [...spec.where, scopeSql];
  if (req.q && spec.search) where.push(spec.search(req.q, params));
  if (req.filter) {
    where.push(
      compileFilter(req.filter, spec.registry, params, {
        userId,
        customFieldsSql: spec.customFieldsSql,
      }),
    );
  }

  // Total before the cursor condition is added.
  const countParams = [...params.values];
  const countSql = `SELECT COUNT(*)::int AS n FROM ${spec.from} WHERE ${where.join(' AND ')}`;

  if (req.cursor) {
    const [value, id] = decodeCursor(req.cursor);
    const cmp = desc ? '<' : '>';
    if (value === null) {
      where.push(`${spec.idSql} ${cmp} ${params.add(id)}`);
    } else {
      where.push(
        `(${sort.sql}, ${spec.idSql}) ${cmp} (${params.add(value)}::${sort.cast}, ${params.add(id)})`,
      );
    }
  }

  const dir = desc ? 'DESC' : 'ASC';
  const sql = `SELECT ${spec.select}, (${sort.sql})::text AS __cursor_value
    FROM ${spec.from}
    WHERE ${where.join(' AND ')}
    ORDER BY ${sort.sql} ${dir}, ${spec.idSql} ${dir}
    LIMIT ${req.limit + 1}`;

  const [rows, count] = await Promise.all([
    db.query<T & { __cursor_value: string | null; id: string }>(sql, params.values),
    options.withTotal === false
      ? Promise.resolve({ rows: [{ n: -1 }] })
      : db.query<{ n: number }>(countSql, countParams),
  ]);

  const hasMore = rows.rows.length > req.limit;
  const pageRows = hasMore ? rows.rows.slice(0, req.limit) : rows.rows;
  const last = pageRows[pageRows.length - 1];
  const items = pageRows.map((row) => {
    const { __cursor_value: _ignored, ...rest } = row;
    return rest as unknown as T;
  });
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(last.__cursor_value, last.id) : null,
    total: count.rows[0]?.n ?? 0,
  };
}

/** The ILIKE pattern for "contains this text", with the text's own % and _ taken literally. */
export function containsPattern(q: string): string {
  return `%${escapeLike(q)}%`;
}

/** Adds the "contains this text" pattern for ILIKE and returns its placeholder. */
export function likeParam(q: string, params: SqlParams): string {
  return params.add(containsPattern(q));
}

/** Free-text search across several columns with ILIKE (trigram-indexed, PRD 6.10). */
export function ilikeAny(columns: string[], q: string, params: SqlParams): string {
  const p = likeParam(q, params);
  return `(${columns.map((c) => `${c} ILIKE ${p}`).join(' OR ')})`;
}
