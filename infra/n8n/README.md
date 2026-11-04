# ADAS CRM — n8n Marketing & Email Automation Pipeline (PRD §4.14, §8.3–8.5, §10.2)

This directory contains the Phase 6 **n8n** workflow definitions and container configuration that orchestrate marketing & sales email automation with **ADAS CRM**.

## Architectural Guardrail (`AGENTS.md` §5 & §10, `PRD.md` §5.1)

- **n8n never sends raw SMTP/ESP emails directly to prospects** and **never writes directly to PostgreSQL**.
- Instead:
  1. **CRM → n8n (Signed Outbound Webhooks):** ADAS CRM emits transactional outbox events (`lead.created`, `inquiry.received`, `deal.stage_changed`, `campaign.auto_paused`) signed with `X-ADAS-Signature: sha256=<hmac>` (`IntelligenceService.dispatchPendingOutboxEventsToWebhooks`).
  2. **n8n → CRM (Scoped `adas_pat_*` API Token):** n8n verifies the HMAC-SHA256 signature and calls ADAS CRM's REST endpoints (`/api/v1/compliance/check-sendable`, `/api/v1/sequences/enroll`, `/api/v1/n8n/pipeline/trigger`) so every message is gated by `checkSendable()` (US CAN-SPAM / Canada CASL), stamped with an RFC 8058 one-click `List-Unsubscribe` token, and routed to Mailpit in non-production (`MAIL_LIVE=false`).

## Included Workflows (`infra/n8n/workflows/`)

1. **`01-inbound-lead-enrichment-and-sequence-enrollment.json`**
   - **Trigger:** `POST /webhook/adas-crm-outbox-lead` (`lead.created` or `inquiry.received`)
   - **Step 1:** Verifies `X-ADAS-Signature` (`HMAC-SHA256`) and 5-minute replay window.
   - **Step 2:** Runs `/api/v1/compliance/check-sendable` for the prospect's market (`US` CAN-SPAM or `CA` CASL).
   - **Step 3:** Calls `/api/v1/sequences/enroll` to enroll the prospect in the matching sequence (`seq_us_tax` or `seq_ca_casl`) and dispatches Step 1 through the CRM's `send.message` job.

2. **`02-marketing-campaign-preflight-and-dispatch.json`**
   - **Trigger:** Every 15 minutes during North American send windows (`08:00–17:00` recipient local time).
   - **Step 1:** Fetches `Marketing Manager`-approved campaigns (`GET /api/v1/campaigns`).
   - **Step 2:** Triggers throttled batch dispatch (`POST /api/v1/n8n/pipeline/trigger`) which enforces `checkSendable()`, injects `List-Unsubscribe`, and monitors the `>3%` bounce / `>0.1%` complaint auto-pause thresholds (`PRD §5.6 A20`).

## Local Setup

```bash
# Start PostgreSQL, Mailpit, and n8n (capped at 1.5 GB RAM per PRD §10.2)
docker compose -f infra/compose.dev.yml -f infra/compose.n8n.yml up -d
```

- **n8n UI:** `http://localhost:5678`
- **Mailpit UI (inspect all automated emails):** `http://localhost:8025`
