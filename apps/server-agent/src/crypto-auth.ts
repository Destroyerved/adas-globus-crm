import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRole } from './audit-log.js';

/**
 * Pairing, AES-256-GCM At-Rest Credential Vault, and Signed HMAC-SHA256 Request Authenticator
 * for `@adas/server-agent`.
 */

export interface SignedAgentHeaders {
  'x-adas-agent-key-id': string;
  'x-adas-agent-timestamp': string;
  'x-adas-agent-nonce': string;
  'x-adas-agent-signature': string;
}

export interface PairedClientSummary {
  keyId: string;
  clientName: string;
  role: AgentRole;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface StoredInvite {
  codeSha256: string;
  role: AgentRole;
  label: string;
  expiresAt: string;
  consumedAt: string | null;
}

interface StoredPairedClient {
  keyId: string;
  clientName: string;
  role: AgentRole;
  encryptedSecret: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface StoredAgentAuthFile {
  version: 1;
  invites: StoredInvite[];
  clients: StoredPairedClient[];
}

export function computeBodySha256Hex(rawBody: string | Buffer): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export function buildCanonicalSigningPayload(params: {
  timestampSec: number | string;
  nonce: string;
  method: string;
  pathWithQuery: string;
  rawBody: string | Buffer;
}): string {
  const bodyHash = computeBodySha256Hex(params.rawBody);
  return `${params.timestampSec}.${params.nonce}.${params.method.toUpperCase()}.${params.pathWithQuery}.${bodyHash}`;
}

export function signAgentRequest(params: {
  keyId: string;
  sharedSecret: string;
  method: string;
  pathWithQuery: string;
  rawBody?: string | Buffer;
  timestampSec?: number;
  nonce?: string;
}): SignedAgentHeaders {
  const ts = params.timestampSec ?? Math.floor(Date.now() / 1000);
  const nonce = params.nonce ?? randomBytes(16).toString('hex');
  const canonical = buildCanonicalSigningPayload({
    timestampSec: ts,
    nonce,
    method: params.method,
    pathWithQuery: params.pathWithQuery,
    rawBody: params.rawBody ?? '',
  });
  const mac = createHmac('sha256', params.sharedSecret).update(canonical, 'utf8').digest('hex');
  return {
    'x-adas-agent-key-id': params.keyId,
    'x-adas-agent-timestamp': String(ts),
    'x-adas-agent-nonce': nonce,
    'x-adas-agent-signature': `v1=${mac}`,
  };
}

function writeMode600(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS ACLs ignore POSIX chmod
  }
}

export class AgentCredentialStore {
  private readonly masterKey: Buffer;
  private readonly authFilePath: string;
  private readonly seenNonces = new Map<string, number>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const masterKeyPath = path.join(dataDir, 'agent_master_key.txt');
    if (existsSync(masterKeyPath)) {
      const hex = readFileSync(masterKeyPath, 'utf8').trim();
      this.masterKey = createHash('sha256').update(hex, 'utf8').digest();
    } else {
      const generated = randomBytes(32).toString('hex');
      writeMode600(masterKeyPath, `${generated}\n`);
      this.masterKey = createHash('sha256').update(generated, 'utf8').digest();
    }
    this.authFilePath = path.join(dataDir, 'agent-auth.json');
    if (!existsSync(this.authFilePath)) {
      this.saveState({ version: 1, invites: [], clients: [] });
    }
  }

  private loadState(): StoredAgentAuthFile {
    try {
      const parsed = JSON.parse(readFileSync(this.authFilePath, 'utf8')) as StoredAgentAuthFile;
      return {
        version: 1,
        invites: Array.isArray(parsed.invites) ? parsed.invites : [],
        clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      };
    } catch {
      return { version: 1, invites: [], clients: [] };
    }
  }

