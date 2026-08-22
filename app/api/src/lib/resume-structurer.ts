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

function coerceSkills(v: unknown): string[] {
  if (absent(v)) return [];
  if (!Array.isArray(v)) throw new MalformedShape();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    // A non-string ENTRY is skipped rather than fatal: one bad element in an
    // otherwise good list is noise, and skills decide nothing dangerous.
    if (typeof item !== 'string') continue;
    const s = item.trim().slice(0, MAX_SKILL_LEN);
    if (s === '' || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
    if (out.length >= MAX_SKILLS) break;
  }
  return out;
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
  const trimmed = v.trim();
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
    },
    // No phone from either side means nothing is dialable regardless, so the
    // model remains the structurer of record.
    phoneFromModel: model.phone !== null || deterministic.phone === null,
  };
}

/**
 * Structure one resume text with the bounded model runner.
 *
 * NEVER throws and NEVER rejects. `null` means "use the deterministic
 * extractor and do not mark the result dialable".
 *
 * Nothing here logs, and that is deliberate: the only values in scope are the
 * resume text and the model's echo of it, so there is no PII-free thing worth
 * saying. The outcome is already observable without a log line — the durable
 * ingestion row records `structurerVersion`, so a model outage shows up as
 * every row carrying the deterministic tag instead of the model one.
 */
export async function structureResumeWithModel(
  text: string,
  runner: ResumeModelRunner = defaultResumeModelRunner,
): Promise<ParsedResume | null> {
  try {
    // `buildExtractionPrompt` already slices the text to 12k before it reaches
    // a provider — the prompt bound is not re-implemented here.
    const raw = await runner(buildExtractionPrompt(text));
    return coerceStructuredResume(raw);
  } catch {
    // Provider outage, open breaker, timeout, output-limit, unparseable JSON.
    // All of them are "no model answer", none of them is an ingestion failure.
    return null;
  }
}
