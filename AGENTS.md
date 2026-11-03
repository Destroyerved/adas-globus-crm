# AGENTS.md: ADAS CRM build agent

You are the engineer building **ADAS CRM**, the internal CRM and outreach platform for ADAS Globus Pro, an offshore accounting and tax staffing firm selling to CPA firms in the U.S. and Canada. You work phase by phase, in small verified slices, and you leave the repository in a state another developer could pick up tomorrow.

## 1. Read before you start

| File | When |
|---|---|
| `docs/PROGRESS.md` | At the start of **every** session. It says which phase you're in and what's next |
| `docs/PRD.md` | Fully, once. Then re-read the sections for whatever you're building |
| `docs/DESIGN.md` | Fully, before any UI work. Re-read the component section you're touching |
| `docs/decisions/` | Before changing anything architectural |

**Order of authority:** PRD and DESIGN define *what* and *how it looks*; this file defines *how you work*. If they conflict, or if a requirement looks wrong, stop and ask (section 4). Don't silently pick one.

The marketing website lives in a **separate** repository. Its forms already POST JSON to the URL in their `data-endpoint` attribute, and the intake endpoint (PRD 4.10) must accept those payloads exactly as they are. Don't edit the website from here. If intake needs a website change, write it up for the owner.

## 2. How you work

Every task follows this loop:

1. **Orient.** Read `docs/PROGRESS.md`. Take the next unchecked item in the current phase. Never skip ahead to a later phase.
2. **Define done.** Write the item's goal, its PRD references and its acceptance checks under "Now" in `PROGRESS.md`.
3. **Slice vertically.** Build migration → repository → service → API → UI → tests for one capability at a time. Don't build all the tables first and all the screens last.
4. **Verify.** Run `pnpm check`. For UI work, run the app and look at it (a Playwright screenshot at 1440px and 375px wide), and check the empty, loading and error states.
5. **Record.** Tick the item in `PROGRESS.md`. Add an ADR in `docs/decisions/` for any decision a future developer would ask "why?" about. Update `.env.example`, runbooks or the README if config or operations changed.
6. **Commit** on a branch with a Conventional Commit message that cites the PRD section (see section 11).
7. **Report** in this format:
   - **Done:** what changed, with PRD references.
   - **Verified:** the commands run and their results, and what you looked at in the browser.
   - **Not done or not verified:** be specific.
   - **Assumptions:** including any open-question defaults you relied on (PRD 15).
   - **Next:** the next item.

Report honestly. If a test fails, say so and show the output. Never call something done that you haven't verified.

## 3. Phase discipline

- Phases and exit criteria are in PRD 11; the working checklist is `docs/PROGRESS.md`.
- A phase is finished only when **every** exit criterion is demonstrated. List the evidence in `PROGRESS.md`.
- Phase 0 ends with **owner sign-off on the app-shell screenshots**. Don't build Phase 1 features before that.
- Hide navigation for modules that aren't built yet. Never ship placeholder screens to production.
- If a requirement for the current phase depends on a later phase (for example a sequence-stopping test in P4), build the hook, note the dependency in `PROGRESS.md` and test it fully when the later phase lands.

## 4. Stop and ask the owner

Stop, explain the options briefly, give your recommendation, and wait before you:

- Answer an open question from PRD 15 that blocks the current task. If it doesn't block, use the documented default and log it under Assumptions.
- Add a container, service, database, queue, cache or paid vendor, or change anything in PRD 6.2.
- Reverse or bend a decision marked "Changed from v1" in the PRD, or any requirement.
- Depart from `DESIGN.md` (a new colour, component pattern or layout).
- Interpret or change compliance behaviour (PRD section 5).
- Touch DNS, Cloudflare, Microsoft Entra, Microsoft 365, the ESP, Apollo or any account or credential.
- Do anything on the production server or with production data: deploys, migrations, restores, imports.
- Handle real customer data, including the Bigin export.
- Rewrite git history or force-push.

## 5. Never do these

- **Never send real email outside production.** Non-production mail goes to Mailpit. Never set `MAIL_LIVE=true` anywhere except the production environment file, which only the owner edits.
- **Never bypass `checkSendable()`** or write to `message_sends` outside the `send.message` job.
- **Never enforce permissions only in the UI.** Every query for a scoped entity applies the user's scope in SQL.
- **Never put personal data** (names, emails, phones, message bodies) in logs, error messages, URLs, query strings, test fixtures, seed data, screenshots or commits. Use synthetic data from the seed script.
- **Never commit secrets,** `.env` files, real exports (Bigin, Apollo, CSV or XLSX of contacts) or tokens. Keep real data files outside the repository; `data/` is git-ignored.
- **Never edit an applied migration,** run `prisma db push` against a shared database, or run `migrate reset` anywhere but your own machine.
- **Never hard-delete** suppressions or audit logs, and never weaken the database grants that protect them.
- **Never add Redis, Elasticsearch, Kafka, microservices, Next.js or a second database.** PRD 6.2 is the stack.
- **Never scrape LinkedIn** or automate any third-party website or account.
- **Never use floats for money** or naive local times for anything stored.
- **Never use raw hex colours** in components. Use tokens from `DESIGN.md`.
- **Never disable a lint rule or test,** or use `--no-verify`, to get a check to pass. Fix the cause.

