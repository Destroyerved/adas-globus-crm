# Security Architecture & Controls

This document describes the implemented security controls across ADAS Globus CRM, `@adas/server-agent`, and `@adas/desktop` (`PRD §6.5, §6.6, §9`) and the automated test suites that verify them.

---

## 1. Network & Host Isolation (`crm.` vs `go.`)

- **Zero inbound ports (`PRD §10.4`):** Production traffic ingresses exclusively through an outbound Cloudflare Tunnel (`cloudflared`). PostgreSQL 17, `api`, `worker`, `backup`, and `uptime-kuma` bind only to internal Docker networks or `127.0.0.1`.
- **Host-header routing (`AuthAndUsersService.verifyHostRouteAccess`):**
  - `go.<domain>` exposes **only** `/healthz`, `/api/v1/healthz`, `/api/v1/health`, `/u/:token` (hashed one-click `RFC 8058` unsubscribe), `/c/:token` (stored-URL click redirect with `CHECK (target_url ~* '^https?://')` blocking open redirects and `javascript:` URLs), `/api/v1/public/*` (website intake), and `/api/v1/webhooks/*`. All other paths return `404`.
  - `crm.<domain>` serves the SPA, `/api/docs`, and `/api/v1/*` behind Cloudflare Access and session/PAT authentication.
- **Cloudflare Access defence-in-depth (`CloudflareAccessVerifier`):**
  - When `CF_ACCESS_ENFORCE=true`, every `crm.` request must carry a valid `Cf-Access-Jwt-Assertion` verified against `https://<CF_ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (`RS256`/`ES256`, `aud`, `iss`, `exp`, `nbf`).

---

## 2. Authentication, Sessions & Startup Readiness Guards

- **Primary employee SSO (`EntraSignIn`):** Single-tenant Microsoft Entra ID OIDC Authorization Code + PKCE (`S256`), signed `state`/`nonce` cookie, invite-only user matching, and immutable `entra_object_id` pinning (`ENTRA_ACCOUNT_MISMATCH` blocks takeover).
- **Emergency Break-Glass Admin (`BreakGlassService`):**
  - Capped at `2` `Admin` accounts; Argon2id (`64 MiB`, 3 iterations) + RFC 6238 TOTP encrypted with AES-256-GCM (`SecretBox` AAD `local_credentials.totp:<userId>`), single-use step replay guard (`totp_last_step`), 5-try 15-minute lockout, per-IP throttling, and Admin security alerts.
- **Server-side sessions (`SessionService`):**
  - `256-bit` token in `__Host-adas_session` (`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`); only `SHA-256(token)` is persisted.
  - 12h idle timeout, 7d absolute lifetime, immediate revocation on `status = 'disabled'`, and **session fixation revocation** on every sign-in.
- **Production boot guard (`verifyProductionReadiness`):**
  - Refuses to boot `NODE_ENV=production` if `DATABASE_URL` uses `postgres` or `adas_admin` instead of least-privilege `adas_app`, if default dev passwords or missing `SecretBox`/session secret files are detected, if SQL migrations are unapplied, or if `MAIL_LIVE=true` lacks counsel sign-off (`Q6`) and live provider secrets. Dev login is compiled/gated out (`404`).
- **Scoped Service API Tokens (`ApiTokenService`):**
  - `adas_pat_<hex>` stored SHA-256 hashed; bounded by the intersection of the creator's live capabilities and the token's `scope_level` (`own` / `team` / `all`); revoked immediately when the creator is disabled.

---

## 3. Authorization, Input Sanitization & Webhook Verification

- **SQL-level scope enforcement (`scopeWhere`):** Every query over scoped entities (`leads`, `contacts`, `companies`, `deals`, `tasks`, `saved_views`, `bulk_jobs`, `imports`, `duplicates`, `exports`, `consents`, `email_threads`, `sequences`, `campaigns`, `reports`) compiles `own` / `team` / `all` predicates into parameterized SQL. Out-of-scope IDs return `404` (IDOR defense).
- **XSS & Sandboxed Email Rendering:**
  - `sanitizeEmailHtml()` strips `<script>`, `<style>`, `<iframe>`, `<svg>`, `<form>`, inline `on*` handlers, and `javascript:`/`data:text/html` URLs on ingest, rewriting external `<img src>` to `data-remote-url` until explicit user consent.
  - `<SandboxedEmailBody />` renders synced email HTML inside a scriptless `<iframe sandbox="">`.
- **Signed Inbound & Outbound Webhooks + SSRF Guard:**
  - `/api/v1/webhooks/esp` and `/api/v1/webhooks/bookings` enforce constant-time `HMAC-SHA256` verification over raw request bytes and a `±300s` replay window; `/api/v1/webhooks/microsoft` verifies constant-time `clientState`.
  - Outbound webhook targets are validated by `validateWebhookTargetUrl()` against loopback, link-local, RFC 1918 private ranges, and cloud metadata IPs (`169.254.169.254`).

---

## 4. Database Least Privilege, Encryption at Rest & Backups

- **Role separation (`00-provision-roles.sh`):** Runtime `api` and `worker` connect strictly as `adas_app` (`NOINHERIT`, DML only). DDL migrations (`migrate.js`) and `pg_dump` (`backup.js`) use `adas_admin`.
- **Append-only audit & suppression immutability:** `REVOKE UPDATE, DELETE` + `BEFORE UPDATE OR DELETE` triggers protect `audit_logs`; `REVOKE DELETE` + `BEFORE DELETE` and `privacy_erasure` triggers protect `suppressions`.
- **Versioned AES-256-GCM (`SecretBox`) & `ADASBK01` Backups:** OAuth tokens, TOTP secrets, and webhook secrets are encrypted with versioned keys and row-bound AAD. Database backups (`pg_dump -Fc`) are encrypted with AES-256-GCM (`ADASBK01`) before disk write or S3 Signature v4 upload.

---

## 5. Server Agent & Electron Desktop Console Hardening (`ADR 0027`)

- **`@adas/server-agent`:** Zero arbitrary shell execution (strict `zod` allowlists), single-use SHA-256 pairing codes (`5 / 10m` IP rate limit), `±300s` + nonce `HMAC-SHA256` request signing, `viewer`/`operator`/`admin` RBAC, `redactSensitiveText()` log scrubbing, and SHA-256 hash-chained `agent-audit.jsonl`.
- **`@adas/desktop`:** `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `connect-src 'none'` CSP, navigation lock, OS keychain + AES-256-GCM `ServerProfileVault`, and Main-Process-only HMAC signing rejecting non-loopback `http://` URLs.

---

## 6. Automated Security Verification Suites

- `apps/api/src/__tests__/ms2-security-auth.int.test.ts`
- `apps/api/src/__tests__/m1-break-glass.int.test.ts`
- `apps/api/src/__tests__/m3-compliance-privacy.int.test.ts`
- `apps/api/src/__tests__/m4-intake-routing-unsubscribe.int.test.ts`
- `apps/api/src/__tests__/ms15-10k-xlsx-and-security-acceptance.int.test.ts`
- `apps/server-agent/src/__tests__/server-agent.test.ts`
- `apps/desktop/src/__tests__/desktop-console.test.ts`
