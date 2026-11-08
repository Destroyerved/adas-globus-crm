import {
  UpdateMyPreferencesInputSchema,
  type Market,
  type SessionUser,
  type UserRoleName,
} from '@adas/shared';
import { type DatabaseService } from '../../platform/db/index.js';
import { DomainError } from '../../platform/errors/index.js';
import { ROLE_CAPABILITY_MATRIX, type CapabilityScopeValue } from '../../platform/scope/index.js';

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
      role_id: string;
      timezone: string;
    }>(
      `SELECT u.id, u.email, u.name, r.name AS role_name, u.team_id, u.market_focus, u.status,
              u.role_id, u.timezone
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

    const [teamMembers, overrides] = await Promise.all([
      row.team_id
        ? this.db.query<{ id: string }>(
            `SELECT id FROM users WHERE team_id = $1 AND status = 'active'`,
            [row.team_id],
          )
        : Promise.resolve({ rows: [] as { id: string }[] }),
      // PRD 2.1: roles are editable bundles. Admin changes are stored per role and win over
      // the built-in defaults.
      this.db.query<{ capability: string; scope: CapabilityScopeValue }>(
        `SELECT capability, scope FROM role_capabilities WHERE role_id = $1`,
        [row.role_id],
      ),
    ]);

    const capabilities: Record<string, CapabilityScopeValue> = {
      ...ROLE_CAPABILITY_MATRIX[row.role_name],
    };
    for (const grant of overrides.rows) capabilities[grant.capability] = grant.scope;
    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role_name,
      teamId: row.team_id,
      teamMemberIds: teamMembers.rows.map((m) => m.id),
      marketFocus: row.market_focus,
      capabilities,
      timezone: row.timezone,
    };
  }

  /**
   * PRD 6.6: invite-only Microsoft sign-in. Matches a Microsoft account to an invited CRM
   * user by email, then pins the Microsoft object ID so a renamed or reused mailbox can't
   * take over the account. Returns the CRM user ID to start a session for.
   */
  async findUserForEntraSignIn(identity: { objectId: string; email: string }): Promise<string> {
    const res = await this.db.query<{
      id: string;
      status: string;
      entra_object_id: string | null;
    }>(
      `SELECT id, status, entra_object_id FROM users
       WHERE entra_object_id = $1 OR LOWER(email) = $2
       ORDER BY (entra_object_id = $1) DESC NULLS LAST
       LIMIT 1`,
      [identity.objectId, identity.email.trim().toLowerCase()],
    );
    const user = res.rows[0];
    if (!user || user.status === 'disabled') {
      throw new DomainError({
        status: 403,
        code: 'USER_NOT_INVITED',
        title: 'Access restricted to invited employees',
        detail:
          'Your Microsoft account has not been invited to ADAS CRM. Ask an admin to invite you.',
      });
    }
    if (user.entra_object_id && user.entra_object_id !== identity.objectId) {
      throw new DomainError({
        status: 403,
        code: 'ENTRA_ACCOUNT_MISMATCH',
        title: 'Different Microsoft account',
        detail:
          'This CRM user is linked to a different Microsoft account. Ask an admin to check it.',
      });
    }
    await this.db.query(
      `UPDATE users
       SET entra_object_id = $2,
           status = CASE WHEN status = 'invited' THEN 'active' ELSE status END,
           updated_at = NOW()
       WHERE id = $1`,
      [user.id, identity.objectId],
    );
    return user.id;
  }

  /** Development and tests only: the seeded user to sign in as (never in production). */
  async findUserForDevSignIn(userId: string): Promise<string> {
    if (!this.isDevLoginAllowed()) {
      throw new DomainError({
        status: 404,
        code: 'NOT_FOUND',
        title: 'Not found',
        detail: 'Not found.',
      });
    }
    const user = await this.resolveSessionUser(userId);
    return user.id;
  }

  /** The signed-in user's own preferences (PRD 4.7: "today" is in their time zone). */
  async updatePreferences(user: SessionUser, raw: unknown): Promise<{ timezone: string }> {
    const input = UpdateMyPreferencesInputSchema.parse(raw);
    await this.db.query(`UPDATE users SET timezone = $2, updated_at = NOW() WHERE id = $1`, [
      user.id,
      input.timezone,
    ]);
    return { timezone: input.timezone };
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
}

export {
  SessionService,
  CookieSigner,
  readCookies,
  serializeCookie,
  sessionCookieName,
  clientIp,
} from './sessions.js';
export { EntraSignIn, type EntraIdentity, type PendingSignIn } from './entra.js';
