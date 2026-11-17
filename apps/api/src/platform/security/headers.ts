import { randomUUID } from 'node:crypto';
import { type IncomingMessage, type ServerResponse } from 'node:http';

export interface SecurityHeaderOptions {
  production: boolean;
  kind?: 'api' | 'spa' | 'public_html' | 'docs_html';
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

const SPA_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PUBLIC_HTML_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "font-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Resolves a safe correlation request ID from `X-Request-Id` or generates a fresh UUID (PRD §10.6).
 */
export function resolveRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-request-id'];
  if (typeof incoming === 'string' && /^[a-zA-Z0-9._-]{8,100}$/.test(incoming.trim())) {
    return incoming.trim();
  }
  return `req_${randomUUID()}`;
}

/**
 * Applies strict defence-in-depth HTTP response headers across API, SPA, and public HTML pages (PRD §9).
 */
export function applySecurityHeaders(res: ServerResponse, options: SecurityHeaderOptions): void {
  const kind = options.kind ?? 'api';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Referrer-Policy',
    kind === 'public_html' ? 'no-referrer' : 'strict-origin-when-cross-origin',
  );
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');

  if (kind === 'spa' || kind === 'docs_html') {
    res.setHeader('Content-Security-Policy', SPA_CSP);
  } else if (kind === 'public_html') {
    res.setHeader('Content-Security-Policy', PUBLIC_HTML_CSP);
  } else {
    res.setHeader('Content-Security-Policy', API_CSP);
  }

  if (options.production) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}