  private saveState(state: StoredAgentAuthFile): void {
    writeMode600(this.authFilePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  private encryptSecret(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decryptSecret(packed: string, aad: string): string {
    const parts = packed.split(':');
    if (parts.length !== 3) throw new Error('Corrupt agent credential ciphertext.');
    const iv = Buffer.from(parts[0] ?? '', 'hex');
    const tag = Buffer.from(parts[1] ?? '', 'hex');
    const ciphertext = Buffer.from(parts[2] ?? '', 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  issuePairingInvite(params: { role: AgentRole; label: string; ttlSeconds?: number }): {
    pairingCode: string;
    expiresAt: string;
    role: AgentRole;
    label: string;
  } {
    const ttl = Math.max(30, Math.min(3600, params.ttlSeconds ?? 300));
    const pairingCode = `pair_${randomBytes(24).toString('hex')}`;
    const codeSha256 = createHash('sha256').update(pairingCode, 'utf8').digest('hex');
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

    const state = this.loadState();
    // Prune expired invites older than 24h
    const cutoff = Date.now() - 86_400_000;
    state.invites = state.invites.filter((i) => Date.parse(i.expiresAt) > cutoff);
    state.invites.push({
      codeSha256,
      role: params.role,
      label: params.label.trim() || 'Desktop console',
      expiresAt,
      consumedAt: null,
    });
    this.saveState(state);

    return {
      pairingCode,
      expiresAt,
      role: params.role,
      label: params.label.trim() || 'Desktop console',
    };
  }

  redeemPairingInvite(params: { pairingCode: string; clientName: string }): {
    keyId: string;
    sharedSecret: string;
    role: AgentRole;
    clientName: string;
  } {
    const suppliedHash = Buffer.from(
      createHash('sha256').update(params.pairingCode.trim(), 'utf8').digest('hex'),
      'utf8',
    );
    const state = this.loadState();
    const now = Date.now();

    let matchedInvite: StoredInvite | undefined;
    for (const inv of state.invites) {
      const storedBuf = Buffer.from(inv.codeSha256, 'utf8');
      if (storedBuf.length === suppliedHash.length && timingSafeEqual(storedBuf, suppliedHash)) {
        matchedInvite = inv;
      }
    }

    if (!matchedInvite) {
      throw new Error('Invalid pairing code.');
    }
    if (matchedInvite.consumedAt !== null) {
      throw new Error('Pairing code has already been used.');
    }
    if (Date.parse(matchedInvite.expiresAt) <= now) {
      throw new Error('Pairing code has expired.');
    }

    matchedInvite.consumedAt = new Date(now).toISOString();

    const keyId = `agt_${randomBytes(12).toString('hex')}`;
    const sharedSecret = `agtsec_${randomBytes(32).toString('hex')}`;
    const cleanClientName = (params.clientName.trim() || matchedInvite.label).slice(0, 80);

    state.clients.push({
      keyId,
      clientName: cleanClientName,
      role: matchedInvite.role,
      encryptedSecret: this.encryptSecret(sharedSecret, keyId),
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });
    this.saveState(state);

    return {
      keyId,
      sharedSecret,
      role: matchedInvite.role,
      clientName: cleanClientName,
    };
  }

  verifySignedRequest(params: {
    keyId: string;
    timestampHeader: string;
    nonceHeader: string;
    signatureHeader: string;
    method: string;
    pathWithQuery: string;
    rawBody: string | Buffer;
    nowSec?: number;
  }): { keyId: string; clientName: string; role: AgentRole } {
    const nowSec = params.nowSec ?? Math.floor(Date.now() / 1000);
    const ts = Number.parseInt(params.timestampHeader, 10);
    if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > 300) {
      throw new Error('Request timestamp outside 5-minute replay window.');
    }
    const nonce = params.nonceHeader.trim();
    if (nonce.length < 16 || nonce.length > 128) {
      throw new Error('Invalid request nonce.');
    }

    this.pruneReplayCache(nowSec);
    const replayKey = `${params.keyId}:${nonce}`;
    if (this.seenNonces.has(replayKey)) {
      throw new Error('Replay detected: nonce already used.');
    }

    const state = this.loadState();
    const client = state.clients.find((c) => c.keyId === params.keyId && c.revokedAt === null);
    if (!client) {
      throw new Error('Unknown or revoked agent credential.');
    }

    if (!params.signatureHeader.startsWith('v1=')) {
      throw new Error('Malformed signature header.');
    }
    const suppliedHex = params.signatureHeader.slice(3).trim();
    const sharedSecret = this.decryptSecret(client.encryptedSecret, client.keyId);

    const canonical = buildCanonicalSigningPayload({
      timestampSec: ts,
      nonce,
      method: params.method,
      pathWithQuery: params.pathWithQuery,
      rawBody: params.rawBody,
    });
    const expectedHex = createHmac('sha256', sharedSecret).update(canonical, 'utf8').digest('hex');

    const bufSupplied = Buffer.from(suppliedHex, 'utf8');
    const bufExpected = Buffer.from(expectedHex, 'utf8');
    if (bufSupplied.length !== bufExpected.length || !timingSafeEqual(bufSupplied, bufExpected)) {
      throw new Error('Signature verification failed.');
    }

    this.seenNonces.set(replayKey, nowSec + 310);
    client.lastUsedAt = new Date(nowSec * 1000).toISOString();
    this.saveState(state);

    return {
      keyId: client.keyId,
      clientName: client.clientName,
      role: client.role,
    };
  }

  listClients(): PairedClientSummary[] {
    const state = this.loadState();
    return state.clients.map((c) => ({
      keyId: c.keyId,
      clientName: c.clientName,
      role: c.role,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
      revokedAt: c.revokedAt,
    }));
  }

  revokeClient(keyId: string): boolean {
    const state = this.loadState();
    const client = state.clients.find((c) => c.keyId === keyId && c.revokedAt === null);
    if (!client) return false;
    client.revokedAt = new Date().toISOString();
    this.saveState(state);
    return true;
  }

  private pruneReplayCache(nowSec: number): void {
    if (this.seenNonces.size < 256) return;
    for (const [k, exp] of this.seenNonces.entries()) {
      if (exp <= nowSec) this.seenNonces.delete(k);
    }
  }
}
