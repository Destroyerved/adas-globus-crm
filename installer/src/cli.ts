#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPreflightChecks } from './preflight.js';
import { InstallerService } from './provision.js';
import { startInstallerWizardServer } from './wizard-server.js';

/**
 * `@adas/installer` CLI Entrypoint.
 *
 * Commands:
 *   preflight [--target-dir <dir>] [--json]
 *   provision [--target-dir <dir>] [--domain <domain>] [--tunnel-name <name>] [--tunnel-token <tok>] [--enable-automation]
 *   install   [--target-dir <dir>] [--domain <domain>] [--tag <tag>] [--admin-email <email>] [--tunnel-name <name>] [--tunnel-token <tok>]
 *   upgrade   --tag <tag> [--target-dir <dir>] [--build]
 *   rollback  [--tag <tag>] [--target-dir <dir>]
 *   health    [--url <http://127.0.0.1:3000>]
 *   uninstall [--target-dir <dir>] [--purge-data --confirm "DELETE ALL CRM DATA"]
 *   wizard    [--target-dir <dir>] [--port <3088>]
 */

function resolveDefaultRepoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
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

export async function runInstallerCli(argv: string[]): Promise<number> {
  const command = argv[0] ?? 'preflight';
  const flags = parseFlags(argv.slice(1));
  const targetDir = path.resolve(readStringFlag(flags, 'target-dir', resolveDefaultRepoRoot()));
  const service = new InstallerService();

  if (command === 'preflight') {
    const report = await runPreflightChecks({ targetDir });
    if (flags.get('json') === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`ADAS CRM Preflight Report (${report.checkedAt})\n`);
      for (const check of report.checks) {
        process.stdout.write(
          `  [${check.status.toUpperCase().padEnd(4)}] ${check.label}: ${check.detail}\n`,
        );
        if (check.remediation) {
          process.stdout.write(`         Remediation: ${check.remediation}\n`);
        }
      }
      process.stdout.write(
        `\nReady for provision: ${report.readyForProvisionOnly ? 'YES' : 'NO'} | Ready for full deploy: ${report.readyForProductionDeploy ? 'YES' : 'NO'}\n`,
      );
    }
    return report.readyForProvisionOnly ? 0 : 1;
  }

  if (command === 'provision') {
    const result = service.provisionConfiguration({
      targetDir,
      domain: readStringFlag(flags, 'domain', 'adasglobuspro.com'),
      tunnelName: readStringFlag(flags, 'tunnel-name', 'adas-crm-prod-16gb'),
      tunnelToken: readStringFlag(flags, 'tunnel-token', ''),
      enableAutomationProfile: flags.get('enable-automation') === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === 'install') {
    const result = await service.installStack({
      config: {
        targetDir,
        domain: readStringFlag(flags, 'domain', 'adasglobuspro.com'),
        tunnelName: readStringFlag(flags, 'tunnel-name', 'adas-crm-prod-16gb'),
        tunnelToken: readStringFlag(flags, 'tunnel-token', ''),
        enableAutomationProfile: flags.get('enable-automation') === true,
      },
      imageTag: readStringFlag(flags, 'tag', 'v1.0.0'),
      adminEmail: readStringFlag(flags, 'admin-email', '') || undefined,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === 'upgrade') {
    const imageTag = readStringFlag(flags, 'tag', '');
    if (!imageTag) {
      process.stderr.write('Error: `upgrade` requires `--tag <version>`.\n');
      return 1;
    }
    const result = await service.upgradeStack({
      targetDir,
      imageTag,
      buildFromSource: flags.get('build') === true,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.rolledBack ? 1 : 0;
  }

  if (command === 'rollback') {
    const targetTag = readStringFlag(flags, 'tag', '') || undefined;
    const result = service.rollbackStack({ targetDir, targetTag });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === 'health') {
    const url = readStringFlag(flags, 'url', 'http://127.0.0.1:3000');
    const health = await service.checkStackHealth(url);
    process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
    return health.ok ? 0 : 1;
  }

  if (command === 'uninstall') {
    const purgeData = flags.get('purge-data') === true;
    const confirmationPhrase = readStringFlag(flags, 'confirm', '');
    const result = service.uninstallStack({
      targetDir,
      purgeData,
      confirmationPhrase,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  if (command === 'wizard') {
    const port = Number.parseInt(readStringFlag(flags, 'port', '3088'), 10);
    const handle = await startInstallerWizardServer({
      defaultTargetDir: targetDir,
      port: Number.isFinite(port) ? port : 3088,
    });
    process.stdout.write(
      `ADAS CRM Setup Wizard listening strictly on loopback: ${handle.url}\nPress Ctrl+C to close.\n`,
    );
    const shutdown = () => {
      void handle.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return 0;
  }

  process.stderr.write(
    `Unknown command "${command}". Valid commands: preflight, provision, install, upgrade, rollback, health, uninstall, wizard.\n`,
  );
  return 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentPath = path.resolve(fileURLToPath(import.meta.url));
if (invokedPath === currentPath) {
  runInstallerCli(process.argv.slice(2))
    .then((code) => {
      if (process.argv[2] !== 'wizard') {
        process.exit(code);
      }
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[adas-installer] Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
