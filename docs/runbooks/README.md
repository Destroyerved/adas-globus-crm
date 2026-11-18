# Operations & Deployment Runbooks Index

All production engineering, deployment, security, integration, and recovery runbooks live in `docs/`:

- [`docs/PRODUCTION_READINESS_REPORT.md`](../PRODUCTION_READINESS_REPORT.md) — Architecture inventory, `A1–A21` acceptance matrix, 20-VU load & 10k XLSX benchmarks, and Owner Go-Live Checklist
- [`docs/INSTALLATION.md`](../INSTALLATION.md) — One-Click Production Server Installer (`installer/install.sh`, `@adas/installer` wizard & CLI, and `ADAS-CRM-Deployer.exe`)
- [`docs/DEPLOYMENT.md`](../DEPLOYMENT.md) — 16 GB Ubuntu Server LTS setup, Cloudflare Tunnel & Access, `scripts/deploy.sh`, and automatic rollback
- [`docs/DISASTER_RECOVERY.md`](../DISASTER_RECOVERY.md) — `ADASBK01` AES-256-GCM backups, S3 Signature v4 off-site sync, monthly `scripts/restore-drill.sh`, and bare-metal recovery
- [`docs/ELECTRON_MANAGEMENT.md`](../ELECTRON_MANAGEMENT.md) — Standalone Electron Desktop Server Management Console (`@adas/desktop`) & Authenticated Server Agent (`@adas/server-agent`)
- [`docs/SECURITY.md`](../SECURITY.md) — Host isolation, Entra OIDC + Break-Glass TOTP, `scopeWhere` SQL isolation, `SecretBox`, least-privilege DB roles, and penetration test suites
- [`docs/INTEGRATIONS.md`](../INTEGRATIONS.md) — Microsoft Entra, Microsoft 365 Graph Inbox, ESP campaigns, Apollo REST v1, Microsoft Bookings, Outbound Webhooks, n8n & Website Intake
- [`docs/OPERATIONS.md`](../OPERATIONS.md) — Day-2 monitoring, dead-letter triage, employee offboarding, `SecretBox` key rotation, privacy erasure, and 10-step Bigin CRM cutover
