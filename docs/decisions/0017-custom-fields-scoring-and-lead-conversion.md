# ADR 0017: Custom fields, explainable rule-based scoring and interactive lead conversion

- **Status:** Accepted
- **Date:** 18 Nov 2026
- **Spec:** PRD 3.2, 4.3–4.6, 4.9, 4.16, 4.17, 6.8, 9

## Context

Phase 2, Phase 3 and Phase 6 require:

1. Admin-managed custom fields (`text`, `number`, `select`, `multi_select`, `boolean`, `date`, `money`, `url`) across Leads, Contacts, Companies and Deals, queryable through the shared filter language (`custom.<key>`) without ad-hoc SQL or schema downtime.
2. Configurable, explainable 0–100 lead and contact scoring combining CPA staffing fit, verified engagement and negative signals while excluding unreliable email open pixels.
3. Interactive lead conversion supporting pipeline/stage choice, contract term, 3-day Free Trial launch, or linking an existing open deal on the firm.
4. Direct `"Merge with…"` initiation from Contact and Company profiles alongside secondary email/phone management.

## Decisions

1. **Typed JSONB custom fields with `jsonb_path_ops` GIN indexes (`0015_custom_fields_scoring_and_conversion`).**
   - `custom_field_definitions` owns the schema per entity (`field_type`, `options_json`, `is_required`, `sort_order`, `archived_at`, `version`), while values live in `custom_fields JSONB` on `leads`, `contacts`, `companies` and `deals` indexed with `USING GIN (custom_fields jsonb_path_ops)`.
   - `CustomFieldService.setRecordValues` validates every value against active definitions, enforces optimistic concurrency (`version`), and records `custom.<key>` diffs in `record_history`.
   - `compileFilter` in `platform/list` compiles `custom.<key>` conditions (`eq` uses `@>` GIN containment; `hasAny`, `hasAll`, `contains`, `gt`, `lt`, `isEmpty`, `isNotEmpty` use parameterized JSONB extraction) after validating `<key>` against `^[a-z][a-z0-9_]{1,39}$`.

2. **Explainable rule-based scoring (`scoring_rules`).**
   - Rules are stored in PostgreSQL (`category IN ('fit', 'engagement', 'negative')`, `field_path`, `operator`, `target_value`, `points`, `active`, `version`) and evaluated inside the same database transaction when leads/contacts are created, updated, converted, or have calls/meetings logged, plus via `POST /api/v1/admin/scoring-rules/recalculate`.
   - `SCORING_FIELD_PATHS` intentionally excludes email opens (`PRD 4.16`), and every matched rule is persisted in `lead_score_breakdown` so `<ScorePanel />` explains the exact points on Lead and Contact profiles.

3. **Two-tier Lead Conversion UX.**
   - Table rows on `LeadsScreen` retain 1-click quick conversion with sensible defaults for fast triage, while `LeadProfileScreen` opens `<ConvertLeadDrawer />` allowing pipeline/stage selection, monthly fee + term, 3-day Free Trial (`trialCandidateRole`), or linking an existing open deal on the company (`existingDealId`).

4. **Shared `MergeForm` for direct profile merges.**
   - `MergeForm` in `features/duplicates/merge-review.tsx` accepts an optional `pairId`, allowing `<MergeWithButton />` on Contact and Company profiles to search for a counterpart and run the exact same optimistic-concurrency field-picker merge and 30-day undo flow as the Duplicates queue (resolving the deferred item from ADR 0009).
