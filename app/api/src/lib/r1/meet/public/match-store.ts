/**
 * The local match store of the public booking form (M035 S04, dark; D-S04-16, D-S04-17, D-S04-18).
 *
 * WHAT IT READS. `findR1PublicLocalRows(db, { email, phone })` turns what a candidate typed into the
 * local rows `decideR1PublicLocal` (match.ts) decides on, with five plain one-table reads over the
 * service-role client (no embeds: two plain queries, not one clever one, the `lib/funnel/summary.ts`
 * lesson; an embed can fail on relationship ambiguity, and only in production):
 *   1. email side    `candidates` `id,decision_use_blocked_at` whose `email` ILIKE the normalised
 *                    email with `\`, `%` and `_` escaped (case-insensitive equality, no wildcard),
 *                    ordered by id, at most 21. Skipped when the email does not normalise, and when
 *                    it contains `*` (PostgREST turns every `*` of a like pattern into `%`, so such an
 *                    address is not looked up here and falls to the Ashby search). Not
 *                    `lower(btrim(email))`: PostgREST cannot filter on an expression, so a stored
 *                    address with surrounding spaces is missed here and found through Ashby, and the
 *                    expression index is not used (a scan, bounded by the page's throttles);
 *   2. phone side    the same columns where `phone_e164` equals the strict `+91` mobile, at most 21;
 *                    skipped when the phone does not normalise. Runs in parallel with (1);
 *   3. links         `ashby_application_links` (provider `ashby`) of those candidates, by id batch:
 *                    `candidate_id,external_application_id,external_candidate_id,terminal_state,
 *                    job_mapping_id`, ordered by application id, at most 101 per batch;
 *   4. DSAR holds    `data_subject_requests` of those candidates whose type is correct, restrict or
 *                    delete and whose status is pending, in progress or fulfilled (the 0130 intake
 *                    predicate), at most 101 per batch: a full batch counts EVERY candidate of that
 *                    batch as held (fail closed). Runs in parallel with (3);
 *   5. mappings      `ashby_job_mappings` `id,status,archived_at` of the links' mappings, by id batch.
 *
 * WHAT IT ANSWERS. One frozen row per (candidate, link), eight fields, ids and booleans only:
 * `matchedBy` is `both` when the candidate came back on both sides; a candidate with no link gives one
 * row with `applicationId` and `ashbyCandidateId` null, `linkTerminal` true and `mappingEnabled` false
 * (the fail-closed booleans); `mappingEnabled` is true only when the link's mapping was read and is
 * `enabled` and not archived; `dsarHold` is a hold of (4); `decisionBlocked` is
 * `decision_use_blocked_at` set. Candidate ids are lower-cased, Ashby ids verbatim (links are matched
 * exactly; only comparisons lower-case them). Rows are sorted by candidate id, then application id
 * (no link last), and at most 21 are returned: a 21st row means "more than 20", which the decision
 * answers `ambiguous`.
 *
 * WHAT IT NEVER DOES. It never selects an email, name, phone, parsed profile or resume column, never
 * returns one, never logs, and never puts a typed value in an error. Both inputs are normalised again
 * here (the normalisers are idempotent); both unusable -> no query at all, no rows.
 *
 * THE OPEN ITEM (D-S04-17). The typed email and phone are PostgREST filter values, so they travel in
 * GET query strings that the Supabase API gateway records in its request logs. Contracts 9 S04 (8)
 * tracks moving them into a read-only POST lookup RPC (same return shape) before the public flag goes
 * on. Until then nothing calls this store: it is dark.
 *
 * FAILURES. Every database failure, rejected call, throwing builder or row that is not what the
 * schema allows (a candidate id that is not a UUID, an Ashby id that is not Ashby-id shaped, a
 * terminal state or mapping status outside its CHECK, a wrong type, a row outside the filter) throws
 * `R1MeetJobError('r1_meet_db_error')`: the code is the whole message, so no driver text, id or value
 * ever reaches a caller's log.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import { ID_BATCH_SIZE, chunkIds } from '../../../id-batches.js';
import type { supabase } from '../../../supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../jobs.js';
import { R1_PUBLIC_LOCAL_ROW_LIMIT, type R1PublicLocalRow } from './match.js';
import { normalizePublicEmail, normalizePublicPhone } from './normalize.js';

type Db = typeof supabase;

/** The DSAR request types that hold a candidate (0130 intake step 7). Frozen. */
export const R1_PUBLIC_DSAR_HOLD_TYPES = Object.freeze(['correct', 'restrict', 'delete'] as const);

/** The DSAR request statuses that hold a candidate (0130 intake step 7). Frozen. */
export const R1_PUBLIC_DSAR_HOLD_STATUSES = Object.freeze(['pending', 'in_progress', 'fulfilled'] as const);

