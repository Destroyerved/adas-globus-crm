/**
 * CSV writing helpers (PRD 4.9, 4.18). RFC 4180 quoting, CRLF line ends and a UTF-8 byte
 * order mark so Excel on Windows reads accents correctly.
 */

/** Spreadsheet apps run a cell that starts with one of these as a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell. Text that a spreadsheet would treat as a formula is prefixed with an apostrophe
 * (OWASP "CSV injection"), so a company named "=HYPERLINK(...)" stays plain text. Phone
 * numbers in E.164 start with "+" and are kept as they are: digits after "+" can't form a
 * formula, and the apostrophe would corrupt them.
 */
export function csvCell(value: string): string {
  let text = value;
  if (FORMULA_START.test(text) && !/^\+\d+$/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: readonly string[]): string {
  return `${cells.map(csvCell).join(',')}\r\n`;
}

/** U+FEFF, the UTF-8 byte order mark. */
export const CSV_BOM = String.fromCharCode(0xfeff);
