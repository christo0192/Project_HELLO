/**
 * Phase 9 L3 — CSV export helpers (RFC4180 + spreadsheet-formula defense).
 *
 * - RFC4180: CRLF line endings; fields containing comma / double-quote /
 *   CR / LF are quoted with embedded quotes doubled.
 * - Formula injection: cells whose FIRST MEANINGFUL character is one of
 *   = + - @ TAB CR (after stripping leading whitespace) are prefixed with
 *   an apostrophe so spreadsheet engines treat them as text.
 * - UTF-8 BOM so Excel/Sheets read non-Latin text correctly.
 * - Filename is fixed and UUID-derived — user-controlled filenames are
 *   impossible.
 */

const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r', '\n']);

/**
 * Neutralize a spreadsheet-formula payload. If the first meaningful
 * character (after leading whitespace/TAB/CR/LF) is a formula trigger, the
 * ORIGINAL cell (leading whitespace intact) is prefixed with an apostrophe.
 */
export function neutralizeFormulaCell(field: string): string {
  if (field.length === 0) return field;
  const meaningful = field.replace(/^[ \t\r\n]+/, '');
  if (meaningful.length > 0 && FORMULA_TRIGGERS.has(meaningful[0])) {
    return `'${field}`;
  }
  return field;
}

/** RFC4180-escape a single cell (after formula neutralization). */
export function csvEscape(field: string): string {
  const safe = neutralizeFormulaCell(field);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** UTF-8 byte-order mark — required for Excel non-Latin decoding. */
export const CSV_BOM = '\uFEFF';

/**
 * Serialize rows to RFC4180 CSV (header + rows, CRLF, formula-safe cells).
 * Cell values are stringified; null/undefined become empty cells.
 */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): string {
  const lines: string[] = [columns.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => csvEscape(String(row[c] ?? ''))).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Safe fixed filename derived from a validated UUID. The caller validates
 * candidateId with uuidSchema first, so injection is impossible. The name
 * reflects that the export contains scorecard AND transcript rows.
 */
export function csvFilename(candidateId: string): string {
  return `screening-export-${candidateId}.csv`;
}

export function csvContentType(): string {
  return 'text/csv; charset=utf-8';
}
