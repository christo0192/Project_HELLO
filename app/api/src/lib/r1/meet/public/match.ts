/**
 * The match and eligibility decisions of the public booking form (M035 S04, dark; D-S04-7..D-S04-13).
 *
 * THE RULE. "Only people already in Ashby can take it", and NEVER GUESS: zero matches, several
 * matches or any input this module cannot read is a refusal, never a pick. Every refusal is one of
 * {@link R1_PUBLIC_MATCH_REFUSALS}; the public page shows one uniform not_found for all of them (S06),
 * so the reason is for our logs and alerts only.
 *
 * decideR1PublicLocal(rows), the local rows of `findR1PublicLocalRows`, in this order:
 *   0. the rows are not an array, a row is malformed, or there are more than 20 rows -> ambiguous;
 *   1. no rows -> search_ashby (no phone identity);
 *   2. E = candidates matched by email (`email`, `both`), P = by phone (`phone`, `both`); both
 *      non-empty and disjoint -> conflicting_identity (the email names one person, the phone another);
 *   3. a DSAR hold or a decision block on ANY matched row -> no_bookable_application. Never a search
 *      of Ashby and never a pick around it: the held person could otherwise be imported again as a
 *      new shell from another of their Ashby applications (an erasure or restriction bypassed);
 *   4. chosen = E and P intersected when both are non-empty, else the side that matched;
 *   5. kept = links of the chosen candidates that have an application, are not terminal and sit on
 *      an enabled non-archived mapping, deduplicated by application id (two rows of one application
 *      that disagree on the person -> ambiguous);
 *   6. nothing kept: no email-matched candidate -> search_ashby, carrying the Ashby candidate ids of
 *      the phone-matched rows; an email-matched candidate -> no_bookable_application (Ashby is
 *      searched only when the typed email matches nobody here);
 *   7. more than 5 kept -> ambiguous;
 *   8. more than one kept and they are not all one known Ashby candidate -> ambiguous;
 *   9. check, with the application ids sorted, the one Ashby candidate id they share (null for a
 *      single link with none) and `emailMatched` (false when the decision rests on the phone alone).
 *
 * After `check`, S06 reads that Ashby candidate (`candidate.info`) and:
 *   - scopeR1PublicCheck(check, hit) widens the decision to EVERY application of the person (the
 *     same set the search path decides over), so "exactly one Active application" never depends on
 *     which applications we happened to import; a kept id Ashby does not list -> ambiguous;
 *   - when `emailMatched` is false, confirmR1PublicTypedEmail(email, hits, id) checks the typed email
 *     against a `candidate.search`: an exact hit that is another Ashby person -> conflicting_identity
 *     (the form names two people); no exact hit, or the same person -> go on.
 *
 * readR1PublicAshbyCandidate / readR1PublicAshbySearch read Ashby `Candidate` JSON (a `candidate.info`
 * result or a `candidate.search` entry) into a bounded hit, failing closed: `doNotContact` is false
 * only when Ashby says exactly `false`; more data beyond the page means an exact match may be past it
 * -> ambiguous. An entry that is not an object makes the page malformed (S06 answers 503). An object
 * entry that fails the strict read makes the page malformed when no typed email is given; with the
 * typed email it is skipped when none of its addresses is that email (it could never be picked), and
 * it makes the page ambiguous when one is, or when its addresses cannot be scanned.
 *
 * pickR1PublicAshbyCandidate(email, hits, o?):
 *   1. the typed email does not normalise -> no_match;
 *   2. more than 20 hits, or a hit or phone-id list that is not well formed -> ambiguous;
 *   3. exact = hits (deduplicated by id) with one of their emails equal to the typed email after
 *      normalisation (Ashby's own exact/partial behaviour is unverified, so we filter ourselves);
 *      none -> no_match; more than one -> ambiguous;
 *   4. the hit has more than 10 applications -> ambiguous;
 *   5. the typed phone matched local rows of other Ashby candidates -> conflicting_identity;
 *   6. one.
 *
 * decideR1PublicApplications(facts, o), the fresh Ashby reads of one person's applications:
 *   eligible = status exactly `Active`, the R1 stage when `requireR1Stage` (milestone `r1`), an
 *   enabled mapping, and either no link (import) or a live link bound to a candidate (book).
 *   1. a malformed fact, more than 10 facts or a duplicate application id -> ambiguous;
 *   2. exactly one eligible -> book (linked) or import (unlinked);
 *   3. more than one eligible -> ambiguous;
 *   4. an Active one (R1 stage when required) only on an unmapped job -> unmapped_job;
 *   5. an Active one off the R1 stage -> stage_not_r1;
 *   6. an Active one whose link is terminal or not bound to a candidate -> no_bookable_application;
 *   7. some facts, none Active -> not_active; no facts -> no_bookable_application.
 *
 * decideR1PublicCandidateFlags: `doNotContact` other than false -> do_not_contact; a fraud status of
 * Fraudulent, Unsure or any value we do not know -> fraud_flag (NotFraudulent, Unreviewed,
 * PassedFraudCheck and null pass; compared case-insensitively); no usable on-file email ->
 * no_on_file_email. resolveR1PublicOnFileEmail: Ashby's `primaryEmailAddress`, else the local email;
 * the `emailAddresses` list is never used for the invite address.
 *
 * PII. Decisions carry ids and reason codes only. A hit carries the Ashby on-file emails, so it is
 * frozen and serialises to a fixed marker (a non-enumerable `toJSON`), never to its contents.
 *
 * Pure: no clock, no configuration read, no I/O, no logger. S06 logs and raises the alerts that
 * {@link r1PublicMatchAlert} names.
 */

