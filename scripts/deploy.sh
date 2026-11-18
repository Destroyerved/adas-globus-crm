#!/usr/bin/env bash
# =============================================================================
# ADAS CRM — Zero-Surprise Production Deploy & Automatic Rollback (`PRD 10.7`)
#
# Usage:
#   scripts/deploy.sh <image-tag> [--build]
#
# Steps:
#   1. Preflight check on `.env.production` and mounted secret files
#   2. Record currently deployed image tag (`PREVIOUS_TAG`) for instant rollback
#   3. Take an encrypted `pre_deploy` database backup (`PRD 10.7`)
#   4. Build (if `--build`) or pull `adas-crm-api:<tag>`
#   5. Run forward-only SQL migrations in a one-off admin container
#   6. Roll `api`, `worker`, and `backup` to `<tag>`
#   7. Run `/healthz?strict=1` readiness smoke checks (DB, worker, outbox, backups)
#   8. Automatically roll back to `PREVIOUS_TAG` if migrations or smoke checks fail
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/compose.prod.yml"
STATE_FILE="${REPO_ROOT}/.deploy-state"
ENV_FILE="${REPO_ROOT}/.env.production"

TAG="${1:-}"
BUILD_FLAG="${2:-}"

if [[ -z "${TAG}" ]]; then
  echo "Usage: scripts/deploy.sh <image-tag> [--build]" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "[deploy] ERROR: Missing ${ENV_FILE}. Refuse to deploy without production config." >&2
  exit 1
fi

REQUIRED_SECRETS=(
  "postgres_admin_password.txt"
  "postgres_app_password.txt"
  "session_secret.txt"
  "token_encryption_key.txt"
  "backup_encryption_key.txt"
)
for sec in "${REQUIRED_SECRETS[@]}"; do
  if [[ ! -s "${REPO_ROOT}/secrets/${sec}" ]]; then
    echo "[deploy] ERROR: Required secret file secrets/${sec} is missing or empty." >&2
    exit 1
  fi
done

PREVIOUS_TAG=""
if [[ -f "${STATE_FILE}" ]]; then
  PREVIOUS_TAG="$(tr -d '\r\n' < "${STATE_FILE}")"
fi

echo "[deploy] Starting deploy of tag '${TAG}' (previous='${PREVIOUS_TAG:-none}')"

rollback() {
  local reason="$1"
  echo "[deploy] ERROR: ${reason}" >&2
  if [[ -n "${PREVIOUS_TAG}" && "${PREVIOUS_TAG}" != "${TAG}" ]]; then
    echo "[deploy] Rolling back api, worker, and backup to '${PREVIOUS_TAG}'..." >&2
    ADAS_IMAGE_TAG="${PREVIOUS_TAG}" docker compose -f "${COMPOSE_FILE}" up -d --no-deps api worker backup
    echo "[deploy] Rollback to '${PREVIOUS_TAG}' triggered." >&2
  else
    echo "[deploy] No previous deploy state recorded; manual intervention required." >&2
  fi
  exit 1
}

# Ensure PostgreSQL is running and healthy before backup/migrations
ADAS_IMAGE_TAG="${PREVIOUS_TAG:-${TAG}}" docker compose -f "${COMPOSE_FILE}" up -d postgres

if [[ "${BUILD_FLAG}" == "--build" ]]; then
  echo "[deploy] Building image adas-crm-api:${TAG} from local source..."
  docker build -f "${REPO_ROOT}/infra/Dockerfile.api" -t "adas-crm-api:${TAG}" "${REPO_ROOT}"
else
  if ! docker image inspect "adas-crm-api:${TAG}" >/dev/null 2>&1; then
    echo "[deploy] Pulling image adas-crm-api:${TAG}..."
    docker pull "adas-crm-api:${TAG}" || rollback "Could not pull image adas-crm-api:${TAG}"
  fi
fi

# 1. Pre-deploy encrypted database backup (if schema already initialized)
if ADAS_IMAGE_TAG="${TAG}" docker compose -f "${COMPOSE_FILE}" run --rm --no-deps \
  api node --conditions=production-dist apps/api/dist/cli/backup.js backup --kind=pre_deploy; then
  echo "[deploy] Pre-deploy encrypted backup completed."
else
  echo "[deploy] Pre-deploy backup skipped or first-time bootstrap; proceeding to migrations."
fi

# 2. Apply forward-only migrations in a one-off container
echo "[deploy] Applying database migrations..."
if ! ADAS_IMAGE_TAG="${TAG}" docker compose -f "${COMPOSE_FILE}" run --rm --no-deps \
  api node --conditions=production-dist apps/api/dist/cli/migrate.js; then
  rollback "Database migration failed"
fi

# 3. Restart application services on new tag
echo "[deploy] Updating api, worker, and backup containers to '${TAG}'..."
if ! ADAS_IMAGE_TAG="${TAG}" docker compose -f "${COMPOSE_FILE}" up -d --no-deps api worker backup uptime-kuma; then
  rollback "Failed to recreate containers"
fi

# 4. Smoke-check /healthz?strict=1 (waits up to 60s for API + worker heartbeat)
echo "[deploy] Running post-deploy readiness smoke checks..."
SMOKE_OK=0
for attempt in $(seq 1 30); do
  if BODY="$(curl -fsS --max-time 5 "http://127.0.0.1:3000/healthz?strict=1" 2>/dev/null)"; then
    if echo "${BODY}" | grep -q '"status":"ok"'; then
      SMOKE_OK=1
      break
    fi
  fi
  sleep 2
done

if [[ "${SMOKE_OK}" -ne 1 ]]; then
  rollback "Post-deploy /healthz?strict=1 smoke check did not reach status=ok within 60s"
fi

printf '%s\n' "${TAG}" > "${STATE_FILE}"
echo "[deploy] SUCCESS: ADAS CRM '${TAG}' is live and healthy."
