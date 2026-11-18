-- Milestone 9: Immutable accent-folding wrapper, generated tsvector columns, and GIN search
-- indexes across companies, contacts, leads, deals, notes, and email_threads (PRD 6.10, 12.2).
-- Fully schema-qualified (`pg_catalog.*` / `public.*`) so `pg_dump` / `pg_restore` succeed
-- cleanly when `search_path = ''`.

CREATE OR REPLACE FUNCTION public.immutable_unaccent(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT public.unaccent('public.unaccent'::pg_catalog.regdictionary, input);
$$;

ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS search_tsv pg_catalog.tsvector
  GENERATED ALWAYS AS (
    pg_catalog.to_tsvector(
      'pg_catalog.simple'::pg_catalog.regconfig,
      public.immutable_unaccent(
        COALESCE(name, '') || ' ' ||
        COALESCE(domain, '') || ' ' ||
        COALESCE(city, '') || ' ' ||
        COALESCE(state_province, '') || ' ' ||
        COALESCE(firm_type, '')
      )
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_companies_search_tsv
  ON public.companies USING GIN (search_tsv)
  WHERE deleted_at IS NULL;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS search_tsv pg_catalog.tsvector
  GENERATED ALWAYS AS (
    pg_catalog.to_tsvector(
      'pg_catalog.simple'::pg_catalog.regconfig,
      public.immutable_unaccent(
        COALESCE(full_name, '') || ' ' ||
        COALESCE(primary_email, '') || ' ' ||
        COALESCE(title, '') || ' ' ||
        COALESCE(job_function, '')
      )
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_contacts_search_tsv
  ON public.contacts USING GIN (search_tsv)
  WHERE deleted_at IS NULL;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS search_tsv pg_catalog.tsvector
  GENERATED ALWAYS AS (
    pg_catalog.to_tsvector(
      'pg_catalog.simple'::pg_catalog.regconfig,
      public.immutable_unaccent(
        COALESCE(full_name, '') || ' ' ||
        COALESCE(email, '') || ' ' ||
        COALESCE(firm_name, '') || ' ' ||
        COALESCE(domain, '') || ' ' ||
        COALESCE(title, '')
      )
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_leads_search_tsv
  ON public.leads USING GIN (search_tsv)
  WHERE deleted_at IS NULL;

ALTER TABLE public.deals
  ADD COLUMN IF NOT EXISTS search_tsv pg_catalog.tsvector
  GENERATED ALWAYS AS (
    pg_catalog.to_tsvector(
      'pg_catalog.simple'::pg_catalog.regconfig,
      public.immutable_unaccent(
        COALESCE(name, '') || ' ' ||
        COALESCE(stage_name, '') || ' ' ||
        COALESCE(engagement_model, '') || ' ' ||
        COALESCE(trial_candidate_role, '')
      )
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_deals_search_tsv
  ON public.deals USING GIN (search_tsv)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_deals_name_trgm
  ON public.deals USING GIN (name public.gin_trgm_ops)
  WHERE deleted_at IS NULL;

ALTER TABLE public.notes
  ADD COLUMN IF NOT EXISTS search_tsv pg_catalog.tsvector
  GENERATED ALWAYS AS (
    pg_catalog.to_tsvector(
      'pg_catalog.simple'::pg_catalog.regconfig,
      public.immutable_unaccent(COALESCE(body, ''))
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_notes_search_tsv
  ON public.notes USING GIN (search_tsv)
  WHERE deleted_at IS NULL;

ALTER TABLE public.email_threads
  ADD COLUMN IF NOT EXISTS search_tsv pg_catalog.tsvector
  GENERATED ALWAYS AS (
    pg_catalog.to_tsvector(
      'pg_catalog.simple'::pg_catalog.regconfig,
      public.immutable_unaccent(COALESCE(subject, '') || ' ' || COALESCE(snippet, ''))
    )
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_email_threads_search_tsv
  ON public.email_threads USING GIN (search_tsv);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    GRANT EXECUTE ON FUNCTION public.immutable_unaccent(text) TO adas_app;
  END IF;
END $$;
