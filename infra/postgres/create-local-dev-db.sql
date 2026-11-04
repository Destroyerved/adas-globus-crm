-- One-time local development setup for an existing PostgreSQL install (no Docker).
-- Run as the postgres superuser:
--   "C:\Program Files\PostgreSQL\17\bin\psql.exe" -U postgres -h localhost -f infra/postgres/create-local-dev-db.sql
--
-- Creates the two roles and databases that .env.example expects. The passwords are the
-- development values from .env.example. Never reuse them anywhere else.
--   adas_admin  owns the databases and runs migrations (DATABASE_ADMIN_URL)
--   adas_app    is what the running API connects as (DATABASE_URL); the migration
--               limits it, e.g. no UPDATE/DELETE on audit_logs, no DELETE on suppressions

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_admin') THEN
    CREATE ROLE adas_admin LOGIN PASSWORD 'adas_admin_password';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    CREATE ROLE adas_app LOGIN PASSWORD 'adas_dev_password';
  ELSE
    ALTER ROLE adas_app LOGIN PASSWORD 'adas_dev_password';
  END IF;
END
$$;

SELECT 'CREATE DATABASE adas_crm OWNER adas_admin'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'adas_crm')\gexec

SELECT 'CREATE DATABASE adas_crm_test OWNER adas_admin'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'adas_crm_test')\gexec

\connect adas_crm
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
GRANT CONNECT ON DATABASE adas_crm TO adas_app;
GRANT USAGE ON SCHEMA public TO adas_app;

\connect adas_crm_test
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;
GRANT CONNECT ON DATABASE adas_crm_test TO adas_app;
GRANT USAGE ON SCHEMA public TO adas_app;

\echo 'ADAS CRM local databases are ready: adas_crm and adas_crm_test.'
