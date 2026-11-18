-- Enable required PostgreSQL extensions (PRD §6.2, §6.10, §7.5, §10.3)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

-- Schema-qualified immutable unaccent wrapper for generated tsvector columns and pg_restore (PRD §6.10)
CREATE OR REPLACE FUNCTION public.immutable_unaccent(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
  SELECT public.unaccent('public.unaccent'::pg_catalog.regdictionary, input);
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    GRANT EXECUTE ON FUNCTION public.immutable_unaccent(text) TO adas_app;
  END IF;
END $$;
