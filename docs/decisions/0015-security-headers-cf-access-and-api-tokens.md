# 0015: HTTP security headers, Cloudflare Access JWT verification & scoped service API tokens

**Date:** 2026-11-18
**Status:** Accepted
**PRD references:** 2.2, 4.14, 6.5, 6.6, 6.7, 9, 10.6

## Context

`docs/PRODUCTION_AUDIT.md` identified five security gaps in the HTTP layer:

1. Missing `Content-Security-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Strict-Transport-Security`, and `X-Request-Id` headers on API and SPA responses.
2. Static SPA assets were registered below the session guard in `main.ts`, causing unauthenticated browser visits to `/` on the standalone API container to receive `401` JSON instead of the sign-in screen.
3. `CF_ACCESS_ENFORCE`, `CF_ACCESS_TEAM_DOMAIN`, and `CF_ACCESS_AUD` were validated in `env.schema.ts` but never enforced on `crm.` requests.
4. `api_tokens` rows could be created in SQL, yet `Authorization: Bearer` was never authenticated and had no live capability ceiling check.
5. `GET /api/v1/users` returned employee email addresses to non-admin roles, `OutreachService.listSequences`/`listCampaigns` lacked `scopeWhere`, and `/api/docs` was missing.

## Decisions

1. **Defence-in-depth HTTP headers (`platform/security/headers.ts`):** Every API, SPA, docs, and public unsubscribe response receives `Content-Security-Policy` (`frame-ancestors 'none'`, no inline scripts), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin`, `X-Request-Id`, and (in production) `Strict-Transport-Security`.
2. **Cloudflare Access JWT verifier (`modules/auth/cloudflare-access.ts`):** When `CF_ACCESS_ENFORCE=true`, every `crm.` request (after `/healthz`) validates `Cf-Access-Jwt-Assertion` (RS256/ES256 signature against Cloudflare's JWKS endpoint, issuer, audience, `exp`, and `nbf`).
3. **Session fixation & SPA order:** Static SPA files on `crm.` are served after Cloudflare Access verification and before `/api/v1/*` session checks. Every sign-in path (`sso/callback`, `dev-login`, `local/login`) revokes any pre-existing session cookie before issuing a new session token.
4. **Scoped service API tokens (`modules/auth/api-tokens.ts`, migration `0013`):** `Authorization: Bearer adas_pat_<hex>` resolves the creator's live account and intersects the creator's current role capabilities with the token's `capabilities` and `scope_level` (`own` / `team` / `all`), so a token can never outlive or exceed its creator's permissions.
5. **Per-user rate limiting & directory redaction:** Authenticated requests pass through `PerUserRateLimiter` (`API_RATE_LIMIT_PER_MIN`, default `600/min`), `GET /api/v1/users` omits employee email addresses unless the caller holds `users.manage`, and `/api/docs` + `/api/docs.json` serve the OpenAPI specification strictly to authenticated callers on `crm.`.
