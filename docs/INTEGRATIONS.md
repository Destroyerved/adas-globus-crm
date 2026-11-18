# External Integrations & Webhook Setup Guide

Every external integration in ADAS Globus CRM calls the provider's real wire protocol, encrypts credentials at rest with versioned AES-256-GCM (`SecretBox`), and enforces safe non-production sandboxing (`MAIL_LIVE=false` routes all outbound mail to Mailpit outside production — `AGENTS.md §5`, `PRD §8.7`).

---

## 1. Microsoft Entra ID Single Sign-On (`PRD §6.6` — Owner Step `R3`)

1. In **Microsoft Entra Admin Center** -> **App registrations** -> **New registration**:
   - **Name:** `ADAS Globus CRM`
   - **Supported account types:** Single tenant (`adasglobuspro.com` directory only)
   - **Redirect URI (Web):** `https://crm.adasglobuspro.com/api/v1/auth/sso/callback` (and `http://localhost:5174/api/v1/auth/sso/callback` for dev)
2. Create a Client Secret and save its value in `secrets/entra_client_secret.txt` (`chmod 600`).
3. Set `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID` in `.env.production`.
4. **Invite-only enforcement:** Only users already invited in `Settings → People` can sign in; their `entra_object_id` is pinned on first login.

---

## 2. Microsoft 365 Graph Delegated Inbox & Sync (`PRD §4.11, §8.2` — Owner Step `R5`)

1. On the same Entra App Registration:
   - Add **Redirect URI (Web):** `https://crm.adasglobuspro.com/api/v1/inbox/oauth/callback`
   - Under **API permissions** -> **Microsoft Graph (Delegated)**, add **only**:
     `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`, and grant **Admin consent**.
2. Users connect their mailbox in **Inbox** -> **Connect Microsoft 365 mailbox**.
   - Refresh/access tokens are sealed with `SecretBox` (`key_version` tracked per row).
   - Initial sync pulls 90 days of `Inbox` and `SentItems`, storing **only** threads matching an existing CRM Contact email or non-free-mail Company domain (`PRD §4.11`).
   - Change notifications deliver to `https://go.adasglobuspro.com/api/v1/webhooks/microsoft` (verified by constant-time `clientState` HMAC), backed up by 5-minute delta polling and `mail.subscriptions.renew`.

---

## 3. Marketing Email Service Provider (`EspBulkSender` — Owner Steps `R6 / Q5 / Q6`)

1. Choose the ESP (`ESP_PROVIDER=postmark` | `resend` | `http_json`) and dedicate subdomain `mail.adasglobuspro.com` (never the root employee domain).
2. Publish `SPF`, `2048-bit DKIM`, and `DMARC` (`p=quarantine`) DNS records for `mail.adasglobuspro.com` (`infra/cloudflare/dns-records.bind`) and mark the sender identity verified in `Campaigns`.
3. Store the API key in `secrets/esp_api_key.txt` and webhook signing secret in `secrets/esp_webhook_secret.txt`.
4. Point the provider's bounce/complaint/delivery webhook to:
   - `POST https://go.adasglobuspro.com/api/v1/webhooks/esp` (`X-ADAS-Signature: t=<unix_sec>,v1=<hmac_sha256>` or Postmark/Resend HMAC header).
5. **Live send gate:** Campaigns and Sequences never send live mail until **all three** hold:
   - `NODE_ENV=production`,
   - `MAIL_LIVE=true` in `.env.production` (edited only by the owner), and
   - Legal counsel sign-off (`Q6`) recorded in `Settings` (`compliance.counsel_signed_off`).

---

## 4. Apollo REST v1 Connector (`PRD §4.14` — Owner Step `R7 / Q11`)

1. Confirm Apollo plan API terms (`Q11`) and save the API key in `secrets/apollo_api_key.txt`.
2. Configure the daily credit cap in `Settings → Integrations`.
3. All searches/imports/enrichments require upfront credit confirmation (`confirmCredits: true`), log usage in `apollo_credit_ledger`, deduplicate via `external_ids`, honour active `suppressions` first, and create **zero** `consent_records` (so Canadian contacts imported from Apollo have marketing basis `None` under CASL until consent is earned).

---

## 5. Microsoft Bookings Webhook (`PRD §4.14`)

1. Generate a 256-bit secret in `secrets/bookings_webhook_secret.txt`.
2. Configure Power Automate / Bookings connector to POST meeting events to:
   - `POST https://go.adasglobuspro.com/api/v1/webhooks/bookings`
   - Header: `X-ADAS-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256_of_ts_dot_raw_body>` (5-minute replay window).
3. Matching bookings deduplicate in `booking_events` (`customer_email_sha256` only), log a `meeting_booked` timeline activity, create a prep task, and immediately stop active outreach sequences for that contact.

---

## 6. Outbound Webhooks, Scoped Service Tokens & n8n (`PRD §4.14`)

- **Outbound Webhooks (`Settings → Webhooks`):** Endpoint secrets are encrypted with `SecretBox`. Every subscribed outbox event (`lead.created`, `deal.won`, `inquiry.received`, etc.) is delivered by the `webhook.deliver` worker with `X-ADAS-Signature: t=<unix_sec>,v1=<hmac_sha256>`, `X-ADAS-Event`, `X-ADAS-Delivery-Id`, SSRF private-IP blocking (unless `WEBHOOK_ALLOW_PRIVATE_TARGETS=true` for internal `http://n8n:5678`), and 24-hour exponential backoff.
- **Scoped API Tokens (`Settings → Integrations`):** `Authorization: Bearer adas_pat_<hex>` tokens are SHA-256 hashed and bounded by the creator's live role capabilities and selected `own`/`team`/`all` scope.
- **n8n Templates:** Ready-to-import workflows live in `infra/n8n/workflows/`.

---

## 7. Website Inquiry Intake (`PRD §4.10`)

Point the marketing website forms' `data-endpoint` attribute to:

- `POST https://go.adasglobuspro.com/api/v1/public/inquiries`
- Allowed CORS origins are configured in `INQUIRY_CORS_ORIGINS` (`https://www.adasglobuspro.com,https://adasglobuspro.com`).
- Enforces salted `ip_sha256` rate limiting (`5` per 10 minutes -> `429`), `(email, formType, utcDay)` idempotency, market routing (`Settings → Routing`), 1-business-day SLA reply task creation, and generic `202 {"status":"received"}` responses.
