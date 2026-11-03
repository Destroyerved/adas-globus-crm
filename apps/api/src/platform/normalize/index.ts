/**
 * Email and domain normalisation with free-mail blocklist (PRD §4.3, §4.4, §7.1; AGENTS.md §7).
 */

export const FREE_MAIL_DOMAINS = new Set<string>([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.ca',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'zoho.com',
  'gmx.com',
  'mail.com',
]);

export function normalizeEmail(rawEmail: string): string {
  return rawEmail.trim().toLowerCase();
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export function normalizeCompanyDomain(rawInput: string): string | null {
  const trimmed = rawInput.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }
  const withoutAt = trimmed.includes('@') ? (trimmed.split('@')[1] ?? '') : trimmed;
  const withoutScheme = withoutAt.replace(/^[a-z]+:\/\//, '');
  const hostOnly = (withoutScheme.split('/')[0] ?? '').split(':')[0] ?? '';
  const withoutWww = hostOnly.replace(/^www\./, '');

  if (!withoutWww || !withoutWww.includes('.')) {
    return null;
  }
  if (isFreeMailDomain(withoutWww)) {
    return null;
  }
  return withoutWww;
}
