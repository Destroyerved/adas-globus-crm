import { hash, verify } from '@node-rs/argon2';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export * from './totp.js';

/**
 * Secrets at rest (PRD 7.2, 9): AES-256-GCM with a key read from TOKEN_ENCRYPTION_KEY_FILE.
 * Used for authenticator secrets now and for connector tokens (PRD 8.2) later. Each value
 * is bound to its purpose and owner through additional authenticated data, so a ciphertext
 * copied to another row or column doesn't decrypt. Format:
 * `v1.<keyVersion>.<iv>.<tag>.<ciphertext>` (base64url parts).
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(
    keyMaterial: string,
    readonly keyVersion: number,
  ) {
    const material = keyMaterial.trim();
    if (material.length < 32) throw new Error('The encryption key must be at least 32 characters.');
    this.key = Buffer.from(
      hkdfSync('sha256', material, Buffer.alloc(0), 'adas-crm secret box', 32),
    );
  }

  /** A box with a random key, for tests and throw-away e2e databases only. */
  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(32).toString('hex'), 1);
  }

  seal(plain: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', this.keyVersion, iv, cipher.getAuthTag(), body]
      .map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : String(part)))
      .join('.');
  }

  open(sealed: string, context: string): string {
    const [format, version, iv, tag, body] = sealed.split('.');
    if (format !== 'v1' || !iv || !tag || body === undefined) {
      throw new Error('Unreadable encrypted value.');
    }
    if (Number(version) !== this.keyVersion) {
      throw new Error(`Encrypted with key version ${version}; this server has ${this.keyVersion}.`);
    }
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }
}

/** The configured box, or null when the key file is missing (never null in production). */
export function loadSecretBox(
  file: string,
  version: number,
  production: boolean,
): SecretBox | null {
  if (existsSync(file)) {
    const material = readFileSync(file, 'utf8');
    if (material.trim().length >= 32) return new SecretBox(material, version);
  }
  if (production) {
    throw new Error(`TOKEN_ENCRYPTION_KEY_FILE ${file} is missing or shorter than 32 characters.`);
  }
  return null;
}

/**
 * Argon2id with RFC 9106's second recommended setting (64 MiB, 3 passes, 4 lanes). Only the
 * emergency admin accounts have passwords (PRD 6.6), so the cost is affordable.
 */
const ARGON2 = { memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // a malformed stored hash is a failed check, not a crash
  }
}

/** 24 characters from an unambiguous alphabet in groups of four (about 119 bits). */
export function generatePassphrase(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const groups: string[] = [];
  for (let g = 0; g < 6; g += 1) {
    let group = '';
    for (let i = 0; i < 4; i += 1) group += alphabet[randomInt(alphabet.length)];
    groups.push(group);
  }
  return groups.join('-');
}
