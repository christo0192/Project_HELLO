/**
 * Escaping and naming helpers for the stakeholder report.
 *
 * The report is a standalone HTML file built by string concatenation, and
 * almost every value in it is controlled by a candidate or a model (a resume
 * line, a transcript turn, a rationale, an evidence quote). `escapeHtml` is the
 * ONE function every dynamic string goes through; `buildReportHtml` never
 * concatenates data any other way.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * Text that is safe in an HTML text node AND in a double- or single-quoted
 * attribute value. Also drops C0 control characters (except tab, newline,
 * carriage return) that have no business in a report and can confuse parsers.
 * Never returns `undefined`/`null`: those render as the empty string.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return stripControlChars(String(value)).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

function stripControlChars(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const keep = code >= 0x20 ? code !== 0x7f : code === 0x09 || code === 0x0a || code === 0x0d;
    if (keep) out += text[i];
  }
  return out;
}

/** Lower-case `[a-z0-9-]` slug, at most `max` characters, or '' when nothing is left. */
export function slugForFilename(value: string | null | undefined, max = 40): string {
  const slug = (value ?? '')
    .normalize('NFKD')
    // Drop combining marks left by NFKD ("é" -> "e").
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

/** `YYYY-MM-DD` of `date` in UTC. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * `screening-report-<slug>-<YYYY-MM-DD>.html`. The slug is the candidate's name,
 * falling back to the first eight characters of the candidate id (never the
 * whole id), then to "candidate". Nothing from the name reaches the file name
 * except `[a-z0-9-]`.
 */
export function reportFilename(
  name: string | null | undefined,
  candidateId: string,
  now: Date = new Date(),
): string {
  const slug =
    slugForFilename(name) || slugForFilename(candidateId.replace(/-/g, '').slice(0, 8)) || 'candidate';
  return `screening-report-${slug}-${isoDay(now)}.html`;
}
