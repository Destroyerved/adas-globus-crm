import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage } from 'node:http';
import { type DatabaseService } from '../../platform/db/index.js';

/**
 * Server-side sessions (PRD 6.6). The browser holds a random token in an HttpOnly cookie;
 * the database stores only its SHA-256 hash, so a database leak can't be replayed.
 */

export interface SessionCookieOptions {
  production: boolean;
  absoluteDays: number;
}

export const sessionCookieName = (production: boolean) =>
  production ? '__Host-adas_session' : 'adas_session';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function readCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeSeconds: number; secure: boolean },
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${opts.maxAgeSeconds}`,
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

/** Signs short-lived values (the sign-in state cookie) so they can't be tampered with. */
export class CookieSigner {
  constructor(private readonly secret: string) {}

  sign(value: string): string {
    const body = Buffer.from(value).toString('base64url');
    const mac = createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  verify(signed: string | undefined): string | null {
    if (!signed) return null;
    const [body, mac] = signed.split('.');
    if (!body || !mac) return null;
    const expected = createHmac('sha256', this.secret).update(body).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return Buffer.from(body, 'base64url').toString('utf8');
  }
}

export class SessionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly idleHours: number,
    private readonly absoluteDays: number,
  ) {}

  /** Creates a session and returns the raw token for the cookie. */
  async create(userId: string, req: IncomingMessage, method: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO sessions (id, user_id, csrf_token, ip_address, user_agent, expires_at, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + make_interval(days => $6::int), NOW())`,
        [
          hashToken(token),
          userId,
          randomBytes(16).toString('hex'),
          clientIp(req),
          String(req.headers['user-agent'] ?? '').slice(0, 300),
          this.absoluteDays,
        ],
      );
      await this.db.writeAuditLog(tx, {
        actorUserId: userId,
        action: `auth.signed_in.${method}`,
        entityType: 'session',
        ipAddress: clientIp(req),
      });
    });
    return token;
  }

  /** The signed-in user for a token, or null if it's unknown, revoked, idle too long or expired. */
  async resolve(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    const id = hashToken(token);
    const res = await this.db.query<{ user_id: string; stale: boolean }>(
      `SELECT s.user_id, s.last_seen_at < NOW() - INTERVAL '5 minutes' AS stale
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > NOW()
         AND s.last_seen_at > NOW() - make_interval(hours => $2::int)
         AND u.status = 'active'`,
      [id, this.idleHours],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.stale) {
      await this.db.query(`UPDATE sessions SET last_seen_at = NOW() WHERE id = $1`, [id]);
    }
    return row.user_id;
  }

  async revoke(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.query(
      `UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  /** Signs a user out everywhere, e.g. when they are deactivated (PRD 6.6). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
  }
}

export function clientIp(req: IncomingMessage): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  return req.socket.remoteAddress ?? 'unknown';
}
