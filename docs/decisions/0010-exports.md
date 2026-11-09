# ADR 0010: CSV exports

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

PRD 4.9 asks for a CSV export of the current list view that is permission-checked, audited and built in the background above 5,000 rows. PRD 2.3 adds that exports above 1,000 rows need export permission with scope `all`, are audited and alert the Super Admins. PRD 6.9 lists an `export.build` job that writes a file and notifies, and PRD 6.11 says files are served only through the API after a permission check.

## Decision

1. **The export is the list's own query.** `CrmListService.exportPage` runs the list query with the same search, filter language, sort and read scope that the screen uses. The `exports.run` scope is added on top in SQL, so the stricter of the two always wins. For example, a manager who can read the team's contacts but export only their own gets only their own. Each entity's columns and their SQL live in the CRM module (`crm/export-columns.ts`), because the CRM module owns those tables. The exports module only pages through them, 1,000 rows at a time, without the per-page count.
2. **Which lists:** leads, contacts, companies and deals. Tasks and reports can use the same path later.
3. **The rules are checked before anything is written.** A count with the real query runs first, so a bad filter or sort is refused before any row is stored.
   - **No rows:** an empty view is refused (`EXPORT_EMPTY`).
   - **More than 100,000 rows:** refused (`EXPORT_TOO_LARGE`). This matches the import limit.
   - **More than 1,000 rows:** needs `exports.run` with scope `all`; otherwise 403 `EXPORT_NEEDS_ALL_SCOPE`.
   - **Up to 5,000 rows:** the file is built while the person waits and downloads at once.
   - **More than 5,000 rows:** the export is queued.
4. **The `export.build` job** runs every 2 seconds and claims the oldest waiting export with `FOR UPDATE SKIP LOCKED` and a heartbeat. It also picks up an export whose builder stopped for 2 minutes, so an export left half-done by an API restart is finished too.
   - **Current access:** it loads the requester with their current role. Access removed since the request stops the export, with a plain reason.
   - **One run per file:** it builds the whole file in one run and keeps it in memory. 100,000 rows is a few tens of megabytes. If the worker dies part-way, the next claim starts again from the beginning.
   - **Notification:** when the file is ready, the requester gets an `export_ready` notification. Clicking it downloads the file.
5. **The file.**
   - **Encoding:** RFC 4180 CSV, UTF-8 with a byte order mark (so Excel on Windows shows accents), CRLF line ends.
   - **Formula injection:** a cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading apostrophe (the OWASP CSV-injection rule), so a value like `=HYPERLINK(...)` stays text. E.164 phone numbers are left as they are.
   - **Dates:** written as `2026-11-10 08:03` in the exporter's time zone. Spreadsheets read that format as a date in every locale, and the header names the zone, for example `Created (America/Chicago)`.
   - **Money:** a plain amount (`4500.50`) with its currency in its own column.
   - **Lists and tags:** joined with `; `.
6. **Storage and downloads.**
   - **Storage:** files go through `platform/files` with `purpose = 'export'`.
   - **Who can download:** only the person who asked, and only while they still hold `exports.run`, through `GET /exports/:id/download`. Anyone else gets 404.
   - **Expiry:** files are deleted after 7 days by `housekeeping.purge`, and the export is marked `expired` (410 afterwards).
   - **No signed URL:** `signedUrl`, which ADR 0008 expected exports to need, is not built. Downloads go through the authenticated API route, as PRD 6.11 requires. A signed link would be a bearer link that can leak from browser history or a forwarded email.
7. **Audit and alerts.**
   - **Audit:** `export.created` records the entity, the row count, whether it ran in the background, whether a search was used, the filter's field names and the sort. `export.downloaded` records each download.
   - **No values:** filter values and search text can be names or emails, so they are never stored in the audit log.
   - **Admin alerts:** an export above 1,000 rows sends a `security` notification to every other active Admin ("Ananya Iyer exported 5,010 contacts."). The Admin role stands in for the PRD's Super Admin.
8. **The web app.**
   - **Where:** an "Export" button sits on the Leads, Contacts and Companies headers and in the Deals list view.
   - **The dialog:** it names the count and what the file holds. When the view is over 1,000 rows and the person's export scope isn't `all`, it explains the limit and disables the button; the API refuses anyway.
   - **Downloads:** they go through the API client, so an expired or unfinished export shows an error instead of navigating to a JSON page.
   - **The confirm dialog:** `ConfirmDialog` gained `tone="primary"`, because DESIGN 6.1 keeps the danger fill for destructive confirmations.

## Consequences

- **Export only:** the large-export alert is a notification only. Email alerts arrive with the Microsoft 365 connector.
- **Board view:** the Deals board has no Export button; the list view of the same pipeline does.
- **Memory:** a 100,000-row export is built in memory in one job run. If exports grow past that, the job should stream to storage in parts.
- **Not measured:** export speed on the large seed and real PostgreSQL. M2 slice 4 checks it.
