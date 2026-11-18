#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AgentAuditLogger } from './audit-log.js';
import { AgentCredentialStore } from './crypto-auth.js';
import { startServerAgent } from './server.js';

/**
 * `@adas/server-agent` CLI (`serve`, `pair`, `clients`, `revoke`, `verify-audit`).
 */

function resolveDefaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..');
}

function parseFlags(args: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] ?? '';
    if (!token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    if (eq > 2) {
      flags.set(token.slice(2, eq), token.slice(eq + 1));
      continue;
    }
    const key = token.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

function readStringFlag(flags: Map<string, string | boolean>, key: string, fallback = ''): string {
  const val = flags.get(key);
  return typeof val === 'string' ? val : fallback;
}

export async function runServerAgentCli(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'serve';
  const flags = parseFlags(argv.slice(1));
  const repoRoot = path.resolve(
    readStringFlag(flags, 'repo-root', process.env['ADAS_REPO_ROOT'] ?? resolveDefaultRepoRoot()),
  );
  const dataDir = path.resolve(
    readStringFlag(
      flags,
      'data-dir',
      process.env['ADAS_AGENT_DATA_DIR'] ?? path.join(repoRoot, 'data', 'server-agent'),
    ),
  );

  if (command === 'pair') {
    const role = z
      .enum(['viewer', 'operator', 'admin'])
      .parse(readStringFlag(flags, 'role', 'admin'));
    const label = readStringFlag(flags, 'label', 'ADAS Desktop Console');
    const ttl = Number.parseInt(readStringFlag(flags, 'ttl', '300'), 10);
    const store = new AgentCredentialStore(dataDir);
    const invite = store.issuePairingInvite({
      role,
      label,
      ttlSeconds: Number.isFinite(ttl) ? ttl : 300,
    });
    process.stdout.write(`${JSON.stringify(invite, null, 2)}\n`);
    return 0;
  }

  if (command === 'clients') {
    const store = new AgentCredentialStore(dataDir);
    process.stdout.write(`${JSON.stringify(store.listClients(), null, 2)}\n`);
    return 0;
  }

  if (command === 'revoke') {
    const keyId = argv[1] ?? readStringFlag(flags, 'key-id', '');
    if (!keyId) {
      process.stderr.write('Usage: adas-agent revoke <agt_keyId>\n');
      return 1;
    }
    const store = new AgentCredentialStore(dataDir);
    const ok = store.revokeClient(keyId);
    process.stdout.write(`${JSON.stringify({ keyId, revoked: ok })}\n`);
    return ok ? 0 : 1;
  }

  if (command === 'verify-audit') {
    const audit = new AgentAuditLogger(dataDir);
    const check = audit.verifyChainIntegrity();
    process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
    return check.valid ? 0 : 1;
  }

  if (command === 'serve') {
    const host = readStringFlag(flags, 'host', process.env['ADAS_AGENT_HOST'] ?? '127.0.0.1');
    const port = Number.parseInt(
      readStringFlag(flags, 'port', process.env['ADAS_AGENT_PORT'] ?? '3090'),
      10,
    );
    const handle = await startServerAgent({
      repoRoot,
      dataDir,
      host,
      port: Number.isFinite(port) ? port : 3090,
    });
    process.stdout.write(`[adas-server-agent] Listening on ${handle.url} (repoRoot=${repoRoot})\n`);
    const shutdown = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return 0;
  }

  process.stderr.write(
    `Unknown command "${command}". Valid commands: serve, pair, clients, revoke, verify-audit.\n`,
  );
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentPath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === currentPath) {
  runServerAgentCli(process.argv.slice(2))
    .then((code) => {
      if ((process.argv[2] ?? 'serve') !== 'serve') {
        process.exit(code);
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[adas-server-agent] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
