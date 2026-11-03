/**
 * Email, domain, and phone normalisation with free-mail blocklist (PRD §4.3, §4.4, §7.1; AGENTS.md §7).
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

export function normalizeEmail(rawEmail: string): string | null {
  const cleaned = rawEmail.trim().toLowerCase();
  if (!cleaned || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

export function isFreeMailDomain(domain: string): boolean {
  return FREE_MAIL_DOMAINS.has(domain.trim().toLowerCase());
}

export function normalizeDomain(rawInput: string): string | null {
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
  return withoutWww;
}

export function normalizeCompanyDomain(rawInput: string): string | null {
  const domain = normalizeDomain(rawInput);
  if (!domain || isFreeMailDomain(domain)) {
    return null;
  }
  return domain;
}

export function extractDomainFromEmail(rawEmail: string): string | null {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    return null;
  }
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) {
    return null;
  }
  return normalizeDomain(email.slice(atIndex + 1));
}

export function normalizePhone(rawPhone: string, defaultRegion: 'US' | 'CA' = 'US'): string | null {
  const digits = rawPhone.replace(/\D/g, '');
  if (!digits) {
    return null;
  }
  if (digits.length === 10 && (defaultRegion === 'US' || defaultRegion === 'CA')) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  if (digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`;
  }
  return null;
}
