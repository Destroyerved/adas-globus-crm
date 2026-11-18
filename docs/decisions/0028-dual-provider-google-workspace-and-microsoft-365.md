# ADR 0028: Dual-Provider Microsoft 365 & Google Workspace SSO and Delegated Mail

- **Status:** Accepted
- **Date:** 2026-11-19
- **References:** PRD §4.11, §4.12, §6.6, §8.2, §8.3, §8.7, §9, §15 Q2

## Context

`PRD §15 Q2` left open whether employee identity and 1:1 outreach mailboxes would use Microsoft 365 alone or also Google Workspace. The owner requested full flexibility so teams can sign in and automate email outreach with **both Microsoft 365 (Entra ID + Graph Outlook) and Google Workspace (Google OIDC + Gmail REST v1)** side-by-side—allowing a deployment to run Microsoft-only, Google-only, or mixed-provider teams where one BDR connects Outlook and another connects Gmail.

## Decision

1. **Dual-Provider Invite-Only OIDC Single Sign-On (`Auth`):**
   - Retain `EntraSignIn` (`/api/v1/auth/sso/start` & `/callback`) pinning `users.entra_object_id`.
   - Add `GoogleSignIn` (`/api/v1/auth/sso/google/start` & `/callback`) using `openid-client` v6 Authorization Code + PKCE (`S256`), `state`/`nonce` validation, mandatory `email_verified === true`, optional hosted-domain allowlist (`GOOGLE_ALLOWED_DOMAINS` checking `hd` and email domain), invite-only matching, and immutable `users.google_subject_id` pinning (migration `0024`).
   - Expose `{ microsoftSignIn, googleSignIn, devSignIn, adminSignIn }` from `GET /api/v1/auth/config` and render both buttons on `LoginScreen`.

2. **Dual-Provider Delegated Mailbox Sync, 1:1 Inbox & Sequence Sending (`Inbox` & `Outreach`):**
   - Widen `mailbox_connections.provider` check constraint (`chk_mailbox_connections_provider`) to `'microsoft_graph' | 'google_gmail'` and add `gmail_history_id TEXT` (migration `0024`).
   - Implement `GoogleGmailMailboxClient` (`apps/api/src/platform/mail-transport/google-gmail.ts`) using minimum delegated scopes (`openid email profile gmail.readonly gmail.send`), OAuth2 PKCE + `access_type=offline`, AES-256-GCM `SecretBox` token encryption, 90-day initial scan (`q=newer_than:90d (in:inbox OR in:sent)`), incremental `users.history.list` sync with automatic `404` expired-cursor fallback, metadata-only attachment indexing with on-demand base64url streaming, RFC 5322 MIME construction with `threadId` + `In-Reply-To` + `References`, and `429 Retry-After` `GmailThrottleError` backoff.
   - Normalize Gmail messages (including `message/delivery-status` DSN parts) into the shared `InboxService` ingestion pipeline so CRM participant/domain filtering, sandboxed HTML sanitization, `5.x.x` hard-bounce suppression, and sequence reply auto-stop behave identically across Outlook and Gmail.
   - Support optional real-time Google Cloud Pub/Sub push notifications via `users.watch` (renewed by `mail.subscriptions.renew`) and `POST /api/v1/webhooks/google` on `go.` (constant-time SHA-256 token comparison + `inbound_events` deduplication), while keeping the 5-minute `mail.sync` worker poll active as an always-on fallback.
   - Wire `OutreachService.setLiveMailboxSender` to `InboxService.sendSequenceMessageViaUserMailbox` so live sequence steps (`NODE_ENV=production` and `MAIL_LIVE=true` after counsel sign-off) send through whichever provider (`microsoft_graph` or `google_gmail`) the enrolled sender connected, while strictly routing all non-production mail to Mailpit (`AGENTS.md §5`).

## Consequences

- **Zero infrastructure creep:** No IMAP daemons, third-party sync proxies, or extra containers are introduced (`PRD §6.2`).
- **Provider-independent compliance:** `checkSendable()`, `List-Unsubscribe` one-click headers, market-specific postal footers, daily per-mailbox caps, bounce suppression, and reply detection apply identically regardless of whether a rep sends via Outlook or Gmail.
