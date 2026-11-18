import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AgentRole } from '@adas/server-agent';
import type { ServerProfileSummary } from '../shared/ipc-contract.js';

/**
 * AES-256-GCM Encrypted Multi-Server Profile Vault (`@adas/desktop`).
 *
 * Paired `sharedSecret` and `cfAccessClientSecret` values are encrypted at rest with
 * per-record AAD (`profile.id`) and optionally wrapped by Electron's OS Keychain (`safeStorage`).
 * Renderer-bound `ServerProfileSummary` records never contain secret material.
 */

export interface OsSafeStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface DecryptedServerProfile extends ServerProfileSummary {
  sharedSecret: string;
  cfAccessClientId: string | null;
  cfAccessClientSecret: string | null;
}

interface StoredVaultRecord {
  id: string;
  name: string;
  mode: 'local' | 'remote';
  agentUrl: string;
  keyId: string;
  role: AgentRole;
  serverName: string;
  encryptedSharedSecret: string;
  cfAccessClientId: string | null;
  encryptedCfAccessSecret: string | null;
  createdAt: string;
  lastConnectedAt: string | null;
}

interface StoredVaultFile {
  version: 1;
  wrappedMasterKeyBase64?: string;
  profiles: StoredVaultRecord[];
}

function writeMode600(filePath: string, content: string): void {
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Windows NTFS ACLs ignore POSIX chmod
  }
}

export class ServerProfileVault {
  private readonly vaultFilePath: string;
  private readonly masterKey: Buffer;

  constructor(vaultDir: string, safeStorage?: OsSafeStorageAdapter) {
    mkdirSync(vaultDir, { recursive: true, mode: 0o700 });
    this.vaultFilePath = path.join(vaultDir, 'profiles.vault.json');
    const rawKeyFile = path.join(vaultDir, 'vault_key.txt');

    let existingVault: StoredVaultFile = { version: 1, profiles: [] };
    if (existsSync(this.vaultFilePath)) {
      try {
        existingVault = JSON.parse(readFileSync(this.vaultFilePath, 'utf8')) as StoredVaultFile;
      } catch {
        existingVault = { version: 1, profiles: [] };
      }
    }

    if (safeStorage?.isEncryptionAvailable()) {
      if (existingVault.wrappedMasterKeyBase64) {
        const unwrappedHex = safeStorage.decryptString(
          Buffer.from(existingVault.wrappedMasterKeyBase64, 'base64'),
        );
        this.masterKey = createHash('sha256').update(unwrappedHex, 'utf8').digest();
      } else {
        const freshHex = randomBytes(32).toString('hex');
        existingVault.wrappedMasterKeyBase64 = safeStorage
          .encryptString(freshHex)
          .toString('base64');
        this.masterKey = createHash('sha256').update(freshHex, 'utf8').digest();
        this.saveVault(existingVault);
      }
    } else if (existsSync(rawKeyFile)) {
      const hex = readFileSync(rawKeyFile, 'utf8').trim();
      this.masterKey = createHash('sha256').update(hex, 'utf8').digest();
    } else {
      const hex = randomBytes(32).toString('hex');
      writeMode600(rawKeyFile, `${hex}\n`);
      this.masterKey = createHash('sha256').update(hex, 'utf8').digest();
    }

    if (!existsSync(this.vaultFilePath)) {
      this.saveVault(existingVault);
    }
  }

  private loadVault(): StoredVaultFile {
    try {
      const parsed = JSON.parse(readFileSync(this.vaultFilePath, 'utf8')) as StoredVaultFile;
      return {
        version: 1,
        wrappedMasterKeyBase64: parsed.wrappedMasterKeyBase64,
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
      };
    } catch {
      return { version: 1, profiles: [] };
    }
  }

  private saveVault(vault: StoredVaultFile): void {
    writeMode600(this.vaultFilePath, `${JSON.stringify(vault, null, 2)}\n`);
  }

  private encryptField(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decryptField(packed: string, aad: string): string {
    const parts = packed.split(':');
    if (parts.length !== 3) throw new Error('Corrupt profile vault ciphertext.');
    const iv = Buffer.from(parts[0] ?? '', 'hex');
    const tag = Buffer.from(parts[1] ?? '', 'hex');
    const ciphertext = Buffer.from(parts[2] ?? '', 'hex');
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }

  private toSummary(rec: StoredVaultRecord): ServerProfileSummary {
    return {
      id: rec.id,
      name: rec.name,
      mode: rec.mode,
      agentUrl: rec.agentUrl,
      keyId: rec.keyId,
      role: rec.role,
      serverName: rec.serverName,
      hasCloudflareServiceToken: Boolean(rec.cfAccessClientId && rec.encryptedCfAccessSecret),
      createdAt: rec.createdAt,
      lastConnectedAt: rec.lastConnectedAt,
    };
  }

  listPublicProfiles(): ServerProfileSummary[] {
    return this.loadVault().profiles.map((p) => this.toSummary(p));
  }

  savePairedProfile(input: {
    name: string;
    mode: 'local' | 'remote';
    agentUrl: string;
    keyId: string;
    sharedSecret: string;
    role: AgentRole;
    serverName: string;
    cfAccessClientId?: string;
    cfAccessClientSecret?: string;
  }): ServerProfileSummary {
    const vault = this.loadVault();
    const id = `srv_${randomUUID()}`;
    const now = new Date().toISOString();

    const record: StoredVaultRecord = {
      id,
      name: input.name.trim(),
      mode: input.mode,
      agentUrl: input.agentUrl,
      keyId: input.keyId,
      role: input.role,
      serverName: input.serverName,
      encryptedSharedSecret: this.encryptField(input.sharedSecret, id),
      cfAccessClientId: input.cfAccessClientId?.trim() || null,
      encryptedCfAccessSecret: input.cfAccessClientSecret?.trim()
        ? this.encryptField(input.cfAccessClientSecret.trim(), `${id}:cf`)
        : null,
      createdAt: now,
      lastConnectedAt: now,
    };

    vault.profiles.push(record);
    this.saveVault(vault);
    return this.toSummary(record);
  }

  getDecryptedProfileForMainProcessOnly(profileId: string): DecryptedServerProfile {
    const vault = this.loadVault();
    const rec = vault.profiles.find((p) => p.id === profileId);
    if (!rec) {
      throw new Error(`Server profile not found: ${profileId}`);
    }
    return {
      ...this.toSummary(rec),
      sharedSecret: this.decryptField(rec.encryptedSharedSecret, rec.id),
      cfAccessClientId: rec.cfAccessClientId,
      cfAccessClientSecret: rec.encryptedCfAccessSecret
        ? this.decryptField(rec.encryptedCfAccessSecret, `${rec.id}:cf`)
        : null,
    };
  }

  touchLastConnected(profileId: string): void {
    const vault = this.loadVault();
    const rec = vault.profiles.find((p) => p.id === profileId);
    if (!rec) return;
    rec.lastConnectedAt = new Date().toISOString();
    this.saveVault(vault);
  }

  removeProfile(profileId: string): boolean {
    const vault = this.loadVault();
    const before = vault.profiles.length;
    vault.profiles = vault.profiles.filter((p) => p.id !== profileId);
    if (vault.profiles.length === before) return false;
    this.saveVault(vault);
    return true;
  }
}
