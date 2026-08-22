/**
 * candidate-phone.ts — the ONE place a resume-derived number becomes dialable.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * `candidates.phone_e164` / `candidates.phone_valid` are not display fields.
 * They are the admission door of the outbound phone screener: migration 0042's
 * `admit_phone_attempt` reads exactly those two columns, refuses `phone_invalid`
 * on anything that is not a strict Indian mobile, and otherwise turns the value
 * straight into a dial. Writing them is therefore a decision to CALL A PERSON.
 *
 * Two independent guarantees are enforced here, together, because either one
 * alone is insufficient:
 *
 *  1. FORMAT — `phone_e164` is either NULL or matches {@link STRICT_IN_MOBILE_E164},
 *     byte-for-byte the predicate 0042 applies. `libphonenumber` alone is NOT
 *     that predicate: `isValid()` accepts every country and every line type, so
 *     a US number and an Indian LANDLINE both come back `valid: true` and would
 *     be stored as a "valid phone" that admission can only ever refuse.
 *
 *     This is not cosmetic. `apply_phone_event` digests `phone_e164` on opt-out
 *     with NO format check, while admission digests only strict values. A
 *     non-strict number stored here would let an opt-out write a suppression
 *     row, audit `suppression_written: true`, and never match anything at
 *     admission — a consent control that looks applied and is not. Keeping this
 *     column strict-or-NULL is what makes the two digests the same digest.
 *
 *  2. PROVENANCE — only a MODEL-authored structured field may become dialable.
 *     The deterministic rescue extractor (`lib/resume-fallback.ts`) finds a
 *     phone with `/(?:\+?\d[\d\s().-]{7,}\d)/` over flattened resume text. That
 *     pattern matches employee ids, date ranges, PIN+phone runs and bank
 *     fragments. Until now the value it produced only ever landed in
 *     `phone_raw`, which nothing dials, so a false positive was inert. The
 *     moment these columns are populated, the same false positive becomes a
 *     call to a stranger. So the fallback keeps writing `phone_raw` — nothing
 *     regresses — and is structurally incapable of setting `phone_e164` or
 *     `phone_valid`.
 *
 * `phone_raw` is preserved on every path, dialable or not: it is the audited
 * record of what the document actually said, and a recruiter correcting a
 * number needs to see it. It is PII-scoped and role-gated at the API edge; it
 * is never dialed.
 */

import { normalizePhone } from './phone.js';

/**
 * The strict dialability predicate, identical to 0042's.
 *
 * `admit_phone_attempt` (0042:1382) applies `!~ '^\+91[6-9][0-9]{9}$'`. This
 * regex is that string in TypeScript form. It is deliberately NOT derived from
 * a country-code constant or assembled from parts: the DB owns the definition
 * and this is a transcription of it, so a reader can diff the two by eye and a
 * test can assert them equal.
 *
 * Indian mobile numbers begin 6-9 and carry exactly ten subscriber digits.
 * An Indian fixed-line number (`+91 22 ...`) fails on both counts.
 */
export const STRICT_IN_MOBILE_E164 = /^\+91[6-9][0-9]{9}$/;

/**
 * Structurer version tag for the bounded MODEL extraction shared by
 * `routes/resumes.ts` and the Ashby ingestion port. Recorded as provenance,
 * never as PII.
 *
 * ── WHY THIS TAG NAMES NO VENDOR ────────────────────────────────────────────
 *
 * It is deliberately `model-extraction-1` and not a provider name. `lib/claude.ts`
 * exports `runClaudeJSON`, but that export is a COMPATIBILITY ALIAS that has
 * already been repointed at the DeepSeek HTTP runner — its own header says so —
 * and every caller kept the Claude-shaped name without noticing. A provenance
 * tag that said `claude-…` would therefore be describing a model that does not
 * run.
 *
 * That is not a cosmetic problem here. This tag is what decides whether a
 * number may be DIALED, so it has to describe the contract it actually
 * asserts: "produced by the shared bounded model runner, through
 * `buildExtractionPrompt`, and shape-validated by
 * `lib/resume-structurer.ts`". That statement stays true across a runner swap;
 * a vendor name would silently stop being true, exactly as it already did once.
 */
export const MODEL_STRUCTURER_VERSION = 'model-extraction-1';

/**
 * Structurer version tag for the deterministic regex rescue path.
 * Shares the vocabulary of `ASHBY_STRUCTURER_VERSION` on purpose.
 */
