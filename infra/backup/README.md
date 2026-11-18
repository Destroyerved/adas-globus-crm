# ADAS CRM — Encrypted Backups & Monthly Restore Drill (`PRD 10.5`, `12.1 A21`)

## Architecture

1. **Client-Side Envelope Encryption (`ADASBK01`):**
   - `apps/api/src/platform/backup/index.ts` executes `pg_dump --format=custom --no-owner --no-acl` against `DATABASE_ADMIN_URL` into an ephemeral directory, derives a 256-bit key via `HKDF-SHA256` from `BACKUP_ENCRYPTION_KEY_FILE` (at least 32 characters, held outside the server by two key holders per `PRD Q7`), encrypts with **AES-256-GCM** (random 12-byte IV + 16-byte authentication tag), writes `<id>.dump.enc` + `<id>.manifest.json`, and deletes the plaintext dump immediately.
2. **Off-Site S3-Compatible Upload:**
   - When `BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, and `BACKUP_S3_SECRET_ACCESS_KEY_FILE` are set (Cloudflare R2, Backblaze B2, AWS S3, or MinIO), `s3-sigv4.ts` uploads `<id>.dump.enc` and `<id>.manifest.json` using signed `AWS4-HMAC-SHA256` `PUT` requests.
3. **Retention & Telemetry:**
   - Local archives older than `BACKUP_RETENTION_DAYS` (default `14`) are pruned automatically.
   - Every backup and restore drill writes to `backup_runs`, surfaced on `/healthz` (`lastBackupHoursAgo <= 26`) and `Settings → System health`, and pushes status to `UPTIME_KUMA_PUSH_URL` when configured.

## Commands

```bash
# Create an encrypted database backup now
pnpm backup:run

# Execute an end-to-end restore drill into a throw-away database
scripts/restore-drill.sh

# Execute a restore drill pulling the encrypted archive from off-site S3/R2/B2
scripts/restore-drill.sh --from-offsite
```
