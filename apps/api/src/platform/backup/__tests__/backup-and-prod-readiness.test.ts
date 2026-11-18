import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptBackupBuffer, encryptBackupBuffer, getS3Object, putS3Object } from '../index.js';
import { validateEnv, verifyProductionReadiness } from '../../config/index.js';
import { SecretBox } from '../../crypto/index.js';
import { type DatabaseService } from '../../db/index.js';

describe('Encrypted backup envelope, S3 SigV4 & production readiness guard (PRD 9, 10.2, 10.5)', () => {
  const validKey = 'bkkey_unit_test_secret_at_least_32_characters_long_2026';

  it('encrypts and decrypts ADASBK01 AES-256-GCM archives and rejects tampering or wrong keys', () => {
    const sample = Buffer.from('PGDMP-custom-archive-binary-payload-1234567890', 'utf8');
    const encrypted = encryptBackupBuffer(sample, validKey);

    expect(encrypted.subarray(0, 8).toString('ascii')).toBe('ADASBK01');
    expect(encrypted.includes(Buffer.from('PGDMP'))).toBe(false);

    const decrypted = decryptBackupBuffer(encrypted, validKey);
    expect(decrypted.equals(sample)).toBe(true);

    // Wrong key fails GCM authentication
    expect(() =>
      decryptBackupBuffer(encrypted, 'bkkey_wrong_secret_at_least_32_characters_long_9999'),
    ).toThrow();

    // Single bit flip in ciphertext fails GCM authentication
    const tampered = Buffer.from(encrypted);
    const lastIdx = tampered.length - 1;
    tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;
    expect(() => decryptBackupBuffer(tampered, validKey)).toThrow();

    // Short key is rejected up front
    expect(() => encryptBackupBuffer(sample, 'too-short')).toThrow(/at least 32/);
  });

  it('signs S3 Signature v4 PUT and GET requests over HTTP', async () => {
    const store = new Map<string, Buffer>();
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=test_akid/')) {
        res.writeHead(403).end('missing sigv4');
        return;
      }
      const key = req.url ?? '/';
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          store.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        });
        return;
      }
      if (req.method === 'GET') {
        const found = store.get(key);
        if (!found) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(found);
        return;
      }
      res.writeHead(405).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    try {
      const s3 = {
        endpoint: `http://127.0.0.1:${port}`,
        region: 'auto',
        bucket: 'adas-backups',
        accessKeyId: 'test_akid',
        secretAccessKey: 'test_secret_access_key_123456',
      };
      const payload = Buffer.from('encrypted-backup-bytes');
      await putS3Object({
        config: s3,
        objectKey: 'db/2026-11-18/test.dump.enc',
        body: payload,
      });

      const fetched = await getS3Object({
        config: s3,
        objectKey: 'db/2026-11-18/test.dump.enc',
      });
      expect(fetched.equals(payload)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('enforces least-privilege non-superuser DB role, mounted secrets, and counsel sign-off in verifyProductionReadiness', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adas-prod-ready-'));
    try {
      const sessionFile = path.join(dir, 'session_secret.txt');
      writeFileSync(sessionFile, 'sess_prod_secret_at_least_32_random_chars_2026\n', 'utf8');

      const prodEnv = validateEnv({
        NODE_ENV: 'production',
        MAIL_LIVE: 'false',
        SESSION_SECRET_FILE: sessionFile,
      });

      const makeMockDb = (rolsuper: boolean, counselSignedOff: boolean) =>
        ({
          async query(sql: string) {
            if (sql.includes('FROM pg_roles')) {
              return {
                rows: [
                  {
                    current_user: rolsuper ? 'postgres' : 'adas_app',
                    rolsuper,
                    rolcreatedb: false,
                    rolcreaterole: false,
                  },
                ],
                rowCount: 1,
              };
            }
            return {
              rows: [{ value_json: counselSignedOff }],
              rowCount: 1,
            };
          },
        }) as unknown as DatabaseService;

      // 1. Rejects PostgreSQL superuser
      await expect(
        verifyProductionReadiness({
          env: prodEnv,
          db: makeMockDb(true, false),
          secretBox: SecretBox.ephemeral(),
          resolvePath: (p) => p,
        }),
      ).rejects.toThrow(/superuser/);

      // 2. Rejects missing SecretBox
      await expect(
        verifyProductionReadiness({
          env: prodEnv,
          db: makeMockDb(false, false),
          secretBox: null,
          resolvePath: (p) => p,
        }),
      ).rejects.toThrow(/TOKEN_ENCRYPTION_KEY_FILE/);

      // 3. Rejects MAIL_LIVE=true without counsel sign-off
      const liveMailEnv = validateEnv({
        NODE_ENV: 'production',
        MAIL_LIVE: 'true',
        SESSION_SECRET_FILE: sessionFile,
      });
      await expect(
        verifyProductionReadiness({
          env: liveMailEnv,
          db: makeMockDb(false, false),
          secretBox: SecretBox.ephemeral(),
          resolvePath: (p) => p,
        }),
      ).rejects.toThrow(/counsel_signed_off/);

      // 4. Accepts properly provisioned least-privilege production config
      await expect(
        verifyProductionReadiness({
          env: prodEnv,
          db: makeMockDb(false, false),
          secretBox: SecretBox.ephemeral(),
          resolvePath: (p) => p,
        }),
      ).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
