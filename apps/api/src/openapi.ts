import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(currentDir, '../openapi.json');

const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'ADAS CRM API',
    version: '0.1.0',
    description: 'Internal CRM and outreach API for ADAS Globus Pro (PRD §6.7)',
  },
  servers: [{ url: '/api/v1' }],
  paths: {
    '/healthz': {
      get: {
        operationId: 'getHealth',
        summary: 'Service health check',
        responses: {
          '200': {
            description: 'Healthy',
          },
        },
      },
    },
  },
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(openApiSpec, null, 2)}\n`, 'utf8');
console.log(`[openapi] Wrote OpenAPI snapshot to ${outPath}`);
