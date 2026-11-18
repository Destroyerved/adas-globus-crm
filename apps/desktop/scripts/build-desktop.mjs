import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptsDir, '..');
const repoRoot = path.resolve(desktopDir, '..', '..');

const distPreloadDir = path.join(desktopDir, 'dist', 'preload');
const distRendererDir = path.join(desktopDir, 'dist', 'renderer');
const distFontsDir = path.join(distRendererDir, 'fonts');

mkdirSync(distPreloadDir, { recursive: true });
mkdirSync(distRendererDir, { recursive: true });
mkdirSync(distFontsDir, { recursive: true });

// 1. Compile Main Process & Shared IPC TypeScript
const tscBin = path.join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
);
execFileSync(tscBin, ['-p', path.join(desktopDir, 'tsconfig.build.json')], {
  cwd: desktopDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

// 2. Copy sandboxed CommonJS preload bridge
copyFileSync(
  path.join(desktopDir, 'src', 'preload', 'index.cjs'),
  path.join(distPreloadDir, 'index.cjs'),
);

// 3. Bundle Renderer TypeScript -> dist/renderer/app.js
await build({
  entryPoints: [path.join(desktopDir, 'src', 'renderer', 'app.ts')],
  outfile: path.join(distRendererDir, 'app.js'),
  bundle: true,
  format: 'iife',
  target: ['chrome130'],
  sourcemap: false,
});

// 4. Copy HTML, DESIGN.md tokens.css, styles.css, and self-hosted Hanken Grotesk fonts
copyFileSync(
  path.join(desktopDir, 'src', 'renderer', 'index.html'),
  path.join(distRendererDir, 'index.html'),
);
copyFileSync(
  path.join(desktopDir, 'src', 'renderer', 'styles.css'),
  path.join(distRendererDir, 'styles.css'),
);
copyFileSync(
  path.join(repoRoot, 'apps', 'web', 'src', 'styles', 'tokens.css'),
  path.join(distRendererDir, 'tokens.css'),
);

const webFontsDir = path.join(repoRoot, 'apps', 'web', 'public', 'fonts');
if (existsSync(webFontsDir)) {
  cpSync(webFontsDir, distFontsDir, { recursive: true });
}

console.log('[desktop] Built @adas/desktop (main + preload + renderer) -> apps/desktop/dist');
