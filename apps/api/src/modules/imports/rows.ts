import { type ImportEntity } from '@adas/shared';
import {
  extractDomainFromEmail,
  isFreeMailDomain,
  normalizeCompanyDomain,
  normalizeEmail,
  normalizePhone,
} from '../../platform/normalize/index.js';

/**
 * Turns one file row into checked values for a contact or company (PRD 4.9). Pure functions,
 * so the dry run and the real run read every row the same way.
 */

export type Market = 'US' | 'CA' | 'OTHER';

export interface ContactValues {
  email: string;
  firstName: string;
  lastName: string;
  title: string | null;
  phone: string | null;
  companyName: string | null;
  /** From the website column, else from a work email address. */
  companyDomain: string | null;
  market: Market;
}

export interface CompanyValues {
  name: string;
  domain: string | null;
  market: Market;
  stateProvince: string | null;
  city: string | null;
  staffBand: string | null;
  firmType: string | null;
}

export type RowRead<T> = { ok: true; values: T } | { ok: false; errors: string[] };

export interface ReferenceValues {
  staffBands: string[];
  firmTypes: string[];
}

/** Picks the mapped cells of one row: field key → trimmed cell text ('' when blank). */
export function mappedFields(
  columns: string[],
  row: string[],
  mapping: Record<string, string>,
): Record<string, string> {
  const fields: Record<string, string> = {};
  columns.forEach((column, i) => {
    const field = mapping[column];
    if (field) fields[field] = (row[i] ?? '').trim();
  });
  return fields;
}

const COUNTRY_NAMES: Record<string, Market> = {
  us: 'US',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  'united states': 'US',
  'united states of america': 'US',
  america: 'US',
  ca: 'CA',
  can: 'CA',
  canada: 'CA',
};

export function parseMarket(value: string | undefined, fallback: Market): Market {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return COUNTRY_NAMES[v] ?? 'OTHER';
}

const MAX_TEXT = 200;

function text(value: string | undefined): string | null {
  const v = (value ?? '').replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

function tooLong(errors: string[], label: string, value: string | null): void {
  if (value && value.length > MAX_TEXT) {
    errors.push(`${label} is longer than ${MAX_TEXT} characters.`);
  }
}

/** Splits "Jane Q. Doe" into first name "Jane" and last name "Q. Doe". */
export function splitFullName(full: string): { firstName: string; lastName: string } {
  const parts = full.replace(/\s+/g, ' ').trim().split(' ');
  return { firstName: parts[0] ?? '', lastName: parts.slice(1).join(' ') };
}

export function readContactRow(
  fields: Record<string, string>,
  defaultMarket: Market,
): RowRead<ContactValues> {
  const errors: string[] = [];
  const rawEmail = fields['email'] ?? '';
  const email = normalizeEmail(rawEmail);
  if (!rawEmail) errors.push('Email is blank.');
  else if (!email) errors.push('Email is not a valid address.');

  let firstName = text(fields['firstName']) ?? '';
  let lastName = text(fields['lastName']) ?? '';
  const fullName = text(fields['fullName']);
  if (!firstName && !lastName && fullName) ({ firstName, lastName } = splitFullName(fullName));
  if (!firstName && !lastName) errors.push('Name is blank.');
  tooLong(errors, 'First name', firstName);
  tooLong(errors, 'Last name', lastName);

  const market = parseMarket(fields['market'], defaultMarket);
  const rawPhone = text(fields['phone']);
  const phone = rawPhone ? normalizePhone(rawPhone, market === 'CA' ? 'CA' : 'US') : null;
  if (rawPhone && !phone) errors.push('Phone is not a valid number.');

  const title = text(fields['title']);
  tooLong(errors, 'Job title', title);
  const companyName = text(fields['companyName']);
  tooLong(errors, 'Company name', companyName);

  const rawWebsite = text(fields['companyWebsite']);
  let companyDomain = rawWebsite ? normalizeCompanyDomain(rawWebsite) : null;
  if (!companyDomain && email) {
    const fromEmail = extractDomainFromEmail(email);
    companyDomain = fromEmail && !isFreeMailDomain(fromEmail) ? fromEmail : null;
  }

  if (errors.length > 0 || !email) return { ok: false, errors };
  return {
    ok: true,
    values: { email, firstName, lastName, title, phone, companyName, companyDomain, market },
  };
}

function pick(value: string | null, allowed: string[], label: string, errors: string[]) {
  if (!value) return null;
  const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (!match) errors.push(`${label} must be one of: ${allowed.join(', ')}.`);
  return match ?? null;
}

export function readCompanyRow(
  fields: Record<string, string>,
  defaultMarket: Market,
  refs: ReferenceValues,
): RowRead<CompanyValues> {
  const errors: string[] = [];
  const name = text(fields['name']);
  if (!name) errors.push('Company name is blank.');
  tooLong(errors, 'Company name', name);

  const rawWebsite = text(fields['website']);
  const domain = rawWebsite ? normalizeCompanyDomain(rawWebsite) : null;
  if (rawWebsite && !domain) {
    errors.push('Website is not a company website (personal email domains are not allowed).');
  }
  const stateProvince = text(fields['stateProvince']);
  const city = text(fields['city']);
  tooLong(errors, 'State or province', stateProvince);
  tooLong(errors, 'City', city);
  const staffBand = pick(text(fields['staffBand']), refs.staffBands, 'Staff size', errors);
  const firmType = pick(text(fields['firmType']), refs.firmTypes, 'Firm type', errors);

  if (errors.length > 0 || !name) return { ok: false, errors };
  return {
    ok: true,
    values: {
      name,
      domain,
      market: parseMarket(fields['market'], defaultMarket),
      stateProvince,
      city,
      staffBand,
      firmType,
    },
  };
}

/** The key that makes two rows of one file the same record: email, else domain or name. */
export function fileKey(entity: ImportEntity, values: ContactValues | CompanyValues): string {
  if (entity === 'contact') return `e:${(values as ContactValues).email}`;
  const company = values as CompanyValues;
  return company.domain
    ? `d:${company.domain}`
    : `n:${company.market}:${company.name.toLowerCase()}`;
}

/** Spreadsheet apps run cells starting with these as formulas; prefix them so they stay text. */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The error file: the original columns plus an Error column (PRD 4.9). */
export function errorsCsv(columns: string[], rows: { raw: string[]; errors: string[] }[]): string {
  const lines = [[...columns, 'Error'].map(csvCell).join(',')];
  for (const row of rows) {
    const cells = columns.map((_, i) => row.raw[i] ?? '');
    lines.push([...cells, row.errors.join(' ')].map(csvCell).join(','));
  }
  // A byte-order mark so Excel opens the file as UTF-8.
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}
