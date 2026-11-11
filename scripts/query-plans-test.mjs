// Checks query plans at full size on the test database, in any shell (ADR 0011):
// loads the large seed into the throw-away test database, explains the screens' queries and
// writes docs/perf/query-plans-pglite.md. On a real server use `pnpm db:plans` instead.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--project', 'integration', 'm2-query-plans'],
  { stdio: 'inherit', shell: true, env: { ...process.env, QUERY_PLANS: 'large' } },
);
process.exit(result.status ?? 1);
