# ADR 0007: Emergency admin sign-in

- **Status:** Accepted
- **Date:** 2026-11-08

## Context

PRD 6.6 asks for at most two local admin accounts with Argon2id passwords and TOTP, for when Microsoft Entra is unavailable, with every use audited and alerted, behind `POST /auth/local/login`. Until now the endpoint returned 501. The users table had `password_hash` and `totp_secret` columns in plain text, and the seed put a fake hash and a well-known TOTP secret on the seeded admin.

## Decision

1. **Credentials live in `local_credentials`** (PRD 7.2): the Argon2id hash, the TOTP secret encrypted with AES-256-GCM, the last accepted code step, the failure count and the lock. The old `users.password_hash` and `users.totp_secret` are cleared by migration 0006 and will be dropped in a later contract migration. `users.is_break_glass` marks the account.
2. **Argon2id with RFC 9106's second recommended setting** (64 MiB, 3 passes, 4 lanes) through `@node-rs/argon2`, a prebuilt native library with no install scripts. Only two accounts ever hash, so the cost is affordable.
3. **TOTP is RFC 6238 written in `platform/crypto`** (HMAC-SHA1, 6 digits, 30 s), tested against the RFC's vectors: about 40 lines, so no library. One step of drift either way is accepted, and a step at or before the last accepted one is refused, so a code works once. The step check is repeated in the UPDATE, so two requests racing with the same code can't both win.
4. **Secrets at rest use one `SecretBox`** keyed from `TOKEN_ENCRYPTION_KEY_FILE` (HKDF-SHA256, then AES-256-GCM with a random nonce). The additional data names the column and the user, so a ciphertext copied to another row doesn't decrypt. Values carry the key version; rotation is a later job. Production refuses to start without the key file; development without it reports admin sign-in as unavailable. The Microsoft 365 connector will store its tokens the same way (PRD 8.2).
5. **Every failure looks the same.** Unknown email, wrong password, wrong or reused code, a locked or deactivated account and a non-Admin role all return the same 401 and message, after an Argon2 verification even when there is no account. The audit log records the reason (`unknown_account`, `bad_password`, `bad_code`, `locked`, `not_allowed`) but never the attempted email, which could be anyone's.
6. **Lockout:** five wrong tries lock the account for 15 minutes; a lock that has run out starts a fresh count, and a successful sign-in resets it. Each network address also gets 20 attempts per 15 minutes before any account is looked at (in memory, per API process: enough for one API container).
7. **Alerts:** a successful sign-in, a lockout and a credential change each notify every active Admin in the app (`kind = 'security'`) and log a warning. Email alerts come with the Microsoft 365 connector.
8. **Set-up is a command, not a screen.** `pnpm break-glass set <email>` gives an existing Admin a generated 24-character passphrase (about 119 bits) and a new authenticator secret, shown once; `pnpm break-glass remove <email>` removes them. Both end the account's sessions, are audited and alert admins. A web screen would make the emergency path depend on the same sign-in it backs up, and a generated passphrase can't be weak.
9. **The sign-in request must come from the CRM web app** (`Origin` check), like every other write, so another site can't sign a browser in to an account it controls.
10. **Secret file paths resolve from the repository root.** `*_FILE` settings that are relative (development) are read from the repository root, absolute ones (production mounts) as given. Before this, the API started from `apps/api` and missed `secrets/`, so Microsoft sign-in would never have found its client secret in development.

## Consequences

- The e2e test API creates a synthetic emergency admin with credentials that `playwright.config.ts` generates on each run, so the browser test signs in for real and nothing secret is stored in the repository.
- The seeded admin is no longer an emergency account; nobody has emergency sign-in until the owner runs the command.
- Losing `TOKEN_ENCRYPTION_KEY_FILE` makes the authenticator secrets unreadable. The fix is to run `pnpm break-glass set` again; the key belongs in the off-site backup with the other secrets (PRD 10).
