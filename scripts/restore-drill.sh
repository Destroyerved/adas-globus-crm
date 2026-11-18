#!/usr/bin/env bash
# =============================================================================
# ADAS CRM — Monthly Encrypted Backup Restore Drill (`PRD 10.5`, `12.1 A21`)
#
# Restores the latest encrypted `.dump.enc` archive (or `--from-offsite` from S3/R2/B2)
# into a throw-away PostgreSQL database, verifies SHA-256 + AES-256-GCM integrity,
# row counts, generated `search_tsv` columns, 0 FK orphans, and append-only triggers
# on `audit_logs` and `suppressions`, drops the throw-away DB, records the run in
# `backup_runs` (surfaced in `/healthz` and `Settings -> System health`), and pushes
# the result to Uptime Kuma when `UPTIME_KUMA_PUSH_URL` is configured.
#
# Usage:
#   scripts/restore-drill.sh [--from-offsite] [--backup-id=bkp_...]
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/compose.prod.yml"

if command -v docker >/dev/null 2>&1 && docker compose -f "${COMPOSE_FILE}" ps --status running backup 2>/dev/null | grep -q "adas-crm-backup-prod"; then
  echo "[restore-drill] Executing restore drill inside running production backup container..."
  docker compose -f "${COMPOSE_FILE}" exec -T backup \
    node --conditions=production-dist /app/apps/api/dist/cli/backup.js drill "$@"
else
  echo "[restore-drill] Executing restore drill via local Node + PostgreSQL toolchain..."
  pnpm --dir "${REPO_ROOT}" --filter @adas/api backup:drill -- "$@"
fi
