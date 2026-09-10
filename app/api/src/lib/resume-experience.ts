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
 * ── A WRONG NUMBER IS WORSE THAN NULL ───────────────────────────────────────
 *
 * The figure this produces is read back to the candidate by the live phone
 * interviewer's résumé-conflict probe (`phone.py`, check 3: spoken total vs
 * résumé total, ≥2 years or ≥50% apart). An under-count from a mis-parsed
 * period therefore becomes an accusation. So every gate fails CLOSED: a
 * period that does not describe a range this module can vouch for counts as
 * nothing; implausible years are dropped; a span outside a human career is
 * dropped; education entries that leaked into the role list are skipped; and
 * when nothing parses the answer is `null`, exactly as before. Overlapping
 * roles are UNIONED, never summed twice.
 *
 * ── COUNTING CONVENTION ─────────────────────────────────────────────────────
 *
 * Intervals are half-open month indices `[start, end)`.
 *   · A range whose END names a month is inclusive of that month
 *     ("Jan 2022 – Dec 2023" = 24 months — the figure a recruiter writes down).
 *   · A bare-year end anchors to January ("2018 – 2020" = 24 months), unless
 *     the period itself states a longer duration ("2018 – 2020 (2.5 yrs)").
 *   · A "present" marker ANYWHERE in the segment ("Jan 2021 – Present
 *     (promoted Jan 2023)", "Aug 2019 – Till Date (Kolkata)") ends the span at
 *     the current month, exclusive — the month in progress is not yet a month
 *     of experience — regardless of any other date in the segment.
 *   · A period listing several stints ("2019 – 2020, 2022 – Present";
 *     "… | …"; "…; …") is split and each stint counted; the gap is not.
 *   · A duration with no dates ("2 years 3 months") is counted only when the
 *     role has no dated span at all.
 */

import type { ResumeRoleEvidence } from './types.js';

/** Upper bound the structurer already applies to a model-stated figure. */
const MAX_EXPERIENCE_YEARS = 80;
/** A single role longer than this is a parse artefact, not a career. */
const MAX_SINGLE_SPAN_MONTHS = 50 * 12;
/** Nothing on a résumé predates this; a smaller year is a typo or a page number. */
const MIN_YEAR = 1950;
/** Periods are short strings; anything longer is not a period. */
const MAX_PERIOD_LEN = 200;

const FULL_MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

/**
 * Optimal-string-alignment distance, bounded: returns 2 as soon as the
 * distance exceeds 1. Lets "Feburary" (a transposition) resolve to February
 * while "Marketing" stays a non-month. Inputs are ≤ 9 letters.
 */
function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (i === a.length || i === b.length) return true; // one insertion/deletion at the tail
  // substitution
  if (a.slice(i + 1) === b.slice(i + 1)) return true;
  // insertion / deletion
  if (a.slice(i + 1) === b.slice(i) || a.slice(i) === b.slice(i + 1)) return true;
  // adjacent transposition
  if (a[i + 1] === b[i] && a[i] === b[i + 1] && a.slice(i + 2) === b.slice(i + 2)) return true;
  return false;
}

/** Resolve a month word ("jan", "sept", "September", "Mar.", "Feburary") to 1..12, or null. */
export function monthFromWord(word: string): number | null {
  const key = word.toLowerCase();
  if (key.length < 3) return null;
  if (key === 'sept') return 9;
  const prefix = FULL_MONTHS.findIndex((full) => full.startsWith(key));
  if (prefix !== -1) return prefix + 1;
  if (key.length >= 5) {
    const fuzzy = FULL_MONTHS.findIndex((full) => withinOneEdit(key, full));
    if (fuzzy !== -1) return fuzzy + 1;
  }
  return null;
}

/**
 * "Still there" markers, as whole words anywhere in a segment. `\b` keeps
 * "Presentation Skills" from qualifying; "presently" and "currently" do.
 */
const PRESENT_WORD_RE =
  /\b(?:present(?:ly)?|current(?:ly)?|now|till\s+date|to\s+date|to\s+till\s+date|ongoing|today|till\s+now|so\s+far|continuing)\b/i;

