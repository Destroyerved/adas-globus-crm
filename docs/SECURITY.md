# Security Architecture & Controls

This document describes the implemented security controls in ADAS Globus CRM (`PRD §6.5, §6.6, §9`) and how each control is enforced and tested.

## 1. Network & Host Isolation (`crm.` vs `go.`)

- **Private database & services:** PostgreSQL 17 and worker processes bind only to private loopback / internal Docker networks; PostgreSQL is never exposed to the public internet.
- **Host-header routing (`AuthAndUsersService.verifyHostRouteAccess`):**
  - `go.<domain>` serves **only** `/healthz`, `/api/v1/healthz`, `/api/v1/health`, `/u/:token` (unsubscribe), `/c/:token` (stored-URL click redirect), `/api/v1/public/*` (website intake), and `/api/v1/webhooks/*`. Every other route returns `404`.
  - `crm.<domain>` serves the SPA, `/api/docs`, and `/api/v1/*` behind Cloudflare Access and session/token authentication.
- **Cloudflare Access defence-in-depth (`CloudflareAccessVerifier`):**
  - When `CF_ACCESS_ENFORCE=true`, every `crm.` request must carry a valid `Cf-Access-Jwt-Assertion` signed by `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` matching `CF_ACCESS_AUD`, `iss`, `exp`, and `nbf`.

## 2. Authentication & Session Lifecycle

- **Primary employee SSO (`EntraSignIn`):** Single-tenant Microsoft Entra ID OIDC Authorization Code flow with PKCE (`S256`), `state` and `nonce` bound in an HMAC-SHA256 signed `HttpOnly` cookie, invite-only account matching, and immutable `entra_object_id` pinning on first sign-in (`ENTRA_ACCOUNT_MISMATCH` prevents account takeover if an email is reassigned).
- **Emergency Break-Glass Admin (`BreakGlassService`):**
  - Maximum 2 `Admin` accounts (`pnpm break-glass set <email>`).
  - Argon2id password hashing (`64 MiB` memory, 3 iterations) + RFC 6238 TOTP (`SHA-1`, 6 digits, 30s step) encrypted at rest with AES-256-GCM (`SecretBox`, row-bound AAD context `local_credentials.totp:<userId>` and versioned keys).
  - Constant-work dummy hash verification on unknown/locked accounts, SQL step replay prevention (`totp_last_step`), 5-failure 15-minute lockout, per-IP rate limiting, audit entries, and in-app security alerts to all active admins.
- **Server-side sessions (`SessionService`):**
  - `256-bit` random session token in `__Host-adas_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/` in production); only `SHA-256(token)` is stored in PostgreSQL.
  - 12-hour idle timeout (`last_seen_at`), 7-day absolute lifetime (`expires_at`), immediate revocation on sign-out or user deactivation (`users.status = 'disabled'`), and **session fixation protection** (any pre-existing session cookie is revoked before issuing a new session on sign-in).
- **Development login:** Compiled/gated out when `NODE_ENV=production` (`isDevLoginEnabled(env)` returns `false`, `/api/v1/auth/dev-login` returns `404`).
- **Scoped Service API Tokens (`ApiTokenService`):**
  - `192-bit` `adas_pat_<hex>` tokens stored as `SHA-256` hashes in `api_tokens`, shown once on creation.
  - Effective permissions are the intersection of the creator's live role capabilities and the token's explicit `capabilities` + `scope_level` (`own` / `team` / `all`). Deactivating the creator or revoking the token invalidates access immediately.

## 3. Authorization, CSRF & Rate Limiting

- **SQL-level data isolation (`scopeWhere`):** Every query over scoped records (`leads`, `contacts`, `companies`, `deals`, `tasks`, `imports`, `duplicates`, `exports`, `consents`, `email_threads`, `sequences`, `campaigns`) compiles the caller's `own`, `team`, or `all` scope into parameterized SQL `WHERE` predicates. Out-of-scope IDs return `404` to prevent existence enumeration (IDOR protection).
- **CSRF protection:** Cookie-authenticated state-changing requests (`POST`, `PATCH`, `PUT`, `DELETE`) must carry `Origin` matching `PUBLIC_WEB_URL`. CORS never reflects arbitrary origins.
- **Rate limiting:**
  - Public website intake: salted `ip_sha256` limit in PostgreSQL (`INQUIRY_RATE_LIMIT_PER_10M`, default `5` per 10 minutes → `429` + `Retry-After: 600`).
  - Break-glass sign-in: per-IP window limit (`20` per 15 minutes) + per-account lockout (`5` failures).
  - Authenticated API: per-user/per-token window limit (`API_RATE_LIMIT_PER_MIN`, default `600` per minute → `429` + `Retry-After: 60`).

## 4. Data Protection, Compliance & Audit Integrity

- **HTTP response headers (`applySecurityHeaders`):** `Content-Security-Policy` (no inline scripts, `frame-ancestors 'none'`), `Strict-Transport-Security` (production), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, and `X-Request-Id`.
- **Append-only audit & suppression tables:** PostgreSQL `REVOKE UPDATE, DELETE` + `BEFORE UPDATE OR DELETE` triggers protect `audit_logs`; `REVOKE DELETE` + `BEFORE DELETE` and `privacy_erasure` immutability triggers protect `suppressions`.
- **PII redaction & CSV safety:** Pino logs redact emails, phones, cookies, authorization headers, and message bodies; audit metadata for exports, suppressions, and privacy erasures stores counts and SHA-256 hashes rather than personal data; all CSV exports prepend UTF-8 BOM and neutralise spreadsheet formula prefixes (`=`, `+`, `-`, `@`, `\t`, `\r`).
