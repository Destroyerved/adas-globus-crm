# ADR 0009: Duplicate review and merge

- **Status:** Accepted
- **Date:** 2026-11-10

## Context

PRD 4.9 asks for a review queue of probable duplicates, a field-by-field merge of two contacts or two companies that moves everything linked to the merged record, and an undo for 30 days. Acceptance tests A5 and A6 (PRD 12.1) check a company merge and a contact merge with undo. Imports already queue probable duplicates (ADR 0008). Records added by hand, by the website or through the API were never checked. The prototype `POST /contacts/merge` copied a few fields, moved some links and could not be undone safely.

## Decision

1. **One writer for merges.** `MergeWriter` in `modules/crm/merge-records.ts` loads, previews, merges, undoes and scans, because the CRM module owns the record tables (PRD 6.4). `modules/duplicates` holds the queue, the HTTP routes and the job. The prototype route is removed.
2. **Who may merge.** A merge needs the `duplicates.merge` capability, and both records must be inside that scope and inside the person's write scope for the entity. Both checks are made in SQL, with the rows locked `FOR UPDATE`. Both versions must match what the person saw; otherwise the result is a 409 conflict.
3. **The merged record is soft-deleted first,** in the same transaction, and its version is bumped. This frees its unique email, Apollo ID or domain for the kept record. Nothing is ever hard-deleted.
4. **Field choices.** The person picks a side for each field the merge view shows (`CONTACT_MERGE_FIELDS`, `COMPANY_MERGE_FIELDS` in `packages/shared`). A field left out keeps the kept record's value, or takes the merged record's when the kept one is blank. These values are worked out without asking:
   - **Do not contact** is set when either record has it (an OR).
   - The **Apollo ID** is the kept record's, or else the merged record's.
   - **Custom fields** are combined, and the kept record's value wins when both have the same key.
   - **Last contacted** is the later of the two.
   - **Company status:** a do-not-contact account status always wins. The estimated revenue is taken from the merged company only when the kept one has none.
5. **Record history.** Every changed field is written to `record_history` with `via = 'merge'`.
6. **Everything linked moves, by recorded ID.** The merge records which rows of each linked table it moved, and undo moves exactly those rows back:
   - **Contacts:** leads, deals, tasks, activities, notes, email threads, sends, sequence enrollments, campaign recipients, consent records, unsubscribe tokens, email addresses and phones.
   - **Companies:** contacts, leads, deals, tasks, activities, notes and email threads.
   - Leads, deals, tasks and contacts get a new version, so a form opened before the merge can't overwrite it.
   - The primary flags on email addresses and phones are recomputed from the kept primary email and phone.
   - **Tags** are combined; the tags that were added are recorded so undo removes only those.
   - **List memberships:** a list both contacts were on keeps one member (the count drops by one), and the others move.
7. **Sequences.** When both contacts are active in the same sequence, the merged contact's enrollment becomes `stopped_merged` (a new status, migration 0008), so one person never gets the same sequence twice. When the merge makes the kept contact do-not-contact, its active enrollments become `stopped_suppressed`. Undo never restarts these.
8. **The queue.** Once a pair is merged, its entry closes as `merged`. The merged record's other open pairs move to the kept record, or close if the kept record already has that pair. A pair that was dismissed or merged is never queued again (`queueDuplicatePair`), so "Not duplicates" sticks.
9. **What is kept for undo.** `merge_logs` (the PRD's `merge_snapshots`) keeps a snapshot of both records before the merge (snapshot format `v: 1`), the moved row IDs, the added tags, the dropped list memberships and the merged record's version after the merge. Audit actions are `contact.merged`, `company.merged`, `*.merge_undone` and `duplicate.dismissed`. Outbox events are `<entity>.merged` and `<entity>.merge_undone`. Audit metadata holds IDs and counts only, never names or emails.
10. **Undo, for 30 days.**
    - **When it is allowed:** the kept record must still exist, and the merged record must be exactly as the merge left it (the same version). The merged record's email, Apollo ID or domain must still be free; otherwise the request is refused with 409 `MERGE_UNDO_IN_USE`.
    - **Fields:** a field on the kept record is reverted only if nobody changed it since the merge. Changed fields are left alone and listed in the result. **Do not contact** is never lifted by an undo, because the CRM cannot tell whether the flag came from a real request.
    - **Linked records:** the moved rows go back. Enrollments that were `stopped_merged` come back as `paused`, so a person decides whether to resume them. Dropped list memberships are restored and the added tags removed.
    - **The queue:** the pair reopens as an open pair.
    - **Refusals:** an older snapshot format is refused with `MERGE_UNDO_UNSUPPORTED`. A second undo or one after 30 days gets `MERGE_ALREADY_UNDONE` or `MERGE_UNDO_EXPIRED`.
11. **A regular check for duplicates.** The `duplicates.scan` job runs every minute for at most 20 seconds, in batches of 500 records. It uses the import's probable-duplicate rules:
    - **Contacts:** the same first and last name at the same company domain, or the same phone number.
    - **Companies:** a name with trigram similarity of at least 0.8 in the same country.
    - It walks records in `(updated_at, id)` order from a watermark kept in `settings` (`job.duplicates_scan`). New and edited records are checked within about a minute, and the first run checks everything.

## Consequences

- **Lost history:** a merge can't be undone once someone edits the merged record's email or domain into another record, or after 30 days. The person can still separate the records by hand.
- **Do not contact:** an undo never turns it off. When the flag came from the merged record alone, an admin has to clear it by hand, and the undo result says so.
- **Not built yet:** a "Merge with…" action on record pages. For now, merges start from the queue, which the regular check fills.
- **Scan load:** the scan's trigram query for companies uses the `pg_trgm` index on `companies.name`. Its plan on the large seed is checked in M2 slice 4.
