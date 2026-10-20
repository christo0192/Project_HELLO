/**
 * ashby/candidate-profile.ts — the bounded contact read behind "phone parsing"
 * (ADR-0018): name, email and phone numbers from the Ashby candidate record.
 *
 * Pure on purpose: no logger, no client, no I/O. The profile job hands in the
 * `results` of the `application.info` / `candidate.info` responses it already
 * holds, and this module only reads them. Every value it returns is personal
 * data, so the returned object serializes to a fixed marker rather than to its
 * contents: a profile passed to a JSON logger by mistake prints
 * `[ashby-profile]`, not a name.
 *
 * Shapes read (the same `results` envelope `extractApplicationInfo` and
 * `extractResumeHandle` read):
 *   - `candidate.info` → the candidate object at the root;
 *   - `application.info` → the application at the root or under
 *     `application`, with the candidate embedded under `candidate`.
 * The `candidate.info` root wins; the embedded candidate is the fallback. A
 * contact item may be a bare string or an object carrying `value`.
 *
 * Whether a number may be DIALED is not decided here: that is
 * `deriveAshbyProfilePhone` in `lib/candidate-phone.ts`, which applies the
 * strict format gate and the placeholder denylist. This module only bounds
 * what it hands over.
 */

/** The contact fields phone parsing may use. Every field is personal data. */
export interface AshbyCandidateProfile {
  /** Sanitized display name, or null when absent or implausible. */
  readonly name: string | null;
  /** Bounded email address, or null. */
  readonly email: string | null;
  /** The designated primary number as written (bounded, not validated). */
  readonly primaryNumber: string | null;
  /** The number list, `isPrimary` entries first, then array order. */
  readonly otherNumbers: readonly string[];
}

export const MAX_PROFILE_NAME_LEN = 80;
export const MAX_PROFILE_NAME_TOKENS = 6;
export const MAX_PROFILE_EMAIL_LEN = 254;
export const MAX_PROFILE_NUMBER_LEN = 64;
export const MAX_PROFILE_OTHER_NUMBERS = 5;
const MAX_STATUS_LEN = 64;

/** What a profile serializes to, in place of its contents. */
export const ASHBY_PROFILE_JSON_MARKER = '[ashby-profile]';

/**
 * C0/C1/DEL and every Unicode format character. A superset of the zero-width
 * and bidi ranges (U+200B-200F, U+202A-202E, U+2066-2069, U+FEFF): stripping a
 * soft hyphen or word joiner restores the word it was hiding in, where turning
 * it into a space would split it.
 */
