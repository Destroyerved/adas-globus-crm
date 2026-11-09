import { IMPORT_MAX_ROWS } from '@adas/shared';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { ValidationDomainError } from '../../platform/errors/index.js';

/**
 * Reads an uploaded CSV or XLSX file into a header row and data rows of plain strings
 * (PRD 4.9). The type is decided by the file's content, not its name (PRD 6.11).
 */

export type FileFormat = 'csv' | 'xlsx';

export interface ParsedTable {
  columns: string[];
  rows: string[][];
  /** Each row's number as a spreadsheet shows it (the header is row 1). */
  rowNumbers: number[];
}

/** XLSX files are zip archives; CSV is text with no NUL bytes. Anything else is refused. */
export function detectFormat(data: Buffer): FileFormat | null {
  if (data.length >= 4 && data.readUInt32BE(0) === 0x504b0304) return 'xlsx';
  if (data.length === 0 || data.subarray(0, 65_536).includes(0)) return null;
  return 'csv';
}

/** UTF-8 if it decodes cleanly, otherwise Windows-1252 (Excel's "CSV" on Windows). */
function decodeText(data: Buffer): string {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return new TextDecoder('windows-1252').decode(data);
  }
}

/** The delimiter used most in the first line: comma, semicolon (European Excel) or tab. */
function guessDelimiter(text: string): string {
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  let best = ',';
  let bestCount = 0;
  for (const d of [',', ';', '\t']) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('result' in value) return cellText(value.result as ExcelJS.CellValue);
    if ('error' in value) return '';
    return '';
  }
  return String(value);
}

function tidy(columns: string[], rows: string[][], numbers: number[]): ParsedTable {
  const seen = new Map<string, number>();
  const names = columns.map((raw, i) => {
    const base = raw.trim() || `Column ${i + 1}`;
    const n = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), n);
    return n === 1 ? base : `${base} (${n})`;
  });
  const data: string[][] = [];
  const rowNumbers: number[] = [];
  rows.forEach((row, index) => {
    const cells = names.map((_, i) => (row[i] ?? '').trim());
    if (cells.some((v) => v !== '')) {
      data.push(cells);
      rowNumbers.push(numbers[index] ?? index + 2);
    }
  });
  if (data.length > IMPORT_MAX_ROWS) {
    throw new ValidationDomainError('The file has too many rows.', {
      file: [
        `Files can have at most ${IMPORT_MAX_ROWS.toLocaleString('en-US')} rows. Split it and import each part.`,
      ],
    });
  }
  return { columns: names, rows: data, rowNumbers };
}

export async function parseTable(data: Buffer, format: FileFormat): Promise<ParsedTable> {
  if (format === 'csv') {
    const text = decodeText(data);
    let records: string[][];
    try {
      records = parseCsv(text, {
        delimiter: guessDelimiter(text),
        relax_column_count: true,
        relax_quotes: true,
      }) as string[][];
    } catch {
      throw new ValidationDomainError('The file could not be read as CSV.', {
        file: ['Check that it is a comma-separated file with a header row.'],
      });
    }
    // A spreadsheet shows each CSV record as one row, so record n is row n.
    const [header, ...rows] = records;
    if (!header) throw emptyFile();
    return tidy(
      header,
      rows,
      rows.map((_, i) => i + 2),
    );
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new ValidationDomainError('The file could not be read as an Excel workbook.', {
      file: ['Save it as .xlsx (Excel workbook) or .csv and try again.'],
    });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw emptyFile();
  const table: string[][] = [];
  const numbers: number[] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      values[col - 1] = cellText(cell.value);
    });
    table.push(Array.from(values, (v) => v ?? ''));
    numbers.push(row.number);
  });
  const [header, ...rows] = table;
  if (!header) throw emptyFile();
  return tidy(header, rows, numbers.slice(1));
}

function emptyFile() {
  return new ValidationDomainError('The file is empty.', {
    file: ['The first row must name the columns, with one record on each row below it.'],
  });
}
