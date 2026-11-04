import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '..');
const sourcePath = path.join(repoRoot, 'infra', 'deployer', 'AdasCrmDeployer.cs');
const outDir = path.join(repoRoot, 'dist', 'deployer');
const outExe = path.join(outDir, 'ADAS-CRM-Deployer.exe');
const rootExe = path.join(repoRoot, 'ADAS-CRM-Deployer.exe');

mkdirSync(outDir, { recursive: true });

const cscCandidates = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const cscPath = cscCandidates.find((candidate) => existsSync(candidate));

if (!cscPath) {
  console.error('Windows C# compiler (csc.exe) not found.');
  process.exit(1);
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

copyFileSync(outExe, rootExe);
console.log(`Built standalone one-click deployer executable: ${rootExe} and ${outExe}`);
