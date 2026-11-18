# One-Click Server Installation Guide

ADAS Globus CRM provides three synchronized installation interfaces that generate identical mode-`0600` secret files, least-privilege `adas_app` / `adas_admin` PostgreSQL URLs, and Cloudflare Tunnel ingress configurations (`ADR 0026`).

---

## 1. Linux / Ubuntu Server LTS (`installer/install.sh` — Recommended for Production)

`installer/install.sh` runs directly on a clean Ubuntu 24.04 LTS machine using `bash`, `openssl`, `curl`, and Docker Engine + Compose v2 (host Node.js is **not** required).

### Commands

```bash
# 1. Hardware, RAM, SSD, port & Docker preflight (optionally installing official Docker Engine)
./installer/install.sh preflight --install-docker

# 2. Idempotent secret & .env.production provisioning only (never overwrites existing secrets)
./installer/install.sh provision --domain adasglobuspro.com --tunnel-name adas-crm-prod-16gb

# 3. Full one-click install (preflight -> secrets -> image build -> PG17 -> migrations -> break-glass -> /healthz)
./installer/install.sh install \
  --domain adasglobuspro.com \
  --tag v1.0.0 \
  --admin-email ops-admin@adasglobuspro.com

# 4. Safe release upgrade (pre-deploy encrypted backup + migrations + /healthz smoke check + auto-rollback)
./installer/install.sh upgrade --tag v1.1.0

# 5. Rollback to previous recorded tag (.deploy-state.prev)
./installer/install.sh rollback

# 6. Live readiness check
./installer/install.sh health

# 7. Stop containers while preserving all PostgreSQL volumes, backups, and secrets
./installer/install.sh uninstall
```

---

## 2. Cross-Platform CLI & Loopback Browser Setup Wizard (`@adas/installer`)

On hosts with Node.js 22+ and `pnpm` installed:

```bash
# Launch the loopback-only (127.0.0.1:3088) visual Setup Wizard in a local browser
pnpm installer:wizard

# Or run CLI subcommands directly
pnpm installer preflight
pnpm installer provision -- --domain adasglobuspro.com
pnpm installer install -- --domain adasglobuspro.com --tag v1.0.0
pnpm installer upgrade -- --tag v1.1.0 --build
pnpm installer rollback
pnpm installer health
```

### Wizard Security Invariants

- Binds strictly to `127.0.0.1` (never LAN/WAN interfaces).
- Enforces a per-process 192-bit CSRF token (`X-Installer-Csrf`) and loopback `Origin` check on all `POST` endpoints.
- Never echoes secret file values back to the browser.

---

## 3. Windows Standalone Deployer Executable (`ADAS-CRM-Deployer.exe`)

For Windows Server or Docker Desktop staging hosts, build the zero-dependency WinForms + CLI executable:

```powershell
pnpm build:exe
# Output: dist\deployer\ADAS-CRM-Deployer.exe
```

### GUI & Headless Modes

- **Double-click `ADAS-CRM-Deployer.exe`** to open the graphical installer (Preflight Check, Provision Secrets & Config, Build/Migrate/Start Stack, Check `/healthz`, Rollback).
- **Headless CLI flags:**
  ```powershell
  .\dist\deployer\ADAS-CRM-Deployer.exe --preflight
  .\dist\deployer\ADAS-CRM-Deployer.exe --provision --domain adasglobuspro.com
  .\dist\deployer\ADAS-CRM-Deployer.exe --install --domain adasglobuspro.com --tag v1.0.0
  .\dist\deployer\ADAS-CRM-Deployer.exe --health
  .\dist\deployer\ADAS-CRM-Deployer.exe --rollback
  .\dist\deployer\ADAS-CRM-Deployer.exe --uninstall
  ```

---

## 4. Non-Destructive Guarantees

- **Existing secrets are never overwritten:** Re-running `provision` or `install` preserves `postgres_admin_password.txt`, `postgres_app_password.txt`, `session_secret.txt`, `token_encryption_key.txt`, and `backup_encryption_key.txt`.
- **`.env.production` backup:** Previous `.env.production` files are backed up to `.env.production.bak`, and operator-set `MAIL_LIVE` and `TOKEN_ENCRYPTION_KEY_VERSION` values are preserved.
- **Safe uninstaller:** `uninstall` stops containers only. Purging volumes and backups (`--purge-data`) is refused unless `--confirm "DELETE ALL CRM DATA"` is explicitly supplied.
