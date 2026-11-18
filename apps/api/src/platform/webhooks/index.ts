import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { ValidationDomainError } from '../errors/index.js';

export const WEBHOOK_REPLAY_WINDOW_SECONDS = 300;

export interface SignedWebhookHeaders {
  signatureHeader: string;
  timestampHeader: string;
  digestHex: string;
}

/**
 * Signs an outbound ADAS webhook payload with HMAC-SHA256 including a Unix timestamp so receivers
 * can enforce a 5-minute replay window (PRD 4.14, 9).
 * Header format: `X-ADAS-Signature: t=<unixSeconds>,v1=<hex>`
 */
export function signAdasWebhookPayload(
  rawBody: string,
  secret: string,
  timestampSec = Math.floor(Date.now() / 1000),
): SignedWebhookHeaders {
  const signedPayload = `${timestampSec}.${rawBody}`;
  const digestHex = createHmac('sha256', secret).update(signedPayload, 'utf8').digest('hex');
  return {
    signatureHeader: `t=${timestampSec},v1=${digestHex}`,
    timestampHeader: String(timestampSec),
    digestHex,
  };
}

function safeHexEqual(expectedHex: string, candidateHex: string): boolean {
  if (expectedHex.length !== candidateHex.length || expectedHex.length % 2 !== 0) {
    return false;
  }
  if (!/^[0-9a-f]+$/i.test(candidateHex)) {
    return false;
  }
  const a = Buffer.from(expectedHex.toLowerCase(), 'hex');
  const b = Buffer.from(candidateHex.toLowerCase(), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verifies an HMAC-SHA256 webhook signature (`t=<ts>,v1=<hex>` or `sha256=<hex>` + timestamp header)
 * in constant time and enforces a 5-minute replay window (PRD 4.14, 9).
 */
export function verifyTimestampedHmacSignature(params: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader?: string | undefined;
  secret: string;
  nowMs?: number;
  toleranceSeconds?: number;
}): { ok: boolean; reason?: string } {
  const {
    rawBody,
    signatureHeader,
    timestampHeader,
    secret,
    nowMs = Date.now(),
    toleranceSeconds = WEBHOOK_REPLAY_WINDOW_SECONDS,
  } = params;

  if (!secret) {
    return { ok: false, reason: 'missing_secret' };
  }
  if (!signatureHeader || !signatureHeader.trim()) {
    return { ok: false, reason: 'missing_signature' };
  }

  const trimmed = signatureHeader.trim();
  const parts = Object.fromEntries(
    trimmed.split(',').map((segment) => {
      const idx = segment.indexOf('=');
      if (idx === -1) return [segment.trim(), ''];
      return [segment.slice(0, idx).trim(), segment.slice(idx + 1).trim()];
    }),
  );

  if (parts['t'] && parts['v1']) {
    const ts = Number(parts['t']);
    if (!Number.isInteger(ts) || ts <= 0) {
      return { ok: false, reason: 'invalid_timestamp' };
    }
    const ageSec = Math.abs(Math.floor(nowMs / 1000) - ts);
    if (ageSec > toleranceSeconds) {
      return { ok: false, reason: 'replay_window_exceeded' };
    }
    const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
    return safeHexEqual(expected, parts['v1'])
      ? { ok: true }
      : { ok: false, reason: 'signature_mismatch' };
  }

  if (trimmed.startsWith('sha256=')) {
    const candidateHex = trimmed.slice('sha256='.length).trim();
    if (timestampHeader) {
      const ts = Number(timestampHeader.trim());
      if (!Number.isInteger(ts) || Math.abs(Math.floor(nowMs / 1000) - ts) > toleranceSeconds) {
        return { ok: false, reason: 'replay_window_exceeded' };
      }
      const tsBound = createHmac('sha256', secret).update(`${ts}.${rawBody}`, 'utf8').digest('hex');
      if (safeHexEqual(tsBound, candidateHex)) return { ok: true };
    }
    const direct = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    return safeHexEqual(direct, candidateHex)
      ? { ok: true }
      : { ok: false, reason: 'signature_mismatch' };
  }

  return { ok: false, reason: 'unsupported_signature_format' };
}

function isPrivateOrBlockedIpv4(ip: string): { metadata: boolean; privateOrLoopback: boolean } {
  const octets = ip.split('.').map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return { metadata: false, privateOrLoopback: false };
  }
  const [a = 0, b = 0] = octets;
  if (ip === '169.254.169.254' || ip === '100.100.100.200' || a === 0) {
    return { metadata: true, privateOrLoopback: true };
  }
  if (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  ) {
    return { metadata: false, privateOrLoopback: true };
  }
  return { metadata: false, privateOrLoopback: false };
}

/**
 * Validates outbound webhook destination URLs against SSRF and cleartext transport in production.
 */
export function validateWebhookTargetUrl(
  rawUrl: string,
  options: { production: boolean; allowPrivateTargets: boolean },
): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ValidationDomainError('Enter a valid http:// or https:// destination URL.', {
      targetUrl: ['Invalid URL.'],
    });
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ValidationDomainError(
      'Webhook URLs must use https:// (or http:// for internal n8n).',
      {
        targetUrl: ['Unsupported URL scheme.'],
      },
    );
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'metadata.google.internal' || host === 'metadata' || host === 'fd00:ec2::254') {
    throw new ValidationDomainError('Cloud metadata addresses are never allowed.', {
      targetUrl: ['Blocked destination host.'],
    });
  }

  const ipVer = isIP(host);
  if (ipVer === 4) {
    const check = isPrivateOrBlockedIpv4(host);
    if (check.metadata) {
      throw new ValidationDomainError('Cloud metadata IP addresses are never allowed.', {
        targetUrl: ['Blocked destination IP.'],
      });
    }
    if (options.production && !options.allowPrivateTargets && check.privateOrLoopback) {
      throw new ValidationDomainError(
        'Private or loopback IP targets are blocked in production unless WEBHOOK_ALLOW_PRIVATE_TARGETS=true.',
        { targetUrl: ['Private IP blocked in production.'] },
      );
    }
  } else if (ipVer === 6) {
    if (
      options.production &&
      !options.allowPrivateTargets &&
      (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80'))
    ) {
      throw new ValidationDomainError(
        'Loopback or link-local IPv6 targets are blocked in production.',
        { targetUrl: ['Private IPv6 blocked in production.'] },
      );
    }
  } else if (options.production && !options.allowPrivateTargets) {
    if (host === 'localhost' || host.endsWith('.local') || !host.includes('.')) {
      throw new ValidationDomainError(
        'Internal hostnames require WEBHOOK_ALLOW_PRIVATE_TARGETS=true in production.',
        { targetUrl: ['Internal hostname blocked.'] },
      );
    }
  }

  if (options.production && !options.allowPrivateTargets && parsed.protocol !== 'https:') {
    throw new ValidationDomainError('Production external webhooks must use https://.', {
      targetUrl: ['HTTPS is required in production.'],
    });
  }

  return parsed.toString();
}
