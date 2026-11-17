import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import { DomainError } from '../../platform/errors/index.js';

export interface CloudflareAccessOptions {
  enforce: boolean;
  teamDomain: string;
  audience: string;
  jwksLoader?: () => Promise<{ keys: Array<JsonWebKey & { kid?: string; alg?: string }> }>;
  nowSeconds?: () => number;
}

export interface CloudflareAccessClaims {
  sub: string;
  email?: string;
  iss: string;
  aud: string | string[];
  exp: number;
  iat?: number;
  nbf?: number;
}

function accessDenied(detail: string): DomainError {
  return new DomainError({
    status: 403,
    code: 'CF_ACCESS_DENIED',
    title: 'Cloudflare Access verification failed',
    detail,
  });
}

function decodeJwtSegment<T>(segment: string): T {
  try {
    const json = Buffer.from(segment, 'base64url').toString('utf8');
    return JSON.parse(json) as T;
  } catch {
    throw accessDenied('Malformed Cloudflare Access token.');
  }
}

/**
 * Validates `Cf-Access-Jwt-Assertion` on internal `crm.` requests when `CF_ACCESS_ENFORCE=true`
 * (PRD §6.5, §9 defence-in-depth).
 */
export class CloudflareAccessVerifier {
  private cachedKeys: Map<string, JsonWebKey> = new Map();
  private cacheExpiresAtMs = 0;
  private readonly cleanDomain: string;
  private readonly expectedIssuer: string;

  constructor(private readonly options: CloudflareAccessOptions) {
    this.cleanDomain = options.teamDomain
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '');
    this.expectedIssuer = `https://${this.cleanDomain}`;
  }

  isEnforced(): boolean {
    return this.options.enforce;
  }

  private async fetchKeys(forceRefresh = false): Promise<Map<string, JsonWebKey>> {
    const nowMs = Date.now();
    if (!forceRefresh && this.cachedKeys.size > 0 && nowMs < this.cacheExpiresAtMs) {
      return this.cachedKeys;
    }

    const jwks = this.options.jwksLoader
      ? await this.options.jwksLoader()
      : await fetch(`https://${this.cleanDomain}/cdn-cgi/access/certs`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        }).then(async (r) => {
          if (!r.ok) {
            throw accessDenied(`Could not load Cloudflare Access keys (${r.status}).`);
          }
          return (await r.json()) as { keys: Array<JsonWebKey & { kid?: string }> };
        });

    const nextMap = new Map<string, JsonWebKey>();
    for (const key of jwks.keys ?? []) {
      if (key.kid) {
        nextMap.set(key.kid, key);
      }
    }
    this.cachedKeys = nextMap;
    this.cacheExpiresAtMs = nowMs + 10 * 60_000;
    return nextMap;
  }

  async verifyAssertion(
    rawHeader: string | string[] | undefined,
  ): Promise<CloudflareAccessClaims | null> {
    if (!this.options.enforce) {
      return null;
    }
    const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
    if (!token || !token.trim()) {
      throw accessDenied('Missing Cf-Access-Jwt-Assertion header.');
    }

    const parts = token.trim().split('.');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
      throw accessDenied('Invalid Cf-Access-Jwt-Assertion format.');
    }

    const header = decodeJwtSegment<{ alg?: string; kid?: string }>(parts[0]);
    if (header.alg !== 'RS256' && header.alg !== 'ES256') {
      throw accessDenied('Unsupported Cloudflare Access signing algorithm.');
    }
    if (!header.kid) {
      throw accessDenied('Cloudflare Access token is missing key ID.');
    }

    let keys = await this.fetchKeys(false);
    let jwk = keys.get(header.kid);
    if (!jwk) {
      keys = await this.fetchKeys(true);
      jwk = keys.get(header.kid);
    }
    if (!jwk) {
      throw accessDenied('Unknown Cloudflare Access signing key.');
    }

    const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`, 'utf8');
    const signature = Buffer.from(parts[2], 'base64url');
    const publicKey = createPublicKey({ key: jwk, format: 'jwk' });
    const sigValid =
      header.alg === 'RS256'
        ? cryptoVerify('RSA-SHA256', signingInput, publicKey, signature)
        : cryptoVerify(
            'SHA256',
            signingInput,
            { key: publicKey, dsaEncoding: 'ieee-p1363' },
            signature,
          );

    if (!sigValid) {
      throw accessDenied('Cloudflare Access token signature verification failed.');
    }

    const claims = decodeJwtSegment<CloudflareAccessClaims>(parts[1]);
    const nowSec = this.options.nowSeconds
      ? this.options.nowSeconds()
      : Math.floor(Date.now() / 1000);
    const clockSkewSec = 30;

    if (claims.iss !== this.expectedIssuer) {
      throw accessDenied('Cloudflare Access token issuer mismatch.');
    }

    const audList = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audList.includes(this.options.audience)) {
      throw accessDenied('Cloudflare Access token audience mismatch.');
    }

    if (typeof claims.exp !== 'number' || claims.exp + clockSkewSec <= nowSec) {
      throw accessDenied('Cloudflare Access token has expired.');
    }

    if (typeof claims.nbf === 'number' && claims.nbf - clockSkewSec > nowSec) {
      throw accessDenied('Cloudflare Access token is not active yet.');
    }

    return claims;
  }
}
