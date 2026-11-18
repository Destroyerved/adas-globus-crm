# Production Deployment Guide

This guide covers preparing the dedicated 16 GB RAM / 256 GB SSD Ubuntu Server LTS host, configuring Cloudflare Tunnel & Cloudflare Access, and running safe zero-surprise deployments and rollbacks (`PRD §10.1–10.8`).

---

## 1. Target Hardware & Container Budget (`PRD §10.1, §10.2`)

| Component / Service                                | Allocation                     | Notes                                                                                                                                      |
| -------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Host OS                                            | Ubuntu Server 24.04 LTS (x64)  | LUKS full-disk encryption (if remote unlock is available), `ufw default deny incoming`, `unattended-upgrades` enabled, UPS attached (`Q7`) |
| `postgres` (`postgres:17.4-alpine`)                | `4 GB` (`mem_limit: 4g`)       | `shared_buffers=2GB`, `effective_cache_size=8GB`, `work_mem=16MB`, `random_page_cost=1.1`, `wal_compression=on`                            |
| `api` (`adas-crm-api:<tag>`)                       | `1 GB` (`mem_limit: 1g`)       | Serves both `/api/v1/*` and the compiled static React SPA (`127.0.0.1:3000:3000`)                                                          |
| `worker` (`adas-crm-api:<tag>`)                    | `768 MB` (`mem_limit: 768m`)   | `pg-boss` worker with DB-backed `worker-healthcheck.js`                                                                                    |
| `backup` (`adas-crm-api:<tag>`)                    | `256 MB` (`mem_limit: 256m`)   | Scheduled `ADASBK01` AES-256-GCM `pg_dump -Fc` + S3 Signature v4 off-site sync                                                             |
| `uptime-kuma` (`louislam/uptime-kuma:1.23.16`)     | `256 MB` (`mem_limit: 256m`)   | Bound to `127.0.0.1:3001:3001`                                                                                                             |
| `cloudflared` (`cloudflare/cloudflared:2025.2.1`)  | `128 MB` (`mem_limit: 128m`)   | Outbound-only tunnel; zero inbound router ports opened                                                                                     |
| `n8n` (`n8nio/n8n:1.81.4`, `--profile automation`) | `1.5 GB` (`mem_limit: 1536m`)  | Optional Phase 6 workflow engine (`127.0.0.1:5678:5678`)                                                                                   |
| Linux Page Cache & OS Headroom                     | `~8 GB` (`~6.5 GB` with `n8n`) | Used directly by PostgreSQL 17 OS file cache                                                                                               |

---

## 2. Host Preparation (Ubuntu Server LTS)

1. **Harden network firewall (zero inbound ports):**

   ```bash
   sudo ufw default deny incoming
   sudo ufw default allow outgoing
   sudo ufw enable
   ```

   _(Admin SSH should run over Cloudflare Access SSH or tailnet loopback rather than exposing public TCP/22.)_

2. **Clone repository to `/opt/adas-crm` and install Docker Engine + Compose v2:**

   ```bash
   sudo mkdir -p /opt/adas-crm
   sudo chown "$USER:$USER" /opt/adas-crm
   git clone https://github.com/Destroyerved/adas-globus-crm.git /opt/adas-crm
   /opt/adas-crm/installer/install.sh preflight --install-docker
   ```

3. **Provision cryptographic secrets & `.env.production` (idempotent):**
   ```bash
   /opt/adas-crm/installer/install.sh provision --domain adasglobuspro.com --tunnel-name adas-crm-prod-16gb
   ```
   This creates mode-`0600` files in `/opt/adas-crm/secrets/`:
   - `postgres_admin_password.txt` (used by `DATABASE_ADMIN_URL` for `migrate.js` and `backup.js`)
   - `postgres_app_password.txt` (used by `DATABASE_URL` for least-privilege runtime `adas_app`)
   - `session_secret.txt`
   - `token_encryption_key.txt` (`SecretBox` AES-256-GCM key for OAuth, TOTP, and webhook secrets)
   - `backup_encryption_key.txt` (`ADASBK01` AES-256-GCM archive encryption key — store an escrow copy with two named key holders outside the server per `PRD §10.5 / Q7`!)

