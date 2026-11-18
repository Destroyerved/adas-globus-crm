import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { redactSensitiveText } from './redact.js';

/**
 * Tamper-Evident Append-Only Admin Action Audit Trail (`agent-audit.jsonl`).
 *
 * Each line records `prevHash` and `entryHash = SHA-256(prevHash + canonicalJson)` so
 * tampering or deleting lines in `agent-audit.jsonl` is cryptographically detectable.
 */

export type AgentRole = 'viewer' | 'operator' | 'admin';

export interface AgentAuditEntry {
  id: string;
  timestamp: string;
  actorKeyId: string;
  actorName: string;
  actorRole: AgentRole | 'unauthenticated';
  action: string;
  outcome: 'success' | 'denied' | 'error';
  ipHash: string;
  metadata: Record<string, string | number | boolean | null>;
  prevHash: string;
  entryHash: string;
}

const GENESIS_HASH = '0'.repeat(64);

function computeEntryHash(
  prevHash: string,
  payloadWithoutHash: Omit<AgentAuditEntry, 'entryHash'>,
): string {
  const canonical = JSON.stringify({
    id: payloadWithoutHash.id,
    timestamp: payloadWithoutHash.timestamp,
    actorKeyId: payloadWithoutHash.actorKeyId,
    actorName: payloadWithoutHash.actorName,
    actorRole: payloadWithoutHash.actorRole,
    action: payloadWithoutHash.action,
    outcome: payloadWithoutHash.outcome,
    ipHash: payloadWithoutHash.ipHash,
    metadata: payloadWithoutHash.metadata,
    prevHash,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export class AgentAuditLogger {
  private readonly logPath: string;
  private lastHash: string = GENESIS_HASH;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.logPath = path.join(dataDir, 'agent-audit.jsonl');
    if (existsSync(this.logPath)) {
      const existing = this.readAll();
      const tail = existing[existing.length - 1];
      if (tail) {
        this.lastHash = tail.entryHash;
      }
    }
  }

  append(params: {
    actorKeyId: string;
    actorName: string;
    actorRole: AgentRole | 'unauthenticated';
    action: string;
    outcome: 'success' | 'denied' | 'error';
    remoteIp: string;
    metadata?: Record<string, string | number | boolean | null>;
  }): AgentAuditEntry {
    const cleanMetadata: Record<string, string | number | boolean | null> = {};
    for (const [k, v] of Object.entries(params.metadata ?? {})) {
      cleanMetadata[k] = typeof v === 'string' ? redactSensitiveText(v) : v;
    }

    const ipHash = createHash('sha256')
      .update(`adas-agent-ip:${params.remoteIp}`, 'utf8')
      .digest('hex')
      .slice(0, 16);

    const partial: Omit<AgentAuditEntry, 'entryHash'> = {
      id: `aud_${randomUUID()}`,
      timestamp: new Date().toISOString(),
      actorKeyId: params.actorKeyId,
      actorName: redactSensitiveText(params.actorName),
      actorRole: params.actorRole,
      action: params.action,
      outcome: params.outcome,
      ipHash,
      metadata: cleanMetadata,
      prevHash: this.lastHash,
    };

    const entryHash = computeEntryHash(this.lastHash, partial);
    const full: AgentAuditEntry = { ...partial, entryHash };
    this.lastHash = entryHash;

    appendFileSync(this.logPath, `${JSON.stringify(full)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      chmodSync(this.logPath, 0o600);
    } catch {
      // Windows NTFS ACLs ignore POSIX chmod
    }
    return full;
  }

  readAll(): AgentAuditEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const entries: AgentAuditEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AgentAuditEntry);
      } catch {
        // Ignore truncated line if crash occurred mid-write; verifyChainIntegrity detects tampering
      }
    }
    return entries;
  }

  listRecent(limit = 100): AgentAuditEntry[] {
    const all = this.readAll();
    const clamped = Math.max(1, Math.min(500, limit));
    return all.slice(-clamped).reverse();
  }

  verifyChainIntegrity(): { valid: boolean; checkedCount: number; brokenAtIndex: number | null } {
    const entries = this.readAll();
    let expectedPrev = GENESIS_HASH;
    for (let i = 0; i < entries.length; i += 1) {
      const item = entries[i];
      if (!item) continue;
      if (item.prevHash !== expectedPrev) {
        return { valid: false, checkedCount: i, brokenAtIndex: i };
      }
      const recomputed = computeEntryHash(expectedPrev, item);
      if (recomputed !== item.entryHash) {
        return { valid: false, checkedCount: i, brokenAtIndex: i };
      }
      expectedPrev = item.entryHash;
    }
    return { valid: true, checkedCount: entries.length, brokenAtIndex: null };
  }
}
