import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../src/csv.js';

describe('csv cells', () => {
  it('quotes commas, quotes, line breaks and edge spaces', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' padded')).toBe('" padded"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(false)).toBe('false');
  });

  it('defuses text a spreadsheet would run as a formula, but not numbers', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 20')).toBe("'+44 20");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=x')).toBe("'\t=x");
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe(`"'=HYPERLINK(""http://x"",""y"")"`);
    expect(csvCell(-2500)).toBe('-2500');
    expect(csvCell('a=b')).toBe('a=b');
  });

  it('joins a row with commas and ends it with CRLF', () => {
    expect(csvRow(['a', 1, null, 'b,c'])).toBe('a,1,,"b,c"\r\n');
  });
});