/** One side's candidate read, and the most rows answered: one past the decision's limit. */
const CANDIDATE_READ_LIMIT = R1_PUBLIC_LOCAL_ROW_LIMIT + 1;
/** The links and DSAR reads of one id batch; a full DSAR answer holds the whole batch. */
const RELATED_READ_LIMIT = 101;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An Ashby id as `ashby_application_links` stores it (0029 length CHECK, the match.ts shape). */
const ASHBY_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const TERMINAL_STATES: ReadonlySet<string> = new Set(['withdrawn', 'deleted', 'manual_stage_cancel']);
const MAPPING_STATUSES: ReadonlySet<string> = new Set(['paused', 'enabled', 'drift']);

// ── Reading rows ────────────────────────────────────────────────────────────

interface DbAnswer {
  readonly data: unknown;
  readonly error: unknown;
}

function dbError(): R1MeetJobError {
  return new R1MeetJobError(R1_MEET_DB_ERROR);
}

/** Run one query; a DB error, a rejected call or a builder that throws is the same one code. */
async function run(query: () => PromiseLike<DbAnswer>): Promise<DbAnswer> {
  let answer: DbAnswer;
  try {
    answer = await query();
  } catch {
    throw dbError();
  }
  if (answer === null || typeof answer !== 'object' || answer.error) throw dbError();
  return answer;
}

function rowsOf(answer: DbAnswer): readonly Record<string, unknown>[] {
  if (!Array.isArray(answer.data)) throw dbError();
  for (const row of answer.data as unknown[]) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw dbError();
  }
  return answer.data as Record<string, unknown>[];
}

/** A UUID column, lower-cased; anything else (absent included) is drift. */
function uuidOf(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !UUID.test(value)) throw dbError();
  return value.toLowerCase();
}

function nullableUuidOf(row: Record<string, unknown>, column: string): string | null {
  return row[column] === null ? null : uuidOf(row, column);
}

/** An Ashby id column, verbatim. */
function ashbyIdOf(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !ASHBY_ID.test(value)) throw dbError();
  return value;
}

function nullableAshbyIdOf(row: Record<string, unknown>, column: string): string | null {
  return row[column] === null ? null : ashbyIdOf(row, column);
}

/** A timestamptz column read only for being set: null, or a non-empty string. */
function isSet(row: Record<string, unknown>, column: string): boolean {
  const value = row[column];
  if (value === null) return false;
  if (typeof value !== 'string' || value.length === 0) throw dbError();
  return true;
}

function oneOf(row: Record<string, unknown>, column: string, allowed: ReadonlySet<string>): string {
  const value = row[column];
  if (typeof value !== 'string' || !allowed.has(value)) throw dbError();
  return value;
}

/** `terminal_state` null (live) or one of its 0029 CHECK values (terminal). */
function isTerminal(row: Record<string, unknown>): boolean {
  if (row.terminal_state === null) return false;
  oneOf(row, 'terminal_state', TERMINAL_STATES);
  return true;
}

/** `\`, `%` and `_` escaped, so an ILIKE with the result is a case-insensitive equality. */
function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Code-unit order (the order match.ts sorts in); null sorts last. */
function compareIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// ── The store ───────────────────────────────────────────────────────────────

interface MatchedCandidate {
  byEmail: boolean;
  byPhone: boolean;
  decisionBlocked: boolean;
}

interface LinkFacts {
  readonly applicationId: string;
  readonly ashbyCandidateId: string | null;
  readonly terminal: boolean;
  readonly mappingId: string | null;
}

/**
 * The local rows of one public booking form (see the header): at most 21, frozen, ids and booleans
 * only. Throws `R1MeetJobError('r1_meet_db_error')` on any failure.
 */