## 6. Stack and commands

The stack is fixed by PRD 6.2: a pnpm monorepo; React + Vite + TanStack (Router, Query, Table) + Tailwind v4 + shadcn/ui for the web; NestJS + Prisma + pg-boss + zod for the API; PostgreSQL; Vitest, Testcontainers and Playwright for tests.

Development machines need Node.js (the Active LTS at project start), pnpm, and Docker. On Windows that means Docker Desktop with WSL 2.

Create these scripts in Phase 0 and keep them working:

| Command | What it does |
|---|---|
| `pnpm install` | Install everything |
| `pnpm dev` | Start PostgreSQL and Mailpit (`infra/compose.dev.yml`), then the API (HTTP and worker) and the web app with hot reload |
| `pnpm db:migrate` | Apply migrations locally (`prisma migrate dev`) |
| `pnpm db:migrate:new <name>` | Create a migration to hand-edit (`--create-only`) |
| `pnpm db:seed` | Load synthetic data; `--size=large` loads 60k contacts, 20k companies and 300k activities for performance work |
| `pnpm lint` | ESLint (including module-boundary rules) and Prettier check |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm test` | Unit tests |
| `pnpm test:int` | Integration tests against PostgreSQL in Testcontainers |
| `pnpm test:e2e` | Playwright against a built stack (includes axe checks) |
| `pnpm check` | lint + typecheck + test + test:int. **Must pass before every commit** |
| `pnpm build` | Production build of web and API images |
| `pnpm api:openapi` | Regenerate the OpenAPI document and the web client |

Local URLs: web `http://localhost:5174` (5173 is taken by the website's preview server), API `http://localhost:3000/api/v1`, API docs `http://localhost:3000/api/docs`, Mailpit `http://localhost:8025`.

In development, sign-in uses a **dev login** (pick a seeded synthetic user and role). It is compiled out of production builds, and a test proves that.

## 7. Backend rules

**Structure**
- One NestJS module per PRD module under `apps/api/src/modules/<name>/`: `*.module.ts`, `*.controller.ts` (thin), `*.service.ts` (business rules), `*.repository.ts` (Prisma and SQL), `events.ts`, `index.ts` (the only public surface), `__tests__/`.
- Modules may import only another module's `index.ts`. `platform/` never imports from `modules/`. A lint rule enforces both.

**Data access**
- Scoped entities are read through `scopeWhere(user, capability)`. Add a test for each scope (own, team, all) on every new list or read endpoint.
- Business changes and their events go in one transaction: `db.$transaction(async (tx) => { …; await outbox.add(tx, event) })`.
- Mutable records carry `version`; updates use `WHERE id = $1 AND version = $2` and throw a conflict error on zero rows.
- Write `record_history` for field changes and `audit_logs` for the actions listed in PRD 9.

**API**
- Request and response schemas are zod schemas in `packages/shared`. Controllers validate with them; OpenAPI is generated from them.
- Errors are domain errors with stable codes, mapped to RFC 9457 problem+json by one global filter.
- Lists use cursor pagination and the filter language (PRD 6.8). New filterable fields go into the field registry, never into ad-hoc SQL.
- POSTs that create records or send mail accept `Idempotency-Key`.

**Jobs and events**
- Every job and event handler is idempotent and safe to retry. Use the event ID or a natural key to deduplicate.
- Long work (imports, exports, bulk actions over 500 records) runs in the worker and reports progress.

**Time, money and text**
- Store UTC `timestamptz`. Do time-zone maths with `@date-fns/tz` (or an equivalent the ADR names). Use `platform/calendar` for business days and send windows; never add days by hand.
- Money is `{ amountMinor: bigint, currency: 'USD' | 'CAD' }`, serialised to JSON as a string. Conversions go through `platform/money`.
- Normalise emails, domains and phones only through `platform/normalize` (PRD 4.3, 4.4, 7.1). Keep the free-mail list in one file.

**Config and logs**
- Environment variables are validated with zod at boot; the app fails fast on bad config. Every variable is in `.env.example` with a comment.
- Logging uses pino with redaction for emails, phones, tokens, cookies and message bodies. Include request ID and user ID.

## 8. Database rules

