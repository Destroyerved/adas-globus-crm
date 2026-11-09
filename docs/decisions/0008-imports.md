# ADR 0008: Imports

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

PRD 4.9 asks for CSV and XLSX imports up to 50 MB and 100,000 rows, with column mapping and saved mappings, a dry run, background processing with live progress, a result for every row, an error file, the duplicate rules (definite and probable), and undo within 7 days that leaves later edits alone. Acceptance tests A1-A3 (PRD 12.1) check speed, exact counts, duplicates and undo. The prototype took JSON rows in one request, with no file, dry-run table or undo.

## Decision

1. **Libraries:** `exceljs` reads XLSX (first sheet) and `csv-parse` reads CSV. Both are maintained, MIT-licensed and have no native parts. The type comes from the content, not the name (PRD 6.11): a zip header means XLSX, text without NUL bytes means CSV, anything else is refused with 415. CSV is read as UTF-8, or as Windows-1252 when that fails (Excel's "CSV" on Windows); the delimiter is a comma, semicolon or tab, whichever the header uses most.
2. **Files go through `platform/files`** (`put`, `get`, `delete`; PRD 6.11), a local directory for now (`FILE_STORAGE_LOCAL_PATH`, a Docker volume in production). The `files` table holds only the key, size, type, SHA-256 and owner. Uploads are the raw request body, with the file name in an `X-Upload-Filename` header, so nothing about the file appears in a URL. `signedUrl` comes with exports, which need downloads.
3. **The API changes status; the worker does the work.** `POST /imports/:id/dry-run`, `/run` and `/rollback` only set the batch to `checking`, `queued` or `rolling_back`. The `import.process` job (every 2 seconds, a stately pg-boss queue) claims the oldest waiting batch with `FOR UPDATE SKIP LOCKED` and a heartbeat, so any number of workers can run, and a batch whose worker died is picked up again after two minutes.
4. **Chunks of 500 rows, one transaction each,** together with the row results and the progress counter. A run stops after about 45 seconds and the next job carries on from `processed_rows`, so no job runs for long and a restart repeats no rows. The parsed file is cached in the worker between runs. Each row runs inside its own savepoint, so one bad row is recorded as an error and the rest of the chunk still saves.
5. **The dry run is the real run, rolled back.** Each chunk runs inside a savepoint that is rolled back before the row results are written. The preview therefore uses exactly the code the real run will use. One known difference: a company that one chunk would create is not visible to the next chunk of a dry run, so the preview's company counts can be slightly high.
6. **Duplicate rules (PRD 4.9):**
   - **Contacts:** a definite match is the same normalised email, as the primary email or any of the contact's emails. A probable match is the same first and last name at the same company domain, or the same phone number.
   - **Companies:** a definite match is the same domain. A probable match is a name with trigram similarity of at least 0.8 in the same country.
   - **Definite matches** follow the chosen rule: leave unchanged, fill in blank fields (the default), or replace with the file's values. Blank cells never clear a field, and only mapped columns change anything.
   - **Probable matches** are created and queued in `duplicate_candidates` for review, never merged automatically.
   - **The same email or company twice in one file** is reported as "repeated" and imported once.
7. **Scope is applied twice.** Batches are scoped to their creator and team through `scopeWhere`. The worker also loads the importing user with their current role and checks `contacts.write` or `companies.write` in SQL before changing a matched record. A match outside their access is left alone and reported, never updated.
8. **A contact row's company:**
   - It is found by the website's domain, or else by the work email's domain (never a personal email domain).
   - Without a domain, it is found by the exact company name in the same country.
   - If none is found and the row names a company, a new company is created with the same source and batch.
   - The exact-name link is a pragmatic choice so a file without websites doesn't create one company per row.
9. **No invented values.** Imported contacts get a blank title, job function and seniority when the file has none, rather than the "Partner" defaults the create form uses. A company with no firm type gets "Other", and one with no staff size gets a blank. The time zone follows the country.
10. **Undo, per row:**
    - A created record is soft-deleted only if its version is unchanged and nothing has been attached to it since: no deals, leads, tasks, or activities other than the import's own.
    - An update is reverted only if the record's version is still the one the import left.
    - Everything else is kept and listed as "edited since".
    - Emails of removed contacts are freed, so a corrected file can be imported again.
    - Open duplicate-queue entries for removed records are dismissed.
    - Companies a contact import created are removed afterwards if nothing uses them.
11. **Suppression always wins.** Imports never touch `suppressions`. An address on the list can be imported as a contact, and `checkSendable()` still blocks it.
12. **Audit, events and notifications:**
    - **Audit entries:** upload, start, completion, undo request, undo completion and every error-file download (the file holds contact data).
    - **Outbox events:** `import.completed` and `import.rolled_back` (PRD 6.9). There is no event per record, so a 100,000-row file doesn't flood outbound webhooks.
    - **Other records:** each record gets an `import` activity on its timeline and `record_history` rows with `via = 'import'`. That column is new in migration 0007; earlier rows default to `ui`.
    - **Notifications:** the importer is notified when an import finishes, stops or is undone.
13. **The error file** has the original columns plus an Error column, starts with a byte-order mark so Excel opens it as UTF-8, and prefixes cells that start with `=`, `+`, `-`, `@`, tab or carriage return with an apostrophe so spreadsheets don't run them as formulas.
14. **The prototype `POST /imports/csv` route is removed.** It imported without a dry run or undo. The `import_jobs` table is no longer written and will be dropped in a later contract migration.

## Consequences

- The worker must be running for imports to progress (`pnpm dev` starts it). The e2e test API runs the same `ImportProcessor` in-process on a timer instead of through pg-boss.
- Upload parses the file once in the API to read its header and count its rows, and the worker parses it again. For a 50 MB workbook that is a few seconds of CPU in the API process. If it becomes a problem, counting can move to the worker.
- A1 (10,000 contacts from XLSX in under 5 minutes) is designed for but not yet measured on real PostgreSQL; it is part of the large-seed speed check.
