import { createSign, generateKeyPairSync, type JsonWebKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CloudflareAccessVerifier } from '../index.js';

function signRs256Jwt(
  privateKeyPem: string | ReturnType<typeof generateKeyPairSync>['privateKey'],
  kid: string,
  payload: Record<string, unknown>,
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = signer.sign(privateKeyPem).toString('base64url');
  return `${header}.${body}.${sig}`;
}

describe('Cloudflare Access JWT verifier (PRD 6.5, 9)', () => {
  it('verifies RS256 Cloudflare Access JWTs and rejects missing, tampered, expired, wrong-aud and wrong-iss tokens', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { privateKey: wrongPrivateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = publicKey.export({ format: 'jwk' }) as JsonWebKey;

    const nowSec = 1_800_000_000;
    const verifier = new CloudflareAccessVerifier({
      enforce: true,
      teamDomain: 'adasglobuspro.cloudflareaccess.com',
      audience: 'aud_crm_prod_123',
      nowSeconds: () => nowSec,
      jwksLoader: async () => ({
        keys: [{ ...jwk, kid: 'kid_1', alg: 'RS256' }],
      }),
    });

    const validJwt = signRs256Jwt(privateKey, 'kid_1', {
      sub: 'user-1',
      email: 'ved@adasglobuspro.com',
      iss: 'https://adasglobuspro.cloudflareaccess.com',
      aud: ['aud_crm_prod_123'],
      iat: nowSec - 10,
      exp: nowSec + 600,
    });
    const claims = await verifier.verifyAssertion(validJwt);
    expect(claims?.email).toBe('ved@adasglobuspro.com');

    await expect(verifier.verifyAssertion(undefined)).rejects.toMatchObject({
      status: 403,
      code: 'CF_ACCESS_DENIED',
    });

    const badSigJwt = signRs256Jwt(wrongPrivateKey, 'kid_1', {
      sub: 'user-1',
      iss: 'https://adasglobuspro.cloudflareaccess.com',
      aud: 'aud_crm_prod_123',
      exp: nowSec + 600,
    });
    await expect(verifier.verifyAssertion(badSigJwt)).rejects.toMatchObject({
      status: 403,
      code: 'CF_ACCESS_DENIED',
    });

    const badAudJwt = signRs256Jwt(privateKey, 'kid_1', {
      sub: 'user-1',
      iss: 'https://adasglobuspro.cloudflareaccess.com',
      aud: 'aud_other_app',
      exp: nowSec + 600,
    });
    await expect(verifier.verifyAssertion(badAudJwt)).rejects.toMatchObject({
      status: 403,
      code: 'CF_ACCESS_DENIED',
    });

    const badIssJwt = signRs256Jwt(privateKey, 'kid_1', {
      sub: 'user-1',
      iss: 'https://attacker.cloudflareaccess.com',
      aud: 'aud_crm_prod_123',
      exp: nowSec + 600,
    });
    await expect(verifier.verifyAssertion(badIssJwt)).rejects.toMatchObject({
      status: 403,
      code: 'CF_ACCESS_DENIED',
    });

    const expiredJwt = signRs256Jwt(privateKey, 'kid_1', {
      sub: 'user-1',
      iss: 'https://adasglobuspro.cloudflareaccess.com',
      aud: 'aud_crm_prod_123',
      exp: nowSec - 120,
    });
    await expect(verifier.verifyAssertion(expiredJwt)).rejects.toMatchObject({
      status: 403,
      code: 'CF_ACCESS_DENIED',
    });
  });
});