export async function findR1PublicLocalRows(
  db: Db,
  input: { email: string | null; phone: string | null },
): Promise<readonly R1PublicLocalRow[]> {
  const email = typeof input?.email === 'string' ? normalizePublicEmail(input.email) : null;
  const phone = typeof input?.phone === 'string' ? normalizePublicPhone(input.phone) : null;
  const emailLookup = email !== null && !email.includes('*') ? email : null;
  if (emailLookup === null && phone === null) return Object.freeze([]);

  // 1 and 2: the candidates, by each side that can be looked up.
  const [emailRows, phoneRows] = await Promise.all([
    emailLookup === null
      ? Promise.resolve([] as readonly Record<string, unknown>[])
      : run(() =>
          db
            .from('candidates')
            .select('id,decision_use_blocked_at')
            .ilike('email', likeEscape(emailLookup))
            .order('id', { ascending: true })
            .limit(CANDIDATE_READ_LIMIT),
        ).then(rowsOf),
    phone === null
      ? Promise.resolve([] as readonly Record<string, unknown>[])
      : run(() =>
          db
            .from('candidates')
            .select('id,decision_use_blocked_at')
            .eq('phone_e164', phone)
            .order('id', { ascending: true })
            .limit(CANDIDATE_READ_LIMIT),
        ).then(rowsOf),
  ]);

  const matched = new Map<string, MatchedCandidate>();
  const note = (row: Record<string, unknown>, side: 'email' | 'phone'): void => {
    const id = uuidOf(row, 'id');
    const blocked = isSet(row, 'decision_use_blocked_at');
    const entry = matched.get(id) ?? { byEmail: false, byPhone: false, decisionBlocked: false };
    if (side === 'email') entry.byEmail = true;
    else entry.byPhone = true;
    // The two reads are not one snapshot: a block seen on either side counts (fail closed).
    entry.decisionBlocked = entry.decisionBlocked || blocked;
    matched.set(id, entry);
  };
  for (const row of emailRows) note(row, 'email');
  for (const row of phoneRows) note(row, 'phone');
  if (matched.size === 0) return Object.freeze([]);

  // 3 and 4: the candidates' links and DSAR holds, batch by batch.
  const links = new Map<string, LinkFacts[]>();
  const held = new Set<string>();
  for (const chunk of chunkIds([...new Set(matched.keys())], ID_BATCH_SIZE)) {
    const inChunk = new Set(chunk);
    const [linkRows, holdRows] = await Promise.all([
      run(() =>
        db
          .from('ashby_application_links')
          .select('candidate_id,external_application_id,external_candidate_id,terminal_state,job_mapping_id')
          .eq('provider', 'ashby')
          .in('candidate_id', chunk)
          .order('external_application_id', { ascending: true })
          .limit(RELATED_READ_LIMIT),
      ).then(rowsOf),
      run(() =>
        db
          .from('data_subject_requests')
          .select('candidate_id')
          .in('candidate_id', chunk)
          .in('request_type', [...R1_PUBLIC_DSAR_HOLD_TYPES])
          .in('request_status', [...R1_PUBLIC_DSAR_HOLD_STATUSES])
          .limit(RELATED_READ_LIMIT),
      ).then(rowsOf),
    ]);
    for (const row of linkRows) {
      const candidateId = uuidOf(row, 'candidate_id');
      if (!inChunk.has(candidateId)) throw dbError();
      const facts: LinkFacts = {
        applicationId: ashbyIdOf(row, 'external_application_id'),
        ashbyCandidateId: nullableAshbyIdOf(row, 'external_candidate_id'),
        terminal: isTerminal(row),
        mappingId: nullableUuidOf(row, 'job_mapping_id'),
      };
      const list = links.get(candidateId) ?? [];
      list.push(facts);
      links.set(candidateId, list);
    }
    for (const row of holdRows) {
      const candidateId = uuidOf(row, 'candidate_id');
      if (!inChunk.has(candidateId)) throw dbError();
      held.add(candidateId);
    }
    // A full answer may have cut some holds off: every candidate of the batch counts as held.
    if (holdRows.length >= RELATED_READ_LIMIT) for (const id of chunk) held.add(id);
  }

  // 5: the mappings of those links.
  const mappingIds = new Set<string>();
  for (const list of links.values()) for (const link of list) if (link.mappingId !== null) mappingIds.add(link.mappingId);
  const enabledMappings = new Set<string>();
  for (const chunk of chunkIds([...new Set(mappingIds)], ID_BATCH_SIZE)) {
    const inChunk = new Set(chunk);
    const mappingRows = rowsOf(
      await run(() => db.from('ashby_job_mappings').select('id,status,archived_at').in('id', chunk)),
    );
    for (const row of mappingRows) {
      const id = uuidOf(row, 'id');
      if (!inChunk.has(id)) throw dbError();
      const status = oneOf(row, 'status', MAPPING_STATUSES);
      const archived = isSet(row, 'archived_at');
      if (status === 'enabled' && !archived) enabledMappings.add(id);
    }
  }

  // The rows: one per (candidate, link), or one fail-closed row for a candidate with no link.
  const out: R1PublicLocalRow[] = [];
  for (const candidateId of [...matched.keys()].sort(compareIds)) {
    const entry = matched.get(candidateId)!;
    const base = {
      candidateId,
      matchedBy: entry.byEmail && entry.byPhone ? ('both' as const) : entry.byEmail ? ('email' as const) : ('phone' as const),
    };
    const flags = { dsarHold: held.has(candidateId), decisionBlocked: entry.decisionBlocked };
    const list = [...(links.get(candidateId) ?? [])].sort((a, b) => compareIds(a.applicationId, b.applicationId));
    if (list.length === 0) {
      out.push(Object.freeze({
        ...base,
        applicationId: null,
        ashbyCandidateId: null,
        linkTerminal: true,
        mappingEnabled: false,
        ...flags,
      }));
      continue;
    }
    for (const link of list) {
      out.push(Object.freeze({
        ...base,
        applicationId: link.applicationId,
        ashbyCandidateId: link.ashbyCandidateId,
        linkTerminal: link.terminal,
        mappingEnabled: link.mappingId !== null && enabledMappings.has(link.mappingId),
        ...flags,
      }));
    }
    if (out.length > R1_PUBLIC_LOCAL_ROW_LIMIT) break;
  }
  return Object.freeze(out.slice(0, R1_PUBLIC_LOCAL_ROW_LIMIT + 1));
}