---

## 3. Cloudflare Tunnel & Cloudflare Access Setup (`PRD §6.5, §10.4`)

1. Authenticate `cloudflared` and create the tunnel:
   ```bash
   cloudflared tunnel login
   cloudflared tunnel create adas-crm-prod-16gb
   ```
2. Copy the generated tunnel credentials JSON to `/opt/adas-crm/infra/cloudflare/credentials.json` (`chmod 600`).
3. Import `/opt/adas-crm/infra/cloudflare/dns-records.bind` (or run `cloudflared tunnel route dns`) so:
   - `crm.adasglobuspro.com` -> `http://api:3000` (**Protected by Cloudflare Access** — Entra IdP, company accounts only)
   - `go.adasglobuspro.com` -> `http://api:3000` (**Public** — strictly limited by `AuthAndUsersService.verifyHostRouteAccess` to `/healthz`, `/u/:token`, `/c/:token`, `/api/v1/public/inquiries`, and `/api/v1/webhooks/*`)
   - `status.adasglobuspro.com` -> `http://uptime-kuma:3001` (**Protected by Cloudflare Access**)
   - `automation.adasglobuspro.com` -> `http://n8n:5678` (**Protected by Cloudflare Access**, when `--profile automation` is enabled)
4. In `.env.production`, set `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` (from the Cloudflare Access Application Overview), and `CF_ACCESS_ENFORCE=true`.

---

## 4. Initial Production Boot & Break-Glass Provisioning

Run the one-click installer (or step-by-step Compose commands):

```bash
/opt/adas-crm/installer/install.sh install \
  --domain adasglobuspro.com \
  --tag v1.0.0 \
  --admin-email ops-admin@adasglobuspro.com
```

Record the one-time Break-Glass password and TOTP authenticator secret in the company password vault immediately.

### Startup Readiness Guard (`verifyProductionReadiness`)

When `NODE_ENV=production`, both `api` and `worker` execute `verifyProductionReadiness()` before opening traffic and refuse to start if:

- `DATABASE_URL` uses the `postgres` superuser or `adas_admin` instead of `adas_app`, or uses a default dev password,
- `SESSION_SECRET_FILE` (`>= 32` chars) or `TOKEN_ENCRYPTION_KEY_FILE` (`SecretBox`) is missing,
- `schema_migrations` is behind the bundled migrations in `apps/api/prisma/migrations/`, or
- `MAIL_LIVE=true` is set without `compliance.counsel_signed_off` and required live connector secrets.

---

## 5. Safe Release Upgrades & Automatic Rollback (`scripts/deploy.sh`)

Never run `prisma db push` or edit applied migrations on production. Deploy a new release tag with:

```bash
cd /opt/adas-crm
git fetch origin main --tags
git checkout v1.1.0
bash scripts/deploy.sh v1.1.0 --build-local
```

`scripts/deploy.sh` executes in strict order:

1. Verifies all 5 required secret files and `.env.production` exist.
2. Takes an encrypted pre-deploy snapshot (`dist/cli/backup.js backup --kind=pre_deploy`).
3. Runs forward-only SQL migrations in a one-off container (`dist/cli/migrate.js` as `adas_admin`).
4. Recreates `api`, `worker`, and `backup` with `ADAS_IMAGE_TAG=v1.1.0`.
5. Polls `http://127.0.0.1:3000/healthz?strict=1`.
6. **Automatic rollback:** If migrations, container startup, or `/healthz?strict=1` fail, `scripts/deploy.sh` automatically restores the previous tag from `.deploy-state` and exits non-zero.

Manual rollback at any time:

```bash
/opt/adas-crm/installer/install.sh rollback
```
