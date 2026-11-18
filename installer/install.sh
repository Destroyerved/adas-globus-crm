#!/usr/bin/env bash
# =============================================================================
# ADAS Globus CRM — Linux / Ubuntu LTS One-Click Production Server Installer
#
# Usage:
#   ./installer/install.sh [preflight|provision|install|upgrade|rollback|health|wizard|uninstall] [options]
#
# Options:
#   --domain <domain>            Primary domain (default: adasglobuspro.com)
#   --tunnel-name <name>         Cloudflare Tunnel name (default: adas-crm-prod-16gb)
#   --tunnel-token <token>       Optional Cloudflare Tunnel token
#   --tag <version>              Docker image tag (default: v1.0.0)
#   --admin-email <email>        Optional initial break-glass Admin email
#   --enable-automation          Enable optional n8n container profile
#   --install-docker             Install official Docker Engine + Compose v2 on Ubuntu/Debian
#   --purge-data                 Delete DB volumes, backups, and secrets during uninstall
#   --confirm "<phrase>"         Must equal "DELETE ALL CRM DATA" when --purge-data is used
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/infra/compose.prod.yml"
SECRETS_DIR="${REPO_ROOT}/secrets"
ENV_PROD="${REPO_ROOT}/.env.production"
STATE_FILE="${REPO_ROOT}/.deploy-state"
PREV_STATE_FILE="${REPO_ROOT}/.deploy-state.prev"

COMMAND="install"
if [[ $# -gt 0 && ! "$1" =~ ^-- ]]; then
  COMMAND="$1"
  shift
fi

DOMAIN="adasglobuspro.com"
TUNNEL_NAME="adas-crm-prod-16gb"
TUNNEL_TOKEN=""
IMAGE_TAG="v1.0.0"
ADMIN_EMAIL=""
ENABLE_AUTOMATION="false"
INSTALL_DOCKER="false"
PURGE_DATA="false"
CONFIRM_PHRASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="${2:-}"; shift 2 ;;
    --tunnel-token) TUNNEL_TOKEN="${2:-}"; shift 2 ;;
    --tag) IMAGE_TAG="${2:-}"; shift 2 ;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --enable-automation) ENABLE_AUTOMATION="true"; shift ;;
    --install-docker) INSTALL_DOCKER="true"; shift ;;
    --purge-data) PURGE_DATA="true"; shift ;;
    --confirm) CONFIRM_PHRASE="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "[installer] Unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

DOMAIN="$(printf '%s' "${DOMAIN}" | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##')"

install_docker_ubuntu() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "[installer] Docker Engine and Compose v2 are already installed."
    return 0
  fi
  if [[ "$(uname -s)" != "Linux" || ! -f /etc/debian_version ]]; then
    echo "[installer] Automated --install-docker requires Ubuntu/Debian Linux." >&2
    exit 1
  fi
  echo "[installer] Installing official Docker Engine and Compose v2 plugin..."
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg
  sudo install -m 0755 -d /etc/apt/keyrings
  if [[ ! -f /etc/apt/keyrings/docker.gpg ]]; then
    . /etc/os-release
    curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    sudo chmod a+r /etc/apt/keyrings/docker.gpg
  fi
  . /etc/os-release
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  echo "[installer] Docker Engine installed and running."
}

run_preflight() {
  local require_docker="${1:-true}"
  local failed=0
  echo "=== ADAS CRM Production Server Preflight ==="

  local os_name arch cpu_threads mem_gb free_gb
  os_name="$(uname -s)"
  arch="$(uname -m)"
  cpu_threads="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)"
  if [[ -r /proc/meminfo ]]; then
    mem_gb="$(awk '/MemTotal/ { printf "%.1f", $2 / 1048576 }' /proc/meminfo)"
  else
    mem_gb="16.0"
  fi
  free_gb="$(df -Pk "${REPO_ROOT}" | awk 'NR==2 { printf "%.0f", $4 / 1048576 }')"

  echo "  [INFO] OS / Arch    : ${os_name} (${arch})"
  echo "  [INFO] CPU Threads  : ${cpu_threads}"
  echo "  [INFO] System RAM   : ${mem_gb} GB"
  echo "  [INFO] Free Disk    : ${free_gb} GB"

  if [[ "${free_gb}" -lt 5 ]]; then
    echo "  [FAIL] Less than 5 GB free disk space (${free_gb} GB). At least 20 GB SSD headroom is recommended." >&2
    failed=1
  elif [[ "${free_gb}" -lt 20 ]]; then
    echo "  [WARN] Free disk (${free_gb} GB) is below the 20 GB production recommendation."
  else
    echo "  [PASS] Disk space check passed."
  fi

  if [[ "${require_docker}" == "true" ]]; then
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
      echo "  [PASS] Docker Engine & Compose v2 verified ($(docker compose version --short))."
    else
      echo "  [FAIL] Docker daemon or 'docker compose' plugin is unavailable. Re-run with --install-docker on Ubuntu LTS." >&2
      failed=1
    fi
  fi

  return "${failed}"
}