export const FALLBACK_STRUCTURER_VERSION = 'deterministic-fallback-1';

/**
 * The ALLOWLIST of structurer tags whose phone output may be dialed.
 *
 * An allowlist rather than a denylist, and that direction is the whole safety
 * property: a structurer added later is undialable until someone deliberately
 * adds it here, instead of being dialable until someone remembers to exclude
 * it. Adding a member is a decision to let that extractor place calls.
 */
const DIALABLE_STRUCTURERS: ReadonlySet<string> = new Set([MODEL_STRUCTURER_VERSION]);

/**
 * Is this structurer tag permitted to produce a dialable number?
 *
 * A `+fallback` suffix is refused regardless of prefix. `runResumeIngestion`
 * marks a model parse that produced nothing useful and was rescued by the
 * deterministic extractor as `<tag>+fallback`; the fields in that result came
 * from the regex, not the model, so the tag's prefix must not launder them.
 */
export function isDialableStructurer(structurerVersion: string | null | undefined): boolean {
  if (!structurerVersion) return false;
  if (structurerVersion.includes('+fallback')) return false;
  return DIALABLE_STRUCTURERS.has(structurerVersion);
}

/**
 * The three candidate columns this module owns. `raw` is always whatever the
 * document said (or null); `e164`/`valid` are the dialing decision.
 */
export interface CandidatePhone {
  /** `candidates.phone_raw` — the extracted string, trimmed, or null. */
  raw: string | null;
  /** `candidates.phone_e164` — strict Indian mobile, or null. Never anything else. */
  e164: string | null;
  /** `candidates.phone_valid` — true only alongside a non-null strict `e164`. */
  valid: boolean;
}

/** The undialable result. `phone_raw` is preserved; nothing can be called. */
function rawOnly(raw: string | null): CandidatePhone {
  return { raw, e164: null, valid: false };
}

/**
 * Derive the three candidate phone columns from one extracted string and the
 * provenance of the extractor that produced it.
 *
 * `normalizePhone` runs first only to produce `phone_raw` — it is pure, and
 * its verdict is deliberately NOT consulted until after provenance. Three
 * gates then apply in order, and each returns raw-only on failure:
 * provenance, then libphonenumber validity, then the strict Indian-mobile
 * format. A fallback-derived value exits at the first gate, so no amount of
 * lucky formatting can promote it.
 *
 * `valid` is true if and only if `e164` is non-null, so the pair can never
 * disagree — the shape `admit_phone_attempt` checks with `coalesce(valid,false)
 * and e164 is not null and e164 ~ strict`.
 */
export function deriveCandidatePhone(
  extracted: string | null | undefined,
  structurerVersion: string | null | undefined,
): CandidatePhone {
  const normalized = normalizePhone(extracted);
  // `normalizePhone` returns '' for a null/empty input; keep the column NULL
  // rather than storing an empty string that reads as "we extracted nothing
  // but wrote something".
  const raw = normalized.raw !== '' ? normalized.raw : null;

  if (!isDialableStructurer(structurerVersion)) return rawOnly(raw);
  if (!normalized.valid || normalized.e164 === null) return rawOnly(raw);
  if (!STRICT_IN_MOBILE_E164.test(normalized.e164)) return rawOnly(raw);

  return { raw, e164: normalized.e164, valid: true };
}

/**
 * Re-assert the invariant at the moment of the COLUMN WRITE.
 *
 * ── WHY THIS EXISTS WHEN `deriveCandidatePhone` ALREADY GUARANTEES IT ───────
 *
 * `CandidatePhone` is a structural interface, so any object of that shape
 * satisfies the persistence seam — TypeScript cannot tell a derived decision
 * from a hand-built one. Today `deriveCandidatePhone` is the only producer, so
 * the invariant holds by CONVENTION. Convention is the wrong strength for this
 * particular guarantee: a later caller (a repair worker, a re-drive, a script
 * reusing the store) writing the perfectly natural
 * `{ e164: '+912212345678', valid: true }` — libphonenumber calls that number
 * valid — would compile, persist, and reintroduce exactly the failure this
 * module exists to prevent: admission refuses the row, but `apply_phone_event`
 * digests `phone_e164` with no format check, so an opt-out writes a
 * suppression that admission can never match.
 *
 * So the strict gate is applied AGAIN here, at the write, and the two columns
 * are coalesced together rather than read independently. Anything that is not
 * a strict Indian mobile — including a `valid: true` carrying a non-strict or
 * null number — collapses to the undialable pair. `phone_raw` is untouched:
 * withholding what the document said would destroy the audit trail without
 * making anything safer.
 *
 * The cost is one regex test per candidate write. The benefit is that the
 * guarantee is structural instead of documentary.
 */
