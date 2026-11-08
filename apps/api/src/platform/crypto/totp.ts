import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps), the
 * format every authenticator app reads. Used only for emergency admin sign-in (PRD 6.6).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 encoded (RFC 4226 recommends 160 bits). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one time step. `digits` exists for the RFC test vectors. */
export function totpCode(secret: string, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift). Returns
 * the matching step, or null. A step at or before `lastUsedStep` never matches, so a code
 * can't be used twice.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(atMs);
  let matched: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const expected = Buffer.from(totpCode(secret, step));
    // Compare every candidate so timing doesn't reveal which step matched.
    if (timingSafeEqual(expected, Buffer.from(code)) && matched === null) matched = step;
  }
  if (matched === null || (lastUsedStep !== null && matched <= lastUsedStep)) return null;
  return matched;
}

/** The link an authenticator app reads from a QR code or as text. */
export function totpUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
