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

/** Production runner: the shared bounded provider path. */
export const defaultResumeModelRunner: ResumeModelRunner = (prompt) =>
  runClaudeJSON<unknown>(prompt);

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
 * A present key whose type is wrong means the SHAPE is wrong, and a wrong
 * shape is not a partially-good answer — the whole result is rejected and the
 * caller falls back. Distinguished on purpose from a value that is merely out
 * of RANGE, which nulls only its own field.
 */
class MalformedShape extends Error {}

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

function coerceString(v: unknown, max: number): string | null {
  if (absent(v)) return null;
  if (typeof v !== 'string') throw new MalformedShape();
  const trimmed = v.trim();
  if (trimmed === '') return null;
  return trimmed.slice(0, max);
}

function coerceStringList(v: unknown, limit: number, itemLimit: number): string[] {
  if (absent(v)) return [];
  if (!Array.isArray(v)) throw new MalformedShape();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    // A non-string ENTRY is skipped rather than fatal: one bad element in an
    // otherwise good list is noise, and these fields decide nothing dangerous.
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, itemLimit);
    if (s === '' || seen.has(s.toLowerCase())) continue;
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

function coerceRoleEvidence(v: unknown): RoleEvidence | null {
  if (absent(v)) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw new MalformedShape();
  const r = v as Record<string, unknown>;
  const own = (k: string): unknown => (Object.hasOwn(r, k) ? r[k] : undefined);
  const role = {
    title: coerceString(own('title'), MAX_DISPLAY_LEN),
    employer: coerceString(own('employer'), MAX_DISPLAY_LEN),
    period: coerceString(own('period'), MAX_DISPLAY_LEN),
    highlights: coerceStringList(own('highlights'), MAX_ROLE_HIGHLIGHTS, MAX_EVIDENCE_LEN),
  };
  return role.title || role.employer || role.period || role.highlights.length > 0 ? role : null;
}

function coercePriorRoles(v: unknown): RoleEvidence[] {
  if (absent(v)) return [];
  if (!Array.isArray(v)) throw new MalformedShape();
  const roles: RoleEvidence[] = [];
  for (const item of v) {
    const role = coerceRoleEvidence(item);
    if (role) roles.push(role);
    if (roles.length >= MAX_ROLE_EVIDENCE) break;
  }
  return roles;
}

function coerceYears(v: unknown): number | null {
  if (absent(v)) return null;
  if (typeof v !== 'number') throw new MalformedShape();
  // NaN and Infinity are `number`-typed but are not answers — out of range,
  // so the field is nulled and the rest of the result survives.
  if (!Number.isFinite(v) || v < 0 || v > MAX_EXPERIENCE_YEARS) return null;
  return v;
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
  if (typeof v !== 'string') throw new MalformedShape();
  // Collapse a country-code plus written as "+ 91 ..." to the canonical "+91
  // ..." a model sometimes emits when it echoes the leading-"+" instruction
  // with a stray space. The downstream `normalizePhone` strips inner spaces
  // anyway, but this stores the canonical form and — more importantly — keeps
  // the "+" ADJACENT to the digits so the strict `^\+91[6-9]...` provenance
  // gate cannot be defeated by a space the model inserted. Only the FIRST
  // "+  " run is collapsed; a "+" appearing mid-string is left alone.
  const trimmed = v.trim().replace(/^\+\s+/, '+');
  if (trimmed === '' || trimmed.length > MAX_PHONE_LEN) return null;
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
    return {
      name: coerceString(own('name'), MAX_DISPLAY_LEN),
      email: coerceEmail(own('email'), MAX_DISPLAY_LEN),
      phone: coercePhone(own('phone')),
      skills: coerceSkills(own('skills')),
      experience_years: coerceYears(own('experience_years')),
      current_role: coerceString(own('current_role'), MAX_DISPLAY_LEN),
      summary: coerceString(own('summary'), MAX_SUMMARY_LEN),
      recent_role: coerceRoleEvidence(own('recent_role')),
      prior_roles: coercePriorRoles(own('prior_roles')),
      career_highlights: coerceStringList(own('career_highlights'), MAX_CAREER_HIGHLIGHTS, MAX_EVIDENCE_LEN),
      education: coerceStringList(own('education'), MAX_EDUCATION, MAX_EVIDENCE_LEN),
      certifications: coerceStringList(own('certifications'), MAX_CERTIFICATIONS, MAX_EVIDENCE_LEN),
    };
  } catch {
    // MalformedShape, or anything unexpected thrown by a hostile getter on a
    // parsed object. Either way: not a usable structured resume.
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
      experience_years: model.experience_years !== null
        ? model.experience_years
        : deterministic.experience_years,
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
  if (err instanceof ProviderError && err.category !== 'timeout') return false;
  if (err === null || typeof err !== 'object') return false;
  const category = (err as { category?: unknown }).category;
  if (category === 'timeout') return true;
  if (category === 'protocol') {
    const status = (err as { status?: unknown }).status;
    return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
  }
  return false;
}

/** One short breath before the single transient retry. */
const TRANSIENT_RETRY_BACKOFF_MS = 2_000;

/** Overridable in tests so the retry path needs no real 2-second wait. */
let transientRetryBackoffMs = TRANSIENT_RETRY_BACKOFF_MS;

/**
 * TEST SEAM ONLY. Shrinks the transient-retry backoff. Returns a restore
 * function. Production always waits the constant above.
 */
export function __setModelRetryBackoffForTest(ms: number): () => void {
  const prev = transientRetryBackoffMs;
  transientRetryBackoffMs = ms;
  return () => {
    transientRetryBackoffMs = prev;
  };
}

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
 * ── ONE BOUNDED IN-TIER RETRY ───────────────────────────────────────────────
 * A TRANSIENT provider failure (timeout / 429 / 5xx) is retried exactly once
 * after a short backoff, holding the already-acquired semaphore slot — the
 * slot bounds provider fan-out, and a retry IS a provider call, so releasing
 * and re-acquiring would let saturation double the fan-out. JSON-parse
 * failures are NOT retried here: the shared runner already re-asks once, and
 * a second layer of retry would quietly square the provider load.
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
    try {
      raw = await runner(prompt);
    } catch (err) {
      if (!isTransientModelFailure(err)) {
        return { structured: null, failure: classifyModelFailure(err) };
      }
      // ONE transient retry, slot still held (see the doc comment).
      await sleep(transientRetryBackoffMs);
      try {
        raw = await runner(prompt);
      } catch (err2) {
        return { structured: null, failure: classifyModelFailure(err2) };
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
