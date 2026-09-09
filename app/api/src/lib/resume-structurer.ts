/**
 * resume-structurer.ts — the bounded MODEL structuring step, shared by the
 * recruiter upload route and the Ashby ingestion port.
 *
 * ── WHY THIS IS ONE MODULE AND NOT TWO CALL SITES ───────────────────────────
 *
 * Its output is the ONLY thing permitted to become a dialable phone number
 * (`lib/candidate-phone.ts`). Two call sites each doing their own
 * `runClaudeJSON<ParsedResume>(...)` and trusting the result would be two
 * different definitions of "the model said so", and the weaker one would
 * decide who gets called. There is one definition, here.
 *
 * ── THE CAST THIS REPLACES ──────────────────────────────────────────────────
 *
 * `runClaudeJSON<ParsedResume>(...)` is a CAST, not a check: the runner parses
 * JSON and hands back whatever shape arrived. Nothing verified that `phone`
 * was a string. A model returning `{"phone": 9876543210}` — a number, which is
 * a perfectly ordinary thing for a model to emit — would previously have
 * reached `normalizePhone`, whose first act is `raw.trim()`, and thrown a
 * TypeError on a value that was never a phone number. So the validation below
 * is not defensive decoration; it closes a real crash and a real provenance
 * hole in one place.
 *
 * ── FAIL-SOFT, ALWAYS ───────────────────────────────────────────────────────
 *
 * `structureResumeWithModel` NEVER throws and NEVER rejects. A provider
 * outage, an open circuit breaker, a timeout, unparseable output or a
 * malformed shape all produce the same answer: `null`. The caller then uses
 * the deterministic extractor and tags the result with a NON-dialable
 * provenance. Model structuring failing must never fail an ingestion — a
 * resume that was fetched, scanned and parsed is still a good resume.
 */

import type { ParsedResume } from './types.js';
import { buildExtractionPrompt } from './prompts.js';
import { runClaudeJSON } from './claude.js';
import { BusinessError, ProviderError } from './provider-resilience.js';
import { deriveExperienceYearsFromRoles } from './resume-experience.js';

/**
 * The model call, as a seam.
 *
 * Injectable so that no test ever reaches a provider: every test supplies its
 * own runner. The default is the shared runner from `lib/claude.js`, which
 * already carries the circuit breaker, the wall-clock timeout, the bounded
 * output and the one bounded JSON retry — this module adds no provider
 * configuration, no key handling and no second resilience policy of its own.
 */
export type ResumeModelRunner = (prompt: string) => Promise<unknown>;

// ── Model-call concurrency bound (P1) ───────────────────────────────────────
//
// The runner spawns ONE external provider call per résumé. The parser pool
// bounds how many DOCUMENTS parse at once, but the model call happens INSIDE
// the parse port, so once pool concurrency is raised (a later change) hundreds
// of model calls could be in flight at once and stampede the provider. This
// counting semaphore bounds concurrent model calls INDEPENDENTLY of the parser
// pool, so raising pool concurrency does not raise provider fan-out.
//
// This is a call-rate bound, not provider configuration: no key, no endpoint,
// no model selection lives here — those remain entirely inside the shared
// runner from `lib/claude.js`. The only env this module reads is this integer
// cap. ENV CONTRACT: `RESUME_MODEL_MAX_CONCURRENCY` must be declared in the
// environment schema by the env-schema owner (see the report accompanying this
// change) — it is read here with a safe clamped default so a missing
// declaration degrades to the default rather than crashing.

/** Concurrency cap default and clamp bounds. */
const MODEL_CONCURRENCY_DEFAULT = 4;
const MODEL_CONCURRENCY_MIN = 1;
const MODEL_CONCURRENCY_MAX = 64;

/**
 * How long a call may WAIT for a semaphore slot before it gives up. A wait that
 * exceeds this falls through to `null` (deterministic fallback) — it NEVER
 * throws into the caller and never becomes an ingestion failure. Bounds the
 * worst-case queue latency a single résumé can add under saturation.
 */
const MODEL_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * Parse the concurrency cap from the environment, clamped into range. A missing
 * or malformed value degrades to the default rather than throwing at import —
 * this module must never be the reason a server fails to start.
 */
function resolveModelConcurrency(): number {
  const raw = process.env.RESUME_MODEL_MAX_CONCURRENCY;
  if (raw === undefined || raw === '') return MODEL_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return MODEL_CONCURRENCY_DEFAULT;
  if (n < MODEL_CONCURRENCY_MIN) return MODEL_CONCURRENCY_MIN;
  if (n > MODEL_CONCURRENCY_MAX) return MODEL_CONCURRENCY_MAX;
  return n;
}

