# ADR 0026: Cross-Platform One-Click Production Server Installer (`@adas/installer`, `install.sh`, `ADAS-CRM-Deployer.exe`)

- **Date:** 2026-11-18
- **Status:** Accepted
- **References:** PRD §10.1–10.8, ADR 0025

## Context

ADAS Globus CRM targets a dedicated 16 GB RAM / 256 GB SSD Ubuntu Server LTS machine behind Cloudflare Tunnel and Cloudflare Access (`PRD 10.1–10.4`), while also supporting Windows Server / Docker Desktop staging and operational setup. Operators need a repeatable, single-command and wizard-driven installation path that:

1. Verifies hardware (CPU, RAM, SSD free space), Docker Engine + Compose v2, and loopback port availability (`3000`, `3001`) before touching containers.
2. Generates all five Milestone 10 least-privilege cryptographic secret files (`postgres_admin_password.txt`, `postgres_app_password.txt`, `session_secret.txt`, `token_encryption_key.txt`, `backup_encryption_key.txt`) without ever overwriting existing secrets on re-runs.
3. Supports initial database initialization, SQL migrations (`dist/cli/migrate.js`), break-glass Admin provisioning (`dist/cli/break-glass.js`), `/healthz` readiness checks, safe upgrades with automatic rollback, and safe uninstallation that preserves PostgreSQL volumes and backups unless explicitly confirmed.

## Decisions

1. **Three Coherent Entry Surfaces Sharing Identical Secret & `.env.production` Layouts:**
   - **Linux / Bare Ubuntu LTS (`installer/install.sh`):** Pure Bash + `openssl` + `docker compose` script so a fresh Ubuntu 24.04 LTS server does not require host Node.js to install Docker (`--install-docker`), run preflight checks, generate mode-`0600` secrets, build `adas-crm-api:<tag>`, run migrations, and verify `/healthz`.
   - **Cross-Platform CLI & Loopback Browser Wizard (`@adas/installer`):** TypeScript package (`pnpm installer` and `pnpm installer:wizard`) providing `runPreflightChecks`, `InstallerService` (`provisionConfiguration`, `installStack`, `upgradeStack`, `rollbackStack`, `checkStackHealth`, `uninstallStack`), and a loopback-only (`127.0.0.1:3088`) setup wizard protected by a 192-bit CSRF token (`X-Installer-Csrf`) and strict loopback `Origin` enforcement.
   - **Windows Standalone `.exe` (`infra/deployer/AdasCrmDeployer.cs` → `dist/deployer/ADAS-CRM-Deployer.exe`):** Upgraded to generate the exact five Milestone 10 secret files, `adas_app` / `adas_admin` URLs, preflight report, `/healthz` check, rollback, and safe uninstall—removing all legacy Phase 0 PGlite references.

2. **Idempotent, Non-Destructive Re-Provisioning:**
   - Existing secret files with length `>= 16` characters are never overwritten.
   - Existing `.env.production` files are backed up to `.env.production.bak`, and operator-controlled flags (`MAIL_LIVE=true`, `TOKEN_ENCRYPTION_KEY_VERSION`) are preserved across re-runs.

3. **Destructive Uninstall Guardrail:**
   - `uninstall` stops and removes containers only by default (`docker compose down`), leaving PostgreSQL volumes, `data/files`, `data/backups`, and `secrets/` untouched.
   - Purging volumes and secrets (`--purge-data`) is rejected unless accompanied by the exact confirmation phrase `"DELETE ALL CRM DATA"`.