const INVISIBLE_RE = /[\p{Cc}\p{Cf}]/gu;
const DIGIT_RE = /\p{Nd}/gu;
const NAME_DISALLOWED_RE = /[^\p{L}\p{M}\s.'-]/gu;
const NAME_EDGE_RE = /^[\s.'-]+|[\s.'-]+$/gu;
const EMAIL_FORBIDDEN_RE = /[\s\p{Cc}\p{Cf}]/u;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The candidate objects to read, in precedence order. */
function profileSources(
  applicationInfoResults: unknown,
  candidateInfoResults: unknown,
): Record<string, unknown>[] {
  const sources: Record<string, unknown>[] = [];
  const root = asObject(candidateInfoResults);
  if (root) sources.push(root);
  const appRoot = asObject(applicationInfoResults);
  const app = appRoot ? asObject(appRoot.application) ?? appRoot : undefined;
  const embedded = asObject(app?.candidate);
  if (embedded) sources.push(embedded);
  return sources;
}

/** The text of a contact item (a bare string or `{ value }`), when non-blank. */
function itemValue(item: unknown): string | null {
  const value = typeof item === 'string' ? item : asObject(item)?.value;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/** The first source's non-blank value for `key`. */
function firstValue(sources: Record<string, unknown>[], key: string): string | null {
  for (const source of sources) {
    const value = itemValue(source[key]);
    if (value !== null) return value;
  }
  return null;
}

/** The first source's list for `key`, `isPrimary` entries first. */
function primaryFirst(sources: Record<string, unknown>[], key: string): unknown[] {
  const list = sources.map((s) => s[key]).find(Array.isArray) as unknown[] | undefined;
  if (!list) return [];
  const isPrimary = (item: unknown) => asObject(item)?.isPrimary === true;
  return [...list.filter(isPrimary), ...list.filter((item) => !isPrimary(item))];
}

/**
 * Name rules: NFC; strip invisibles; refuse anything carrying `@` or three or
 * more digits (an email or a number typed into the name field); keep only
 * letters, marks, spaces and `.'-`; collapse whitespace and trim punctuation
 * from the edges. Empty, over 80 characters or over 6 tokens is refused.
 *
 * The name is what the call opens with ("am I speaking to …?"), so a value
 * that does not read as a person's name is worse than none.
 */
function sanitizeName(value: string): string | null {
  const visible = value.normalize('NFC').replace(INVISIBLE_RE, '');
  if (visible.includes('@') || (visible.match(DIGIT_RE)?.length ?? 0) >= 3) return null;
  const name = visible
    .replace(NAME_DISALLOWED_RE, ' ')
    .replace(/\s+/gu, ' ')
    .replace(NAME_EDGE_RE, '');
  if (name === '' || name.length > MAX_PROFILE_NAME_LEN) return null;
  if (name.split(' ').length > MAX_PROFILE_NAME_TOKENS) return null;
  return name;
}

/** Trimmed, bounded, exactly one `@` with text either side, nothing invisible. */
function sanitizeEmail(value: string): string | null {
  const email = value.trim();
  if (email.length > MAX_PROFILE_EMAIL_LEN || EMAIL_FORBIDDEN_RE.test(email)) return null;
  const at = email.indexOf('@');
  if (at <= 0 || at !== email.lastIndexOf('@') || at === email.length - 1) return null;
  return email;
}

/** A number value too long to be one; see {@link readNumbers}. */
const OVERSIZE = Symbol('oversize');

function readNumber(item: unknown): string | null | typeof OVERSIZE {
  const value = itemValue(item);
  if (value === null) return null;
  const text = value.replace(INVISIBLE_RE, '').trim();
  if (text === '') return null;
  return text.length > MAX_PROFILE_NUMBER_LEN ? OVERSIZE : text;
}

/**
 * The primary number and the bounded list.
 *
 * An over-long value fails the WHOLE read closed rather than being dropped.
 * Dropping it would move the next entry into its place, and the deriver
 * dials the first list entry when there is no primary — so a garbage primary
 * would quietly hand the call to a secondary number. No number at all leaves
 * the candidate at `number_invalid`, where HR can verify one by hand.
 */
function readNumbers(sources: Record<string, unknown>[]): {
  primaryNumber: string | null;
  otherNumbers: readonly string[];
} {
  const none = { primaryNumber: null, otherNumbers: Object.freeze([]) };
  let primaryNumber: string | null = null;
  for (const source of sources) {
    const read = readNumber(source.primaryPhoneNumber);
    if (read === OVERSIZE) return none;
    if (read !== null) { primaryNumber = read; break; }
  }
  const others: string[] = [];
  for (const item of primaryFirst(sources, 'phoneNumbers')) {
    if (others.length === MAX_PROFILE_OTHER_NUMBERS) break;
    const read = readNumber(item);
    if (read === OVERSIZE) return none;
    if (read !== null) others.push(read);
  }
  return { primaryNumber, otherNumbers: Object.freeze(others) };
}

/**
 * Read the contact profile from the `application.info` results and, when the
 * job has it, the `candidate.info` results.
 *
 * Name and email take the first source that carries a value, and that value
 * then passes its rules or is null — a refused root value does not fall back
 * to the embedded copy. The returned object is frozen, and its `toJSON` (not
 * enumerable, so spreads and key lists never see it) returns
 * {@link ASHBY_PROFILE_JSON_MARKER}.
 */
export function extractAshbyCandidateProfile(
  applicationInfoResults: unknown,
  candidateInfoResults?: unknown,
): AshbyCandidateProfile {
  const sources = profileSources(applicationInfoResults, candidateInfoResults);
  const rawName = sources.map((s) => s.name).find(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  );
  const rawEmail = firstValue(sources, 'primaryEmailAddress')
    ?? primaryFirst(sources, 'emailAddresses').map(itemValue).find((v) => v !== null)
    ?? null;
  const profile: AshbyCandidateProfile = {
    name: rawName === undefined ? null : sanitizeName(rawName),
    email: rawEmail === null ? null : sanitizeEmail(rawEmail),
    ...readNumbers(sources),
  };
  Object.defineProperty(profile, 'toJSON', {
    value: () => ASHBY_PROFILE_JSON_MARKER,
    enumerable: false,
  });
  return Object.freeze(profile);
}

/**
 * The application's Ashby status (`Active`, `Archived`, `Hired`, `Lead`), or
 * null when the field is absent. Not personal data.
 *
 * A present status is never coerced to null: the profile job reads null as
 * "field absent, proceed", so an unreadable status must stay a string that is
 * not `Active`. Truncation keeps that true — a cut value is 64 characters long.
 */
export function extractAshbyApplicationStatus(results: unknown): string | null {
  const root = asObject(results);
  if (!root) return null;
  const app = asObject(root.application) ?? root;
  return typeof app.status === 'string' ? app.status.slice(0, MAX_STATUS_LEN) : null;
}