/**
 * A minimal in-module counting semaphore.
 *
 * `acquire` resolves when a slot is free, or resolves to `false` if the wait
 * exceeds `timeoutMs` (the caller then falls back to the deterministic
 * extractor). `release` frees a slot and hands it to the oldest waiter. No
 * timers leak: the timeout handle is cleared whether the slot is granted or the
 * wait expires, and an expired waiter is removed from the queue so a later
 * `release` cannot hand a slot to a caller that already gave up.
 */
class CountingSemaphore {
  private available: number;

  /** Clamped once at construction so `available` and the `release` guard agree. */
  private readonly capacity: number;

  private readonly waiters: Array<{ grant: () => void }> = [];

  constructor(capacity: number) {
    // Clamp to a minimum of one slot. If both `available` started clamped but
    // the release guard compared against the RAW `capacity` (0), the freed slot
    // would never be restored and the semaphore would wedge after the first
    // release. Storing the clamped value once keeps the two in lockstep.
    this.capacity = Math.max(1, capacity);
    this.available = this.capacity;
  }

  async acquire(timeoutMs: number): Promise<boolean> {
    if (this.available > 0) {
      this.available -= 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      const entry = {
        grant: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(entry);
        if (at !== -1) this.waiters.splice(at, 1);
        resolve(false);
      }, timeoutMs);
      // Node timers keep the event loop alive; a screening API should not be
      // held open by a pending acquire wait.
      if (typeof timer.unref === 'function') timer.unref();
      this.waiters.push(entry);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next.grant();
      return;
    }
    if (this.available < this.capacity) this.available += 1;
  }
}

/** Process-wide semaphore. Sized once at module load from the clamped env. */
let modelSemaphore = new CountingSemaphore(resolveModelConcurrency());

/** Wait budget for a slot; overridable in tests to force fast saturation. */
let modelAcquireTimeoutMs = MODEL_ACQUIRE_TIMEOUT_MS;

/**
 * TEST SEAM ONLY. Re-sizes the module semaphore and (optionally) the acquire
 * wait budget so a suite can prove the bound holds and that saturation falls
 * through to `null` without a 30-second wait or a live provider. Returns a
 * restore function. Not part of the production contract — production sizes the
 * semaphore once from the clamped env at module load and never calls this.
 */
export function __setModelConcurrencyForTest(
  capacity: number,
  acquireTimeoutMs?: number,
): () => void {
  const prevSem = modelSemaphore;
  const prevTimeout = modelAcquireTimeoutMs;
  modelSemaphore = new CountingSemaphore(capacity);
  if (acquireTimeoutMs !== undefined) modelAcquireTimeoutMs = acquireTimeoutMs;
  return () => {
    modelSemaphore = prevSem;
    modelAcquireTimeoutMs = prevTimeout;
  };
}

/**
 * Production runner: the shared bounded provider path, in provider JSON mode.
 *
 * `responseFormat: 'json_object'` asks DeepSeek to constrain the answer to one
 * valid JSON object. Before this the model was free to wrap the object in
 * prose or a fence, and the runner's `extractJson` slice was the only thing
 * standing between that and a `parse_error` surrender to the keyword
 * extractor. The extraction prompt already contains the word "json" (the
 * provider's precondition for the mode) — `resume-extraction-prompt.test.ts`
 * pins that so the two cannot drift apart.
 */
export const defaultResumeModelRunner: ResumeModelRunner = (prompt) =>
  runClaudeJSON<unknown>(prompt, { responseFormat: 'json_object' });

// ── Bounds ──────────────────────────────────────────────────────────────────
//
// Chosen to match what the deterministic extractor already produces, so the
// two structurers cannot disagree about how big a field may be.

/** Display strings (`name`, `email`, `current_role`). Truncated if longer. */
const MAX_DISPLAY_LEN = 200;
/** `summary` — the same 500 the deterministic extractor slices to. */
const MAX_SUMMARY_LEN = 500;
/** `skills` — the same 30 the deterministic extractor caps at. */
const MAX_SKILLS = 30;
/** One skill string. */
const MAX_SKILL_LEN = 80;
/**
 * `phone`. A generous ceiling for punctuation and a country code; anything
 * beyond it is not a phone number.
 */
