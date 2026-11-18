# ADR 0020: Microsoft 365 Graph Inbox, Sandboxed Email Rendering and Development Mail Gate

- **Status:** Accepted
- **Date:** 2026-11-18
- **References:** PRD 4.11, 4.12, 4.18, 6.9, 8.2, 8.3, 8.7, 9, 12.1 (A10, A11); DESIGN 6.10, 9.3

## Context

Phase 4 requires every salesperson to connect their own Microsoft 365 mailbox using delegated OAuth2 permissions (`Mail.Read`, `Mail.Send`, `offline_access`), sync 90 days of initial history plus incremental folder deltas, receive webhook notifications on `go.adasglobuspro.com/api/v1/webhooks/microsoft`, render conversation threads safely inside the CRM and on record timelines, stream attachments on demand without filling local disk, and never send live external email outside production.

## Decisions

1. **Real Delegated OAuth2 + PKCE and `SecretBox` Encryption (`MicrosoftGraphMailboxClient` + `InboxService`):**
   - Access and refresh tokens are sealed with `SecretBox` (AES-256-GCM + HKDF-SHA256 + `token_key_version`) using row-bound AAD contexts (`mailbox_connection:<userId>:access` and `mailbox_connection:<userId>:refresh`).
   - When Entra credentials are unconfigured (`00000000-...` or missing secret file), `isConfigured()` returns `false` and the UI surfaces a clear configuration notice rather than simulating OAuth.
   - Graph `429` / `503` responses parse `Retry-After` (seconds or HTTP-date) and persist `mailbox_connections.retry_after_at` so worker delta polls back off per mailbox.
   - Disconnecting a mailbox (or encountering `invalid_grant`) clears stored access tokens, deletes remote subscriptions best-effort, and immediately pauses active `sequence_enrollments` sending from that user.

2. **Strict CRM Sync Rule & Thread Grouping:**
   - Synced messages are persisted only when at least one external participant matches `contact_emails` on an active contact, matches a non-free-mail `companies.domain` on an active company, or is linked manually by the user (`linked_by = 'user'`). Purely internal employee-to-employee mail and unknown personal mail are ignored.
   - Inbound replies stop active sequence enrollments (matching `In-Reply-To` / `References` against `message_sends.internet_message_id`, the contact, or the contact's company) and create a high-priority follow-up task; inbound `5.x.x` NDR bounces mark the address `invalid` and add an active `hard_bounce` suppression.
   - Attachments store metadata only in `email_attachments` and stream bytes on demand from Microsoft Graph after checking `inbox.read` scope.

3. **Input HTML Sanitisation + Scriptless Sandboxed `<iframe sandbox="">`:**
   - `sanitizeEmailHtml` strips active tags (`<script>`, `<style>`, `<iframe>`, `<svg>`, `<form>`), `on*` attributes, and unsafe URI schemes, and rewrites external `<img src="https://...">` to `data-remote-url="..."`.
   - `<SandboxedEmailBody />` renders sanitised HTML inside `<iframe sandbox="" referrerPolicy="no-referrer" srcDoc={...} />`, blocking scripts, same-origin access, and remote tracking pixels until the viewer clicks `"Load remote images"`.

4. **Non-Production Mail Gate (`PRD 8.7`):**
   - Live Graph `sendMail` / `createReply` executes only when `NODE_ENV === 'production'` and `MAIL_LIVE === true`; all non-production sends and replies route through `MailpitTransport`.
