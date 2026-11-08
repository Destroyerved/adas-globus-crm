import { BreakGlassLoginInputSchema } from '@adas/shared';
import { type Logger } from 'pino';
import {
  generatePassphrase,
  generateTotpSecret,
  hashPassword,
  totpUri,
  verifyPassword,
  verifyTotp,
  type SecretBox,
} from '../../platform/crypto/index.js';
import { type DatabaseService, type DbTx } from '../../platform/db/index.js';
import { DomainError } from '../../platform/errors/index.js';
import { normalizeEmail } from '../../platform/normalize/index.js';
import { addNotification } from '../notifications/index.js';

/**
 * Emergency admin sign-in (PRD 6.6): at most two local Admin accounts with an Argon2id
 * password and an authenticator code, for when Microsoft sign-in is down. Every attempt is
 * audited; a successful sign-in, a lockout and a credential change alert every active admin.
 *
 * Wrong email, wrong password, wrong or reused code, a locked account and a disabled user
 * all get the same answer, after the same amount of work, so the endpoint doesn't reveal
 * which emergency accounts exist.
 */

export const BREAK_GLASS_MAX_ACCOUNTS = 2;
export const BREAK_GLASS_MAX_FAILURES = 5;
export const BREAK_GLASS_LOCK_MINUTES = 15;
/** Attempts per network address per window, before any account is looked at. */
const IP_LIMIT = 20;
const IP_WINDOW_MS = 15 * 60_000;
const ISSUER = 'ADAS CRM';

const totpContext = (userId: string) => `local_credentials.totp:${userId}`;

const signInFailed = () =>
  new DomainError({
    status: 401,
    code: 'SIGN_IN_FAILED',
    title: 'Sign-in failed',
    detail: `The email, password or code is wrong. After ${BREAK_GLASS_MAX_FAILURES} wrong tries the account is locked for ${BREAK_GLASS_LOCK_MINUTES} minutes.`,
  });

type FailureReason =
  'unknown_account' | 'locked' | 'bad_password' | 'bad_code' | 'not_allowed' | 'unreadable_secret';

interface CredentialRow {
  id: string;
  name: string;
  status: string;
  role_name: string;
  password_hash: string;
  totp_secret_ciphertext: string;
  totp_last_step: string | null;
  locked: boolean;
}

export interface BreakGlassSetup {
  userId: string;
  name: string;
  email: string;
  password: string;
  totpSecret: string;
  otpauthUri: string;
}

export class BreakGlassService {
  private dummyHash: Promise<string> | null = null;
  private readonly attemptsByIp = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly db: DatabaseService,
    private readonly box: SecretBox | null,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  isAvailable(): boolean {
    return this.box !== null;
  }

