import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');
const sourcePath = path.join(repoRoot, 'infra', 'deployer', 'AdasCrmDeployer.cs');
const outDir = path.join(repoRoot, 'dist', 'deployer');
const outExe = path.join(outDir, 'ADAS-CRM-Deployer.exe');

mkdirSync(outDir, { recursive: true });

if (process.platform !== 'win32') {
  console.log(
    '[deployer] Non-Windows host detected; skipping Windows .exe compilation (Linux servers use installer/install.sh).',
  );
  process.exit(0);
}

const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const cscPath = cscCandidates.find((candidate) => existsSync(candidate));

if (!cscPath) {
  console.warn('[deployer] Windows C# compiler (csc.exe) not found; skipping .exe build.');
  process.exit(0);
}

execFileSync(
  cscPath,
  [
    '/nologo',
    '/optimize+',
    '/target:exe',
    `/out:${outExe}`,
    '/r:System.Windows.Forms.dll',
    '/r:System.Drawing.dll',
    sourcePath,
  ],
  { stdio: 'inherit' },
);

console.log(`[deployer] Built standalone Windows deployer executable -> ${outExe}`);
