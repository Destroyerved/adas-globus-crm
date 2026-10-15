# Adas Globus Pro CRM

A self-hosted CRM with built-in email outreach, an **Apollo.io** connector for prospecting and enrichment, and a webhook + REST API layer built for **n8n** automations. One Node.js process, one SQLite file, no external database.

| Area | What's included |
|---|---|
| CRM | Contacts, companies, deals pipeline (drag-and-drop board), tasks, notes/calls/meetings/WhatsApp logs, timeline, lead scoring, tags, owners, CSV import/export, global search |
| Mailing | Send from your own mailbox (SMTP), templates with `{{variables}}`, multi-step **sequences** with auto-stop on reply, one-off **campaigns**, open/click tracking, unsubscribe page + `List-Unsubscribe`, bounce handling, IMAP reply sync |
| Apollo.io | People & company search, import with email reveal, contact/company enrichment, push contacts into Apollo sequences, credit usage log |
| n8n | Signed outbound webhooks for 28 events, REST API with API keys, 7 ready-to-import workflow templates, docker-compose with n8n included |
| Lead capture | Public form endpoints with honeypot + rate limit, embeddable HTML, auto-tagging, auto-enroll in a sequence, optional deal creation |
| Team | Admin / manager / sales roles, per-user email signature |

---

## 1. Run it

### Option A: on a Windows PC (quickest)
1. Install **Node.js 22.13+** from <https://nodejs.org>.
2. Double-click `start-crm.bat`. It installs dependencies, starts the server and opens <http://localhost:3000>.
3. Create the admin account on the welcome screen.

### Option B: any machine with Node
```bash
npm install
npm start
```

### Option C: Docker (CRM + n8n together)
```bash
cp .env.example .env      # then set APP_SECRET, N8N_ENCRYPTION_KEY, BASE_URL
docker compose up -d
```
CRM → <http://localhost:3000>, n8n → <http://localhost:5678>. Inside Docker, n8n reaches the CRM at `http://crm:3000` and the CRM reaches n8n at `http://n8n:5678/webhook/…`.

For a public server with HTTPS, point two DNS names at it, set `CRM_DOMAIN`, `N8N_DOMAIN`, `BASE_URL=https://crm.yourdomain`, `TRUST_PROXY=true`, `SECURE_COOKIES=true`, `N8N_PROTOCOL=https`, `N8N_HOST`, `N8N_WEBHOOK_URL`, then:
```bash
docker compose --profile https up -d
```

> **BASE_URL matters.** Open tracking, click tracking and unsubscribe links in emails point at `BASE_URL`. With `localhost`, recipients' clicks and opens can't reach you. Use your public HTTPS address in production.

### Demo data (optional)
```bash
npm run seed
```
Adds 6 companies, 8 contacts and 8 deals tagged `demo`. Remove them later: Contacts → tag filter `demo` → select all → Delete.

---

## 2. Connect your mailbox
**Integrations → Email (SMTP / IMAP)**. Pick your provider (Gmail/Google Workspace, Microsoft 365, Zoho, Hostinger, GoDaddy, Brevo, SendGrid, Amazon SES) to pre-fill the servers, add your username and **app password**, save, then *Send test email to me*.

Turn on **IMAP sync** so replies land on the contact's timeline, stop their sequences, and fire `email.replied`. Bounce messages automatically suppress the address.

Deliverability checklist:
- Add SPF, DKIM and DMARC DNS records for your sending domain (your mail provider gives you the values).
- Keep the campaign rate modest (**Settings → Email sending**, default 20/minute).
- Set your postal address under **Settings → Company**; it's included in the unsubscribe footer.

## 3. Connect Apollo.io
**Integrations → Apollo.io** → paste your API key (Apollo → Settings → Integrations → API) → *Test connection*.

