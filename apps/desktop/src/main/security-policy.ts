import type { WebPreferences } from 'electron';

/**
 * Hardened Electron Security Policy (`Milestone 12`, `PRD 9`).
 *
 * Enforces:
 * - `contextIsolation: true`
 * - `nodeIntegration: false` (including workers & subframes)
 * - `sandbox: true`
 * - `webSecurity: true`
 * - `connect-src 'none'` so all server communication occurs exclusively in the Main Process
 *   over typed, `zod`-validated IPC channels.
 */

export const DESKTOP_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ');

export function createHardenedWebPreferences(preloadPath: string): WebPreferences {
  return {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
  };
}

export function isAllowedNavigationUrl(targetUrl: string, allowedEntryUrl: string): boolean {
  try {
    const parsedTarget = new URL(targetUrl);
    const parsedAllowed = new URL(allowedEntryUrl);
    if (parsedTarget.protocol !== parsedAllowed.protocol) return false;
    if (parsedTarget.protocol === 'file:') {
      return parsedTarget.pathname === parsedAllowed.pathname;
    }
    return (
      parsedTarget.origin === parsedAllowed.origin &&
      parsedTarget.pathname === parsedAllowed.pathname
    );
  } catch {
    return false;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1';
}

export function validateAgentBaseUrl(
  rawUrl: string,
  options: { allowInsecureRemoteHttp?: boolean } = {},
): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Agent URL must use https:// (or http:// strictly for loopback 127.0.0.1).');
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    if (!options.allowInsecureRemoteHttp) {
      throw new Error(
        'Plaintext http:// is forbidden for remote servers. Expose the remote agent over HTTPS (Cloudflare Access / TLS) or SSH loopback forwarding.',
      );
    }
  }
  if (parsed.username || parsed.password) {
    throw new Error('Agent URL must not embed credentials.');
  }
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}
