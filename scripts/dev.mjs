import { spawn, spawnSync } from 'node:child_process';

console.log('[adas-crm] Starting local development stack...');

const dockerCheck = spawnSync('docker', ['compose', '-f', 'infra/compose.dev.yml', 'up', '-d'], {
  stdio: 'inherit',
  shell: true,
});

if (dockerCheck.status !== 0) {
  console.warn(
    '[adas-crm] Warning: Docker Compose could not start PostgreSQL/Mailpit. Continuing with API + Web dev servers.',
  );
}

const children = [];

function startProcess(name, args) {
  const proc = spawn('pnpm', args, {
    stdio: 'inherit',
    shell: true,
  });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[adas-crm] ${name} exited with code ${code}`);
    }
  });
  children.push(proc);
}

startProcess('api', ['--filter', '@adas/api', 'dev']);
startProcess('web', ['--filter', '@adas/web', 'dev']);

function shutdown() {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
