import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { suggestImportMapping } from '@adas/shared';
import { detectFormat, parseTable } from '../parse.js';
import {
  errorsCsv,
  fileKey,
  mappedFields,
  parseMarket,
  readCompanyRow,
  readContactRow,
  splitFullName,
} from '../rows.js';

/** Reading import files and rows (PRD 4.9, 6.11). All data is synthetic. */

async function xlsx(rows: (string | number | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Contacts');
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('file type and parsing', () => {
  it('decides the type from the content, not the name', async () => {
    expect(detectFormat(Buffer.from('Email,Name\na@b.example.com,A B\n'))).toBe('csv');
    expect(detectFormat(await xlsx([['Email']]))).toBe('xlsx');
    expect(detectFormat(Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]))).toBeNull();
    expect(detectFormat(Buffer.alloc(0))).toBeNull();
  });

  it('reads CSV with quotes, a byte-order mark, semicolons and blank lines', async () => {
    const csv = Buffer.from(
      String.fromCharCode(0xfeff) +
        'Email;Full name;Company\n' +
        'one@firm.example.com;"Doe; Jane";Firm LLP\n' +
        '\n' +
        'two@firm.example.com;Sam Lee;"Firm ""Two"""\n',
    );
    const table = await parseTable(csv, 'csv');
    expect(table.columns).toEqual(['Email', 'Full name', 'Company']);
    expect(table.rows).toEqual([
      ['one@firm.example.com', 'Doe; Jane', 'Firm LLP'],
      ['two@firm.example.com', 'Sam Lee', 'Firm "Two"'],
    ]);
    // Row numbers match the spreadsheet: the blank line is row 3.
    expect(table.rowNumbers).toEqual([2, 4]);
  });

  it('falls back to Windows-1252 for files Excel saved as CSV', async () => {
    const latin = Buffer.from([
      ...Buffer.from('Name,City\nRen'),
      0xe9,
      ...Buffer.from(',Montr'),
      0xe9,
      ...Buffer.from('al\n'),
    ]);
    const table = await parseTable(latin, 'csv');
    expect(table.rows[0]).toEqual(['René', 'Montréal']);
  });

  it('reads the first sheet of a workbook and names blank or repeated headers', async () => {
    const file = await xlsx([
      ['Email', '', 'Email', 'Staff'],
      ['a@firm.example.com', 'x', 'b@firm.example.com', 12],
      [null, null, null, null],
      ['c@firm.example.com', '', '', 40],
    ]);
    const table = await parseTable(file, 'xlsx');
    expect(table.columns).toEqual(['Email', 'Column 2', 'Email (2)', 'Staff']);
    expect(table.rows).toEqual([
      ['a@firm.example.com', 'x', 'b@firm.example.com', '12'],
      ['c@firm.example.com', '', '', '40'],
    ]);
    expect(table.rowNumbers).toEqual([2, 4]);
  });

  it('refuses an empty file and a file that is not a workbook', async () => {
    await expect(parseTable(Buffer.from(''), 'csv')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      parseTable(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'xlsx'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('mapping and rows', () => {
  it('suggests a mapping from common column names', () => {
    expect(
      suggestImportMapping('contact', ['E-mail', 'First Name', 'last_name', 'Firm', 'Notes']),
    ).toEqual({
      'E-mail': 'email',
      'First Name': 'firstName',
      last_name: 'lastName',
      Firm: 'companyName',
    });
  });

  it('reads a contact row and normalises email, phone, country and company domain', () => {
    const fields = mappedFields(
      ['Email', 'Name', 'Phone', 'Country', 'Website'],
      [' Jane.Doe@Firm.Example.com ', 'Jane  Q. Doe', '(416) 555-0100', 'Canada', ''],
      {
        Email: 'email',
        Name: 'fullName',
        Phone: 'phone',
        Country: 'market',
        Website: 'companyWebsite',
      },
    );
    const read = readContactRow(fields, 'US');
    expect(read).toEqual({
      ok: true,
      values: {
        email: 'jane.doe@firm.example.com',
        firstName: 'Jane',
        lastName: 'Q. Doe',
        title: null,
        phone: '+14165550100',
        companyName: null,
        companyDomain: 'firm.example.com',
        market: 'CA',
      },
    });
  });

  it('never takes a company domain from a personal email address', () => {
    const read = readContactRow(
      { email: 'synthetic.sam.lee@gmail.com', fullName: 'Sam Lee' },
      'US',
    );
    expect(read.ok && read.values.companyDomain).toBeNull();
  });

  it('lists every problem with a contact row in plain words', () => {
    expect(readContactRow({ email: '', phone: '12' }, 'US')).toEqual({
      ok: false,
      errors: ['Email is blank.', 'Name is blank.', 'Phone is not a valid number.'],
    });
    expect(readContactRow({ email: 'not-an-email', firstName: 'A' }, 'US')).toEqual({
      ok: false,
      errors: ['Email is not a valid address.'],
    });
  });

  it('checks company rows against the reference lists', () => {
    const refs = { staffBands: ['1–5', '6–20'], firmTypes: ['CPA firm', 'Other'] };
    expect(
      readCompanyRow(
        {
          name: 'Firm LLP',
          website: 'https://www.Firm.example.com/about',
          staffBand: '6–20',
          firmType: 'cpa FIRM',
        },
        'US',
        refs,
      ),
    ).toEqual({
      ok: true,
      values: {
        name: 'Firm LLP',
        domain: 'firm.example.com',
        market: 'US',
        stateProvince: null,
        city: null,
        staffBand: '6–20',
        firmType: 'CPA firm',
      },
    });
    const bad = readCompanyRow({ name: 'X', website: 'gmail.com', staffBand: 'huge' }, 'US', refs);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.errors).toEqual([
      'Website is not a company website (personal email domains are not allowed).',
      'Staff size must be one of: 1–5, 6–20.',
    ]);
  });

  it('keys rows so the same record twice in one file is caught', () => {
    const a = readCompanyRow({ name: 'Firm LLP' }, 'US', { staffBands: [], firmTypes: [] });
    const b = readCompanyRow({ name: 'firm llp' }, 'US', { staffBands: [], firmTypes: [] });
    expect(a.ok && b.ok && fileKey('company', a.values) === fileKey('company', b.values)).toBe(
      true,
    );
  });

  it('parses countries and splits names', () => {
    expect(parseMarket('U.S.A.', 'CA')).toBe('US');
    expect(parseMarket('', 'CA')).toBe('CA');
    expect(parseMarket('India', 'US')).toBe('OTHER');
    expect(splitFullName('Cher')).toEqual({ firstName: 'Cher', lastName: '' });
  });

  it('writes an error file that spreadsheets will not run as formulas', () => {
    const csv = errorsCsv(
      ['Email', 'Note'],
      [{ raw: ['=HYPERLINK("x")', 'a, "b"'], errors: ['Email is not a valid address.'] }],
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      'Email,Note,Error',
      `"'=HYPERLINK(""x"")","a, ""b""",Email is not a valid address.`,
      '',
    ]);
  });
});
