/**
 * Container healthcheck for the `worker` service in `infra/compose.prod.yml` (`PRD 10.2, 10.6`).
 * Verifies PostgreSQL is reachable and at least one `running` worker has pulsed within 60 seconds.
 */
import { loadDotEnv, validateEnv } from './platform/config/index.js';
import { DatabaseService } from './platform/db/index.js';

loadDotEnv();
const env = validateEnv();
const db = DatabaseService.connect(env.DATABASE_URL);

try {
  const res = await db.query<{ ok: number }>(
    `SELECT COUNT(*)::int AS ok
     FROM worker_heartbeats
     WHERE status = 'running'
       AND last_heartbeat_at >= NOW() - INTERVAL '60 seconds'`,
  );
  const ok = (res.rows[0]?.ok ?? 0) > 0;
  await db.close();
  process.exit(ok ? 0 : 1);
} catch {
  await db.close().catch(() => undefined);
  process.exit(1);
}
