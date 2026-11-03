import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AddressInfo } from 'node:net';
import { createAppServer } from '../main.js';
import { validateEnv } from '../platform/config/index.js';

describe('API HTTP server integration', () => {
  const { server } = createAppServer(validateEnv({ NODE_ENV: 'test', LOG_LEVEL: 'error' }));
  let baseUrl = '';

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('responds 200 on /healthz and /api/v1/healthz', async () => {
    const res = await fetch(`${baseUrl}/api/v1/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; mailLive: boolean };
    expect(body.status).toBe('ok');
    expect(body.mailLive).toBe(false);
  });

  it('returns RFC 9457 application/problem+json on unknown routes (PRD §6.7)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/does-not-exist`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('route_not_found');
    expect(body.status).toBe(404);
  });
});
