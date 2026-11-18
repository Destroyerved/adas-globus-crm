#!/usr/bin/env sh
# =============================================================================
# Provision least-privilege runtime role `adas_app` on first cluster bootstrap
# (`PRD 7.4, 9, 10.2`). Runs inside `postgres:17.4-alpine` as `POSTGRES_USER`
# (`adas_admin`) before `01-init-extensions.sql`.
# =============================================================================
set -eu

APP_PASSWORD_FILE="${POSTGRES_APP_PASSWORD_FILE:-/run/secrets/postgres_app_password}"
if [ ! -f "$APP_PASSWORD_FILE" ]; then
  echo "[postgres-init] ERROR: Missing $APP_PASSWORD_FILE for least-privilege role adas_app" >&2
  exit 1
fi

APP_PASSWORD="$(tr -d '\r\n' < "$APP_PASSWORD_FILE")"
if [ "${#APP_PASSWORD}" -lt 16 ]; then
  echo "[postgres-init] ERROR: postgres_app_password must be at least 16 characters" >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set=app_pwd="$APP_PASSWORD" <<'EOSQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'adas_app') THEN
    CREATE ROLE adas_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
  END IF;
END
$$;

ALTER ROLE adas_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'app_pwd';
GRANT CONNECT ON DATABASE adas_crm TO adas_app;
GRANT USAGE ON SCHEMA public TO adas_app;
EOSQL

echo "[postgres-init] Provisioned least-privilege runtime role adas_app."
