import { formatSpreadsheetDateTime, moneyInputValue, type ExportEntity } from '@adas/shared';
import { type ListEntity } from './lists.js';

/**
 * What a CSV export of each list holds (PRD 4.9). The CRM module owns these tables, so the
 * columns and their SQL live here; the exports module only pages through them.
 */

type Row = Record<string, unknown>;

export interface ExportColumn {
  header: string;
  /** Dates are written in the exporter's time zone, which the header names. */
  isDate?: boolean;
  value: (row: Row, timeZone: string) => string;
}

const MARKET_TEXT: Record<string, string> = { US: 'United States', CA: 'Canada', OTHER: 'Other' };

const text =
  (key: string) =>
  (row: Row): string =>
    row[key] === null || row[key] === undefined ? '' : String(row[key]);

const items =
  (key: string) =>
  (row: Row): string =>
    Array.isArray(row[key]) ? (row[key] as unknown[]).map(String).join('; ') : '';

const yesNo =
  (key: string) =>
  (row: Row): string =>
    row[key] ? 'Yes' : 'No';

const market =
  (key: string) =>
  (row: Row): string =>
    MARKET_TEXT[String(row[key] ?? '')] ?? text(key)(row);

/** Minor units as a plain amount ("4500.50"); the currency is its own column. */
const amount =
  (key: string) =>
  (row: Row): string =>
    row[key] === null || row[key] === undefined ? '' : moneyInputValue(String(row[key]));

const col = (header: string, value: (row: Row) => string): ExportColumn => ({ header, value });

const dateCol = (header: string, key: string): ExportColumn => ({
  header,
  isDate: true,
  value: (row, timeZone) =>
    row[key] ? formatSpreadsheetDateTime(row[key] as Date | string, timeZone) : '',
});

const ownerName = (alias: string, column = 'owner_user_id') =>
  `(SELECT u.name FROM users u WHERE u.id = ${alias}.${column}) AS owner_name`;

export interface ExportSpec {
  list: ListEntity;
  /** "contacts", for file names and messages. */
  plural: string;
  /** Developer-written SQL added to the list's select; never user input. */
  extraSelect: string;
  columns: ExportColumn[];
}

export const EXPORT_SPECS: Record<ExportEntity, ExportSpec> = {
  lead: {
    list: 'leads',
    plural: 'leads',
    extraSelect: ownerName('l'),
    columns: [
      col('Name', text('full_name')),
      col('First name', text('first_name')),
      col('Last name', text('last_name')),
      col('Email', text('email')),
      col('Phone', text('phone_e164')),
      col('Firm', text('firm_name')),
      col('Website', text('website')),
      col('Title', text('title')),
      col('Country', market('market')),
      col('State or province', text('state_province')),
      col('Staff size', text('staff_band')),
      col('Source', text('source')),
      col('Status', text('status')),
      col('Score', text('lead_score')),
      col('Services needed', items('services_needed')),
      col('Software', items('software_stack')),
      col('Owner', text('owner_name')),
      col('Tags', items('tags')),
      dateCol('Created', 'created_at'),
      dateCol('Last contacted', 'last_contacted_at'),
    ],
  },
  contact: {
    list: 'contacts',
    plural: 'contacts',
    extraSelect: ownerName('c'),
    columns: [
      col('Name', text('full_name')),
      col('First name', text('first_name')),
      col('Last name', text('last_name')),
      col('Email', text('primary_email')),
      col('Phone', text('phone_e164')),
      col('Title', text('title')),
      col('Job function', text('job_function')),
      col('Seniority', text('seniority')),
      col('Company', text('company_name')),
      col('Company domain', text('company_domain')),
      col('Country', market('market')),
      col('Time zone', text('timezone')),
      col('Do not contact', yesNo('do_not_contact')),
      col('Email status', text('email_verification_status')),
      col('Score', text('lead_score')),
      col('Owner', text('owner_name')),
      col('Tags', items('tags')),
      dateCol('Created', 'created_at'),
      dateCol('Last contacted', 'last_contacted_at'),
    ],
  },
  company: {
    list: 'companies',
    plural: 'companies',
    extraSelect: ownerName('c'),
    columns: [
      col('Name', text('name')),
      col('Domain', text('domain')),
      col('Website', text('website')),
      col('Firm type', text('firm_type')),
      col('Country', market('market')),
      col('State or province', text('state_province')),
      col('City', text('city')),
      col('Time zone', text('timezone')),
      col('Staff size', text('staff_band')),
      col('Account status', text('account_status')),
      col('Accounting software', items('accounting_software')),
      col('Services needed', items('services_needed')),
      col('Estimated revenue', amount('estimated_revenue_minor')),
      col('Currency', text('currency')),
      col('Contacts', text('contact_count')),
      col('Open deals', text('open_deal_count')),
      col('Owner', text('owner_name')),
      col('Tags', items('tags')),
      dateCol('Created', 'created_at'),
      dateCol('Last contacted', 'last_contacted_at'),
    ],
  },
  deal: {
    list: 'deals',
    plural: 'deals',
    extraSelect: `${ownerName('d')},
      (SELECT p.name FROM pipelines p WHERE p.id = d.pipeline_id) AS pipeline_name`,
    columns: [
      col('Name', text('name')),
      col('Company', text('company_name')),
      col('Primary contact', text('primary_contact_name')),
      col('Pipeline', text('pipeline_name')),
      col('Stage', text('stage_name')),
      col('Outcome', text('stage_category')),
      col('Currency', text('currency')),
      col('Monthly value', amount('monthly_value_minor')),
      col('One-time value', amount('one_time_value_minor')),
      col('Term (months)', text('term_months')),
      col('Contract value', amount('contract_value_minor')),
      col('FTEs', text('fte_count')),
      col('Probability (%)', text('probability')),
      col('Expected close', text('expected_close_date')),
      dateCol('Closed', 'closed_at'),
      col('Owner', text('owner_name')),
      col('Tags', items('tags')),
      dateCol('Created', 'created_at'),
    ],
  },
};

/** The header row: date columns name the time zone their values are in. */
export function exportHeader(entity: ExportEntity, timeZone: string): string[] {
  return EXPORT_SPECS[entity].columns.map((c) =>
    c.isDate ? `${c.header} (${timeZone})` : c.header,
  );
}
