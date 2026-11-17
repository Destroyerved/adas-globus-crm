import { randomBytes, randomUUID } from 'node:crypto';
import {
  CreateApiTokenInputSchema,
  type ApiTokenView,
  type Scope,
  type SessionUser,
} from '@adas/shared';
import { sha256Hex, type DatabaseService } from '../../platform/db/index.js';
import {
  DomainError,
  NotFoundDomainError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import {
  effectiveCapabilities,
  requireCapability,
  type CapabilityScopeValue,
} from '../../platform/scope/index.js';
import { type AuthAndUsersService } from './index.js';

const SCOPE_RANK: Record<CapabilityScopeValue, number> = {
  none: 0,
  own: 1,
  team: 2,
  all: 3,
};

function minScope(a: CapabilityScopeValue, b: CapabilityScopeValue): CapabilityScopeValue {
  return SCOPE_RANK[a] <= SCOPE_RANK[b] ? a : b;
}

function isoOrNull(val: unknown): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'string') {
    const parsed = new Date(val);
    return Number.isNaN(parsed.getTime()) ? val : parsed.toISOString();
  }
  return null;
}

/**
 * Scoped Service API Tokens (`Authorization: Bearer adas_pat_...` — PRD §4.14, §6.7, §9).
 * Tokens are stored SHA-256 hashed, shown once at creation, bounded by the creator's live
 * permissions, revocable, optional expiry, and audited.
 */
