import { describe, expect, it } from 'vitest';
import { csvCell, csvLine } from '../csv.js';

describe('CSV cells (PRD 4.9)', () => {
  it('leaves plain text alone and quotes commas, quotes and line breaks', () => {
    expect(csvCell('Acme Tax & Advisory LLP')).toBe('Acme Tax & Advisory LLP');
    expect(csvCell('Tax, Audit')).toBe('"Tax, Audit"');
    expect(csvCell('The "big" firm')).toBe('"The ""big"" firm"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('')).toBe('');
  });

  it('keeps anything a spreadsheet would run as a formula as plain text', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('=HYPERLINK("x","y")')).toBe(`"'=HYPERLINK(""x"",""y"")"`);
  });

  it('keeps phone numbers in E.164 as they are', () => {
    expect(csvCell('+13125550148')).toBe('+13125550148');
  });

  it('ends each line with CRLF', () => {
    expect(csvLine(['a', 'b,c'])).toBe('a,"b,c"\r\n');
  });
});