- **Prospecting** page: search people by title, seniority, location, company size, domain or keywords (free in Apollo), tick rows, *Import*. "Reveal emails" uses Apollo enrichment credits (via `people/bulk_match`). Optionally enroll the imported people into a sequence in the same step.
- **Enrich** any contact or company from its page (or many at once from the contacts list).
- **Apollo sequence**: push selected contacts into an existing Apollo sequence (needs a master API key).
- The **credit log** on the Apollo tab shows each call and estimated credits.

## 4. Connect n8n

### One-click setup (recommended)
1. In n8n: **Settings → n8n API → Create an API key**.
2. In the CRM: **Integrations → n8n & webhooks → Connect n8n**. Enter the n8n address and the API key, then *Test connection*. With the bundled docker-compose the addresses are pre-filled (`http://n8n:5678` and `http://crm:3000`), so only the key is needed.
3. Click **Install** on any workflow template and answer its questions (Slack URL, digest recipient, Apollo search…).

Install creates the workflow in n8n with your answers filled in, adds an “Adas Globus CRM API key” Header Auth credential in n8n (backed by a dedicated CRM API key), activates the workflow, and, for event-driven templates, registers the matching CRM webhook. *Reinstall* replaces it; *Remove* deletes both the workflow and its webhook. This uses n8n's public API, which self-hosted n8n includes; n8n Cloud free trials don't.

### Manual setup
**CRM → n8n (events):** in n8n add a *Webhook* node (POST), copy its Production URL, and add it in **Integrations → n8n & webhooks**. Pick events or send all. Use *Send test* and the delivery log to debug. Failed deliveries retry after 1 min, 5 min, 30 min and 2 h.

