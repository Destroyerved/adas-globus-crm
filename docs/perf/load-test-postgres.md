# Concurrent HTTP Load Test Report (2026-11-18)

- **Database engine:** PostgreSQL 17.11
- **Dataset scale:** 20,005 companies, 60,005 contacts, 12,004 leads, 2,504 deals, 6,003 tasks, 300,000 activities
- **Concurrency:** 20 concurrent virtual users (Admin, Sales Manager, Account Executive, BDR sessions)
- **Measured window:** 30.3 s (+ 2.0 s warm-up)
- **Total HTTP requests:** 4,973 (164.4 req/s)
- **Error rate:** 0.000% (0 errors; budget < 0.500%)
- **API Node process CPU (normalized across 8 logical threads):** 10.5% (budget < 80%)
- **Peak API RSS memory:** 238.8 MB (container limit 1,024 MB)

**Result:** PASS — All PRD 12.2 p95 latency and error-rate budgets met under 20-VU concurrent load.

## Latency Distribution vs PRD 12.2 Budgets

| Operation                                            | Requests | Errors |      p50 |          p95 |      p99 |      Max | PRD 12.2 p95 Budget | Status |
| ---------------------------------------------------- | -------: | -----: | -------: | -----------: | -------: | -------: | ------------------: | ------ |
| List page API (filtered, sorted, 50 rows)            |    1,104 |      0 |  73.6 ms | **136.9 ms** | 187.6 ms | 261.9 ms |              400 ms | PASS   |
| Global search (trigram + full-text + extended)       |    1,104 |      0 | 119.1 ms | **226.5 ms** | 297.8 ms | 410.3 ms |              300 ms | PASS   |
| Record profile API (company / contact / lead / deal) |    1,104 |      0 |  70.6 ms | **141.8 ms** | 197.7 ms | 256.0 ms |              500 ms | PASS   |
| Kanban board API (open deals + totals)               |      557 |      0 |  97.1 ms | **165.2 ms** | 224.6 ms | 256.9 ms |            1,500 ms | PASS   |
| Dashboard widget API                                 |    1,104 |      0 | 111.7 ms | **299.4 ms** | 368.3 ms | 448.1 ms |              800 ms | PASS   |

## Reproducing

```bash
pnpm db:seed --size=large
pnpm perf:load
# Or with k6 CLI for a 15-minute soak:
k6 run -e BASE_URL=http://127.0.0.1:3000 -e API_TOKEN=<token> infra/k6/crm-load.js
```