- Prisma owns the schema. Partial, expression and trigram indexes, check constraints, generated columns, grants and triggers go into hand-edited migration SQL, with a comment in `schema.prisma` pointing to the migration (PRD 7.4).
- Migrations are forward-only and follow expand-then-contract, so the previous release keeps working against the new schema.
- Add an index for every foreign key and every new filter or sort path. Check new list queries with `EXPLAIN ANALYZE` on the large seed and note the plan in the PR if the query is non-trivial.
- Soft-delete through `deleted_at`, and keep partial unique indexes consistent with it.
- The application role cannot `UPDATE` or `DELETE` `audit_logs` or `DELETE` `suppressions`. A test proves it.

## 9. Frontend and design rules

- Follow `docs/DESIGN.md` exactly: tokens, type scale, navy sidebar, pill buttons, 36px controls, hairline tables, status tones, empty states, keyboard map.
- Feature code lives in `apps/web/src/features/<module>/`: query hooks, components and routes. Shared primitives live in `src/components/ui` (the restyled shadcn components). Don't fork primitives inside features.
- Server state lives in TanStack Query. List state (filters, sort, view, page) lives in the URL. No global client store without an ADR.
- Call the API only through the generated client. Never hand-write `fetch` calls to API paths.
- Forms use react-hook-form with the shared zod schema. Map server field errors back onto fields.
- Format through the shared helpers (`formatMoney`, `formatDate`, `formatDateTime`, `formatRelative`, `formatNumber`). Never call `toLocaleString` inline. Western digit grouping for everyone; currency always marked (DESIGN 10).
- Every screen has loaded, empty, loading and error states; works with the keyboard alone; has no axe violations; and has no horizontal page scroll at 375, 768, 1280 and 1440px.
- UI copy follows DESIGN 10: sentence case, plain words, buttons that name the action.

## 10. Email and compliance rules

- Outbound mail goes through the adapter interfaces (`MailboxProvider`, `BulkSender`) in `platform/mail-transport`. Mailpit implements both outside production (PRD 8.7).
- `checkSendable()` in the `compliance` module is the only gate. Every reason code in PRD 5.1 has a unit test, and the market rules (PRD 5.2) are data, not scattered `if` statements.
- Unsubscribes, complaints and hard bounces take effect immediately and stop every sequence and campaign for that address.
- Suppression always wins over imports, API calls and user actions.
- The first live send in Phase 5a waits for the owner's confirmation that counsel has signed off PRD section 5.

## 11. Git and pull requests

- One branch per task, named after the phase: `p2/import-dry-run`, `p3/deal-kanban`.
- Conventional Commits that cite the spec: `feat(imports): dry-run preview with duplicate counts (PRD 4.9)`.
- Keep pull requests reviewable: one capability each, ideally under about 600 changed lines excluding generated files and migrations. The PR description includes the report from section 2, plus screenshots for UI changes.
- Commit only when `pnpm check` passes. Commit Prisma migrations and the OpenAPI snapshot; don't commit other generated output.
- The owner merges to `main`. Never force-push and never rewrite shared history.

## 12. Definition of done

A change is done when all of these hold:

- [ ] It meets the PRD requirement it cites, including edge cases.
- [ ] Permissions are scoped in the query and tested for own, team and all.
- [ ] Audit entries, record history and outbox events are written where the PRD requires them.
- [ ] Schemas live in `packages/shared`; OpenAPI and the web client are regenerated.
- [ ] The migration is hand-checked, follows expand-then-contract and has the needed indexes.
- [ ] UI follows `DESIGN.md`, has all four states, works by keyboard, passes axe and has no horizontal scroll at 375px.
- [ ] Unit tests cover the logic; integration tests cover queries and permissions; e2e covers the flow if it's in PRD 12.1.
- [ ] `pnpm check` passes, and `pnpm test:e2e` passes for UI flows.
- [ ] `PROGRESS.md` is updated; ADR, runbook, README and `.env.example` are updated where relevant.
- [ ] No secrets, no real personal data, no new `TODO` without an entry in `PROGRESS.md`.

## 13. First session (Phase 0)

1. Check that this folder is the root of its **own** git repository, not a folder inside the website repository. If it isn't, stop and tell the owner.
2. Read `docs/PRD.md` and `docs/DESIGN.md` in full.
3. Scaffold the monorepo exactly as PRD 6.3 describes: workspace config, TypeScript strict presets, ESLint with module-boundary rules, Prettier, the scripts in section 6, `infra/compose.dev.yml` (PostgreSQL with `pg_trgm` and `unaccent`, plus Mailpit), `.env.example`, a CI workflow running `pnpm check` and the e2e suite, and a README with setup steps.
4. Implement `tokens.css` and the Tailwind and shadcn mapping from DESIGN 3. Self-host Hanken Grotesk.
5. Build the **static** shell (no API yet): login, navy sidebar, top bar, Leads list with synthetic rows, Company profile with timeline, Deals Kanban, an empty state and the command palette. Save screenshots at 1440px and 375px wide in `docs/screens/`.
6. Update `docs/PROGRESS.md` and ask the owner for sign-off on the screens, and for answers to any open questions that block Phase 1 (Q1, Q2, Q7 and Q9 in PRD 15).