const MAX_PHONE_LEN = 64;
/** A sane human range; outside it the value is noise, not an answer. */
const MAX_EXPERIENCE_YEARS = 80;
/** Rich screening context remains small enough for prompt and storage bounds. */
const MAX_ROLE_EVIDENCE = 5;
const MAX_ROLE_HIGHLIGHTS = 5;
const MAX_CAREER_HIGHLIGHTS = 8;
const MAX_EDUCATION = 6;
const MAX_CERTIFICATIONS = 6;
const MAX_EVIDENCE_LEN = 240;

/** `undefined` (key absent) and `null` both mean "the model had no value". */
function absent(v: unknown): boolean {
  return v === undefined || v === null;
}

/**
 * Strings a model emits to mean "no value". Treated as null for every scalar
 * field so `"experience_years": "N/A"` or `"phone": "not provided"` never
 * become stored facts. Matched whole, case-insensitively, after trimming.
 */
const NULL_WORDS = new Set([
  'null', 'none', 'n/a', 'na', 'nil', 'unknown', 'not specified', 'not provided',
  'not available', 'not mentioned', 'unspecified', '-', '—', '--',
]);

function isNullWord(s: string): boolean {
  return NULL_WORDS.has(s.trim().toLowerCase());
}

// ── TOLERANT COERCION, AND WHY THE STRICT VERSION HAD TO GO ─────────────────
//
// The previous validator rejected the WHOLE result when any present key had
// the wrong JSON type — a number where a string was expected, a string where
// an array was expected, a role given as "Sales Manager at Acme" instead of an
// object. The stated rationale was safety: "a wrong shape is not a partially
// good answer, falling back is safer".
//
// Measured against what models actually emit, that rule was the single largest
// source of silent degradation. `"experience_years": "5+"`, `"phone":
// 9876543210`, `"skills": "Sales, CRM, Excel"`, `"education": "MBA"` are all
// ORDINARY answers, and each one threw the entire structured résumé away and
// replaced it with the keyword extractor's `Sales / Communication / Excel`
// — and, because the regex tag is not dialable, an UNCALLABLE candidate. The
// safety the strictness bought was nil: the dialing decision never rested on
// the shape check. It rests on `deriveCandidatePhone`'s strict `+91[6-9]…`
// gate and the provenance allowlist, both of which run downstream of this
// module on every path and are untouched.
//
// So each field now coerces the values a model plausibly returns and NULLS
// only itself when it cannot. The whole result is rejected in exactly two
// cases that remain genuinely not-a-résumé: the answer is not a plain object,
// or reading it throws (a hostile getter).

/**
 * Coerce a scalar to a display string. Numbers and booleans are rendered;
 * a one-element string array unwraps; an array of several strings joins with
 * a space (a summary the model split into sentences). Objects, empty strings
 * and null-words are `null`. Never throws for a value `JSON.parse` can yield.
 */
function coerceString(v: unknown, max: number): string | null {
  if (absent(v)) return null;
  let s: string;
  if (typeof v === 'string') {
    s = v;
  } else if (typeof v === 'number' || typeof v === 'boolean') {
    s = String(v);
  } else if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    if (parts.length === 0) return null;
    s = parts.join(' ');
  } else {
    return null;
  }
  const trimmed = s.trim();
  if (trimmed === '' || isNullWord(trimmed)) return null;
  return trimmed.slice(0, max);
}

/**
 * A minimal email shape check.
 *
 * `phone` has a strict format gate, a provenance allowlist and a re-assertion
 * at the column write. `email` had none of that, so a model answering
 * `{"email": "see resume"}` wrote `see resume` into `candidates.email` — a
 * field the deterministic extractor could only ever fill with something
 * email-SHAPED, because it finds it with a regex. This restores that floor.
 * It is a shape check, not a validity claim: nothing here asserts the address
 * exists or is deliverable.
 */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function coerceEmail(v: unknown, max: number): string | null {
  const s = coerceString(v, max);
  if (s === null) return null;
  return EMAIL_SHAPE.test(s) ? s : null;
}

/** Separators a model uses when it flattens a list into one string. */
const LIST_SPLIT_RE = /\s*(?:[,;|•·\n]|\s{2,}-\s+|^\s*-\s+)\s*/;

/**
 * Coerce a list field. An array keeps its string entries (non-string entries
 * are skipped, never fatal); a single string is SPLIT on list separators —
 * `"Sales, CRM, Excel"` is the same answer as `["Sales","CRM","Excel"]`;
 * anything else is an empty list. Trimmed, bounded, case-insensitively
 * de-duplicated, order preserved.
 */