/**
 * One date token. Alternatives, in order:
 *   1. Month word (3+ letters), optional day ("May 12,"), then a 4-digit year
 *      — separators may be space, dot, apostrophe or hyphen: "Jan 2021",
 *      "Sept. 2019", "Mar-2019", "June 15, 2019", "Jan 05, 2021".
 *   2. Month word + APOSTROPHE + 2-digit year: "Jun'18", "Dec ’20". The
 *      apostrophe is MANDATORY for a 2-digit year — without it, "May 12" is a
 *      day, not 2012.
 *   3. Quarter: "Q1 2020" → the quarter's first month.
 *   4. Numeric month/year: "03/2018", "3-2018", "03.2018".
 *   5. ISO-ish year-month: "2021-06", "2021/06".
 *   6. Bare 4-digit year: "2018".
 * Every quantifier is bounded, so this stays linear over a 200-char string.
 */
const DATE_TOKEN_RE = new RegExp(
  [
    /\b([a-z]{3,9})\.?[\s.'’-]{0,3}(?:\d{1,2}(?:st|nd|rd|th)?,?\s{1,3})?(\d{4})\b/.source,
    /\b([a-z]{3,9})\.?\s{0,3}['’]\s{0,2}(\d{2})\b/.source,
    /\bq([1-4])\s{0,2}['’]?\s{0,2}(\d{4})\b/.source,
    /\b(\d{1,2})[/.-](\d{4})\b/.source,
    /\b(\d{4})[/.-](\d{1,2})\b/.source,
    /\b((?:19|20)\d{2})\b/.source,
  ].join('|'),
  'gi',
);

/**
 * A stated duration: "5 years 8 months", "2 yrs 7 mos", "3+ years", "2.5 years",
 * "6 months". Two MANDATORY alternatives (years with optional months, or
 * months alone) — an all-optional pattern matches the empty string at index 0
 * and never reaches a duration further along the line.
 */
const DURATION_RE =
  /\b(\d{1,2}(?:\.\d)?)\s*\+?\s*(?:years?|yrs?)\b(?:\s*(?:and\s+)?(\d{1,2})\s*(?:months?|mos?)\b)?|\b(\d{1,2})\s*(?:months?|mos?)\b/i;

/** How much of the calendar a token names. Decides the inclusive end width. */
export type DatePrecision = 'month' | 'quarter' | 'year';

/** Months an inclusive END token covers, by precision (a bare year anchors to January). */
const END_WIDTH_MONTHS: Readonly<Record<DatePrecision, number>> = { month: 1, quarter: 3, year: 0 };

export interface DateToken {
  year: number;
  month: number;
  precision: DatePrecision;
  /** Whether the document named the month (or quarter), or only the year. */
  hasMonth: boolean;
}

function token(year: number, month: number, precision: DatePrecision): DateToken {
  return { year, month, precision, hasMonth: precision !== 'year' };
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
  const text = period.slice(0, MAX_PERIOD_LEN);
  DATE_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATE_TOKEN_RE.exec(text)) !== null) {
    let t: DateToken | null = null;
    if (m[1] !== undefined) {
      const month = monthFromWord(m[1]);
      const year = Number(m[2]);
      // A non-month word before a 4-digit year ("Quarter 2021", "Batch 2019")
      // still yields the bare year — a word must not swallow a real date.
      t = month !== null ? token(year, month, 'month') : token(year, 1, 'year');
    } else if (m[3] !== undefined) {
      const month = monthFromWord(m[3]);
      if (month !== null) t = token(expandTwoDigitYear(Number(m[4]), now), month, 'month');
    } else if (m[5] !== undefined) {
      t = token(Number(m[6]), (Number(m[5]) - 1) * 3 + 1, 'quarter');
    } else if (m[7] !== undefined) {
      const month = Number(m[7]);
      if (month >= 1 && month <= 12) t = token(Number(m[8]), month, 'month');
    } else if (m[9] !== undefined) {
      const month = Number(m[10]);
      if (month >= 1 && month <= 12) t = token(Number(m[9]), month, 'month');
    } else if (m[11] !== undefined) {
      t = token(Number(m[11]), 1, 'year');
    }
    if (t && yearInRange(t.year, now)) out.push(t);
  }
  return out;
}

/** A stated duration in months, or null when the segment states none. */
export function parseDurationMonths(segment: string): number | null {
  const m = segment.match(DURATION_RE);
  if (!m) return null;
  const years = m[1] !== undefined ? Number(m[1]) : 0;
  const months = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : 0;
  const total = Math.round(years * 12) + months;
  if (!Number.isFinite(total) || total <= 0 || total > MAX_SINGLE_SPAN_MONTHS) return null;
  return total;
}

/** Whether a comma-separated piece stands alone as a dated range. */
function isStandaloneRange(piece: string, now: Date): boolean {
  const tokens = extractDateTokens(piece, now);
  if (tokens.length >= 2) return true;
  return tokens.length === 1 && PRESENT_WORD_RE.test(piece);
}

/**
 * Split one period string into the segments that each describe ONE stint.
 * Hard separators (`;`, `|`, newline) always split. A comma splits only when
 * EVERY comma-piece is itself a dated range, so "May 12, 2021 – Jun 3, 2022"
 * and "Jan 2021 – Present, Bengaluru" stay whole while
 * "2019 – 2020, 2022 – Present" becomes two stints.
 */
export function splitPeriodSegments(period: string, now: Date): string[] {
  const out: string[] = [];
  for (const hard of period.split(/[;|\n]/)) {
    const seg = hard.trim();
    if (!seg) continue;
    const pieces = seg.split(',').map((p) => p.trim()).filter(Boolean);
    if (pieces.length > 1 && pieces.every((p) => isStandaloneRange(p, now))) {
      out.push(...pieces);
    } else {
      out.push(seg);
    }
  }
  return out;
}

export interface PeriodParse {
  /** Dated stints, half-open month indices, in document order. */
  spans: Array<[number, number]>;
  /** A stated duration with no dates at all, in months (else null). */
  durationOnlyMonths: number | null;
}

/**
 * Parse one role period into its dated spans (and/or a dates-free duration).
 * Every segment that this module cannot vouch for contributes nothing.
 */
export function parsePeriod(period: string | null | undefined, now: Date): PeriodParse {
  const none: PeriodParse = { spans: [], durationOnlyMonths: null };
  if (typeof period !== 'string') return none;
  const text = period.trim();
  if (text === '' || text.length > MAX_PERIOD_LEN) return none;
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans: Array<[number, number]> = [];
  let allEndsImprecise = true;
  let durationOnly: number | null = null;
  for (const seg of splitPeriodSegments(text, now)) {
    const tokens = extractDateTokens(seg, now);
    const duration = parseDurationMonths(seg);
    if (tokens.length === 0) {
      if (duration !== null) durationOnly = (durationOnly ?? 0) + duration;
      continue;
    }
    const first = tokens[0];
    const start = toIndex(first);
    let end: number;
    let imprecise = false;
    if (PRESENT_WORD_RE.test(seg)) {
      // "present" anywhere wins over any other date in the segment (a
      // promotion date, an acquisition year, a parenthetical).
      end = nowIndex;
    } else if (tokens.length >= 2) {
      const last = tokens[tokens.length - 1];
      end = toIndex(last) + END_WIDTH_MONTHS[last.precision];
      imprecise = last.precision === 'year';
      // A bare-year end is imprecise; a stated duration on the same segment
      // ("2018 – 2020 (2.5 yrs)") is the document's own, better answer.
      if (imprecise && duration !== null && start + duration > end) end = start + duration;
    } else if (duration !== null) {
      end = start + duration;
    } else {
      // A lone date with no "present" marker is a point, not a range.
      continue;
    }
    if (end < start) continue;
    if (end - start > MAX_SINGLE_SPAN_MONTHS) continue;
    // "2020 – 2020" (bare years) still represents a held role; count it as one
    // month rather than zero so it is not silently dropped.
    spans.push([start, Math.max(end, start + 1)]);
    if (!imprecise) allEndsImprecise = false;
  }
  // A duration stated in its own segment ("2019 – 2020 | 2 yrs") outranks a
  // bare-year range it accompanies — the years alone can be out by up to 11
  // months either way, the document's own figure cannot.
  if (spans.length > 0 && allEndsImprecise && durationOnly !== null && durationOnly > unionMonths(spans)) {
    const start = Math.min(...spans.map((s) => s[0]));
    return { spans: [[start, start + durationOnly]], durationOnlyMonths: null };
  }
  return { spans, durationOnlyMonths: spans.length === 0 ? durationOnly : null };
}

/** Total months of a set of half-open spans, overlaps unioned. */
export function unionMonths(spans: ReadonlyArray<[number, number]>): number {
  if (spans.length === 0) return 0;
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [curStart, curEnd] = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const [s, e] = sorted[i];
    if (s <= curEnd) {
      curEnd = Math.max(curEnd, e);
    } else {
      total += curEnd - curStart;
      [curStart, curEnd] = [s, e];
    }
  }
  return total + (curEnd - curStart);
}