Every delivery is a JSON POST:
```json
{ "id": "uuid", "event": "deal.won", "created_at": "2026-10-15T09:30:00.000Z", "source": "adas-globus-crm", "data": { "deal": { … } } }
```
Headers: `X-CRM-Event`, `X-CRM-Delivery`, `X-CRM-Signature: sha256=<HMAC of the raw body with the webhook secret>`, plus any custom headers you set (handy for n8n's Header Auth on the Webhook node).

**n8n → CRM (actions):** create a key in **Integrations → API keys**. In n8n create a *Header Auth* credential named `CRM API key` with Name `Authorization` and Value `Bearer agp_…`, and use it on HTTP Request nodes.

**Ready-made workflows** (install with one click, or download from the n8n tab / `public/n8n/` and use *Import from file* in n8n, then select the credential on the CRM nodes and set `crm_url` in the **CRM config** node):

| File | What it does |
|---|---|
| `01-new-lead-alert.json` | `contact.created` / `form.submitted` → Slack message |
| `02-website-form-to-crm.json` | Any form/lead-ad → upsert contact → enroll in a sequence |
| `03-deal-won-handoff.json` | `deal.won` → onboarding task + welcome email + Slack |
| `04-reply-follow-up-task.json` | `email.replied` → urgent task + mark qualified |
| `05-daily-task-digest.json` | Weekdays 08:30 → overdue/today tasks emailed to you |
| `06-apollo-weekly-prospecting.json` | Mondays → Apollo search via the CRM → import new people |
| `07-task-due-reminder.json` | `task.due` → Telegram reminder (swap for WhatsApp) |

### Events
`contact.created` `contact.updated` `contact.deleted` `contact.unsubscribed` `contacts.imported` `company.created` `company.updated` `company.deleted` `deal.created` `deal.updated` `deal.stage_changed` `deal.won` `deal.lost` `deal.deleted` `activity.created` `task.created` `task.completed` `task.due` `email.sent` `email.failed` `email.opened` `email.clicked` `email.replied` `email.bounced` `sequence.enrolled` `sequence.completed` `form.submitted` `apollo.imported`

Sample payloads for each are under **Integrations → API keys → Webhook event payloads**.

### REST API (all JSON, `Authorization: Bearer agp_…`)
| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/contacts?q=&status=&tag=&owner_id=&limit=&offset=` | List/search contacts |
| POST | `/api/contacts/upsert` | Create or update by `email` (accepts `company_name`, `tags`) |
| POST / PATCH / DELETE | `/api/contacts`, `/api/contacts/:id` | CRUD |
| POST | `/api/contacts/bulk` | `{ ids, action: add_tag \| remove_tag \| set_status \| set_owner \| delete, value }` |
| POST | `/api/contacts/import` | `{ csv, tags, status }` |
| GET / POST / PATCH | `/api/companies…` | Companies |
| GET | `/api/deals/board` | Pipeline grouped by stage |
| POST | `/api/deals`, `/api/deals/:id/move` | Create deal, move stage `{ stage_id }` |
| POST | `/api/activities`, `/api/tasks` | Log activity / create task |
| GET | `/api/tasks?view=overdue\|today\|upcoming\|done&assigned_to=me` | Tasks |
| POST | `/api/emails/send` | `{ contact_id \| to, subject, body \| template_id }` |
| POST | `/api/sequences/:id/enroll` | `{ contact_ids }` or `{ filter: { tag } }` |
| POST | `/api/apollo/people/search`, `/api/apollo/people/import` | Apollo prospecting |
| POST | `/api/apollo/enrich/contact/:id`, `/api/apollo/enrich/company/:id` | Enrichment |
| GET | `/api/meta`, `/api/dashboard` | IDs for automations; KPIs |
| POST | `/api/public/forms/:token` | Public lead capture (no key) |

---

## 5. Day-to-day
- **Dashboard**: open pipeline by stage, won revenue, win rate, reply rate, your tasks, deals closing soon.
- **Contacts**: filter, bulk-tag, bulk-enroll, enrich, export; each contact has a timeline of every email, reply, call, note and task.
- **Deals**: drag cards between stages; dropping on *Lost* asks for a reason.
- **Sequences**: e.g. intro → wait 3 days → follow-up in the same thread → call task → break-up. They send only in business hours if you want, and stop automatically on reply, unsubscribe or bounce.
- **Campaigns**: pick an audience by status/tag/owner/source/score, write or pick a template, send a test, then send.

## 6. Operations
- **Data** lives in `data/crm.db` (SQLite) and `data/.app-secret` (if `APP_SECRET` isn't set). Back up the whole `data/` folder; with Docker, back up the `crm-data` volume.
- **Security**: passwords hashed with scrypt; SMTP/IMAP passwords and the Apollo key are AES-256-GCM encrypted at rest; session cookies are HttpOnly + SameSite with a CSRF header check; API keys are stored hashed; inbound email HTML is shown in a sandboxed frame; click-tracking links are HMAC-signed (no open redirect).
- **Health check**: `GET /api/health`.
- **Smoke test**: `npm run smoke` boots a throwaway instance and checks auth, CRUD, pipeline, email tracking, sequences, campaigns, unsubscribe, forms, API keys, signed webhooks and the n8n installer (against a fake n8n API).
- **n8n template test**: `npm run n8n-e2e` (Linux + Docker) imports all 7 templates into the official n8n image, activates them, and drives real CRM events through them (form intake, deal won, email reply, daily digest), checking the results in the CRM.
- **CI**: `.github/workflows/ci.yml` runs the smoke test, the real-n8n template test, and builds + boots the Docker image on every push to `main` and every pull request.

## Project layout
```
server/
  index.js            Express app, security headers, static UI
  db.js               SQLite schema + query helpers (node:sqlite)
  models.js           Contacts, companies, deals, activities (+ events)
  events.js           Event bus → signed webhooks with retries
  scheduler.js        Sequences, email queue, retries, task reminders, IMAP polling
  services/           mailer.js · sequencer.js · imap.js · apollo.js
  routes/             auth · crm · mail · integrations · public (tracking, unsubscribe, forms)
public/               Single-page UI (no build step) + n8n workflow templates
scripts/smoke-test.js
docker-compose.yml    CRM + n8n (+ optional Caddy HTTPS)
```

Requires Node.js 22.13+ (uses the built-in `node:sqlite`).
