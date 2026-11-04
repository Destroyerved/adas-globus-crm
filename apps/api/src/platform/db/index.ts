import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { seedSyntheticBaseline } from './seed.js';

export interface DbQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface DbTx {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<DbQueryResult<T>>;
}

export interface OutboxEventInput {
  id?: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
}

export interface AuditLogInput {
  id?: string;
  actorUserId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export interface RecordHistoryInput {
  entityType: string;
  entityId: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  changedByUserId?: string | null;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value.trim().toLowerCase()).digest('hex');
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(currentDir, '../../../prisma/migrations');

/** Every migration.sql under prisma/migrations, in folder order. */
export function readMigrations(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf-8'),
    }));
}

/** The minimum a SQL engine must offer. Production uses PostgreSQL; tests may use PGlite. */
interface SqlDriver {
  query<T>(sql: string, params: unknown[]): Promise<DbQueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function createPgDriver(connectionString: string): SqlDriver {
  const pool = new pg.Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000 });
  return {
    async query<T>(sql: string, params: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: DbTx) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: DbTx = {
          query: async <R>(sql: string, params: unknown[] = []) => {
            const res = await client.query(sql, params);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** In-memory PGlite for unit and integration tests only (AGENTS.md section 5). */
async function createPgliteDriver(): Promise<SqlDriver> {
  const [{ PGlite }, { pg_trgm }, { unaccent }] = await Promise.all([
    import('@electric-sql/pglite'),
    import('@electric-sql/pglite/contrib/pg_trgm'),
    import('@electric-sql/pglite/contrib/unaccent'),
  ]);
  const db = await PGlite.create({ extensions: { pg_trgm, unaccent } });
  return {
    async query<T>(sql: string, params: unknown[]) {
      const res = await db.query<T>(sql, params);
      return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
    transaction<T>(fn: (tx: DbTx) => Promise<T>) {
      return db.transaction(async (pgTx) =>
        fn({
          query: async <R>(sql: string, params: unknown[] = []) => {
            const res = await pgTx.query<R>(sql, params);
            return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
          },
        }),
      );
    },
    async close() {
      await db.close();
    },
  };
}

type DriverFactory = () => Promise<SqlDriver>;

export class DatabaseService {
  private driver: SqlDriver | null = null;
  private starting: Promise<SqlDriver> | null = null;

  private constructor(
    private readonly factory: DriverFactory,
    /** Applied once when the driver starts: migrations and seed for test databases. */
    private readonly prepare: (driver: SqlDriver) => Promise<void> = async () => undefined,
  ) {}

  /**
   * The running API: a real PostgreSQL connection. Migrations are applied separately
   * (`pnpm db:migrate`) and demo data only by `pnpm db:seed`.
   */
  static connect(databaseUrl: string): DatabaseService {
    return new DatabaseService(async () => {
      const driver = createPgDriver(databaseUrl);
      await driver.query('SELECT 1', []); // fail fast with a clear error if PostgreSQL is unreachable
      return driver;
    });
  }

  /**
   * Tests: a fresh, migrated and seeded database. Uses real PostgreSQL when
   * TEST_DATABASE_URL is set (the schema is dropped and rebuilt, so point it at a
   * throw-away database), otherwise in-memory PGlite.
   */
  static forTests(): DatabaseService {
    const testUrl = process.env['TEST_DATABASE_URL'];
    const factory: DriverFactory = testUrl
      ? async () => createPgDriver(testUrl)
      : createPgliteDriver;
    return new DatabaseService(factory, async (driver) => {
      if (testUrl) {
        await driver.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
      }
      for (const migration of readMigrations()) {
        await driver.exec(migration.sql);
      }
      await seedSyntheticBaseline({
        exec: (sql) => driver.exec(sql),
        query: <T>(sql: string) => driver.query<T>(sql, []),
      });
    });
  }

  async ensureInitialized(): Promise<void> {
    await this.getDriver();
  }

  private async getDriver(): Promise<SqlDriver> {
    if (this.driver) return this.driver;
    this.starting ??= (async () => {
      const driver = await this.factory();
      await this.prepare(driver);
      this.driver = driver;
      return driver;
    })();
    try {
      return await this.starting;
    } catch (err) {
      this.starting = null;
      throw err;
    }
  }

  async close(): Promise<void> {
    const driver = this.driver;
    this.driver = null;
    this.starting = null;
    if (driver) await driver.close();
  }

  /** Tests only: throw the database away and start a fresh one. */
  async resetAndReseed(): Promise<void> {
    await this.close();
    await this.ensureInitialized();
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<DbQueryResult<T>> {
    return (await this.getDriver()).query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    await (await this.getDriver()).exec(sql);
  }

  async transaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<T> {
    return (await this.getDriver()).transaction(fn);
  }

  async addOutboxEvent(tx: DbTx, event: OutboxEventInput): Promise<string> {
    const id = event.id ?? `evt_${randomUUID()}`;
    await tx.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, 'pending')`,
      [id, event.eventType, event.aggregateType, event.aggregateId, JSON.stringify(event.payload)],
    );
    return id;
  }

  async writeAuditLog(tx: DbTx, entry: AuditLogInput): Promise<string> {
    const id = entry.id ?? `aud_${randomUUID()}`;
    await tx.query(
      `INSERT INTO audit_logs (id, actor_user_id, actor_email, action, entity_type, entity_id, metadata, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
      [
        id,
        entry.actorUserId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.ipAddress ?? '127.0.0.1',
      ],
    );
    return id;
  }

  async writeRecordHistory(tx: DbTx, change: RecordHistoryInput): Promise<void> {
    await tx.query(
      `INSERT INTO record_history (id, entity_type, entity_id, field_name, old_value, new_value, changed_by_user_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
      [
        `rh_${randomUUID()}`,
        change.entityType,
        change.entityId,
        change.fieldName,
        JSON.stringify(change.oldValue ?? null),
        JSON.stringify(change.newValue ?? null),
        change.changedByUserId ?? null,
      ],
    );
  }

  async explainAnalyze(sql: string, params: unknown[] = []): Promise<string[]> {
    const res = await this.query<{ 'QUERY PLAN': string }>(`EXPLAIN ANALYZE ${sql}`, params);
    return res.rows.map((r) => r['QUERY PLAN']);
  }
}
