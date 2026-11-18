/**
 * PII and Secret Redaction for Server Agent Logs & Diagnostics (`AGENTS.md §5`, `PRD 9`).
 *
 * Ensures container logs, diagnostic bundles, and error strings never leak:
 * - Email addresses
 * - PostgreSQL connection passwords
 * - Bearer / PAT / session / encryption / backup tokens
 * - Environment variable secret assignments
 */

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PG_URL_PASSWORD_PATTERN = /(postgresql:\/\/[^:\s]+:)([^@\s]+)(@)/gi;
const BEARER_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const PREFIXED_SECRET_PATTERN =
  /\b(adas_pat_|pgadm_|pgapp_|sess_|tkey_|bkey_|pair_|agtsec_)[A-Za-z0-9_-]+/g;
const ENV_SECRET_ASSIGN_PATTERN =
  /\b([A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*)=([^\s"']+)/gi;

export function redactSensitiveText(input: string): string {
  return input
    .replace(PG_URL_PASSWORD_PATTERN, '$1[REDACTED]$3')
    .replace(BEARER_PATTERN, '$1[REDACTED]')
    .replace(PREFIXED_SECRET_PATTERN, '$1[REDACTED]')
    .replace(ENV_SECRET_ASSIGN_PATTERN, '$1=[REDACTED]')
    .replace(EMAIL_PATTERN, '[REDACTED_EMAIL]');
}
