/**
 * The local match store of the public booking form (M035 S04, dark; D-S04-16, D-S04-17, D-S04-18).
 *
 * WHAT IT READS. `findR1PublicLocalRows(db, { email, phone })` turns what a candidate typed into the
 * local rows `decideR1PublicLocal` (match.ts) decides on, with ONE read: the read-only lookup RPC
 * `screening_v2.r1_meet_public_local_rows(p_email text, p_phone text, p_limit integer default 21)`
 * over the service-role client (`db.rpc`, a POST). The typed values travel only in the POST body:
 * never in a URL, so never in the Supabase API gateway's request log (contracts 8; the earlier
 * PostgREST GET filters put them in query strings, review F1). The RPC is created by S12's migration
 * 0144 (contracts 9, S04 fix round); until it exists a call answers an error, which is
 * `r1_meet_db_error` here (fail closed), and nothing calls this store anyway: it is dark.
 *
 * WHAT IT SENDS. `p_email` = `normalizePublicEmail(email)` or null, `p_phone` =
 * `normalizePublicPhone(phone)` or null, `p_limit` = 21; both null -> no call at all, no rows. The RPC
 * matches `lower(btrim(candidates.email)) = p_email` (`idx_v2_candidates_email_norm`) and
 * `phone_e164 = p_phone` (`idx_v2_candidates_phone`), at most 21 candidates per side, and joins their
 * Ashby links, the links' mappings, the 0130 DSAR hold predicate and `decision_use_blocked_at`.
 *
 * WHAT IT ANSWERS. The RPC answers `{status:'ok', rows:[...]}` with at most 21 rows of exactly eight
 * keys (`candidate_id, matched_by, application_id, ashby_candidate_id, link_terminal,
 * mapping_enabled, dsar_hold, decision_blocked`); this store reads that strictly and returns one
 * frozen `R1PublicLocalRow` per (candidate, link): ids and booleans only. A candidate with no link is
 * one row with `applicationId` and `ashbyCandidateId` null, `linkTerminal` true and `mappingEnabled`
 * false (the fail-closed booleans). Candidate ids are lower-cased, Ashby ids verbatim (only
 * comparisons lower-case them). Rows are sorted by candidate id, then application id (no link
 * last): a 21st row means "more than 20", which the decision answers `ambiguous`.
 *
 * WHAT IT NEVER DOES. It never reads, returns or logs an email, name, phone, parsed profile or resume
 * column (a row with any other key is drift), and never puts a typed value in an error.
 *
 * FAILURES. A database failure, a rejected call, a throwing builder, a status other than `ok`, more
 * than 21 rows, or a row the contract does not allow (an unknown or missing key, a candidate id that
 * is not a UUID, an Ashby id that is not Ashby-id shaped, a flag that is not a boolean, a no-link row
 * that is not fail-closed, rows of one candidate that disagree on how it matched or on its hold or
 * block, the same link twice, a no-link row beside a link row) throws
 * `R1MeetJobError('r1_meet_db_error')`: the code is the whole message, so no driver text, id or value
 * ever reaches a caller's log.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import type { supabase } from '../../../supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../jobs.js';
import { R1_PUBLIC_LOCAL_ROW_LIMIT, type R1PublicLocalRow } from './match.js';
import { normalizePublicEmail, normalizePublicPhone } from './normalize.js';

type Db = typeof supabase;

/** The read-only lookup RPC (S12's migration 0144 creates it; contracts 9). */
export const R1_PUBLIC_LOCAL_ROWS_RPC = 'r1_meet_public_local_rows';

/** The DSAR request types that hold a candidate (0130 intake step 7); the RPC's predicate. Frozen. */
export const R1_PUBLIC_DSAR_HOLD_TYPES = Object.freeze(['correct', 'restrict', 'delete'] as const);

/** The DSAR request statuses that hold a candidate (0130 intake step 7); the RPC's predicate. Frozen. */
export const R1_PUBLIC_DSAR_HOLD_STATUSES = Object.freeze(['pending', 'in_progress', 'fulfilled'] as const);

/** The keys of one RPC row, exactly, in this order. Frozen. */
export const R1_PUBLIC_LOCAL_ROW_COLUMNS = Object.freeze([
  'candidate_id',
  'matched_by',
  'application_id',
  'ashby_candidate_id',
  'link_terminal',
  'mapping_enabled',
  'dsar_hold',
  'decision_blocked',
] as const);

