import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesktopIpcController } from './main/ipc-controller.js';
import { ServerProfileVault } from './main/profile-vault.js';

/**
 * Loopback-only (`127.0.0.1`) Preview Server for Visual QA & Playwright Accessibility Verification
 * of the Electron Desktop Server Management Console UI (`@adas/desktop`).
 */

const MIME_BY_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
};

export interface DesktopPreviewHandle {
  server: Server;
  url: string;
  port: number;
  controller: DesktopIpcController;
  close: () => Promise<void>;
}

export async function startDesktopPreviewServer(
  options: {
    port?: number;
    repoRoot?: string;
    vaultDir?: string;
  } = {},
): Promise<DesktopPreviewHandle> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const desktopRoot = path.resolve(here, '..');
  const rendererDir = path.join(desktopRoot, 'dist', 'renderer');
  const repoRoot = path.resolve(options.repoRoot ?? path.join(desktopRoot, '..', '..'));

  let createdTempVault: string | null = null;
  const vaultDir =
    options.vaultDir ??
    (() => {
      createdTempVault = mkdtempSync(path.join(os.tmpdir(), 'adas-desktop-preview-vault-'));
      return createdTempVault;
    })();

  const vault = new ServerProfileVault(vaultDir);
  const controller = new DesktopIpcController({
    vault,
    defaultRepoRoot: repoRoot,
  });

  const server = createServer(async (req, res) => {
    try {
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && reqUrl.pathname === '/__ipc') {
        const chunks: Buffer[] = [];
        for await (const c of req) {
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
        }
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          channel: string;
          payload: unknown;
        };
        const data = await controller.invokeChannel(parsed.channel, parsed.payload);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data }));
        return;
      }

      const relPath = reqUrl.pathname === '/' ? 'index.html' : reqUrl.pathname.replace(/^\/+/, '');
      const fullPath = path.resolve(rendererDir, relPath);
      if (!fullPath.startsWith(rendererDir) || !existsSync(fullPath)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(fullPath);
      res.writeHead(200, {
        'Content-Type': MIME_BY_EXT[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(readFileSync(fullPath));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'Preview IPC error',
        }),
      );
    }
  });

  let boundPort = options.port ?? 0;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 5185, '127.0.0.1', () => {
      boundPort = (server.address() as AddressInfo).port;
      resolve();
    });
  });

  return {
    server,
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    controller,
    close: async () => {
      await controller.close();
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      if (createdTempVault) {
        rmSync(createdTempVault, { recursive: true, force: true });
      }
    },
  };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const current = path.resolve(fileURLToPath(import.meta.url));
if (invoked === current) {
  startDesktopPreviewServer({ port: 5185 }).then((handle) => {
    process.stdout.write(`[adas-desktop-preview] Listening on ${handle.url}\n`);
    const stop = () => void handle.close().finally(() => process.exit(0));
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
