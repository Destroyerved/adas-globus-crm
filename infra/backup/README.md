# Off-site Backups (PRD §10.5)

Continuous WAL archiving (WAL-G / pgBackRest), nightly `pg_dump -Fc`, and restic volume snapshots are implemented in **Phase 1**.
Restore drills run via `scripts/restore-drill.sh`.
