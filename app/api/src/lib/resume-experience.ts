/**
 * resume-experience.ts — derive total years of experience from the dated role
 * evidence a résumé already carries.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `experience_years` reached the dashboard as `—` for almost every candidate,
 * including résumés the model structured perfectly. Two things conspired:
 *
 *  1. The extraction prompt said "Copy evidence only. Do not infer … dates",
 *     and a total-years figure is rarely STATED on a résumé — it is implied by
 *     the role dates. A faithful model therefore answered `null`.
 *  2. The deterministic extractor only matched the literal phrase
 *     "N years … experience", which most résumés do not contain.
 *
 * Neither side ever did the one thing a recruiter does in their head: add up
 * the dated roles. This module does exactly that, and nothing more. It is
 * arithmetic over dates that are PRESENT in the document (the role `period`
 * strings the structurer already copied verbatim) — not an inference of facts
 * that are absent, which is the thing the prompt rightly forbids.
 *
 * ── CONSERVATIVE BY DESIGN ──────────────────────────────────────────────────
 *
 * A wrong number here becomes a résumé "fact" the live interviewer may
 * challenge the candidate about, so every gate fails CLOSED: a period that
 * does not parse into two dates (or one date plus a "present" marker) counts
 * as nothing; a span outside a sane human range counts as nothing; and when no
 * period parses at all the answer is `null`, exactly as before. Overlapping
 * roles are UNIONED, never summed twice — a candidate holding two concurrent
 * roles for three years has three years of experience, not six.
 *
 * ── COUNTING CONVENTION ─────────────────────────────────────────────────────
 *
 * Intervals are half-open month indices `[start, end)`. A range whose END
 * names a month is INCLUSIVE of that month ("Jan 2022 – Dec 2023" = 24 months,
 * the figure a recruiter writes down); a bare-year end anchors to January
 * ("2018 – 2020" = 24 months); "Present" ends at the current month, exclusive
 * (the month in progress is not yet a month of experience).
 */

import type { ResumeRoleEvidence } from './types.js';

/** Upper bound the structurer already applies to a model-stated figure. */
const MAX_EXPERIENCE_YEARS = 80;
/** A single role longer than this is a parse artefact, not a career. */
const MAX_SINGLE_SPAN_MONTHS = 50 * 12;
/** Nothing on a résumé predates this; a smaller year is a typo or a page number. */
const MIN_YEAR = 1950;

const FULL_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

/** Resolve a month word ("jan", "sept", "September", "Mar.") to 1..12, or null. */
function monthFromWord(word: string): number | null {
  const key = word.toLowerCase();
  if (key.length < 3) return null;
  if (key === 'sept') return 9;
  const idx = FULL_MONTHS.findIndex((full) => full.startsWith(key));
  return idx === -1 ? null : idx + 1;
}

/**
 * "Still there" markers. Matched on word boundaries against the normalised
 * period so "Present" inside another word ("Presentation") cannot masquerade
 * as an open-ended range: the marker must be the trailing token.
 */
const PRESENT_RE = /(?:^|[\s\-–—])(?:present|current(?:ly)?|now|till\s+date|to\s+date|ongoing|today)\s*\.?$/i;

/**
 * One date token. Alternatives, in order:
 *   1. Word (3+ letters) + 2- or 4-digit year: "Jan 2021", "Sept. 2019", "Jun'18"
 *      — a word that is not a month still yields the YEAR when it has 4 digits
 *      ("Quarter 2021" → 2021), so a stray word cannot swallow a real year.
 *   2. Numeric month/year: "03/2018", "3-2018", "03.2018"
 *   3. ISO-ish year-month: "2021-06", "2021/06"
 *   4. Bare 4-digit year: "2018"
 * Every quantifier is bounded, so this stays linear over a 200-char string.
 */
