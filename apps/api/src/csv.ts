// RFC 4180 CSV for exports, safe to open in a spreadsheet.

export type Cell = string | number | boolean | null | undefined;

/**
 * One cell. Text that a spreadsheet would read as a formula (it starts with `=`, `+`, `-`, `@`,
 * a tab or a carriage return) gets a leading `'`, so a key name or audit reason cannot run as
 * one. Numbers are written as they are: a negative amount is not a formula.
 */
export function csvCell(v: Cell): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** One CSV line, ending in CRLF. */
export const csvRow = (cells: readonly Cell[]): string => `${cells.map(csvCell).join(',')}\r\n`;
