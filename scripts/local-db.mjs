// A separate PostgreSQL for development (README; ADR 0012). For a machine with PostgreSQL
// installed but no way in: the installed server's "postgres" password is unknown and Docker
// isn't available. It uses the installed programs with its own data folder, logins and port,
// needs no administrator rights and leaves the installed server alone.
//
//   pnpm db:local init     create it (once), start it, create the CRM's roles and databases
//   pnpm db:local start    start it, for example after a restart (pnpm dev does this too)
//   pnpm db:local stop
//   pnpm db:local reset    delete the two CRM development databases and create them empty
//   pnpm db:local status
//
// It listens on localhost:5433 only. Development data only: never put real data in it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 5433;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Outside the repository: a database must not live in a folder that a sync tool copies.
const base = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), '.local', 'share'),
  'adas-crm',
);
const dataDir = path.join(base, 'pg-dev');
const passwordFile = path.join(base, 'pg-dev-superuser-password.txt');
const logFile = path.join(base, 'pg-dev.log');
const exe = process.platform === 'win32' ? '.exe' : '';

/** The folder holding initdb, pg_ctl and psql: PG_BIN, the newest Windows install, or PATH. */
function findBin() {
  if (process.env.PG_BIN) return process.env.PG_BIN;
  if (process.platform === 'win32') {
    const root = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PostgreSQL');
    if (existsSync(root)) {
      const versions = readdirSync(root)
        .filter(
          (name) => /^\d+$/.test(name) && existsSync(path.join(root, name, 'bin', 'initdb.exe')),
        )
        .sort((a, b) => Number(b) - Number(a));
      if (versions[0]) return path.join(root, versions[0], 'bin');
    }
  }
  return '';
}

const bin = findBin();
const tool = (name) => (bin ? path.join(bin, `${name}${exe}`) : name);

function run(name, args, options = {}) {
  return spawnSync(tool(name), args, { stdio: 'inherit', ...options });
}

const initialised = () => existsSync(path.join(dataDir, 'PG_VERSION'));
const running = () =>
  spawnSync(tool('pg_ctl'), ['-D', dataDir, 'status'], { stdio: 'ignore' }).status === 0;

function fail(message) {
  console.error(`[db:local] ${message}`);
  process.exit(1);
}

function start() {
  if (running()) {
    console.log(`[db:local] already running on localhost:${PORT}`);
    return;
  }
  // No inherited output: the server would otherwise keep the caller's terminal or pipe open
  // for as long as it runs. Its messages go to the log file.
  const started = run('pg_ctl', ['-D', dataDir, '-l', logFile, '-w', 'start'], {
    stdio: 'ignore',
  });
  if (started.status !== 0) fail(`could not start; see ${logFile}`);
  console.log(`[db:local] running on localhost:${PORT}`);
}

function init() {
  if (!initialised()) {
    mkdirSync(base, { recursive: true });
    // The new server's own superuser password: random, kept beside the data folder for the
    // person who owns this machine, never printed.
    writeFileSync(passwordFile, `${randomBytes(24).toString('base64url')}\n`, { mode: 0o600 });
    const created = run('initdb', [
      '-D',
      dataDir,
      '-U',
      'postgres',
      `--pwfile=${passwordFile}`,
      '--auth=scram-sha-256',
      '--encoding=UTF8',
      `--locale=${process.platform === 'win32' ? 'en-US' : 'en_US.UTF-8'}`,
    ]);
    if (created.status !== 0) {
      fail(
        'initdb failed. Is PostgreSQL installed? Set PG_BIN to its bin folder if it is elsewhere.',
      );
    }
    // Its own port, local connections only, and the planner settings production uses
    // (infra/postgres/postgresql.conf), so query plans here match production's (ADR 0011).
    appendFileSync(
      path.join(dataDir, 'postgresql.conf'),
      [
        '',
        '# ADAS CRM development server (scripts/local-db.mjs)',
        `port = ${PORT}`,
        "listen_addresses = 'localhost'",
        'random_page_cost = 1.1',
        'effective_cache_size = 8GB',
        'work_mem = 16MB',
        'log_min_duration_statement = 500ms',
        '',
      ].join('\n'),
    );
  }
  start();
  createRolesAndDatabases();
  console.log(
    [
      '[db:local] ready. In .env, point both database URLs at this server:',
      `[db:local]   DATABASE_URL and DATABASE_ADMIN_URL use localhost:${PORT} (see .env.example)`,
      `[db:local] data folder: ${dataDir}`,
      `[db:local] its superuser password is saved in: ${passwordFile}`,
    ].join('\n'),
  );
}

/** psql as this server's own superuser; the password goes to the child process only. */
function psql(args) {
  const password = readFileSync(passwordFile, 'utf8').trim();
  return run('psql', ['-U', 'postgres', '-h', 'localhost', '-p', String(PORT), ...args], {
    env: { ...process.env, PGPASSWORD: password },
  });
}

function createRolesAndDatabases() {
  const roles = psql([
    '-v',
    'ON_ERROR_STOP=1',
    '-q',
    '-f',
    path.join(repoRoot, 'infra', 'postgres', 'create-local-dev-db.sql'),
  ]);
  if (roles.status !== 0) fail('could not create the CRM roles and databases.');
}

/** Development data only: drops both CRM databases on this server and creates them empty. */
function reset() {
  if (!initialised()) fail('not set up yet. Run: pnpm db:local init');
  start();
  for (const database of ['adas_crm', 'adas_crm_test']) {
    const dropped = psql([
      '-v',
      'ON_ERROR_STOP=1',
      '-q',
      '-d',
      'postgres',
      '-c',
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
    ]);
    if (dropped.status !== 0) fail(`could not drop ${database}.`);
  }
  createRolesAndDatabases();
  console.log('[db:local] both databases are empty. Next: pnpm db:migrate, then pnpm db:seed');
}

const command = process.argv[2];
const ifPresent = process.argv.includes('--if-present');

if (command === 'init') {
  init();
} else if (command === 'start') {
  if (!initialised()) {
    if (ifPresent) process.exit(0);
    fail('not set up yet. Run: pnpm db:local init');
  }
  start();
} else if (command === 'stop') {
  if (initialised() && running()) run('pg_ctl', ['-D', dataDir, '-m', 'fast', 'stop']);
  console.log('[db:local] stopped');
} else if (command === 'reset') {
  reset();
} else if (command === 'status') {
  console.log(
    !initialised()
      ? '[db:local] not set up. Run: pnpm db:local init'
      : running()
        ? `[db:local] running on localhost:${PORT} (${dataDir})`
        : `[db:local] set up but not running. Run: pnpm db:local start`,
  );
} else {
  fail('use: pnpm db:local init | start | stop | status | reset');
}