const DATE_TOKEN_RE =
  /\b([a-z]{3,9})\.?\s{0,3}['’]?\s{0,2}(\d{4}|\d{2})\b|\b(\d{1,2})[/.-](\d{4})\b|\b(\d{4})[/.-](\d{1,2})\b|\b((?:19|20)\d{2})\b/gi;

export interface DateToken {
  year: number;
  month: number;
  /** Whether the document named the month, or only the year. */
  hasMonth: boolean;
}

/** Month index since year 0, for arithmetic. */
function toIndex(t: { year: number; month: number }): number {
  return t.year * 12 + (t.month - 1);
}

function expandTwoDigitYear(two: number, now: Date): number {
  // "'18" → 2018; a value beyond next year rolls back a century ("'99" → 1999).
  const pivot = (now.getUTCFullYear() + 1) % 100;
  return two <= pivot ? 2000 + two : 1900 + two;
}

function yearInRange(year: number, now: Date): boolean {
  return year >= MIN_YEAR && year <= now.getUTCFullYear() + 1;
}

/** Extract every date token from one period string, in document order. */
export function extractDateTokens(period: string, now: Date): DateToken[] {
  const out: DateToken[] = [];
  DATE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_TOKEN_RE.exec(period)) !== null) {
    let t: DateToken | null = null;
    if (m[1] !== undefined) {
      const month = monthFromWord(m[1]);
      const rawYear = Number(m[2]);
      if (month !== null) {
        const year = m[2].length === 2 ? expandTwoDigitYear(rawYear, now) : rawYear;
        t = { year, month, hasMonth: true };
      } else if (m[2].length === 4) {
        // Not a month word; the 4-digit year still counts as a bare year.
        t = { year: rawYear, month: 1, hasMonth: false };
      }
    } else if (m[3] !== undefined) {
      const month = Number(m[3]);
      if (month >= 1 && month <= 12) t = { year: Number(m[4]), month, hasMonth: true };
    } else if (m[5] !== undefined) {
      const month = Number(m[6]);
      if (month >= 1 && month <= 12) t = { year: Number(m[5]), month, hasMonth: true };
    } else if (m[7] !== undefined) {
      t = { year: Number(m[7]), month: 1, hasMonth: false };
    }
    if (t && yearInRange(t.year, now)) out.push(t);
  }
  return out;
}

/**
 * Parse one role period into a half-open month interval `[start, end)`, or
 * `null` when the string does not describe a range this module is willing to
 * vouch for.
 */
export function parsePeriodMonths(period: string | null | undefined, now: Date): [number, number] | null {
  if (typeof period !== 'string') return null;
  const text = period.trim();
  if (text === '' || text.length > 200) return null;
  const tokens = extractDateTokens(text, now);
  if (tokens.length === 0) return null;
  const start = toIndex(tokens[0]);
  let end: number;
  if (tokens.length >= 2) {
    const last = tokens[tokens.length - 1];
    // A named end month is inclusive of that month.
    end = toIndex(last) + (last.hasMonth ? 1 : 0);
  } else if (PRESENT_RE.test(text)) {
    end = now.getUTCFullYear() * 12 + now.getUTCMonth();
  } else {
    // A lone date with no "present" marker is a point, not a range.
    return null;
  }
  if (end < start) return null;
  if (end - start > MAX_SINGLE_SPAN_MONTHS) return null;
  // "2020 – 2020" (bare years) still represents a held role; count it as one
  // month rather than zero so it is not silently dropped.
  return [start, Math.max(end, start + 1)];
}

/**
 * Total years across the given roles, from their `period` strings.
 *
 * Overlapping or adjacent spans are UNIONED. Returns `null` when no period
 * parses, and never a value above the structurer's own ceiling.
 */
export function deriveExperienceYearsFromRoles(
  roles: ReadonlyArray<ResumeRoleEvidence | null | undefined>,
  now: Date = new Date(),
): number | null {
  const spans: Array<[number, number]> = [];
  for (const role of roles) {
    const span = parsePeriodMonths(role?.period, now);
    if (span) spans.push(span);
  }
  if (spans.length === 0) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = spans[0];
  for (let i = 1; i < spans.length; i += 1) {
    const [s, e] = spans[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  total += curEnd - curStart;
  if (total <= 0) return null;
  const years = Math.round((total / 12) * 10) / 10;
  if (!Number.isFinite(years) || years <= 0 || years > MAX_EXPERIENCE_YEARS) return null;
  return years;
}
