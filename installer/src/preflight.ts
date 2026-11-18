import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

/**
 * Hardware, OS, Disk, Port, and Docker Runtime Preflight Verifier (`PRD 10.1, 10.2, 10.8`).
 */

export type PreflightStatus = 'pass' | 'warn' | 'fail';

export interface PreflightCheckItem {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  remediation?: string;
}

export interface ExistingInstallState {
  hasEnvProduction: boolean;
  hasDeployState: boolean;
  currentTag: string | null;
  presentSecrets: string[];
}

export interface PreflightReport {
  checkedAt: string;
  readyForProductionDeploy: boolean;
  readyForProvisionOnly: boolean;
  system: {
    platform: NodeJS.Platform;
    release: string;
    arch: string;
    cpuCount: number;
    totalMemoryGb: number;
    freeMemoryGb: number;
    freeDiskGb: number | null;
    dockerVersion: string | null;
    composeVersion: string | null;
  };
  existingInstall: ExistingInstallState;
  checks: PreflightCheckItem[];
}

export interface CommandProbe {
  (cmd: string, args: string[]): { status: number | null; stdout: string; stderr: string };
}

const defaultCommandProbe: CommandProbe = (cmd, args) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8_000 });
  return {
    status: res.status,
    stdout: (res.stdout ?? '').trim(),
    stderr: (res.stderr ?? '').trim(),
  };
};

export async function checkLoopbackPortAvailable(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => {
      srv.close(() => resolve(true));
    });
    srv.listen(port, '127.0.0.1');
  });
}

function getFreeDiskGb(targetDir: string): number | null {
  try {
    const probeDir = existsSync(targetDir) ? targetDir : path.dirname(targetDir);
    const st = statfsSync(probeDir);
    const freeBytes = Number(st.bavail) * Number(st.bsize);
    return Math.round((freeBytes / 1024 ** 3) * 10) / 10;
  } catch {
    return null;
  }
}

export function detectExistingInstall(targetDir: string): ExistingInstallState {
  const envProdPath = path.join(targetDir, '.env.production');
  const statePath = path.join(targetDir, '.deploy-state');
  const secretsDir = path.join(targetDir, 'secrets');

  const expectedSecrets = [
    'postgres_admin_password.txt',
    'postgres_app_password.txt',
    'session_secret.txt',
    'token_encryption_key.txt',
    'backup_encryption_key.txt',
  ];
  const presentSecrets = expectedSecrets.filter((name) => existsSync(path.join(secretsDir, name)));

  let currentTag: string | null = null;
  if (existsSync(statePath)) {
    try {
      currentTag = readFileSync(statePath, 'utf8').trim() || null;
    } catch {
      currentTag = null;
    }
  }

  return {
    hasEnvProduction: existsSync(envProdPath),
    hasDeployState: existsSync(statePath),
    currentTag,
    presentSecrets,
  };
}