import { ASHBY_CANDIDATE_SEARCH_LIMIT } from '../../../../integrations/ashby/types.js';
import { normalizePublicEmail } from './normalize.js';

/** Every reason a public booking form is refused (contracts 7.2 order). */
export const R1_PUBLIC_MATCH_REFUSALS = Object.freeze([
  'no_match',
  'conflicting_identity',
  'ambiguous',
  'no_bookable_application',
  'unmapped_job',
  'not_active',
  'stage_not_r1',
  'do_not_contact',
  'fraud_flag',
  'no_on_file_email',
] as const);
export type R1PublicMatchRefusal = (typeof R1_PUBLIC_MATCH_REFUSALS)[number];

/** More local rows than this is too many people to pick from: ambiguous. */
export const R1_PUBLIC_LOCAL_ROW_LIMIT = 20;
/** At most this many local links are read in Ashby for one form. */
export const R1_PUBLIC_MAX_CHECK_LINKS = 5;
/** A person with more Ashby applications than this is not decided automatically. */
export const R1_PUBLIC_MAX_ASHBY_APPLICATIONS = 10;

/** At most this many email entries on one Ashby candidate. */
const MAX_HIT_EMAIL_ENTRIES = 20;
/** At most this many application ids on one Ashby candidate. */
const MAX_HIT_APPLICATION_IDS = 100;
/** A fraud status longer than this is cut (it then matches no known value and refuses). */
const MAX_FRAUD_STATUS_LEN = 64;
/** At most this many addresses are scanned on an unreadable search entry; more -> ambiguous. */
const MAX_LOOSE_EMAIL_SCAN = 1000;
/** What a hit serialises to, in place of its contents. */
const HIT_JSON_MARKER = '[r1-public-ashby-candidate]';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An Ashby id as `ashby_application_links` stores it (verbatim; only comparisons lower-case it). */
const ASHBY_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const MATCHED_BY: ReadonlySet<string> = new Set(['email', 'phone', 'both']);
/** Fraud statuses that let a booking through; any other value refuses (fail closed). */
const FRAUD_PASS: ReadonlySet<string> = new Set(['notfraudulent', 'unreviewed', 'passedfraudcheck']);

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The text of a contact item (a bare string or `{ value }`), when non-blank. */
function itemValue(item: unknown): string | null {
  const value = typeof item === 'string' ? item : asObject(item)?.value;
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

const isAshbyId = (value: unknown): value is string => typeof value === 'string' && ASHBY_ID.test(value);
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const key = (id: string): string => id.toLowerCase();

function refuse(reason: R1PublicMatchRefusal): { kind: 'not_found'; reason: R1PublicMatchRefusal } {
  return Object.freeze({ kind: 'not_found' as const, reason });
}

/** Distinct values by lower-cased key, first spelling kept, sorted. */
function distinctSorted(values: readonly string[]): readonly string[] {
  const seen = new Map<string, string>();
  for (const value of values) if (!seen.has(key(value))) seen.set(key(value), value);
  return Object.freeze([...seen.values()].sort());
}

// ── Local rows ──────────────────────────────────────────────────────────────────────────────────

/** One (candidate, link) row of the local match; ids and booleans only. */
export interface R1PublicLocalRow {
  candidateId: string;
  matchedBy: 'email' | 'phone' | 'both';
  applicationId: string | null;
  ashbyCandidateId: string | null;
  linkTerminal: boolean;
  mappingEnabled: boolean;
  dsarHold: boolean;
  decisionBlocked: boolean;
}

export type R1PublicLocalDecision =
  | { kind: 'check'; applicationIds: readonly string[]; ashbyCandidateId: string | null; emailMatched: boolean }
  | { kind: 'search_ashby'; phoneAshbyCandidateIds: readonly string[] | null }
  | { kind: 'not_found'; reason: R1PublicMatchRefusal };

function isLocalRow(value: unknown): value is R1PublicLocalRow {
  const row = asObject(value);
  return row !== undefined
    && isUuid(row.candidateId)
    && typeof row.matchedBy === 'string' && MATCHED_BY.has(row.matchedBy)
    && (row.applicationId === null || isAshbyId(row.applicationId))
    && (row.ashbyCandidateId === null || isAshbyId(row.ashbyCandidateId))
    && typeof row.linkTerminal === 'boolean'
    && typeof row.mappingEnabled === 'boolean'
    && typeof row.dsarHold === 'boolean'
    && typeof row.decisionBlocked === 'boolean';
}

/** Decide what the local rows allow: read some links in Ashby, search Ashby, or refuse. */
export function decideR1PublicLocal(rows: readonly R1PublicLocalRow[]): R1PublicLocalDecision {
  if (!Array.isArray(rows) || rows.length > R1_PUBLIC_LOCAL_ROW_LIMIT) return refuse('ambiguous');
  if (!rows.every(isLocalRow)) return refuse('ambiguous');
  if (rows.length === 0) return Object.freeze({ kind: 'search_ashby' as const, phoneAshbyCandidateIds: null });

  const byEmail = new Set<string>();
  const byPhone = new Set<string>();
  for (const row of rows) {
    if (row.matchedBy !== 'phone') byEmail.add(key(row.candidateId));
    if (row.matchedBy !== 'email') byPhone.add(key(row.candidateId));
  }
  const both = [...byEmail].filter((id) => byPhone.has(id));
  if (byEmail.size > 0 && byPhone.size > 0 && both.length === 0) return refuse('conflicting_identity');
  // A hold or block on anyone the form matched refuses the form: no search, no import around it.
  if (rows.some((row) => row.dsarHold || row.decisionBlocked)) return refuse('no_bookable_application');
  const chosen = byEmail.size > 0 && byPhone.size > 0 ? new Set(both) : byEmail.size > 0 ? byEmail : byPhone;

  const kept = new Map<string, R1PublicLocalRow>();
  for (const row of rows) {
    const candidate = key(row.candidateId);
    if (!chosen.has(candidate)) continue;
    if (row.applicationId === null || row.linkTerminal || !row.mappingEnabled) continue;
    const previous = kept.get(key(row.applicationId));
    if (previous === undefined) {
      kept.set(key(row.applicationId), row);
      continue;
    }
    const samePerson = key(previous.candidateId) === candidate
      && (previous.ashbyCandidateId === null ? null : key(previous.ashbyCandidateId))
        === (row.ashbyCandidateId === null ? null : key(row.ashbyCandidateId));
    if (!samePerson) return refuse('ambiguous');
  }

  if (kept.size === 0) {
    if (byEmail.size > 0) return refuse('no_bookable_application');
    const phoneIds = rows
      .filter((row) => row.matchedBy !== 'email' && row.ashbyCandidateId !== null)
      .map((row) => row.ashbyCandidateId as string);
    return Object.freeze({
      kind: 'search_ashby' as const,
      phoneAshbyCandidateIds: phoneIds.length === 0 ? null : distinctSorted(phoneIds),
    });
  }
  if (kept.size > R1_PUBLIC_MAX_CHECK_LINKS) return refuse('ambiguous');
  const links = [...kept.values()];
  if (links.length > 1) {
    if (links.some((row) => row.ashbyCandidateId === null)) return refuse('ambiguous');
    if (new Set(links.map((row) => key(row.ashbyCandidateId as string))).size > 1) return refuse('ambiguous');
  }
  const ashbyIds = distinctSorted(links.flatMap((row) => (row.ashbyCandidateId === null ? [] : [row.ashbyCandidateId])));
  return Object.freeze({
    kind: 'check' as const,
    applicationIds: Object.freeze(links.map((row) => row.applicationId as string).sort()),
    ashbyCandidateId: ashbyIds[0] ?? null,
    emailMatched: byEmail.size > 0,
  });
}

// ── Ashby candidates ────────────────────────────────────────────────────────────────────────────

/** One Ashby candidate as the matcher needs it. `emails` are normalised; ids are verbatim. */
export interface R1PublicAshbyCandidateHit {
  id: string;
  emails: readonly string[];
  applicationIds: readonly string[];
  doNotContact: boolean;
  fraudStatus: string | null;
}

/** Read one Ashby `Candidate` object; null when it is not one we can trust. */
export function readR1PublicAshbyCandidate(raw: unknown): R1PublicAshbyCandidateHit | null {
  const candidate = asObject(raw);
  if (!candidate || !isUuid(candidate.id)) return null;

  const listed = candidate.emailAddresses;
  if (listed !== undefined && (!Array.isArray(listed) || listed.length > MAX_HIT_EMAIL_ENTRIES)) return null;
  const emails: string[] = [];
  for (const item of [candidate.primaryEmailAddress, ...((listed as unknown[] | undefined) ?? [])]) {
    const value = itemValue(item);
    const email = value === null ? null : normalizePublicEmail(value);
    if (email !== null && !emails.includes(email)) emails.push(email);
  }

  const ids = candidate.applicationIds;
  if (!Array.isArray(ids) || ids.length > MAX_HIT_APPLICATION_IDS || !ids.every(isUuid)) return null;
  const applicationIds: string[] = [];
  for (const id of ids as string[]) {
    if (!applicationIds.some((seen) => key(seen) === key(id))) applicationIds.push(id);
  }

  const fraud = candidate.fraudStatus;
  if (fraud !== undefined && fraud !== null && typeof fraud !== 'string') return null;

  const hit: R1PublicAshbyCandidateHit = {
    id: candidate.id,
    emails: Object.freeze(emails),
    applicationIds: Object.freeze(applicationIds),
    doNotContact: candidate.doNotContact === false ? false : true,
    fraudStatus: typeof fraud === 'string' ? fraud.slice(0, MAX_FRAUD_STATUS_LEN) : null,
  };
  Object.defineProperty(hit, 'toJSON', { value: () => HIT_JSON_MARKER, enumerable: false });
  return Object.freeze(hit);
}

/**
 * Whether an entry the strict reader refused could be the typed person: true when one of its
 * addresses normalises to `typed`, and also when its addresses cannot be scanned (fail closed).
 */
function mayCarryEmail(entry: Record<string, unknown>, typed: string): boolean {
  const listed = entry.emailAddresses;
  if (listed !== undefined && listed !== null && !Array.isArray(listed)) return true;
  const items: unknown[] = [entry.primaryEmailAddress, ...((listed as unknown[] | null | undefined) ?? [])];
  if (items.length > MAX_LOOSE_EMAIL_SCAN) return true;
  return items.some((item) => {
    const value = itemValue(item);
    return value !== null && normalizePublicEmail(value) === typed;
  });
}

/**
 * Read one `candidate.search` page (`results` and `moreDataAvailable` of the response). S06 passes
 * the typed email (`o.email`), so an unreadable entry that is not that person does not fail the page.
 */
export function readR1PublicAshbySearch(
  page: { results: unknown; moreDataAvailable?: boolean },
  o?: { email?: string | null },
):
  | { ok: true; hits: readonly R1PublicAshbyCandidateHit[] }
  | { ok: false; reason: 'ambiguous' | 'malformed' } {
  const envelope = asObject(page);
  if (!envelope || !Array.isArray(envelope.results)) return Object.freeze({ ok: false as const, reason: 'malformed' as const });
  const more = envelope.moreDataAvailable;
  if (more !== undefined && typeof more !== 'boolean') return Object.freeze({ ok: false as const, reason: 'malformed' as const });
  if (more === true || envelope.results.length > ASHBY_CANDIDATE_SEARCH_LIMIT) {
    return Object.freeze({ ok: false as const, reason: 'ambiguous' as const });
  }
  const typed = typeof o?.email === 'string' ? normalizePublicEmail(o.email) : null;
  const hits: R1PublicAshbyCandidateHit[] = [];
  let unreadable = false;
  for (const entry of envelope.results as unknown[]) {
    const hit = readR1PublicAshbyCandidate(entry);
    if (hit !== null) {
      hits.push(hit);
      continue;
    }
    const object = asObject(entry);
    if (object === undefined || typed === null) return Object.freeze({ ok: false as const, reason: 'malformed' as const });
    // Unreadable, but maybe the person: never pick around it.
    if (mayCarryEmail(object, typed)) unreadable = true;
  }
  if (unreadable) return Object.freeze({ ok: false as const, reason: 'ambiguous' as const });
  return Object.freeze({ ok: true as const, hits: Object.freeze(hits) });
}

function isHit(value: unknown): value is R1PublicAshbyCandidateHit {
  const hit = asObject(value);
  return hit !== undefined
    && typeof hit.id === 'string'
    && Array.isArray(hit.emails)
    && Array.isArray(hit.applicationIds);
}

/** Pick the one Ashby candidate whose on-file email is exactly the typed one, or refuse. */
export function pickR1PublicAshbyCandidate(
  email: string,
  hits: readonly R1PublicAshbyCandidateHit[],
  o?: { phoneAshbyCandidateIds?: readonly string[] | null },
): { kind: 'one'; hit: R1PublicAshbyCandidateHit } | { kind: 'not_found'; reason: R1PublicMatchRefusal } {
  const typed = typeof email === 'string' ? normalizePublicEmail(email) : null;
  if (typed === null) return refuse('no_match');
  if (!Array.isArray(hits) || hits.length > ASHBY_CANDIDATE_SEARCH_LIMIT) return refuse('ambiguous');
  if (!hits.every(isHit)) return refuse('ambiguous');

  const exact = new Map<string, R1PublicAshbyCandidateHit>();
  for (const hit of hits) {
    if (exact.has(key(hit.id))) continue;
    const matches = hit.emails.some(
      (value) => typeof value === 'string' && normalizePublicEmail(value) === typed,
    );
    if (matches) exact.set(key(hit.id), hit);
  }
  if (exact.size === 0) return refuse('no_match');
  if (exact.size > 1) return refuse('ambiguous');
  const [hit] = [...exact.values()] as [R1PublicAshbyCandidateHit];
  if (hit.applicationIds.length > R1_PUBLIC_MAX_ASHBY_APPLICATIONS) return refuse('ambiguous');

  const phoneIds = o?.phoneAshbyCandidateIds;
  if (phoneIds !== undefined && phoneIds !== null && !Array.isArray(phoneIds)) return refuse('ambiguous');
  if (Array.isArray(phoneIds) && phoneIds.length > 0) {
    const known = phoneIds.some((id) => typeof id === 'string' && key(id) === key(hit.id));
    if (!known) return refuse('conflicting_identity');
  }
  return Object.freeze({ kind: 'one' as const, hit });
}

/**
 * Widen a `check` to every application of the person: the ids S06 reads in Ashby and decides over
 * with `decideR1PublicApplications`, the same set the search path uses. `hit` is the person's
 * `candidate.info` (read by `check.ashbyCandidateId`, or for a single link with none, by the
 * `candidate.id` of its `application.info`). A different person, a kept id Ashby does not list, or
 * more than 10 applications -> ambiguous.
 */
export function scopeR1PublicCheck(
  check: { applicationIds: readonly string[]; ashbyCandidateId: string | null },
  hit: R1PublicAshbyCandidateHit,
): { kind: 'read'; applicationIds: readonly string[] } | { kind: 'not_found'; reason: R1PublicMatchRefusal } {
  const local = asObject(check)?.applicationIds;
  const expected = asObject(check)?.ashbyCandidateId;
  if (!Array.isArray(local) || local.length === 0 || local.length > R1_PUBLIC_MAX_CHECK_LINKS) return refuse('ambiguous');
  if (!local.every(isAshbyId) || !(expected === null || isAshbyId(expected))) return refuse('ambiguous');
  if (!isHit(hit) || !isAshbyId(hit.id) || !hit.applicationIds.every(isAshbyId)) return refuse('ambiguous');
  if (expected !== null && key(expected) !== key(hit.id)) return refuse('ambiguous');
  const all = distinctSorted(hit.applicationIds);
  if (all.length > R1_PUBLIC_MAX_ASHBY_APPLICATIONS) return refuse('ambiguous');
  const listed = new Set(all.map(key));
  if (!local.every((id) => listed.has(key(id)))) return refuse('ambiguous');
  return Object.freeze({ kind: 'read' as const, applicationIds: all });
}

/**
 * A `check` that rests on the phone alone (`emailMatched` false): does the typed email name ANOTHER
 * Ashby person? `hits` is the read `candidate.search` page for the typed email; `ashbyCandidateId`
 * the person the phone matched. An exact hit that is someone else -> conflicting_identity; several
 * exact hits -> ambiguous; no exact hit (the email is new to Ashby) or the same person -> ok.
 */
export function confirmR1PublicTypedEmail(
  email: string,
  hits: readonly R1PublicAshbyCandidateHit[],
  ashbyCandidateId: string,
): { ok: true } | { ok: false; reason: R1PublicMatchRefusal } {
  if (!isAshbyId(ashbyCandidateId)) return Object.freeze({ ok: false as const, reason: 'ambiguous' as const });
  const picked = pickR1PublicAshbyCandidate(email, hits, { phoneAshbyCandidateIds: [ashbyCandidateId] });
  if (picked.kind === 'one' || picked.reason === 'no_match') return Object.freeze({ ok: true as const });
  return Object.freeze({ ok: false as const, reason: picked.reason });
}

// ── Applications ────────────────────────────────────────────────────────────────────────────────

/** The fresh Ashby facts of one application, joined with our link and mapping (S06 builds these). */
export interface R1PublicApplicationFacts {
  applicationId: string;
  status: string | null;
  jobId: string | null;
  stageId: string | null;
  stageMilestone: string | null;
  mappingEnabled: boolean;
  link: { candidateId: string | null; terminal: boolean } | null;
}

const isTextOrNull = (value: unknown): boolean => value === null || typeof value === 'string';

function isFacts(value: unknown): value is R1PublicApplicationFacts {
  const fact = asObject(value);
  if (!fact || !isAshbyId(fact.applicationId)) return false;
  if (!isTextOrNull(fact.status) || !isTextOrNull(fact.jobId) || !isTextOrNull(fact.stageId)) return false;
  if (!isTextOrNull(fact.stageMilestone) || typeof fact.mappingEnabled !== 'boolean') return false;
  if (fact.link === null) return true;
  const link = asObject(fact.link);
  return link !== undefined
    && (link.candidateId === null || isUuid(link.candidateId))
    && typeof link.terminal === 'boolean';
}

/** Decide which of one person's applications the form books (or imports), or refuse. */
export function decideR1PublicApplications(
  facts: readonly R1PublicApplicationFacts[],
  o: { requireR1Stage: boolean },
):
  | { kind: 'book'; candidateId: string; applicationId: string }
  | { kind: 'import'; applicationId: string }
  | { kind: 'not_found'; reason: R1PublicMatchRefusal } {
  if (!Array.isArray(facts) || facts.length > R1_PUBLIC_MAX_ASHBY_APPLICATIONS) return refuse('ambiguous');
  if (!facts.every(isFacts)) return refuse('ambiguous');
  if (new Set(facts.map((fact) => key(fact.applicationId))).size !== facts.length) return refuse('ambiguous');

  // Fail closed: only an explicit `false` switches the R1-stage rule off.
  const requireStage = o?.requireR1Stage !== false;
  const active = (fact: R1PublicApplicationFacts) => fact.status === 'Active';
  const stageOk = (fact: R1PublicApplicationFacts) => !requireStage || fact.stageMilestone === 'r1';
  const eligible = facts.filter(
    (fact) => active(fact) && stageOk(fact) && fact.mappingEnabled
      && (fact.link === null || (!fact.link.terminal && fact.link.candidateId !== null)),
  );

  if (eligible.length === 1) {
    const [fact] = eligible as [R1PublicApplicationFacts];
    if (fact.link === null) return Object.freeze({ kind: 'import' as const, applicationId: fact.applicationId });
    return Object.freeze({
      kind: 'book' as const,
      candidateId: fact.link.candidateId as string,
      applicationId: fact.applicationId,
    });
  }
  if (eligible.length > 1) return refuse('ambiguous');
  if (facts.some((fact) => active(fact) && stageOk(fact) && !fact.mappingEnabled && fact.link?.terminal !== true)) {
    return refuse('unmapped_job');
  }
  if (facts.some((fact) => active(fact) && !stageOk(fact))) return refuse('stage_not_r1');
  if (facts.some(active)) return refuse('no_bookable_application');
  if (facts.length > 0) return refuse('not_active');
  return refuse('no_bookable_application');
}

// ── Candidate flags and the on-file email ───────────────────────────────────────────────────────

/** Ashby's do-not-contact and fraud flags, and the presence of an address to invite. */
export function decideR1PublicCandidateFlags(p: {
  doNotContact: boolean;
  fraudStatus: string | null;
  onFileEmail: string | null;
}): { ok: true } | { ok: false; reason: R1PublicMatchRefusal } {
  if (p.doNotContact !== false) return Object.freeze({ ok: false as const, reason: 'do_not_contact' as const });
  const fraud = p.fraudStatus;
  if (fraud !== null && (typeof fraud !== 'string' || !FRAUD_PASS.has(fraud.toLowerCase()))) {
    return Object.freeze({ ok: false as const, reason: 'fraud_flag' as const });
  }
  const email = typeof p.onFileEmail === 'string' ? normalizePublicEmail(p.onFileEmail) : null;
  if (email === null) return Object.freeze({ ok: false as const, reason: 'no_on_file_email' as const });
  return Object.freeze({ ok: true as const });
}

/**
 * The address the invite goes to: Ashby's `primaryEmailAddress` of the `candidate.info` results
 * (a bare string or `{ value }`), normalised; when it is absent, blank or unusable, the local
 * `candidates.email`, normalised; else null. Never the typed address and never the list.
 */
export function resolveR1PublicOnFileEmail(candidateInfoResults: unknown, localEmail: string | null): string | null {
  const primary = itemValue(asObject(candidateInfoResults)?.primaryEmailAddress);
  const fromAshby = primary === null ? null : normalizePublicEmail(primary);
  if (fromAshby !== null) return fromAshby;
  return typeof localEmail === 'string' ? normalizePublicEmail(localEmail) : null;
}

// ── Alerts ──────────────────────────────────────────────────────────────────────────────────────

export type R1PublicMatchAlert = 'r1_meet_public_ambiguous_match' | 'r1_meet_public_unmapped_job';

/** The alert S06 raises for a refusal, or null (a plain miss or a flag is not alert-worthy). */
export function r1PublicMatchAlert(reason: R1PublicMatchRefusal): R1PublicMatchAlert | null {
  switch (reason) {
    case 'ambiguous':
    case 'conflicting_identity':
      return 'r1_meet_public_ambiguous_match';
    case 'unmapped_job':
      return 'r1_meet_public_unmapped_job';
    default:
      return null;
  }
}