function coerceStringList(v: unknown, limit: number, itemLimit: number): string[] {
  if (absent(v)) return [];
  let items: unknown[];
  if (Array.isArray(v)) {
    items = v;
  } else if (typeof v === 'string') {
    items = isNullWord(v) ? [] : v.split(LIST_SPLIT_RE);
  } else {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    // A non-string ENTRY is skipped rather than fatal: one bad element in an
    // otherwise good list is noise, and these fields decide nothing dangerous.
    // A short object entry with a `name`/`title` (a "skill" the model wrapped)
    // is unwrapped rather than lost.
    let s: string | null = null;
    if (typeof item === 'string') {
      s = item;
    } else if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const rec = item as Record<string, unknown>;
      const inner = ['name', 'title', 'skill', 'value', 'text'].map((k) => rec[k]).find((x) => typeof x === 'string');
      if (typeof inner === 'string') s = inner;
    }
    if (s === null) continue;
    s = s.trim().slice(0, itemLimit);
    if (s === '' || isNullWord(s) || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

function coerceSkills(v: unknown): string[] {
  return coerceStringList(v, MAX_SKILLS, MAX_SKILL_LEN);
}

type RoleEvidence = NonNullable<ParsedResume['recent_role']>;

/** Aliases a model uses for the role-evidence keys. First present wins. */
const ROLE_KEY_ALIASES: Readonly<Record<keyof RoleEvidence, readonly string[]>> = {
  title: ['title', 'role', 'position', 'job_title', 'designation'],
  employer: ['employer', 'company', 'organization', 'organisation', 'org'],
  period: ['period', 'dates', 'duration', 'tenure', 'date_range', 'years'],
  highlights: ['highlights', 'achievements', 'responsibilities', 'bullets'],
};

/**
 * Coerce one role. An object is read by key (with the common aliases above);
 * a plain string — `"Senior Sales Executive at Acme (2021–Present)"` — becomes
 * a role whose `title` is that string, which is exactly what the deterministic
 * extractor produces for prose roles, so nothing downstream sees a new shape.
 * Anything else, or a role with no content, is `null`.
 */
function coerceRoleEvidence(v: unknown): RoleEvidence | null {
  if (absent(v)) return null;
  if (typeof v === 'string') {
    const title = coerceString(v, MAX_DISPLAY_LEN);
    return title ? { title, employer: null, period: null, highlights: [] } : null;
  }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  const pick = (aliases: readonly string[]): unknown => {
    for (const k of aliases) if (Object.hasOwn(r, k) && !absent(r[k])) return r[k];
    return undefined;
  };
  const role = {
    title: coerceString(pick(ROLE_KEY_ALIASES.title), MAX_DISPLAY_LEN),
    employer: coerceString(pick(ROLE_KEY_ALIASES.employer), MAX_DISPLAY_LEN),
    period: coerceString(pick(ROLE_KEY_ALIASES.period), MAX_DISPLAY_LEN),
    highlights: coerceStringList(pick(ROLE_KEY_ALIASES.highlights), MAX_ROLE_HIGHLIGHTS, MAX_EVIDENCE_LEN),
  };
  return role.title || role.employer || role.period || role.highlights.length > 0 ? role : null;
}

/**
 * Coerce the prior-roles list. An array coerces each entry (strings and
 * objects alike, see `coerceRoleEvidence`); a lone object or string is one
 * role; anything else is empty. Bounded to {@link MAX_ROLE_EVIDENCE}.
 */
function coercePriorRoles(v: unknown): RoleEvidence[] {
  if (absent(v)) return [];
  const items: unknown[] = Array.isArray(v) ? v : [v];
  const roles: RoleEvidence[] = [];
  for (const item of items) {
    const role = coerceRoleEvidence(item);
    if (role) roles.push(role);
    if (roles.length >= MAX_ROLE_EVIDENCE) break;
  }
  return roles;
}

/** Leading decimal in a years string: "5+", "5.5 years", "6 yrs", "7-9 years" → 5, 5.5, 6, 7. */
const YEARS_IN_STRING_RE = /^\D{0,12}?(\d{1,3}(?:\.\d{1,2})?)/;

/**
 * Coerce total years. A JSON number is taken as-is; a string with a leading
 * figure (`"5+"`, `"5 years"`, `"6.5"`) yields that figure. Out-of-range,
 * non-finite or unparseable values null ONLY this field.
 */
function coerceYears(v: unknown): number | null {
  if (absent(v)) return null;
  let n: number;
  if (typeof v === 'number') {
    n = v;
  } else if (typeof v === 'string') {
    if (isNullWord(v)) return null;
    const m = v.trim().match(YEARS_IN_STRING_RE);
    if (!m) return null;
    n = Number(m[1]);
  } else {
    return null;
  }
  // NaN and Infinity are `number`-typed but are not answers — out of range,
  // so the field is nulled and the rest of the result survives.
  if (!Number.isFinite(n) || n < 0 || n > MAX_EXPERIENCE_YEARS) return null;
  return n;
}

/**
 * The phone field, and the one place truncation is REFUSED.
 *
 * Every other string here is sliced to a bound, because a shortened name or
 * summary is a visibly shortened version of the same thing. A shortened phone
 * number is a DIFFERENT phone number — quite possibly someone else's — and
 * this field is the one that decides who gets called. So an over-long value is
 * discarded outright rather than trimmed to fit.
 */
function coercePhone(v: unknown): string | null {
  if (absent(v)) return null;
  let s: string;
  if (typeof v === 'string') {
    s = v;
  } else if (typeof v === 'number') {
    // `{"phone": 9876543210}` — a JSON number — is an ordinary model answer.
    // It used to reject the WHOLE result. Rendered as its integer digits it is
    // exactly the string the model would otherwise have returned; anything
    // non-integer or beyond safe-integer precision is not a phone number, and
    // the strict downstream gate still decides whether the digits may be
    // dialed. Nothing about dialability is decided here.
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    s = String(v);
  } else if (Array.isArray(v)) {
    // Several numbers listed: take the first string entry. The rest are lost
    // rather than guessed at — one candidate, one number.
    const first = v.find((x) => typeof x === 'string');
    if (typeof first !== 'string') return null;
    s = first;
  } else {
    return null;
  }
  // Collapse a country-code plus written as "+ 91 ..." to the canonical "+91
  // ..." a model sometimes emits when it echoes the leading-"+" instruction
  // with a stray space. The downstream `normalizePhone` strips inner spaces
  // anyway, but this stores the canonical form and — more importantly — keeps
  // the "+" ADJACENT to the digits so the strict `^\+91[6-9]...` provenance
  // gate cannot be defeated by a space the model inserted. Only the FIRST
  // "+  " run is collapsed; a "+" appearing mid-string is left alone.
  const trimmed = s.trim().replace(/^\+\s+/, '+');
  if (trimmed === '' || isNullWord(trimmed) || trimmed.length > MAX_PHONE_LEN) return null;
  return trimmed;
}

/**
 * Validate and normalize raw model output into the approved structured shape.
 *
 * Returns `null` when the output is not a usable structured resume — the
 * signal to fall back to the deterministic extractor with a non-dialable
 * provenance tag. Never throws.
 */
export function coerceStructuredResume(raw: unknown): ParsedResume | null {
  // Inside no `try` yet, but `Array.isArray` can itself throw on a REVOKED
  // Proxy, and this function's contract is "never throws" without an asterisk.
  try {
    return coerceChecked(raw);
  } catch {
    return null;
  }
}

function coerceChecked(raw: unknown): ParsedResume | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  /**
   * OWN properties only, never inherited ones.
   *
   * `JSON.parse` output normally has a clean prototype, but this value decides
   * whether a person gets phoned, and an inherited `phone` — from prototype
   * pollution anywhere else in the process — would be indistinguishable from
   * one the model actually returned. Reading own properties makes that
   * impossible rather than unlikely. A property whose getter throws is caught
   * by the try below and rejects the whole result.
   */
  const own = (k: string): unknown => (Object.hasOwn(r, k) ? r[k] : undefined);
  try {
    const recent_role = coerceRoleEvidence(own('recent_role'));
    const prior_roles = coercePriorRoles(own('prior_roles'));
    const current_role = coerceString(own('current_role'), MAX_DISPLAY_LEN);
    return {
      name: coerceString(own('name'), MAX_DISPLAY_LEN),
      email: coerceEmail(own('email'), MAX_DISPLAY_LEN),
      phone: coercePhone(own('phone')),
      skills: coerceSkills(own('skills')),
      // The model's own figure when it gave one; otherwise the sum of the dated
      // roles it copied (see `lib/resume-experience.ts`). Arithmetic over dates
      // that are present, never a guess about dates that are not.
      experience_years: coerceYears(own('experience_years'))
        ?? deriveExperienceYearsFromRoles([recent_role, ...prior_roles]),
      // A model that filled `recent_role.title` but left `current_role` empty
      // has still named the current role; mirror it so the dashboard column and
      // the interviewer's "current role" evidence agree.
      current_role: current_role ?? recent_role?.title ?? null,
      summary: coerceString(own('summary'), MAX_SUMMARY_LEN),
      recent_role,
      prior_roles,
      career_highlights: coerceStringList(own('career_highlights'), MAX_CAREER_HIGHLIGHTS, MAX_EVIDENCE_LEN),
      education: coerceStringList(own('education'), MAX_EDUCATION, MAX_EVIDENCE_LEN),
      certifications: coerceStringList(own('certifications'), MAX_CERTIFICATIONS, MAX_EVIDENCE_LEN),
    };
  } catch {
    // A hostile getter on a parsed object, or anything else unexpected.
    // Either way: not a usable structured resume.
    return null;
  }
}

/**
 * The result of combining the two structurers.
 */
export interface MergedStructure {
  structured: ParsedResume;
  /**
   * Whether `structured.phone` came from the MODEL.
   *
   * This is the ONLY input to the dialing provenance. A phone the model did
   * not produce — one rescued from the deterministic extractor — must not be
   * dialable even though the rest of the result is model-authored.
   */
  phoneFromModel: boolean;
}

/**
 * Combine a model result with the deterministic extractor's, field by field.
 *
 * ── WHY A MERGE AND NOT A CHOICE ────────────────────────────────────────────
 *
 * Returning the model result INSTEAD of the deterministic one loses data. A
 * model that drops a phone number sitting in a header or footer — routine
 * behaviour — still returns a name, and `usefulStructured` in the ingestion is
 * an OR across all seven fields, so the deterministic rescue never runs. The
 * candidate is then written with `phone_raw: null` and `email: null` where the
 * pre-change regex path would have populated both. A change made to let
 * candidates be CALLED would have made that candidate less contactable than
 * before, on exactly the field it exists for.
 *
 * So the model wins per FIELD where it produced something, and the regex fills
 * every gap. Nothing is lost relative to the old behaviour, and everything the
 * model adds is gained.
 *
 * ── AND WHY THE PHONE IS TRACKED SEPARATELY ─────────────────────────────────
 *
 * Merging must not launder provenance. If the phone came from the regex, the
 * caller has to tag the result non-dialable even though `name` and `summary`
 * are model-authored — otherwise the merge would quietly promote exactly the
 * digit-run false positives the provenance gate exists to refuse.
 */
export function mergeStructuredResume(
  model: ParsedResume,
  deterministic: ParsedResume,
): MergedStructure {
  const pick = (m: string | null, d: string | null): string | null => (m !== null ? m : d);
  return {
    structured: {
      name: pick(model.name, deterministic.name),
      email: pick(model.email, deterministic.email),
      phone: pick(model.phone, deterministic.phone),
      skills: model.skills.length > 0 ? model.skills : deterministic.skills,
      // Model figure, else the regex's stated-phrase figure, else the sum of
      // whichever side's dated roles parse. The model's roles are tried first
      // because they carry `period`; the regex's never do today, but the merge
      // should not depend on that.
      experience_years: model.experience_years
        ?? deterministic.experience_years
        ?? deriveExperienceYearsFromRoles([
          model.recent_role, ...(model.prior_roles ?? []),
          deterministic.recent_role, ...(deterministic.prior_roles ?? []),
        ]),
      current_role: pick(model.current_role, deterministic.current_role),
      summary: pick(model.summary, deterministic.summary),
      recent_role: model.recent_role ?? deterministic.recent_role ?? null,
      prior_roles: (model.prior_roles?.length ?? 0) > 0 ? model.prior_roles : deterministic.prior_roles ?? [],
      career_highlights: (model.career_highlights?.length ?? 0) > 0
        ? model.career_highlights : deterministic.career_highlights ?? [],
      education: (model.education?.length ?? 0) > 0 ? model.education : deterministic.education ?? [],
      certifications: (model.certifications?.length ?? 0) > 0
        ? model.certifications : deterministic.certifications ?? [],
    },
    // No phone from either side means nothing is dialable regardless, so the
    // model remains the structurer of record.
    phoneFromModel: model.phone !== null || deterministic.phone === null,
  };
}

// ── Failure taxonomy (observability) ────────────────────────────────────────
//
// A closed set of SANITIZED, stable category codes describing WHY the model
// tier produced no answer. Categories name OUR MACHINE, never the document:
// no résumé content, no model echo, no PII can ride one of these strings.
// `protocol:<status>` carries only the HTTP status integer.

/** Why the model tier surrendered. Stable machine codes — never content. */
export type ResumeModelFailureCategory =
  | 'slot_timeout'      // no semaphore slot freed within the wait budget
  | 'timeout'           // provider call exceeded its wall clock
  | 'circuit_open'      // breaker refused the call outright
  | 'parse_error'       // output was not JSON, twice (runner's bounded retry)
  | 'shape_rejected'    // JSON arrived but was not a usable structured resume
  | 'missing_api_key'   // no provider credential configured
  | 'connection'        // transport-level failure before a response
  | 'output_limit'      // response exceeded the byte bound
  | 'protocol'          // non-OK response with no usable status
  | `protocol:${number}` // non-OK response, e.g. 'protocol:429', 'protocol:502'
  | 'unknown';

/** The model tier's answer plus, on surrender, the sanitized reason. */
export interface ResumeModelOutcome {
  structured: ParsedResume | null;
  /** `null` on success; a stable {@link ResumeModelFailureCategory} otherwise. */
  failure: ResumeModelFailureCategory | null;
}

/**
 * Map a thrown runner error to a sanitized category. Reads only the stable
 * `category`/`status` fields the shared runner's error types carry (
 * `DeepseekError`, `ProviderError`) — never the message of an arbitrary error,
 * which could echo content.
 */
function classifyModelFailure(err: unknown): ResumeModelFailureCategory {
  if (err instanceof BusinessError) return 'parse_error';
  if (err === null || typeof err !== 'object') return 'unknown';
  const category = (err as { category?: unknown }).category;
  if (typeof category !== 'string') return 'unknown';
  switch (category) {
    case 'timeout':
    case 'circuit_open':
    case 'missing_api_key':
    case 'connection':
    case 'output_limit':
    case 'parse_error':
      return category;
    case 'protocol': {
      const status = (err as { status?: unknown }).status;
      return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? (`protocol:${status}` as ResumeModelFailureCategory)
        : 'protocol';
    }
    default:
      return 'unknown';
  }
}

/**
 * TRANSIENT provider failures — the only ones worth ONE bounded in-tier retry:
 * a wall-clock timeout, a 429 and a 5xx are all statements about the
 * provider's moment, not about the request. Everything else is either already
 * retried by the runner (the bounded JSON re-ask that surfaces as
 * `BusinessError`/`parse_error` — retrying it HERE would double it), or is a
 * deterministic answer that a retry cannot change (4xx protocol,
 * missing key, open breaker, output limit).
 */
function isTransientModelFailure(err: unknown): boolean {
  if (err instanceof BusinessError) return false;
  if (err === null || typeof err !== 'object') return false;
  const category = (err as { category?: unknown }).category;
  // `circuit_open` is a statement about the LAST few calls, not this résumé:
  // the shared breaker trips on five consecutive provider failures from ANY
  // DeepSeek caller in the process (the scorer included) and stays open for
  // its cooldown. Before this it surrendered instantly and every résumé that
  // arrived during the cooldown became a keyword-extracted, undialable row —
  // the "burst of fallback rows" signature. The ladder below outlasts one
  // cooldown, so a breaker that closes again is given the chance to answer.
  if (category === 'timeout' || category === 'connection' || category === 'circuit_open') return true;
  if (category === 'protocol') {
    const status = (err as { status?: unknown }).status;
    return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
  }
  return false;
}

/**
 * The bounded transient-retry LADDER, in milliseconds of backoff before each
 * retry. Three retries, four attempts in total. The steps sum to 42s — chosen
 * to exceed the breaker's default 30s cooldown (`BREAKER_COOLDOWN_MS`), so a
 * `circuit_open` seen on the first attempt can be retried after the breaker
 * has had the chance to half-open. Under a genuine outage a résumé therefore
 * costs at most ~42s plus four provider timeouts before it falls back, and
 * the semaphore slot is held throughout so the fan-out bound is unchanged.
 */
const TRANSIENT_RETRY_BACKOFF_LADDER_MS: readonly number[] = [2_000, 8_000, 32_000];

/** Overridable in tests so the retry path needs no real waits. */
let transientRetryBackoffLadderMs: readonly number[] = TRANSIENT_RETRY_BACKOFF_LADDER_MS;

/**
 * TEST SEAM ONLY. Replaces every step of the retry ladder with `ms` (the
 * ladder LENGTH — and so the attempt count — is unchanged). Returns a restore
 * function. Production always waits the constants above.
 */
export function __setModelRetryBackoffForTest(ms: number): () => void {
  const prev = transientRetryBackoffLadderMs;
  transientRetryBackoffLadderMs = TRANSIENT_RETRY_BACKOFF_LADDER_MS.map(() => ms);
  return () => {
    transientRetryBackoffLadderMs = prev;
  };
}

/** Attempts the model tier makes per résumé at most (1 + ladder length). */
export const MODEL_MAX_ATTEMPTS = 1 + TRANSIENT_RETRY_BACKOFF_LADDER_MS.length;

/** Unref'd sleep — a pending backoff must not hold the process open. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}

/**
 * Structure one resume text with the bounded model runner, reporting WHY on
 * surrender.
 *
 * NEVER throws and NEVER rejects. `structured: null` means "use the
 * deterministic extractor and do not mark the result dialable", and `failure`
 * then carries the sanitized category so the CALLER can log it.
 *
 * Nothing here logs, and that is still deliberate: the values in scope are
 * the resume text and the model's echo of it, so the only PII-free thing
 * worth saying is the failure CATEGORY — which is exactly what this returns,
 * for the caller at the fallback branch to emit (see the Ashby parse port).
 * The durable ingestion row still records `structurerVersion`, so an outage
 * remains visible at rest; the category is what makes it DIAGNOSABLE.
 *
 * ── A BOUNDED IN-TIER RETRY LADDER ──────────────────────────────────────────
 * A TRANSIENT provider failure (timeout / connection / 429 / 5xx / open
 * breaker) is retried after each step of {@link TRANSIENT_RETRY_BACKOFF_LADDER_MS}
 * — three retries, four attempts — holding the already-acquired semaphore
 * slot: the slot bounds provider fan-out, and a retry IS a provider call, so
 * releasing and re-acquiring would let saturation multiply the fan-out.
 * JSON-parse failures are NOT retried here: the shared runner already re-asks
 * once, and a second layer of retry would quietly square the provider load.
 */
export async function structureResumeWithModelDetailed(
  text: string,
  runner: ResumeModelRunner = defaultResumeModelRunner,
): Promise<ResumeModelOutcome> {
  // Bound concurrent model calls. If no slot frees within the wait budget the
  // call falls through to the deterministic fallback — saturation must degrade
  // the answer, never throw into the caller or fail the ingestion.
  const acquired = await modelSemaphore.acquire(modelAcquireTimeoutMs);
  if (!acquired) return { structured: null, failure: 'slot_timeout' };
  try {
    // `buildExtractionPrompt` already slices the text to 12k before it reaches
    // a provider — the prompt bound is not re-implemented here.
    const prompt = buildExtractionPrompt(text);
    let raw: unknown;
    // The bounded ladder, slot still held (see the doc comments above). A
    // non-transient failure surrenders immediately with its own category; a
    // transient one is retried after each step of the ladder and, when the
    // ladder is exhausted, surrenders with the LAST failure's category.
    let attempt = 0;
    for (;;) {
      try {
        raw = await runner(prompt);
        break;
      } catch (err) {
        if (!isTransientModelFailure(err) || attempt >= transientRetryBackoffLadderMs.length) {
          return { structured: null, failure: classifyModelFailure(err) };
        }
        await sleep(transientRetryBackoffLadderMs[attempt]);
        attempt += 1;
      }
    }
    const structured = coerceStructuredResume(raw);
    return structured !== null
      ? { structured, failure: null }
      : { structured: null, failure: 'shape_rejected' };
  } catch (err) {
    // Anything unexpected (a throwing prompt builder, a hostile value). Still
    // "no model answer", never an ingestion failure.
    return { structured: null, failure: classifyModelFailure(err) };
  } finally {
    // Always released — including on every surrender path above — so a
    // failing call never permanently consumes a slot.
    modelSemaphore.release();
  }
}

/**
 * Structure one resume text with the bounded model runner.
 *
 * NEVER throws and NEVER rejects. `null` means "use the deterministic
 * extractor and do not mark the result dialable". Callers that want to know
 * WHY use {@link structureResumeWithModelDetailed}; this wrapper keeps the
 * original contract for callers that do not.
 */
export async function structureResumeWithModel(
  text: string,
  runner: ResumeModelRunner = defaultResumeModelRunner,
): Promise<ParsedResume | null> {
  return (await structureResumeWithModelDetailed(text, runner)).structured;
}