export class ApiTokenService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthAndUsersService,
  ) {}

  async listTokens(actor: SessionUser): Promise<{ items: ApiTokenView[] }> {
    requireCapability(actor, 'settings.manage');
    const res = await this.db.query<Record<string, unknown>>(
      `SELECT t.id, t.name, t.token_prefix, t.capabilities, t.scopes, t.scope_level,
              t.created_by_user_id, u.name AS created_by_name,
              t.expires_at, t.last_used_at, t.revoked_at, t.created_at
       FROM api_tokens t
       LEFT JOIN users u ON u.id = t.created_by_user_id
       ORDER BY t.created_at DESC
       LIMIT 200`,
    );
    return {
      items: res.rows.map((r) => ({
        id: String(r['id']),
        name: String(r['name']),
        tokenPrefix: String(r['token_prefix']),
        capabilities: Array.isArray(r['capabilities'])
          ? (r['capabilities'] as string[])
          : Array.isArray(r['scopes'])
            ? (r['scopes'] as string[])
            : [],
        scopeLevel: (r['scope_level'] as Scope) ?? 'team',
        createdByUserId: String(r['created_by_user_id']),
        createdByName: (r['created_by_name'] as string | null) ?? null,
        expiresAt: isoOrNull(r['expires_at']),
        lastUsedAt: isoOrNull(r['last_used_at']),
        revokedAt: isoOrNull(r['revoked_at']),
        createdAt: isoOrNull(r['created_at']) ?? new Date().toISOString(),
      })),
    };
  }

  async createToken(
    actor: SessionUser,
    rawInput: unknown,
    ip: string | null,
  ): Promise<{ token: ApiTokenView; secretToken: string }> {
    requireCapability(actor, 'settings.manage');
    const input = CreateApiTokenInputSchema.parse(rawInput);
    const actorCaps = effectiveCapabilities(actor);

    const uniqueCaps = [...new Set(input.capabilities)];
    for (const cap of uniqueCaps) {
      const granted = actorCaps[cap] ?? 'none';
      if (granted === 'none') {
        throw new ValidationDomainError(
          `Cannot grant capability "${cap}" because your account does not hold it.`,
          { capabilities: [`Your account does not hold ${cap}.`] },
        );
      }
      if (SCOPE_RANK[input.scopeLevel] > SCOPE_RANK[granted]) {
        throw new ValidationDomainError(
          `Scope "${input.scopeLevel}" exceeds your "${granted}" access for ${cap}.`,
          { scopeLevel: [`Cannot exceed your ${granted} scope for ${cap}.`] },
        );
      }
    }

    const secretToken = `adas_pat_${randomBytes(24).toString('hex')}`;
    const tokenPrefix = secretToken.slice(0, 15);
    const tokenSha256 = sha256Hex(secretToken);
    const id = `pat_${randomUUID()}`;
    const expiresInDays = input.expiresInDays ?? null;

    const inserted = await this.db.transaction(async (tx) => {
      const res = await tx.query<Record<string, unknown>>(
        `INSERT INTO api_tokens (
           id, name, token_prefix, token_sha256, scopes, capabilities, scope_level,
           created_by_user_id, expires_at
         ) VALUES (
           $1, $2, $3, $4, $5::jsonb, $5::jsonb, $6,
           $7, CASE WHEN $8::int IS NOT NULL THEN NOW() + make_interval(days => $8::int) ELSE NULL END
         ) RETURNING *`,
        [
          id,
          input.name,
          tokenPrefix,
          tokenSha256,
          JSON.stringify(uniqueCaps),
          input.scopeLevel,
          actor.id,
          expiresInDays,
        ],
      );

      await this.db.writeAuditLog(tx, {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: 'api_token.created',
        entityType: 'api_token',
        entityId: id,
        metadata: {
          name: input.name,
          tokenPrefix,
          capabilities: uniqueCaps,
          scopeLevel: input.scopeLevel,
          expiresInDays,
        },
        ipAddress: ip,
      });

      return res.rows[0] ?? {};
    });

    return {
      secretToken,
      token: {
        id,
        name: input.name,
        tokenPrefix,
        capabilities: uniqueCaps,
        scopeLevel: input.scopeLevel,
        createdByUserId: actor.id,
        createdByName: actor.name,
        expiresAt: isoOrNull(inserted['expires_at']),
        lastUsedAt: null,
        revokedAt: null,
        createdAt: isoOrNull(inserted['created_at']) ?? new Date().toISOString(),
      },
    };
  }

  async revokeToken(
    actor: SessionUser,
    tokenId: string,
    ip: string | null,
  ): Promise<{ id: string; revoked: true }> {
    requireCapability(actor, 'settings.manage');
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; name: string; token_prefix: string }>(
        `SELECT id, name, token_prefix FROM api_tokens WHERE id = $1 FOR UPDATE`,
        [tokenId],
      );
      const row = existing.rows[0];
      if (!row) {
        throw new NotFoundDomainError('API token', tokenId);
      }
      await tx.query(
        `UPDATE api_tokens SET revoked_at = COALESCE(revoked_at, NOW()) WHERE id = $1`,
        [tokenId],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: 'api_token.revoked',
        entityType: 'api_token',
        entityId: tokenId,
        metadata: { name: row.name, tokenPrefix: row.token_prefix },
        ipAddress: ip,
      });
      return { id: tokenId, revoked: true };
    });
  }

  /**
   * Authenticates `Authorization: Bearer adas_pat_...` and returns a capability-restricted
   * `SessionUser`. Throws 401 when a Bearer header is present but invalid, revoked, expired,
   * or belongs to a deactivated user. Returns `null` when no Bearer header was sent.
   */
  async authenticateBearer(
    authorizationHeader: string | string[] | undefined,
    ip: string | null,
  ): Promise<{ user: SessionUser; tokenId: string } | null> {
    const header = Array.isArray(authorizationHeader)
      ? authorizationHeader[0]
      : authorizationHeader;
    if (!header) return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match || !match[1]) {
      throw new DomainError({
        status: 401,
        code: 'INVALID_API_TOKEN',
        title: 'Invalid API token',
        detail: 'Malformed Authorization header. Expected Bearer <token>.',
      });
    }

    const rawToken = match[1];
    const hash = sha256Hex(rawToken);
    const res = await this.db.query<{
      id: string;
      name: string;
      token_prefix: string;
      capabilities: string[];
      scope_level: Scope;
      created_by_user_id: string;
      revoked_at: string | null;
      expired: boolean;
      should_audit: boolean;
    }>(
      `SELECT id, name, token_prefix, capabilities, scope_level, created_by_user_id, revoked_at,
              COALESCE(expires_at <= NOW(), FALSE) AS expired,
              COALESCE(last_audited_at < NOW() - INTERVAL '5 minutes', TRUE) AS should_audit
       FROM api_tokens
       WHERE token_sha256 = $1
       LIMIT 1`,
      [hash],
    );

    const tokenRow = res.rows[0];
    if (!tokenRow || tokenRow.revoked_at !== null || tokenRow.expired) {
      throw new DomainError({
        status: 401,
        code: 'INVALID_API_TOKEN',
        title: 'Invalid or expired API token',
        detail: 'This API token is unknown, revoked, or expired.',
      });
    }

    // Resolve live creator user (throws 401 UNAUTHENTICATED if deactivated)
    const creator = await this.auth.resolveSessionUser(tokenRow.created_by_user_id);
    const creatorCaps = effectiveCapabilities(creator);
    const allowedSet = new Set(Array.isArray(tokenRow.capabilities) ? tokenRow.capabilities : []);

    const restrictedCaps: Record<string, CapabilityScopeValue> = {};
    for (const [capKey, creatorScope] of Object.entries(creatorCaps)) {
      if (allowedSet.has(capKey) && creatorScope !== 'none') {
        restrictedCaps[capKey] = minScope(creatorScope, tokenRow.scope_level);
      } else {
        restrictedCaps[capKey] = 'none';
      }
    }

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE api_tokens
         SET last_used_at = NOW(),
             last_used_ip = $2,
             last_audited_at = CASE WHEN $3 THEN NOW() ELSE last_audited_at END
         WHERE id = $1`,
        [tokenRow.id, ip, tokenRow.should_audit],
      );
      if (tokenRow.should_audit) {
        await this.db.writeAuditLog(tx, {
          actorUserId: creator.id,
          actorEmail: creator.email,
          action: 'api_token.used',
          entityType: 'api_token',
          entityId: tokenRow.id,
          metadata: { tokenPrefix: tokenRow.token_prefix, name: tokenRow.name },
          ipAddress: ip,
        });
      }
    });

    return {
      tokenId: tokenRow.id,
      user: {
        ...creator,
        capabilities: restrictedCaps,
      },
    };
  }
}
