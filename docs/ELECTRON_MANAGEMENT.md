# Electron Desktop Server Management Console & Authenticated Server Agent

ADAS Globus CRM includes a standalone hardened Electron Desktop Console (`apps/desktop`) paired with a narrowly scoped Authenticated Server Management Agent (`apps/server-agent`) so SREs and Admins can monitor, deploy, back up, and manage local or remote CRM servers without routine SSH shell access (`ADR 0027`).

---

## 1. Security Architecture

### Server Agent (`@adas/server-agent`)

- **Zero arbitrary shell execution:** Never invokes `sh -c`, `cmd /c`, or user-supplied commands. Every endpoint validates inputs via `zod` against fixed allowlists (`postgres`, `api`, `worker`, `backup`, `uptime-kuma`, `cloudflared`, `n8n`).
- **Single-use pairing codes:** `pnpm agent:pair` generates a 5-minute single-use `pair_<48 hex>` code, storing only `SHA-256(code)` on disk (`data/server-agent/agent-auth.json`, mode `0600`). Pairing attempts are rate-limited to `5` per 10 minutes per IP.
- **HMAC-SHA256 request signing & replay defense:** Every authenticated request signs `${timestamp}.${nonce}.${method}.${pathWithQuery}.${sha256(body)}` using the paired 256-bit `sharedSecret` (encrypted at rest via AES-256-GCM), verified within a `±300s` window + nonce replay cache.
- **Role-Based Access Control (RBAC):**
  - `viewer`: Read telemetry, container status, redacted logs, backup inventory, masked config, and audit log.
  - `operator`: `viewer` + start/stop/restart containers, run manual encrypted backups, run restore drills, and export redacted diagnostic bundles.
  - `admin`: `operator` + deploy releases, rollback releases, run SQL migrations, execute confirmed database restores (`"RESTORE DATABASE <fileName>"`), update allowlisted `.env.production` keys / rotate secrets, and revoke paired desktop clients.
- **Tamper-evident audit trail (`agent-audit.jsonl`):** Every action and denied request is recorded in a SHA-256 hash chain (`prevHash` -> `entryHash`) verified live on the **Security & audit** tab.

### Electron Desktop Console (`@adas/desktop`)

- **Process isolation:** `BrowserWindow` runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, popup/navigation blocking, and `Content-Security-Policy: ... connect-src 'none'`.
- **Main-process secret confinement:** Paired `sharedSecret` and Cloudflare Access Service Tokens are stored in `ServerProfileVault` (encrypted with AES-256-GCM + OS Keychain `safeStorage`) and used strictly inside Electron's Main Process (`AgentRpcClient`). Secrets never enter Chromium Renderer memory.
- **Transport enforcement:** Non-loopback remote server URLs must use `https://` (plaintext `http://` to remote hosts is rejected).

---

## 2. Installing & Running the Server Agent on Ubuntu LTS

1. Build `@adas/server-agent`:
   ```bash
   pnpm --filter @adas/server-agent build
   ```
2. Install and enable the hardened `systemd` service (`127.0.0.1:3090`):
   ```bash
   sudo cp /opt/adas-crm/infra/systemd/adas-server-agent.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now adas-server-agent
   ```
3. _(Optional for remote desktop management)_ Expose `http://127.0.0.1:3090` on a dedicated Cloudflare Tunnel hostname (e.g. `https://ops-agent.adasglobuspro.com`) protected by a **Cloudflare Access Service Auth policy** (`Service Token`).

---

## 3. Pairing & Operating the Electron Desktop Console

1. **Start the Desktop Console on an operator workstation:**
   ```bash
   pnpm desktop:start
   ```
2. **Connect to a local server (1 click):**
   - Click **Connect local server** in the left navy sidebar. The console automatically starts or attaches to a loopback `@adas/server-agent` instance and pairs with an ephemeral admin invite.
3. **Pair a remote production server:**
   - On the server, issue a single-use 5-minute pairing code:
     ```bash
     pnpm --dir /opt/adas-crm agent:pair -- --role admin --label "Ops Workstation"
     ```
   - In the Desktop Console, click **Pair remote server**, enter `https://ops-agent.adasglobuspro.com`, the `pair_...` code, and optional Cloudflare Access Service Token (`Client ID` + `Client Secret`).
4. **Revoking a lost or retired laptop:**
   - Open **Security & audit** -> **Paired desktop consoles** -> click **Revoke** next to the device's `agt_...` Key ID (or run `node apps/server-agent/dist/cli.js revoke <agt_keyId>` on the server).
