import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDevLoginEnabled, validateEnv, type AppEnv } from './platform/config/index.js';
import { createLogger } from './platform/logger/index.js';

export function createAppServer(env: AppEnv = validateEnv()) {
  const logger = createLogger(env.LOG_LEVEL);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && (url === '/healthz' || url === '/api/v1/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'adas-crm-api',
          mailLive: env.MAIL_LIVE,
          devLoginEnabled: isDevLoginEnabled(env),
        }),
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/problem+json; charset=utf-8' });
    res.end(
      JSON.stringify({
        type: 'https://crm.adasglobuspro.com/errors/not-found',
        title: 'Not found',
        status: 404,
        code: 'route_not_found',
        detail: `No route matched ${req.method ?? 'GET'} ${url}`,
      }),
    );
  });

  return { server, logger, env };
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));

if (isMainModule) {
  const { server, logger, env } = createAppServer();
  server.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'ADAS CRM API listening');
  });
}
