#!/usr/bin/env bash
# Production deploy script (PRD §10.7, Phase 1 full implementation)
set -euo pipefail

TAG="${1:-}"
if [[ -z "$TAG" ]]; then
  echo "Usage: scripts/deploy.sh <image-tag>" >&2
  exit 1
fi

echo "[deploy] Pre-deploy backup marker for tag: ${TAG}"
echo "[deploy] Full production deploy workflow lands in Phase 1 (PRD §10.7)."