/**
 * Titles that are education, not employment. The tolerant structurer turns a
 * string entry such as "B.Tech CSE, VIT, 2018 – 2022" into a role, and a
 * model sometimes files a degree under `prior_roles`; neither is experience.
 */
const EDUCATION_TITLE_RE =
  /\b(?:b\.?\s?tech|b\.?\s?e\.?|b\.?\s?sc|b\.?\s?com|b\.?\s?a\.?|b\.?\s?b\.?\s?a|b\.?\s?c\.?\s?a|m\.?\s?tech|m\.?\s?sc|m\.?\s?com|m\.?\s?c\.?\s?a|mba|pgdm|ph\.?\s?d|bachelor|master'?s?|diploma|degree|university|college|institute of|school|class of|batch of|graduat(?:e|ed|ion)|higher secondary|hsc|ssc|10th|12th|xii|cbse|icse)\b/i;

export function isEducationLikeRole(role: ResumeRoleEvidence): boolean {
  const text = `${role.title ?? ''} ${role.employer ?? ''}`;
  return EDUCATION_TITLE_RE.test(text) && !/\b(?:engineer|developer|manager|analyst|executive|associate|consultant|lead|intern|trainee|officer|specialist|teacher|professor|lecturer|faculty)\b/i.test(role.title ?? '');
}

/**
 * Total years across the given roles, from their `period` strings.
 *
 * Dated spans are UNIONED across all roles; dates-free durations are added
 * only for roles that had no dated span. Returns `null` when nothing parses,
 * and never a value above the structurer's own ceiling.
 */
export function deriveExperienceYearsFromRoles(
  roles: ReadonlyArray<ResumeRoleEvidence | null | undefined>,
  now: Date = new Date(),
): number | null {
  const spans: Array<[number, number]> = [];
  let durationOnly = 0;
  for (const role of roles) {
    if (!role || isEducationLikeRole(role)) continue;
    const parsed = parsePeriod(role.period, now);
    spans.push(...parsed.spans);
    if (parsed.durationOnlyMonths !== null) durationOnly += parsed.durationOnlyMonths;
  }
  const total = unionMonths(spans) + durationOnly;
  if (total <= 0) return null;
  const years = Math.round((total / 12) * 10) / 10;
  if (!Number.isFinite(years) || years <= 0 || years > MAX_EXPERIENCE_YEARS) return null;
  return years;
}

/**
 * The verbatim period substring of one résumé line, for the deterministic
 * extractor: from the first date token to the last date token or present
 * marker. `null` when the line carries fewer than a range's worth of dates.
 * Used so a prose/section role line such as "Senior Sales Executive, Acme —
 * Bengaluru  Jan 2021 – Present" contributes its dates to the total.
 */
export function extractPeriodFromLine(line: string, now: Date = new Date()): string | null {
  const text = line.slice(0, 400);
  const tokens = extractDateTokens(text, now);
  if (tokens.length === 0) return null;
  const firstIdx = text.search(/(?:19|20)\d{2}|['’]\d{2}\b|\b[A-Za-z]{3,9}\.?[\s.'’-]{0,3}(?:\d{1,2}(?:st|nd|rd|th)?,?\s{1,3})?(?:19|20)\d{2}/);
  if (firstIdx === -1) return null;
  const tail = text.slice(firstIdx);
  const present = tail.match(PRESENT_WORD_RE);
  const lastYear = [...tail.matchAll(/(?:19|20)\d{2}|['’]\d{2}\b/g)].pop();
  let endIdx = lastYear ? (lastYear.index ?? 0) + lastYear[0].length : 0;
  if (present && (present.index ?? 0) + present[0].length > endIdx) endIdx = (present.index ?? 0) + present[0].length;
  const period = tail.slice(0, endIdx).trim();
  if (!period) return null;
  return tokens.length >= 2 || PRESENT_WORD_RE.test(period) ? period : null;
}