/** The most rows asked for and accepted: one past the decision's limit. */
const ROW_READ_LIMIT = R1_PUBLIC_LOCAL_ROW_LIMIT + 1;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An Ashby id as `ashby_application_links` stores it (0029 length CHECK, the match.ts shape). */
const ASHBY_ID = /^[A-Za-z0-9_.:-]{1,256}$/;
const MATCHED_BY: ReadonlySet<string> = new Set(['email', 'phone', 'both']);
const COLUMN_SET: ReadonlySet<string> = new Set(R1_PUBLIC_LOCAL_ROW_COLUMNS);

// ── Reading the answer ──────────────────────────────────────────────────────

interface DbAnswer {
  readonly data: unknown;
  readonly error: unknown;
}

function dbError(): R1MeetJobError {
  return new R1MeetJobError(R1_MEET_DB_ERROR);
}

/** Run the call; a DB error, a rejected call or a builder that throws is the same one code. */
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

function asPlainObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw dbError();
  return value as Record<string, unknown>;
}

function uuidOf(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !UUID.test(value)) throw dbError();
  return value.toLowerCase();
}

function nullableAshbyIdOf(row: Record<string, unknown>, column: string): string | null {
  const value = row[column];
  if (value === null) return null;
  if (typeof value !== 'string' || !ASHBY_ID.test(value)) throw dbError();
  return value;
}

function booleanOf(row: Record<string, unknown>, column: string): boolean {
  const value = row[column];
  if (typeof value !== 'boolean') throw dbError();
  return value;
}

/** One RPC row, read strictly: exactly the eight keys, each of its type. */
function readRow(raw: unknown): R1PublicLocalRow {
  const row = asPlainObject(raw);
  const keys = Object.keys(row);
  if (keys.length !== COLUMN_SET.size || !keys.every((name) => COLUMN_SET.has(name))) throw dbError();
  const matchedBy = row.matched_by;
  if (typeof matchedBy !== 'string' || !MATCHED_BY.has(matchedBy)) throw dbError();
  const out: R1PublicLocalRow = {
    candidateId: uuidOf(row, 'candidate_id'),
    matchedBy: matchedBy as R1PublicLocalRow['matchedBy'],
    applicationId: nullableAshbyIdOf(row, 'application_id'),
    ashbyCandidateId: nullableAshbyIdOf(row, 'ashby_candidate_id'),
    linkTerminal: booleanOf(row, 'link_terminal'),
    mappingEnabled: booleanOf(row, 'mapping_enabled'),
    dsarHold: booleanOf(row, 'dsar_hold'),
    decisionBlocked: booleanOf(row, 'decision_blocked'),
  };
  // A candidate with no link is one fail-closed row, nothing else.
  if (out.applicationId === null && (out.ashbyCandidateId !== null || !out.linkTerminal || out.mappingEnabled)) {
    throw dbError();
  }
  return Object.freeze(out);
}

/** Code-unit order (the order match.ts sorts in); null sorts last. */
function compareIds(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// ── The store ───────────────────────────────────────────────────────────────

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
  if (email === null && phone === null) return Object.freeze([]);

  const answer = asPlainObject(
    (
      await run(() =>
        db.rpc(R1_PUBLIC_LOCAL_ROWS_RPC, { p_email: email, p_phone: phone, p_limit: ROW_READ_LIMIT }),
      )
    ).data,
  );
  if (answer.status !== 'ok' || !Array.isArray(answer.rows) || answer.rows.length > ROW_READ_LIMIT) throw dbError();

  const rows = (answer.rows as unknown[]).map(readRow);
  // One candidate is one person: every row of it agrees on how it matched and on its hold and block.
  const byCandidate = new Map<string, R1PublicLocalRow>();
  const links = new Set<string>();
  for (const row of rows) {
    const first = byCandidate.get(row.candidateId);
    if (first === undefined) byCandidate.set(row.candidateId, row);
    else if (
      first.matchedBy !== row.matchedBy
      || first.dsarHold !== row.dsarHold
      || first.decisionBlocked !== row.decisionBlocked
      || first.applicationId === null
      || row.applicationId === null
    ) {
      throw dbError();
    }
    const link = `${row.candidateId}\u0000${row.applicationId ?? ''}`;
    if (links.has(link)) throw dbError();
    links.add(link);
  }

  const sorted = [...rows].sort(
    (a, b) => compareIds(a.candidateId, b.candidateId) || compareIds(a.applicationId, b.applicationId),
  );
  return Object.freeze(sorted);
}
