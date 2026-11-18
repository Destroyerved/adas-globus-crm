import { describe, expect, it } from 'vitest';
import { HealthCheckResponseSchema } from '@adas/shared';
import { type DatabaseService } from '../../../platform/db/index.js';
import { HealthService } from '../index.js';

describe('HealthService unit checks (PRD 10.6)', () => {
  it('returns HTTP 503 with status down and zero leaked internals when PostgreSQL is unreachable', async () => {
    const brokenDb = {
      async ensureInitialized() {
        throw new Error('ECONNREFUSED 127.0.0.1:5432 secret-host.internal');
      },
      async query() {
        throw new Error('unreachable');
      },
    } as unknown as DatabaseService;

    const service = new HealthService(brokenDb, {
      nodeEnv: 'production',
      mailLive: false,
      devLoginEnabled: false,
    });

    const res = await service.checkReadiness();
    expect(res.httpStatus).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.checks.database.ok).toBe(false);
    expect(res.body.checks.database.latencyMs).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('secret-host.internal');
    expect(HealthCheckResponseSchema.safeParse(res.body).success).toBe(true);
  });
});
