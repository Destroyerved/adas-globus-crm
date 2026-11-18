# ADR 0027: Authenticated Server Management Agent (`@adas/server-agent`) & Standalone Electron Desktop Console (`@adas/desktop`)

- **Date:** 2026-11-18
- **Status:** Accepted
- **References:** PRD §9, §10.1–10.8, ADR 0025, ADR 0026

## Context

Operating ADAS Globus CRM on a dedicated office Ubuntu Server LTS host (and staging nodes) without requiring SSH terminal access for routine operations requires two tightly coupled components:

1. **Authenticated Local & Remote Server Management Agent (`apps/server-agent`):** A narrowly scoped management daemon exposing server telemetry, container controls, release deployment/rollback, redacted logs, encrypted backups/restore drills, and masked configuration—with **zero arbitrary shell execution**.
2. **Standalone Electron Desktop Server Management Console (`apps/desktop`):** A hardened desktop application for SREs/Admins to pair with local or remote servers and operate them safely.

## Decisions

1. **Zero Arbitrary Shell Execution & Allowlisted Operations (`@adas/server-agent`):**
   - `AgentOperationsService` never invokes `sh -c` or accepts user-supplied commands. Every endpoint validates inputs against fixed `zod` enums (`ALLOWLISTED_SERVICES`, `ALLOWLISTED_ACTIONS`, `ALLOWLISTED_CONFIG_KEYS`, `ALLOWLISTED_SECRET_FILES`).
   - `MAIL_LIVE` is intentionally excluded from remote `PUT /agent/v1/config` edits so live outbound mail can only be enabled directly by the owner on the production host (`AGENTS.md §5`).
   - `POST /agent/v1/backups/restore` requires both `admin` role and the exact confirmation phrase `"RESTORE DATABASE <fileName>"`.

2. **Single-Use Pairing, AES-256-GCM Credential Vaults & Signed HMAC-SHA256 Requests:**
   - Operators generate a 5-minute single-use pairing code (`adas-agent pair --role <viewer|operator|admin>`). Only `SHA-256(pairingCode)` is persisted in `agent-auth.json`; `POST /agent/v1/pair` is rate-limited to `5` attempts per 10 minutes per IP.
   - Paired client secrets (`agtsec_...`) are encrypted at rest with AES-256-GCM on both the server (`AgentCredentialStore`) and desktop (`ServerProfileVault`, optionally wrapped by OS keychain `safeStorage`).
   - Every authenticated request signs `${timestamp}.${nonce}.${method}.${pathWithQuery}.${sha256(body)}` using `HMAC-SHA256`, enforced within a `±300s` replay window plus a bounded nonce replay cache.

3. **Tamper-Evident Audit Chain & PII/Secret Redaction:**
   - Every administrative action and denied attempt is appended to `agent-audit.jsonl` with `prevHash` and `entryHash = SHA-256(prevHash + canonicalPayload)`.
   - `redactSensitiveText()` strips email addresses, PostgreSQL URL passwords, `Bearer`/`adas_pat_` tokens, and secret assignments from container logs and diagnostic bundles.

4. **Hardened Electron Process Isolation (`@adas/desktop`):**
   - `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, navigation/popup blocking, and `Content-Security-Policy: ... connect-src 'none'`.
   - All network communication and HMAC signing occur inside the Electron Main Process (`AgentRpcClient`) behind `zod`-validated `ipcMain.handle` channels; paired secrets never cross into Chromium Renderer memory, and non-loopback `http://` agent URLs are rejected.