export async function runPreflightChecks(params: {
  targetDir: string;
  portsToCheck?: number[];
  probeCommand?: CommandProbe;
}): Promise<PreflightReport> {
  const probe = params.probeCommand ?? defaultCommandProbe;
  const ports = params.portsToCheck ?? [3000, 3001];
  const checks: PreflightCheckItem[] = [];

  const platform = process.platform;
  const release = os.release();
  const arch = process.arch;
  const cpuCount = os.cpus().length;
  const totalMemoryGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10;
  const freeMemoryGb = Math.round((os.freemem() / 1024 ** 3) * 10) / 10;
  const freeDiskGb = getFreeDiskGb(params.targetDir);
  const existingInstall = detectExistingInstall(params.targetDir);

  // 1. OS & Architecture
  if (platform === 'linux' && (arch === 'x64' || arch === 'arm64')) {
    checks.push({
      id: 'os',
      label: 'Operating system',
      status: 'pass',
      detail: `Linux (${release}, ${arch})`,
    });
  } else if (
    (platform === 'win32' || platform === 'darwin') &&
    (arch === 'x64' || arch === 'arm64')
  ) {
    checks.push({
      id: 'os',
      label: 'Operating system',
      status: 'warn',
      detail: `${platform} (${release}, ${arch}) — supported for provisioning, staging, or Docker Desktop; Ubuntu LTS recommended for dedicated office server.`,
    });
  } else {
    checks.push({
      id: 'os',
      label: 'Operating system',
      status: 'fail',
      detail: `Unsupported architecture ${platform}/${arch}`,
      remediation: 'Use a 64-bit Linux (Ubuntu Server LTS) or Windows/macOS x64/arm64 host.',
    });
  }

  // 2. CPU threads (>= 2 cores / 4 threads per PRD 10.1)
  if (cpuCount >= 4) {
    checks.push({
      id: 'cpu',
      label: 'CPU capacity',
      status: 'pass',
      detail: `${cpuCount} logical CPU threads available`,
    });
  } else if (cpuCount >= 2) {
    checks.push({
      id: 'cpu',
      label: 'CPU capacity',
      status: 'warn',
      detail: `${cpuCount} logical CPU threads (4+ threads recommended for concurrent workers)`,
    });
  } else {
    checks.push({
      id: 'cpu',
      label: 'CPU capacity',
      status: 'fail',
      detail: `Only ${cpuCount} CPU thread detected`,
      remediation: 'Provision a machine with at least 2 CPU cores.',
    });
  }

  // 3. System Memory (16 GB production profile per PRD 10.1–10.2)
  if (totalMemoryGb >= 15) {
    checks.push({
      id: 'memory',
      label: 'System memory (RAM)',
      status: 'pass',
      detail: `${totalMemoryGb} GB total (${freeMemoryGb} GB currently free) — fits 16 GB production profile`,
    });
  } else if (totalMemoryGb >= 4) {
    checks.push({
      id: 'memory',
      label: 'System memory (RAM)',
      status: 'warn',
      detail: `${totalMemoryGb} GB total — below 16 GB production server spec; suitable for staging or light workloads`,
      remediation:
        'Upgrade server RAM to 16 GB DDR4 before onboarding 40 employees + 60k contacts.',
    });
  } else {
    checks.push({
      id: 'memory',
      label: 'System memory (RAM)',
      status: 'fail',
      detail: `${totalMemoryGb} GB total RAM is insufficient for PostgreSQL + API + Worker`,
      remediation: 'Provide at least 8–16 GB RAM.',
    });
  }

  // 4. Free Disk Space (256 GB SSD target, >= 20 GB minimum free)
  if (freeDiskGb === null) {
    checks.push({
      id: 'disk',
      label: 'Disk free space',
      status: 'warn',
      detail: 'Could not read filesystem free space statistics',
    });
  } else if (freeDiskGb >= 20) {
    checks.push({
      id: 'disk',
      label: 'Disk free space',
      status: 'pass',
      detail: `${freeDiskGb} GB available on target volume`,
    });
  } else if (freeDiskGb >= 5) {
    checks.push({
      id: 'disk',
      label: 'Disk free space',
      status: 'warn',
      detail: `${freeDiskGb} GB available (< 20 GB recommended headroom for WAL & local encrypted backups)`,
      remediation: 'Free disk space or attach a larger SSD volume.',
    });
  } else {
    checks.push({
      id: 'disk',
      label: 'Disk free space',
      status: 'fail',
      detail: `Only ${freeDiskGb} GB free disk space remaining`,
      remediation: 'At least 20 GB of free SSD storage is required before installation.',
    });
  }

  // 5. Docker Engine & Docker Compose v2
  const dockerRes = probe('docker', ['info', '--format', '{{.ServerVersion}}']);
  const dockerVersion = dockerRes.status === 0 && dockerRes.stdout ? dockerRes.stdout : null;

  const composeRes = probe('docker', ['compose', 'version', '--short']);
  const composeVersion = composeRes.status === 0 && composeRes.stdout ? composeRes.stdout : null;

  if (dockerVersion && composeVersion) {
    checks.push({
      id: 'docker',
      label: 'Docker Engine & Compose v2',
      status: 'pass',
      detail: `Docker ${dockerVersion}, Compose ${composeVersion}`,
    });
  } else {
    checks.push({
      id: 'docker',
      label: 'Docker Engine & Compose v2',
      status: 'fail',
      detail: 'Docker daemon or `docker compose` plugin is not running/installed',
      remediation:
        platform === 'linux'
          ? 'Run `sudo ./installer/install.sh --install-docker` on Ubuntu LTS or start `systemctl start docker`.'
          : 'Install and start Docker Desktop (with WSL 2 backend on Windows).',
    });
  }

  // 6. Loopback TCP ports
  for (const port of ports) {
    const free = await checkLoopbackPortAvailable(port);
    if (free) {
      checks.push({
        id: `port_${port}`,
        label: `Loopback port 127.0.0.1:${port}`,
        status: 'pass',
        detail: `Port ${port} is free`,
      });
    } else {
      checks.push({
        id: `port_${port}`,
        label: `Loopback port 127.0.0.1:${port}`,
        status: existingInstall.hasDeployState ? 'warn' : 'fail',
        detail: existingInstall.hasDeployState
          ? `Port ${port} is in use (existing ADAS CRM deployment detected: ${existingInstall.currentTag ?? 'active'})`
          : `Port ${port} is already bound by another local process`,
        remediation: `Stop the process listening on 127.0.0.1:${port} before starting ADAS CRM.`,
      });
    }
  }

  const nonDockerFail = checks.some(
    (c) => c.id !== 'docker' && !c.id.startsWith('port_') && c.status === 'fail',
  );
  const anyFail = checks.some((c) => c.status === 'fail');

  return {
    checkedAt: new Date().toISOString(),
    readyForProductionDeploy: !anyFail,
    readyForProvisionOnly: !nonDockerFail,
    system: {
      platform,
      release,
      arch,
      cpuCount,
      totalMemoryGb,
      freeMemoryGb,
      freeDiskGb,
      dockerVersion,
      composeVersion,
    },
    existingInstall,
    checks,
  };
}
