# 0018. Deal stakeholder contacts, keyboard Kanban drag-and-drop, recurring tasks & FX rate administration

- **Status:** Accepted
- **Date:** 2026-11-18
- **PRD references:** 3.3, 4.6, 4.7, 4.15, 4.17, 14; DESIGN 6.8

## Context

Phase 3 requires four capabilities to complete daily deal and follow-up management:

1. **Multi-stakeholder CPA firm deals (`PRD 4.6`):** CPA firm staffing deals typically involve a managing partner (`Decision Maker`), a tax/audit director (`Champion` or `Evaluator`), and an operations/finance contact (`Billing` or `IT / Security`) alongside `deals.primary_contact_id`.
2. **Accessible Kanban stage moves (`PRD 4.6`, `DESIGN 6.8`):** Reps need pointer drag-and-drop, keyboard pickup/move/drop (`Space` → `ArrowLeft`/`ArrowRight` → `Space`, `Escape` to cancel) with `aria-live` announcements, stage-gate dialogs when required fields (`trial_candidate_role`, `contract_start_date`, `lost_reason`) are missing, and collapsed `Won`/`Lost` drop zones at the end of the board.
3. **Recurring tasks, team workload, and calendar (`PRD 4.7`):** Follow-ups need recurrence (`daily`, `business_days`, `weekly`, `biweekly`, `monthly`), manager `Team tasks` visibility without leaking cross-team data, and a week/month calendar view that stays mobile-safe at `375px`.
4. **Manual FX table (`PRD 4.15, 4.17, 14`):** Multi-currency (`USD`/`CAD`) reporting and deal-close FX snapshots (`deals.fx_rate_scaled_at_close`) need an admin-editable `fx_rates` table seeded in production migrations (not just dev seeds) using fixed-point `10^6` integer scaling with zero floats.

## Decisions

1. **`deal_contacts` join table (`0016_deal_contacts_recurring_tasks_and_fx`):**
   - Stores `(deal_id, contact_id, role)` with `UNIQUE (deal_id, contact_id)` and indexes on both foreign keys.
   - Scoped via `deals.read` / `deals.write` on the deal and `contacts.read` when linking a new contact so users cannot attach contacts outside their visibility scope.
   - `MergeWriter` (`merge-records.ts`) transfers and deduplicates `deal_contacts` rows during contact merges and restores them from the merge snapshot on undo.

2. **Native HTML5 pointer drag-and-drop + zero-dependency keyboard drag controller (`DealsKanbanScreen`):**
   - Rather than adding third-party drag libraries, `DealsKanbanScreen` uses native HTML5 drag events paired with an explicit keyboard drag state machine (`Space` to pick up, `ArrowLeft`/`ArrowRight` across allowed columns, `Space`/`Enter` to drop, `Escape` to cancel) and a polite `aria-live` status region.
   - Dropping onto a stage with satisfied gate requirements dispatches `PATCH /api/v1/deals/:id/stage` immediately; missing stage-gate fields open `<StageGateDialog />`.
   - `Won` and `Lost` columns render at the right end of the board as compact dashed drop zones by default and can be expanded in place to inspect or reopen closed deals.

3. **Idempotent next-occurrence spawning on task completion (`nextRecurringDueAt`):**
   - Completing a task with `recurrence_rule IS NOT NULL` computes the next due timestamp in the assignee's IANA time zone (`nextRecurringDueAt` in `platform/calendar`), preserving wall-clock hours across DST transitions, skipping weekends and US/CA market holidays for `business_days`, and clamping month-end dates (`Jan 31 → Feb 28`).
   - Any relative `reminder_at` offset prior to `due_at` is preserved on the spawned task.
   - Spawning checks `SELECT id FROM tasks WHERE parent_task_id = $1` inside the completion transaction so repeated `POST /api/v1/tasks/:id/complete` calls are strictly idempotent.

4. **Fixed-point `10^6` FX rates with reciprocal upsert and last-rate protection:**
   - `parseFxRateScaled` and `formatFxRateScaled` (`@adas/shared`) convert decimal strings (`"0.74"`) to `bigint` (`740000n`) using string regex arithmetic only—no `parseFloat` or floating-point multiplication.
   - `POST /api/v1/admin/fx-rates` upserts both `(from, to, effective_date)` and its integer reciprocal `(10^12 / rate_scaled)` in one transaction and writes `audit_logs` (`fx_rate.upserted`).
   - `DELETE /api/v1/admin/fx-rates/:id` refuses removing the final remaining rate for a currency pair (`409 FX_LAST_RATE`) so dashboard conversions and deal-close FX snapshots never lack a fallback rate.
