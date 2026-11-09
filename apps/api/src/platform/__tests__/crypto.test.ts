import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfigPath } from '../config/index.js';
import {
  SecretBox,
  base32Decode,
  base32Encode,
  generatePassphrase,
  generateTotpSecret,
  hashPassword,
  loadSecretBox,
  totpCode,
  totpStep,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '../crypto/index.js';

// RFC 6238 appendix B uses the ASCII secret "12345678901234567890" for SHA-1.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('authenticator codes (RFC 6238)', () => {
  it('matches the RFC test vectors', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [seconds, code] of [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ] as const) {
      expect(totpCode(RFC_SECRET, totpStep(seconds * 1000), 8)).toBe(code);
    }
    // The 6-digit code is the last six digits of the same value.
    expect(totpCode(RFC_SECRET, totpStep(59_000))).toBe('287082');
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode('gezd gnbv-gy3t')).toEqual(base32Decode('GEZDGNBVGY3T'));
    expect(() => base32Decode('not base32!')).toThrow();
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('accepts one step of clock drift either way, and never the same step twice', () => {
    const secret = generateTotpSecret();
    const at = 1_800_000_000_000;
    const step = totpStep(at);
    expect(verifyTotp(secret, totpCode(secret, step), at, null)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, step - 1), at, null)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), at, null)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), at, null)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 2), at, null)).toBeNull();
    // Replay: the step already used, or an earlier one, is refused.
    expect(verifyTotp(secret, totpCode(secret, step), at, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step - 1), at, step - 1)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), at, step - 1)).toBe(step);
    expect(verifyTotp(secret, '12345', at, null)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', at, null)).toBeNull();
  });

  it('builds the link authenticator apps read', () => {
    expect(totpUri('ADAS CRM', 'admin@example.com', 'ABC')).toBe(
      'otpauth://totp/ADAS%20CRM%3Aadmin%40example.com?secret=ABC&issuer=ADAS+CRM&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('secrets at rest', () => {
  it('encrypts, and only opens with the same key and context', () => {
    const box = new SecretBox('k'.repeat(40), 1);
    const sealed = box.seal('JBSWY3DPEHPK3PXP', 'totp:usr_1');
    expect(sealed).toMatch(/^v1\.1\./);
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.open(sealed, 'totp:usr_1')).toBe('JBSWY3DPEHPK3PXP');
    // Each seal uses a fresh nonce.
    expect(box.seal('JBSWY3DPEHPK3PXP', 'totp:usr_1')).not.toBe(sealed);
    // Copied to another user's row: refused.
    expect(() => box.open(sealed, 'totp:usr_2')).toThrow();
    expect(() => new SecretBox('j'.repeat(40), 1).open(sealed, 'totp:usr_1')).toThrow();
    expect(() => new SecretBox('k'.repeat(40), 2).open(sealed, 'totp:usr_1')).toThrow(
      /key version 1/,
    );
    // Flip one bit of the ciphertext itself. (Rewriting the last base64url characters is not
    // enough: their unused low bits are ignored, so the bytes could come out unchanged.)
    const parts = sealed.split('.');
    const body = Buffer.from(parts[4] ?? '', 'base64url');
    body[0] = (body[0] ?? 0) ^ 0x01;
    const tampered = [...parts.slice(0, 4), body.toString('base64url')].join('.');
    expect(() => box.open(tampered, 'totp:usr_1')).toThrow();
    expect(() => new SecretBox('short', 1)).toThrow();
  });

  it('loads the key file, and fails closed in production when it is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'adas-key-'));
    const file = path.join(dir, 'key.txt');
    writeFileSync(file, `${'z'.repeat(48)}\n`);
    expect(loadSecretBox(file, 1, true)).toBeInstanceOf(SecretBox);
    expect(loadSecretBox(path.join(dir, 'missing.txt'), 1, false)).toBeNull();
    expect(() => loadSecretBox(path.join(dir, 'missing.txt'), 1, true)).toThrow(
      /TOKEN_ENCRYPTION_KEY_FILE/,
    );
  });

  it('reads relative secret paths from the repository root', () => {
    const resolved = resolveConfigPath('./secrets/session_secret.txt');
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.replace(/\\/g, '/')).toMatch(/\/secrets\/session_secret\.txt$/);
    expect(resolved).not.toContain(`${path.sep}apps${path.sep}`);
    const absolute = path.resolve(tmpdir(), 'x.txt');
    expect(resolveConfigPath(absolute)).toBe(absolute);
  });
});

describe('passwords', () => {
  it('hashes with Argon2id and verifies only the right password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(await verifyPassword(stored, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(stored, 'Correct horse battery staple')).toBe(false);
    expect(await verifyPassword('not a hash', 'anything')).toBe(false);
  });

  it('generates long passphrases without look-alike characters', () => {
    const a = generatePassphrase();
    expect(a).toMatch(/^[a-hj-km-np-z2-9]{4}(-[a-hj-km-np-z2-9]{4}){5}$/);
    expect(generatePassphrase()).not.toBe(a);
  });
});
