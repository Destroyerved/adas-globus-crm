# ADR 0021: Outreach Sequences, Campaigns, ESP Bulk Adapter and Stored Click Redirects

- **Status:** Accepted
- **Date:** 2026-11-18
- **References:** PRD 4.12, 4.13, 5.1–5.5, 6.5, 6.9, 8.3–8.7, 9, 12.1 (A12, A15–A20), 15 (Q5, Q6, Q12); DESIGN 6.5, 6.8, 10

## Context

Phases 5a and 5b require two complementary email automation engines governed by one compliance gate:

1. **Personal Outreach Sequences (`PRD 4.12`):** Multi-step plain-text email and follow-up task sequences sent from connected employee Microsoft 365 mailboxes within recipient business-day send windows (`09:00–17:00` local time, skipping US/CA public holidays), capped per mailbox (`50/day` default) and per contact (`2` automated emails in rolling `7` days), stopping immediately on reply, bounce, unsubscribe, suppression, meeting scheduled, or deal creation/win.
2. **Marketing Campaigns (`PRD 4.13`):** Block-editor HTML + plain-text campaigns targeting dynamic segments (using the shared `PRD 6.8` filter registry) or static lists, sent from verified dedicated sending subdomains (`sender_identities` with SPF, DKIM, and DMARC checks), requiring second-person approval (`campaigns.approve`, creator cannot self-approve unless `Admin`), warm-up/hourly throttling, signed ESP webhooks, automatic threshold pause (`hard_bounce > 3%` or `complaint > 0.1%`), and scanner-safe click redirects without open-redirect vulnerabilities.

## Decisions

1. **Single Send Gate (`checkSendable` + `executeSendMessageJob`):**
   - Every sequence email and every campaign recipient is evaluated by `evaluateRecipientSendability` / `checkSendable()` immediately before send.
   - Suppression checks (`SUPPRESSED_EMAIL`, `SUPPRESSED_DOMAIN`) run immediately after syntax normalisation so permanent suppressions always win over verification state (`AGENTS.md §10`).
   - `executeSendMessageJob` (`send.message` queue) remains the **only** code path permitted to insert into `message_sends`.
   - When `MAIL_LIVE === true`, `executeSendMessageJob` additionally verifies `settings('compliance.counsel_signed_off').approved === true` (`PRD 15 Q6`), blocking live automated sends until counsel sign-off is recorded. Outside production (`MAIL_LIVE=false`), both sequence `MailboxProvider` and campaign `BulkSender` route to `MailpitTransport`.

2. **Real `EspBulkSender` + Signed Idempotent `/api/v1/webhooks/esp` (`PRD 8.3, 8.7`):**
   - `EspBulkSender` implements `BulkSender` over HTTPS for Postmark, Resend, or generic JSON ESP APIs, attaching `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (`RFC 8058`) alongside market-aware physical postal footers (`Sheridan, WY` for US/OTHER; `Edmonton, AB` for CA).
   - `POST /api/v1/webhooks/esp` is exposed on the public `go.` host, verifies raw-body HMAC-SHA256 signatures (`X-ESP-Signature` / Svix `v1`) with a 5-minute replay window, deduplicates via `send_events (provider, provider_event_id)`, and enforces auto-pause thresholds (`> 3%` hard bounce over `>= 50` sends or `> 0.1%` spam complaint over `>= 100` sends), notifying `Admin` and `Marketing Manager` users.

3. **Stored-URL Click Redirects (`click_tokens` on `go.adasglobuspro.com/c/:token`, `PRD 4.13, 6.5`):**
   - Outbound links when click tracking is enabled mint random URL-safe tokens whose `SHA-256` digest is stored in `click_tokens` alongside the validated `http(s)://` `target_url` (`CHECK (target_url ~* '^https?://')`).
   - `GET /c/:token` looks up `sha256(token)` and issues a `302` redirect solely to the stored `target_url`—never reading a target URL from query parameters—eliminating open-redirect abuse. Email open pixels are disabled by default (`PRD 4.12, 4.13`) and never feed lead/contact scoring (`PRD 4.14`).
