/**
 * Sets up or removes emergency admin sign-in (PRD 6.6) for an existing Admin. Run it on the
 * server, as the owner; the new password and authenticator secret are shown once.
 *
 *   pnpm break-glass set <email>      new password and authenticator secret
 *   pnpm break-glass remove <email>   remove the credentials and end the account's sessions
 *
 * At most two accounts can have emergency sign-in. Every change is audited and every active
 * admin is notified.
 */
import { BreakGlassService } from '../src/modules/auth/index.js';
import { loadDotEnv, resolveConfigPath, validateEnv } from '../src/platform/config/index.js';
import { loadSecretBox } from '../src/platform/crypto/index.js';
import { DatabaseService } from '../src/platform/db/index.js';
import { createLogger } from '../src/platform/logger/index.js';

loadDotEnv();
const env = validateEnv();
const [action, email] = process.argv.slice(2).filter((arg) => arg !== '--');

if (!email || (action !== 'set' && action !== 'remove')) {
  console.error('Usage: pnpm break-glass set <email>  |  pnpm break-glass remove <email>');
  process.exit(1);
}

const db = DatabaseService.connect(env.DATABASE_URL);
const service = new BreakGlassService(
  db,
  loadSecretBox(
    resolveConfigPath(env.TOKEN_ENCRYPTION_KEY_FILE),
    env.TOKEN_ENCRYPTION_KEY_VERSION,
    env.NODE_ENV === 'production',
  ),
  createLogger('warn'),
);

try {
  if (action === 'remove') {
    const user = await service.remove(email);
    console.log(`[break-glass] Removed emergency sign-in for ${user.name}. Their sessions ended.`);
  } else {
    const setup = await service.setUp(email);
    console.log(
      [
        '',
        `Emergency admin sign-in is set for ${setup.name} (${setup.email}).`,
        'This is the only time these are shown. Store them in the company password manager,',
        'or print them and keep them somewhere locked, and add the secret to an authenticator',
        'app (Microsoft Authenticator, Google Authenticator or 1Password).',
        '',
        `  Password:              ${setup.password}`,
        `  Authenticator secret:  ${setup.totpSecret}`,
        `  Authenticator link:    ${setup.otpauthUri}`,
        '',
        'Sign in from the CRM sign-in page with "Admin sign-in". Every use alerts all admins.',
        '',
      ].join('\n'),
    );
  }
} catch (err) {
  console.error(`[break-glass] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await db.close().catch(() => undefined);
}