ensure_secret_file() {
  local file_path="$1"
  local prefix="$2"
  local num_bytes="$3"
  if [[ -s "${file_path}" ]]; then
    chmod 600 "${file_path}" 2>/dev/null || true
    echo "  [OK] Preserved existing secret -> $(basename "${file_path}")"
  else
    local hex
    if command -v openssl >/dev/null 2>&1; then
      hex="$(openssl rand -hex "${num_bytes}")"
    else
      hex="$(head -c "${num_bytes}" /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    umask 077
    printf '%s%s\n' "${prefix}" "${hex}" > "${file_path}"
    chmod 600 "${file_path}" 2>/dev/null || true
    echo "  [OK] Generated cryptographic secret -> $(basename "${file_path}")"
  fi
}

provision_config() {
  echo "=== Provisioning Secrets, .env.production & Cloudflare Ingress ==="
  mkdir -p -m 700 "${SECRETS_DIR}"
  mkdir -p "${REPO_ROOT}/data/files" "${REPO_ROOT}/data/backups" "${REPO_ROOT}/infra/cloudflare"

  ensure_secret_file "${SECRETS_DIR}/postgres_admin_password.txt" "pgadm_" 24
  ensure_secret_file "${SECRETS_DIR}/postgres_app_password.txt" "pgapp_" 24
  ensure_secret_file "${SECRETS_DIR}/session_secret.txt" "sess_" 32
  ensure_secret_file "${SECRETS_DIR}/token_encryption_key.txt" "tkey_" 32
  ensure_secret_file "${SECRETS_DIR}/backup_encryption_key.txt" "bkey_" 32

  if [[ -n "${TUNNEL_TOKEN}" ]]; then
    umask 077
    printf '%s\n' "${TUNNEL_TOKEN}" > "${SECRETS_DIR}/cloudflare_tunnel_token.txt"
    chmod 600 "${SECRETS_DIR}/cloudflare_tunnel_token.txt" 2>/dev/null || true
    echo "  [OK] Saved Cloudflare Tunnel token -> secrets/cloudflare_tunnel_token.txt"
  fi

  local admin_pw app_pw mail_live="false" key_version="1"
  admin_pw="$(tr -d '\r\n' < "${SECRETS_DIR}/postgres_admin_password.txt")"
  app_pw="$(tr -d '\r\n' < "${SECRETS_DIR}/postgres_app_password.txt")"

  if [[ -f "${ENV_PROD}" ]]; then
    cp "${ENV_PROD}" "${ENV_PROD}.bak"
    if grep -q '^MAIL_LIVE=true' "${ENV_PROD}"; then
      mail_live="true"
    fi
    local existing_kv
    existing_kv="$(grep '^TOKEN_ENCRYPTION_KEY_VERSION=' "${ENV_PROD}" | head -n1 | cut -d= -f2 || true)"
    if [[ -n "${existing_kv}" ]]; then
      key_version="${existing_kv}"
    fi
    echo "  [OK] Backed up previous .env.production -> .env.production.bak"
  fi

  umask 077
  cat > "${ENV_PROD}" <<EOF
# =============================================================================
# ADAS CRM — Production Environment (.env.production)
# Generated idempotently by installer/install.sh
# =============================================================================
NODE_ENV=production
PORT=3000
WEB_PORT=5174
ADAS_DOMAIN=${DOMAIN}
APP_INTERNAL_HOST=crm.${DOMAIN}
APP_PUBLIC_HOST=go.${DOMAIN}
PUBLIC_WEB_URL=https://crm.${DOMAIN}
PUBLIC_API_URL=https://crm.${DOMAIN}/api/v1
DATABASE_URL=postgresql://adas_app:${app_pw}@postgres:5432/adas_crm?schema=public
DATABASE_ADMIN_URL=postgresql://adas_admin:${admin_pw}@postgres:5432/adas_crm?schema=public
MAIL_LIVE=${mail_live}
SESSION_IDLE_TIMEOUT_HOURS=12
SESSION_ABSOLUTE_TIMEOUT_DAYS=7
SESSION_SECRET_FILE=/app/secrets/session_secret.txt
TOKEN_ENCRYPTION_KEY_FILE=/app/secrets/token_encryption_key.txt
TOKEN_ENCRYPTION_KEY_VERSION=${key_version}
ENTRA_TENANT_ID=00000000-0000-0000-0000-000000000000
ENTRA_CLIENT_ID=00000000-0000-0000-0000-000000000000
ENTRA_CLIENT_SECRET_FILE=/app/secrets/entra_client_secret.txt
ENTRA_REDIRECT_URI=https://crm.${DOMAIN}/api/v1/auth/sso/callback
ENTRA_MAIL_REDIRECT_URI=https://crm.${DOMAIN}/api/v1/inbox/oauth/callback
CRM_NOTIFICATION_MAILBOX=crm@${DOMAIN}
ESP_PROVIDER=postmark
ESP_SENDING_DOMAIN=mail.${DOMAIN}
ESP_API_KEY_FILE=/app/secrets/esp_api_key.txt
ESP_WEBHOOK_SECRET_FILE=/app/secrets/esp_webhook_secret.txt
APOLLO_API_KEY_FILE=/app/secrets/apollo_api_key.txt
BOOKINGS_WEBHOOK_SECRET_FILE=/app/secrets/bookings_webhook_secret.txt
WEBHOOK_ALLOW_PRIVATE_TARGETS=${ENABLE_AUTOMATION}
CF_ACCESS_TEAM_DOMAIN=adasglobuspro.cloudflareaccess.com
CF_ACCESS_AUD=0000000000000000000000000000000000000000000000000000000000000000
CF_ACCESS_ENFORCE=false
FILE_STORAGE_DRIVER=local
FILE_STORAGE_LOCAL_PATH=/app/data/files
INQUIRY_CORS_ORIGINS=https://www.${DOMAIN},https://${DOMAIN}
INQUIRY_RATE_LIMIT_PER_10M=5
API_RATE_LIMIT_PER_MIN=600
DEFAULT_REPORTING_CURRENCY=USD
BACKUP_LOCAL_DIR=/app/data/backups
BACKUP_ENCRYPTION_KEY_FILE=/app/secrets/backup_encryption_key.txt
BACKUP_RETENTION_DAYS=14
BACKUP_S3_REGION=auto
BACKUP_S3_SECRET_ACCESS_KEY_FILE=/app/secrets/backup_s3_secret_key.txt
LOG_LEVEL=info
EOF
  chmod 600 "${ENV_PROD}" 2>/dev/null || true
  echo "  [OK] Wrote mode-0600 .env.production"

  cat > "${REPO_ROOT}/infra/cloudflare/config.yml" <<EOF
# ADAS CRM — Outbound Cloudflare Tunnel Ingress (PRD 10.4)
tunnel: ${TUNNEL_NAME}
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: crm.${DOMAIN}
    service: http://api:3000
  - hostname: go.${DOMAIN}
    service: http://api:3000
  - hostname: status.${DOMAIN}
    service: http://uptime-kuma:3001
  - service: http_status:404
EOF
  echo "  [OK] Wrote infra/cloudflare/config.yml"
}