  /**
   * Checks an emergency sign-in and returns the user ID to start a session for. Throws the
   * same 401 for every kind of failure.
   */
  async signIn(raw: unknown, ip: string): Promise<string> {
    const input = BreakGlassLoginInputSchema.parse(raw);
    if (!this.box) {
      throw new DomainError({
        status: 503,
        code: 'BREAK_GLASS_UNAVAILABLE',
        title: 'Admin sign-in unavailable',
        detail: 'Admin sign-in isn’t set up on this server. Use Microsoft sign-in.',
      });
    }
    this.limitByIp(ip);

    const email = normalizeEmail(input.email) ?? input.email.trim().toLowerCase();
    const res = await this.db.query<CredentialRow>(
      `SELECT u.id, u.name, u.status, r.name AS role_name, c.password_hash,
              c.totp_secret_ciphertext, c.totp_last_step::text AS totp_last_step,
              COALESCE(c.locked_until > NOW(), FALSE) AS locked
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN local_credentials c ON c.user_id = u.id
       WHERE LOWER(u.email) = $1 AND u.is_break_glass`,
      [email],
    );
    const row = res.rows[0];

    if (!row || row.locked) {
      await verifyPassword(await this.getDummyHash(), input.password); // same work either way
      await this.recordFailure(row ?? null, row ? 'locked' : 'unknown_account', ip);
      throw signInFailed();
    }

    const passwordOk = await verifyPassword(row.password_hash, input.password);
    let step: number | null = null;
    let secretReadable = true;
    try {
      const secret = this.box.open(row.totp_secret_ciphertext, totpContext(row.id));
      step = verifyTotp(
        secret,
        input.totpCode,
        this.now(),
        row.totp_last_step === null ? null : Number(row.totp_last_step),
      );
    } catch {
      secretReadable = false;
    }

    const reason: FailureReason | null = !passwordOk
      ? 'bad_password'
      : !secretReadable
        ? 'unreadable_secret'
        : step === null
          ? 'bad_code'
          : row.status === 'disabled' || row.role_name !== 'Admin'
            ? 'not_allowed'
            : null;
    if (reason || step === null) {
      if (reason === 'unreadable_secret') {
        this.logger.error({ userId: row.id }, 'emergency admin secret could not be decrypted');
      }
      await this.recordFailure(row, reason ?? 'bad_code', ip);
      throw signInFailed();
    }

    const accepted = await this.db.transaction(async (tx) => {
      // The step check in SQL stops two requests racing with the same code.
      const updated = await tx.query(
        `UPDATE local_credentials
         SET failed_attempts = 0, locked_until = NULL, totp_last_step = $2,
             last_used_at = NOW(), updated_at = NOW()
         WHERE user_id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
        [row.id, step],
      );
      if (updated.rowCount === 0) return false;
      await tx.query(
        `UPDATE users SET status = 'active', version = version + 1, updated_at = NOW()
         WHERE id = $1 AND status = 'invited'`,
        [row.id],
      );
      await this.alertAdmins(tx, {
        title: 'Emergency admin sign-in used',
        body: `${row.name} signed in with an emergency admin account. If this wasn’t expected, deactivate the account and check the audit log.`,
        userId: row.id,
        dedupeKey: `break_glass_used:${row.id}:${step}`,
      });
      return true;
    });
    if (!accepted) {
      await this.recordFailure(row, 'bad_code', ip);
      throw signInFailed();
    }
    this.logger.warn({ userId: row.id }, 'emergency admin sign-in used');
    return row.id;
  }

  /**
   * Sets (or replaces) the credentials of an existing Admin. Run from the command line by
   * the owner; the password and secret are shown once and never stored in plain text.
   * `fixed` lets the throw-away e2e database use credentials the test run generated.
   */
  async setUp(
    rawEmail: string,
    fixed?: { password: string; totpSecret: string },
  ): Promise<BreakGlassSetup> {
    const box = this.requireBox();
    const email = normalizeEmail(rawEmail) ?? rawEmail.trim().toLowerCase();
    const user = await this.findAdmin(email);
    const others = await this.db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM users u JOIN local_credentials c ON c.user_id = u.id
       WHERE u.is_break_glass AND u.status <> 'disabled' AND u.id <> $1`,
      [user.id],
    );
    if ((others.rows[0]?.n ?? 0) >= BREAK_GLASS_MAX_ACCOUNTS) {
      throw new Error(
        `There are already ${BREAK_GLASS_MAX_ACCOUNTS} emergency admin accounts. Remove one first.`,
      );
    }
    const password = fixed?.password ?? generatePassphrase();
    const totpSecret = fixed?.totpSecret ?? generateTotpSecret();
    const passwordHash = await hashPassword(password);
    const ciphertext = box.seal(totpSecret, totpContext(user.id));

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO local_credentials (user_id, password_hash, totp_secret_ciphertext)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET password_hash = EXCLUDED.password_hash,
             totp_secret_ciphertext = EXCLUDED.totp_secret_ciphertext,
             totp_last_step = NULL, failed_attempts = 0, locked_until = NULL,
             updated_at = NOW()`,
        [user.id, passwordHash, ciphertext],
      );
      await tx.query(
        `UPDATE users SET is_break_glass = TRUE, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [user.id],
      );
      // Old sessions of this account end with the old credentials.
      await tx.query(
        `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      await this.db.writeAuditLog(tx, {
        action: 'auth.break_glass.credentials_set',
        entityType: 'user',
        entityId: user.id,
        metadata: { via: 'command_line' },
      });
      await this.alertAdmins(tx, {
        title: 'Emergency admin credentials set',
        body: `New emergency sign-in credentials were set for ${user.name} from the server’s command line.`,
        userId: user.id,
        dedupeKey: null,
      });
    });

    return {
      userId: user.id,
      name: user.name,
      email,
      password,
      totpSecret,
      otpauthUri: totpUri(ISSUER, email, totpSecret),
    };
  }

  /** Removes an account's emergency credentials and ends its sessions. */
  async remove(rawEmail: string): Promise<{ userId: string; name: string }> {
    const email = normalizeEmail(rawEmail) ?? rawEmail.trim().toLowerCase();
    const res = await this.db.query<{ id: string; name: string }>(
      `SELECT id, name FROM users WHERE LOWER(email) = $1`,
      [email],
    );
    const user = res.rows[0];
    if (!user) throw new Error('No CRM user has that email.');
    await this.db.transaction(async (tx) => {
      await tx.query(`DELETE FROM local_credentials WHERE user_id = $1`, [user.id]);
      await tx.query(
        `UPDATE users SET is_break_glass = FALSE, version = version + 1, updated_at = NOW()
         WHERE id = $1`,
        [user.id],
      );
      await tx.query(
        `UPDATE sessions SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL`,
        [user.id],
      );
      await this.db.writeAuditLog(tx, {
        action: 'auth.break_glass.credentials_removed',
        entityType: 'user',
        entityId: user.id,
        metadata: { via: 'command_line' },
      });
    });
    return { userId: user.id, name: user.name };
  }

  private requireBox(): SecretBox {
    if (!this.box) {
      throw new Error(
        'TOKEN_ENCRYPTION_KEY_FILE is missing or shorter than 32 characters; it is needed to store the authenticator secret.',
      );
    }
    return this.box;
  }

  private async findAdmin(email: string): Promise<{ id: string; name: string }> {
    const res = await this.db.query<{ id: string; name: string; status: string; role: string }>(
      `SELECT u.id, u.name, u.status, r.name AS role FROM users u JOIN roles r ON r.id = u.role_id
       WHERE LOWER(u.email) = $1`,
      [email],
    );
    const user = res.rows[0];
    if (!user) {
      throw new Error('No CRM user has that email. Invite the person in Settings first.');
    }
    if (user.status === 'disabled') throw new Error('That user is deactivated.');
    if (user.role !== 'Admin') {
      throw new Error('Only people with the Admin role can have emergency sign-in.');
    }
    return user;
  }

  private limitByIp(ip: string): void {
    const now = this.now();
    for (const [key, entry] of this.attemptsByIp) {
      if (entry.resetAt <= now) this.attemptsByIp.delete(key);
    }
    const entry = this.attemptsByIp.get(ip) ?? { count: 0, resetAt: now + IP_WINDOW_MS };
    entry.count += 1;
    this.attemptsByIp.set(ip, entry);
    if (entry.count > IP_LIMIT) {
      throw new DomainError({
        status: 429,
        code: 'TOO_MANY_ATTEMPTS',
        title: 'Too many attempts',
        detail: 'Too many sign-in attempts from this network. Try again in 15 minutes.',
      });
    }
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hashPassword(generatePassphrase());
    return this.dummyHash;
  }

  private async recordFailure(
    row: { id: string; name: string } | null,
    reason: FailureReason,
    ip: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      let lockedNow = false;
      if (row && reason !== 'locked') {
        // A lock that has run out starts a fresh count; the count that reaches the limit
        // locks the account (SET expressions read the old row).
        const res = await tx.query<{ locked_now: boolean }>(
          `UPDATE local_credentials
           SET failed_attempts = CASE WHEN locked_until <= NOW() THEN 1
                                      ELSE failed_attempts + 1 END,
               locked_until = CASE
                 WHEN (CASE WHEN locked_until <= NOW() THEN 1 ELSE failed_attempts + 1 END) >= $2::int
                   THEN NOW() + make_interval(mins => $3::int)
                 WHEN locked_until <= NOW() THEN NULL
                 ELSE locked_until END,
               last_failed_at = NOW(), updated_at = NOW()
           WHERE user_id = $1
           RETURNING failed_attempts = $2::int AS locked_now`,
          [row.id, BREAK_GLASS_MAX_FAILURES, BREAK_GLASS_LOCK_MINUTES],
        );
        lockedNow = res.rows[0]?.locked_now ?? false;
      }
      // The attempted email isn't stored: for an unknown account it may be anyone's address.
      await this.db.writeAuditLog(tx, {
        action: 'auth.break_glass.failed',
        entityType: 'user',
        entityId: row?.id ?? null,
        metadata: { reason },
        ipAddress: ip,
      });
      if (row && lockedNow) {
        await this.db.writeAuditLog(tx, {
          action: 'auth.break_glass.locked',
          entityType: 'user',
          entityId: row.id,
          metadata: { minutes: BREAK_GLASS_LOCK_MINUTES },
          ipAddress: ip,
        });
        await this.alertAdmins(tx, {
          title: 'Emergency admin account locked',
          body: `${row.name}’s emergency sign-in was locked for ${BREAK_GLASS_LOCK_MINUTES} minutes after ${BREAK_GLASS_MAX_FAILURES} wrong tries.`,
          userId: row.id,
          dedupeKey: null,
        });
      }
    });
    this.logger.warn({ reason, userId: row?.id ?? null }, 'emergency admin sign-in failed');
  }

  private async alertAdmins(
    tx: DbTx,
    alert: { title: string; body: string; userId: string; dedupeKey: string | null },
  ): Promise<void> {
    const admins = await tx.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = 'Admin' AND u.status = 'active'`,
    );
    for (const admin of admins.rows) {
      await addNotification(tx, {
        userId: admin.id,
        kind: 'security',
        title: alert.title,
        body: alert.body,
        entityType: 'user',
        entityId: alert.userId,
        dedupeKey: alert.dedupeKey ? `${alert.dedupeKey}:${admin.id}` : null,
      });
    }
  }
}