export function toCandidateColumns(phone: CandidatePhone | undefined): {
  phone_e164: string | null;
  phone_valid: boolean;
} {
  // Absent means nobody decided, and on a dialer that reads as "do not call".
  if (!phone) return { phone_e164: null, phone_valid: false };
  if (!phone.valid || phone.e164 === null) return { phone_e164: null, phone_valid: false };
  if (!STRICT_IN_MOBILE_E164.test(phone.e164)) return { phone_e164: null, phone_valid: false };
  return { phone_e164: phone.e164, phone_valid: true };
}

// ── API projection ──────────────────────────────────────────────────────────

/**
 * Redact the candidate phone fields for one caller's role.
 *
 * ── WHY A HELPER AND NOT A NARROWER `select()` ──────────────────────────────
 *
 * `GET /api/candidates` selects `phone_e164, phone_valid` explicitly and
 * `GET /api/candidates/:id` selects `*`. Both are `requireRole('viewer')`.
 * Those fields have always been in the response — they were simply always
 * null, because nothing populated them. The moment they carry real numbers,
 * every viewer and every interviewer can read candidate mobile numbers through
 * endpoints this change never otherwise touches.
 *
 * The decision taken here is that the NUMBER is admin-only and the FACT of a
 * dialable number is not:
 *
 *  - `phone_e164` — admin only. Below admin it is nulled, NOT deleted, because
 *    both response schemas declare it `required`; removing the key would make
 *    the API contract untruthful in a different direction.
 *  - `phone_raw`  — removed entirely below admin. It is not in either declared
 *    schema, so no contract requires its presence, and it is the least
 *    structured, most incidental piece of PII in the row.
 *  - `phone_valid` — left alone for every role. It is a boolean, it discloses
 *    no contact detail, and the recruiter UI needs it to explain why a
 *    candidate is or is not reachable by phone.
 *
 * Doing this by role at the projection boundary rather than by narrowing the
 * query keeps ONE rule in ONE place for every projection, instead of a
 * different `select()` per route that the next reader has to re-derive.
 */
export function redactCandidatePhone<T extends Record<string, unknown>>(
  row: T,
  role: string | null | undefined,
): T {
  if (role === 'admin') return row;
  const { phone_raw: _dropped, ...rest } = row as Record<string, unknown>;
  const redacted = rest as Record<string, unknown>;
  if ('phone_e164' in row) redacted.phone_e164 = null;
  if ('parsed' in redacted) redacted.parsed = redactParsedPhone(redacted.parsed);
  return redacted as T;
}

/**
 * Null the `phone` field inside a stored `parsed` resume blob.
 *
 * THE FOURTH CARRIER. `candidates.parsed` is the raw structurer output and its
 * `phone` field holds the same string as `phone_raw`. Two routes return the
 * candidate row with `select('*')`, so nulling `phone_e164` and dropping
 * `phone_raw` while leaving `parsed` untouched would redact nothing at all —
 * the number would still be one key further down the same object. `ParsedResume`
 * already declares `phone: string | null`, so writing null here is a value the
 * shape allows, not a contract break.
 */
function redactParsedPhone(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  if (!('phone' in (parsed as Record<string, unknown>))) return parsed;
  return { ...(parsed as Record<string, unknown>), phone: null };
}

/**
 * Redact the standalone `{raw, e164, valid}` object `POST /api/resumes`
 * returns alongside the created rows.
 *
 * The boolean survives for every role — an uploader is told whether the number
 * they just submitted is dialable — while both string forms are nulled below
 * admin. `Phone.raw` is `nullable: true` in the OpenAPI schema for exactly this
 * redaction; `null` is a truthful "withheld", where `''` would read as "the
 * document contained no number".
 */
export function redactPhoneView(phone: CandidatePhone, role: string | null | undefined): CandidatePhone {
  if (role === 'admin') return phone;
  return { raw: null, e164: null, valid: phone.valid };
}
