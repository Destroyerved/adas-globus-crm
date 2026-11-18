#!/usr/bin/env sh
# =============================================================================
# ADAS CRM — Scheduled Encrypted Database Backup Daemon (`PRD 10.2, 10.5`)
# Runs inside `adas-crm-backup-prod` (`mem_limit: 256m`):
# - Takes an immediate startup backup if none exists within 20 hours,
# - Runs nightly encrypted `pg_dump -Fc` + S3/R2/B2 off-site upload + 14-day prune,
# - Pulses `/tmp/backup-loop.heartbeat` every 30 minutes for container healthcheck.
# =============================================================================
set -eu

INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-86400}"
echo "[backup-daemon] Starting encrypted backup scheduler (interval=${INTERVAL_SECONDS}s)"

touch /tmp/backup-loop.heartbeat

run_once() {
  echo "[backup-daemon] Starting encrypted pg_dump at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if node --conditions=production-dist /app/apps/api/dist/cli/backup.js backup --kind=pg_dump; then
    echo "[backup-daemon] Encrypted backup succeeded"
  else
    echo "[backup-daemon] ERROR: Encrypted backup failed" >&2
  fi
  touch /tmp/backup-loop.heartbeat
}

# Run immediately on container start so a newly provisioned box has a baseline backup
run_once

elapsed=0
while true; do
  sleep 1800
  touch /tmp/backup-loop.heartbeat
  elapsed=$((elapsed + 1800))
  if [ "$elapsed" -ge "$INTERVAL_SECONDS" ]; then
    elapsed=0
    run_once
  fi
done
