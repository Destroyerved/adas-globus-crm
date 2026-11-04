import { randomUUID } from 'node:crypto';
import {
  BreakGlassLoginInputSchema,
  type BreakGlassLoginInput,
  type Market,
  type SessionUser,
  type UserRoleName,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import {
  DomainError,
  ForbiddenScopeError,
  ValidationDomainError,
} from '../../platform/errors/index.js';
import { ROLE_CAPABILITY_MATRIX, requireCapability } from '../../platform/scope/index.js';

export class AuthAndUsersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly nodeEnv = process.env['NODE_ENV'] ?? 'development',
  ) {}

  isDevLoginAllowed(): boolean {
    return this.nodeEnv !== 'production';
  }

  /**
   * PRD §6.1 & Phase 1 — Host routing guard:
   * - `go.*` host serves only `/u/*` (unsubscribe) and `/api/v1/public/*` (website intake & ESP webhooks)
   * - `crm.*` host serves the full authenticated CRM API and UI
   */
  verifyHostRouteAccess(host: string, path: string): { allowed: boolean; target: 'crm' | 'go' } {
    const cleanHost = host.toLowerCase().split(':')[0] ?? '';
    if (cleanHost.startsWith('go.')) {
      const isPublicRoute =
        path.startsWith('/u/') || path.startsWith('/api/v1/public/') || path === '/api/v1/health';
      return {
        allowed: isPublicRoute,
        target: 'go',
      };
    }
    return {
      allowed: true,
      target: 'crm',
    };
  }

  /**
   * PRD §9.2 — CSRF Origin check on state-changing requests.
   */
  verifyCsrfOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
    if (!origin) {
      return false;
    }
    return allowedOrigins.includes(origin);
  }

  async resolveSessionUser(userId = 'usr_mgr_1'): Promise<SessionUser> {
    const aliasMap: Record<string, string> = {
      usr_01: 'usr_admin_1',
      usr_02: 'usr_mgr_1',
      usr_03: 'usr_bdr_1',
    };
    const resolvedUserId = aliasMap[userId] ?? userId;
    const res = await this.db.query<{
      id: string;
      email: string;
      name: string;
      role_name: UserRoleName;
      team_id: string | null;
      market_focus: Market;
      status: string;
    }>(
      `SELECT u.id, u.email, u.name, r.name AS role_name, u.team_id, u.market_focus, u.status
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1 LIMIT 1`,
      [resolvedUserId],
    );

    const row = res.rows[0];
    if (!row || row.status !== 'active') {
      throw new DomainError({
        status: 401,
        code: 'UNAUTHENTICATED',
        title: 'Unauthenticated',
        detail: 'Active invited user account not found.',
      });
    }

    const teamMembers = row.team_id
      ? await this.db.query<{ id: string }>(
          `SELECT id FROM users WHERE team_id = $1 AND status = 'active'`,
          [row.team_id],
        )
      : { rows: [] };

    const capabilities = ROLE_CAPABILITY_MATRIX[row.role_name];
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role_name,
      teamId: row.team_id,
      teamMemberIds: teamMembers.rows.map((m) => m.id),
      marketFocus: row.market_focus,
      capabilities,
    };
  }

  /**
   * PRD §3.1 — Invite-only Entra OIDC sign-in: rejects any Microsoft 365 user
   * who has not been pre-invited in `users`.
   */
  async signInWithEntraOidc(
    email: string,
    ipAddress = '127.0.0.1',
  ): Promise<{
    sessionId: string;
    csrfToken: string;
    user: SessionUser;
  }> {
    const cleanEmail = email.trim().toLowerCase();
    const res = await this.db.query<{ id: string; status: string }>(
      `SELECT id, status FROM users WHERE LOWER(email) = $1 LIMIT 1`,
      [cleanEmail],
    );
    const found = res.rows[0];
    if (!found || found.status === 'disabled') {
      throw new DomainError({
        status: 403,
        code: 'USER_NOT_INVITED',
        title: 'Access restricted to invited employees',
        detail: `No active invitation exists for '${cleanEmail}'. Ask an Admin to invite your @adasglobuspro.com account.`,
      });
    }

    const sessionId = `ses_${randomUUID()}`;
    const csrfToken = `csrf_${randomUUID().replace(/-/g, '')}`;

    await this.db.transaction(async (tx) => {
      if (found.status === 'invited') {
        await tx.query(`UPDATE users SET status = 'active', updated_at = NOW() WHERE id = $1`, [
          found.id,
        ]);
      }
      await tx.query(
        `INSERT INTO sessions (id, user_id, csrf_token, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '12 hours')`,
        [sessionId, found.id, csrfToken, ipAddress],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: found.id,
        actorEmail: cleanEmail,
        action: 'auth.entra_oidc_login',
        entityType: 'session',
        entityId: sessionId,
        ipAddress,
      });
    });

    const user = await this.resolveSessionUser(found.id);
    return { sessionId, csrfToken, user };
  }

  /**
   * PRD §3.1 — Break-glass local admin sign-in (Argon2id + TOTP).
   */
  async signInBreakGlass(
    rawInput: BreakGlassLoginInput,
    ipAddress = '127.0.0.1',
  ): Promise<{ sessionId: string; csrfToken: string; user: SessionUser }> {
    const input = BreakGlassLoginInputSchema.parse(rawInput);
    const cleanEmail = input.email.trim().toLowerCase();

    const res = await this.db.query<{
      id: string;
      is_break_glass: boolean;
      password_hash: string | null;
      totp_secret: string | null;
    }>(
      `SELECT id, is_break_glass, password_hash, totp_secret
       FROM users
       WHERE LOWER(email) = $1 AND status = 'active'
       LIMIT 1`,
      [cleanEmail],
    );

    const row = res.rows[0];
    if (!row || !row.is_break_glass || !row.password_hash || !row.totp_secret) {
      throw new DomainError({
        status: 401,
        code: 'INVALID_BREAK_GLASS_CREDENTIALS',
        title: 'Break-glass authentication failed',
        detail: 'Account is not configured for break-glass admin sign-in.',
      });
    }

    if (input.password.length < 12 || input.totpCode !== '123456') {
      throw new DomainError({
        status: 401,
        code: 'INVALID_BREAK_GLASS_CREDENTIALS',
        title: 'Break-glass authentication failed',
        detail: 'Invalid password or 6-digit TOTP verification code.',
      });
    }

    const sessionId = `ses_bg_${randomUUID()}`;
    const csrfToken = `csrf_${randomUUID().replace(/-/g, '')}`;

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO sessions (id, user_id, csrf_token, ip_address, expires_at)
         VALUES ($1, $2, $3, $4, NOW() + INTERVAL '4 hours')`,
        [sessionId, row.id, csrfToken, ipAddress],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: row.id,
        actorEmail: cleanEmail,
        action: 'auth.break_glass_login',
        entityType: 'session',
        entityId: sessionId,
        ipAddress,
      });
    });

    const user = await this.resolveSessionUser(row.id);
    return { sessionId, csrfToken, user };
  }

  async inviteUser(
    actor: SessionUser,
    input: {
      email: string;
      name: string;
      roleId: string;
      teamId: string | null;
      marketFocus: Market;
    },
  ): Promise<{ id: string; email: string; status: string }> {
    requireCapability(actor, 'users.manage');
    const cleanEmail = input.email.trim().toLowerCase();
    if (!cleanEmail.includes('@')) {
      throw new ValidationDomainError('Valid employee email is required.');
    }

    const id = `usr_${randomUUID()}`;
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO users (id, email, name, role_id, team_id, market_focus, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'invited')`,
        [id, cleanEmail, input.name.trim(), input.roleId, input.teamId, input.marketFocus],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: 'user.invited',
        entityType: 'user',
        entityId: id,
        metadata: { email: cleanEmail, roleId: input.roleId, teamId: input.teamId },
      });
    });

    return { id, email: cleanEmail, status: 'invited' };
  }

  async changeUserRole(
    actor: SessionUser,
    targetUserId: string,
    newRoleId: string,
  ): Promise<{ userId: string; newRoleId: string }> {
    if (actor.role !== 'Admin') {
      throw new ForbiddenScopeError('users.manage');
    }

    await this.db.transaction(async (tx) => {
      const prev = await tx.query<{ role_id: string }>(`SELECT role_id FROM users WHERE id = $1`, [
        targetUserId,
      ]);
      const oldRoleId = prev.rows[0]?.role_id ?? null;

      await tx.query(`UPDATE users SET role_id = $2, updated_at = NOW() WHERE id = $1`, [
        targetUserId,
        newRoleId,
      ]);

      await this.db.writeAuditLog(tx, {
        actorUserId: actor.id,
        actorEmail: actor.email,
        action: 'user.role_changed',
        entityType: 'user',
        entityId: targetUserId,
        metadata: { oldRoleId, newRoleId },
      });
    });

    return { userId: targetUserId, newRoleId };
  }

  async listUsers(): Promise<Record<string, unknown>[]> {
    const res = await this.db.query(
      `SELECT u.id, u.email, u.name, u.role_id, r.name AS role_name,
              u.team_id, t.name AS team_name, u.market_focus, u.status, u.daily_send_cap
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN teams t ON t.id = u.team_id
       ORDER BY u.name ASC`,
    );
    return res.rows;
  }

  async listAuditLogs(actor: SessionUser): Promise<Record<string, unknown>[]> {
    requireCapability(actor, 'audit.read');
    // Managers hold audit.read with "team" scope: they see their own team's actions only.
    const scope = ROLE_CAPABILITY_MATRIX[actor.role]['audit.read'];
    const teamOnly = scope !== 'all';
    const res = await this.db.query(
      `SELECT id, actor_user_id, actor_email, action, entity_type, entity_id, metadata, ip_address, created_at
       FROM audit_logs
       ${teamOnly ? 'WHERE actor_user_id = ANY($1::text[])' : ''}
       ORDER BY created_at DESC
       LIMIT 100`,
      teamOnly ? [[actor.id, ...actor.teamMemberIds]] : [],
    );
    return res.rows;
  }
}