wait_for_health() {
  local attempts=30
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "http://127.0.0.1:3000/healthz" >/dev/null 2>&1; then
      echo "  [PASS] /healthz responded HTTP 200."
      return 0
    fi
    sleep 2
  done
  echo "  [FAIL] /healthz did not become healthy within 60 seconds." >&2
  return 1
}

if [[ "${INSTALL_DOCKER}" == "true" ]]; then
  install_docker_ubuntu
fi

case "${COMMAND}" in
  preflight)
    run_preflight "true"
    ;;
  provision)
    run_preflight "false"
    provision_config
    ;;
  install)
    run_preflight "true"
    provision_config
    export ADAS_IMAGE_TAG="${IMAGE_TAG}"
    echo "=== Building Production Image adas-crm-api:${IMAGE_TAG} ==="
    docker build -f "${REPO_ROOT}/infra/Dockerfile.api" -t "adas-crm-api:${IMAGE_TAG}" "${REPO_ROOT}"
    echo "=== Starting PostgreSQL 17 & Applying SQL Migrations ==="
    docker compose -f "${COMPOSE_FILE}" up -d postgres
    docker compose -f "${COMPOSE_FILE}" run --rm --no-deps api node --conditions=production-dist apps/api/dist/cli/migrate.js
    if [[ -n "${ADMIN_EMAIL}" ]]; then
      echo "=== Provisioning Break-Glass Admin (${ADMIN_EMAIL}) ==="
      docker compose -f "${COMPOSE_FILE}" run --rm --no-deps api node --conditions=production-dist apps/api/dist/cli/break-glass.js set "${ADMIN_EMAIL}"
    fi
    PROFILE_ARGS=()
    SERVICES=(api worker backup uptime-kuma)
    if [[ -f "${REPO_ROOT}/infra/cloudflare/credentials.json" ]]; then
      SERVICES+=(cloudflared)
    fi
    if [[ "${ENABLE_AUTOMATION}" == "true" ]]; then
      PROFILE_ARGS=(--profile automation)
      SERVICES+=(n8n)
    fi
    echo "=== Starting Production Services: ${SERVICES[*]} ==="
    docker compose -f "${COMPOSE_FILE}" "${PROFILE_ARGS[@]}" up -d "${SERVICES[@]}"
    if [[ -f "${STATE_FILE}" ]]; then
      cp "${STATE_FILE}" "${PREV_STATE_FILE}"
    fi
    printf '%s\n' "${IMAGE_TAG}" > "${STATE_FILE}"
    wait_for_health
    echo "=== ADAS CRM Production Installation Complete (${IMAGE_TAG}) ==="
    ;;
  upgrade)
    echo "=== Running Safe Upgrade via scripts/deploy.sh (${IMAGE_TAG}) ==="
    bash "${REPO_ROOT}/scripts/deploy.sh" "${IMAGE_TAG}" --build-local
    ;;
  rollback)
    TARGET_TAG="${IMAGE_TAG}"
    if [[ -f "${PREV_STATE_FILE}" && "${TARGET_TAG}" == "v1.0.0" ]]; then
      TARGET_TAG="$(tr -d '\r\n' < "${PREV_STATE_FILE}")"
    fi
    if [[ -z "${TARGET_TAG}" ]]; then
      echo "[installer] No rollback image tag found in .deploy-state.prev; pass --tag <version>." >&2
      exit 1
    fi
    echo "=== Rolling Back Services to ${TARGET_TAG} ==="
    ADAS_IMAGE_TAG="${TARGET_TAG}" docker compose -f "${COMPOSE_FILE}" up -d --no-deps api worker backup
    printf '%s\n' "${TARGET_TAG}" > "${STATE_FILE}"
    wait_for_health
    ;;
  health)
    curl -fsS "http://127.0.0.1:3000/healthz" && echo ""
    ;;
  wizard)
    if ! command -v pnpm >/dev/null 2>&1; then
      echo "[installer] Interactive browser wizard requires Node.js 22+ and pnpm. Use CLI commands on minimal servers." >&2
      exit 1
    fi
    pnpm --dir "${REPO_ROOT}" --filter @adas/installer wizard
    ;;
  uninstall)
    if [[ "${PURGE_DATA}" == "true" ]]; then
      if [[ "${CONFIRM_PHRASE}" != "DELETE ALL CRM DATA" ]]; then
        echo "[installer] Refusing --purge-data without --confirm \"DELETE ALL CRM DATA\"." >&2
        exit 1
      fi
      echo "=== Stopping Containers and Purging Volumes, Backups & Secrets ==="
      docker compose -f "${COMPOSE_FILE}" --profile automation down --volumes
      rm -rf "${REPO_ROOT}/data" "${SECRETS_DIR}" "${ENV_PROD}" "${STATE_FILE}" "${PREV_STATE_FILE}"
    else
      echo "=== Stopping Containers (Preserving PostgreSQL Volumes, Backups & Secrets) ==="
      docker compose -f "${COMPOSE_FILE}" --profile automation down
    fi
    ;;
  *)
    echo "[installer] Unknown command '${COMMAND}'." >&2
    exit 1
    ;;
esac
