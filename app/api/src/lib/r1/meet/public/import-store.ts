/**
 * The database side of the public booking page's on-the-spot import (M035 S12, dark; S12-PLAN R18).
 *
 * WHAT IT SENDS. `callR1PublicImportRpc(db, input)` makes ONE call over the service-role client
 * (`db.rpc`, a POST): `screening_v2.r1_meet_public_import_application(p_ashby_application_id text,
 * p_ashby_candidate_id text, p_ashby_job_id text, p_ashby_stage_id text, p_name text, p_email text,
 * p_phone_e164 text, p_now timestamptz default now())` of migration 0144, with exactly those eight
 * keys in that order, each taken from the matching named field of the input and nothing else (an
 * extra key on the input never reaches the call). Every value comes from the caller's two Ashby
 * reads (import.ts); this module never sees a typed form value. The values travel in the POST body
 * only, never in a URL.
 *
 * WHAT IT ANSWERS. The RPC answers one of four closed shapes, read strictly here into a frozen
 * `R1PublicImportRpcAnswer`:
 *   {status:'imported'|'exists', candidate_id, application_link_id}   ids UUID-shaped, lower-cased
 *   {status:'refused', code}            code in R1_PUBLIC_IMPORT_REFUSAL_CODES
 *   {status:'invalid_request', field}   field in R1_PUBLIC_IMPORT_INVALID_FIELDS
 * with exactly those keys: an answer with any other key, a missing key, an unknown status, code or
 * field, or an id that is not a UUID is drift.
 *
 * WHAT IT NEVER DOES. It reads no table, writes nothing itself (the RPC does, in one transaction),
 * logs nothing (import.ts logs), and never puts a value into an error.
 *
 * FAILURES. A database failure, a rejected call, a throwing builder or an answer the contract does
 * not allow throws `R1MeetJobError('r1_meet_db_error')`: the code is the whole message, so no driver
 * text, id or value ever reaches a caller's log.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import type { supabase } from '../../../supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../jobs.js';

type Db = typeof supabase;

/** The import RPC (migration 0144 §7). */
export const R1_PUBLIC_IMPORT_RPC = 'r1_meet_public_import_application';

/** The RPC's refusal codes, in its order of precedence (0144 §7). Frozen. */
export const R1_PUBLIC_IMPORT_REFUSAL_CODES = Object.freeze([
  'dsar_hold',
  'candidate_ineligible',
  'application_terminal',
  'link_unbound',
  'mapping_unavailable',
] as const);
export type R1PublicImportRefusalCode = (typeof R1_PUBLIC_IMPORT_REFUSAL_CODES)[number];

/** The RPC's invalid_request fields, in its check order (0144 §7 step 1). Frozen. */
export const R1_PUBLIC_IMPORT_INVALID_FIELDS = Object.freeze([
  'application_id',
  'ashby_candidate_id',
  'job_id',
  'stage_id',
  'name',
  'email',
  'phone',
  'now',
] as const);
export type R1PublicImportInvalidField = (typeof R1_PUBLIC_IMPORT_INVALID_FIELDS)[number];

/** What the call sends; every value from the two Ashby reads (import.ts). */
export interface R1PublicImportRpcInput {
  readonly applicationId: string;
  readonly ashbyCandidateId: string;
  readonly jobId: string;
  readonly stageId: string | null;
  readonly name: string | null;
  readonly email: string | null;
  readonly phoneE164: string | null;
  readonly nowIso: string;
}

/** The RPC's answer, read strictly. */
export type R1PublicImportRpcAnswer =
  | { readonly status: 'imported' | 'exists'; readonly candidateId: string; readonly applicationLinkId: string }
  | { readonly status: 'refused'; readonly code: R1PublicImportRefusalCode }
  | { readonly status: 'invalid_request'; readonly field: R1PublicImportInvalidField };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSAL_CODES: ReadonlySet<string> = new Set(R1_PUBLIC_IMPORT_REFUSAL_CODES);
const INVALID_FIELDS: ReadonlySet<string> = new Set(R1_PUBLIC_IMPORT_INVALID_FIELDS);

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

/** The object has exactly these keys (any order). */
function hasExactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(row);
  return own.length === keys.length && keys.every((name) => Object.prototype.hasOwnProperty.call(row, name));
}

function uuidOf(row: Record<string, unknown>, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || !UUID.test(value)) throw dbError();
  return value.toLowerCase();
}

/** One RPC answer, read strictly (see the header). */
function readAnswer(raw: unknown): R1PublicImportRpcAnswer {
  const answer = asPlainObject(raw);
  const status = answer.status;
  if (status === 'imported' || status === 'exists') {
    if (!hasExactKeys(answer, ['status', 'candidate_id', 'application_link_id'])) throw dbError();
    return Object.freeze({
      status,
      candidateId: uuidOf(answer, 'candidate_id'),
      applicationLinkId: uuidOf(answer, 'application_link_id'),
    });
  }
  if (status === 'refused') {
    if (!hasExactKeys(answer, ['status', 'code'])) throw dbError();
    const code = answer.code;
    if (typeof code !== 'string' || !REFUSAL_CODES.has(code)) throw dbError();
    return Object.freeze({ status, code: code as R1PublicImportRefusalCode });
  }
  if (status === 'invalid_request') {
    if (!hasExactKeys(answer, ['status', 'field'])) throw dbError();
    const field = answer.field;
    if (typeof field !== 'string' || !INVALID_FIELDS.has(field)) throw dbError();
    return Object.freeze({ status, field: field as R1PublicImportInvalidField });
  }
  throw dbError();
}

// ── The call ────────────────────────────────────────────────────────────────

/**
 * Import one Ashby application through the 0144 RPC (see the header). Throws
 * `R1MeetJobError('r1_meet_db_error')` on any failure.
 */
export async function callR1PublicImportRpc(db: Db, input: R1PublicImportRpcInput): Promise<R1PublicImportRpcAnswer> {
  const answer = await run(() =>
    db.rpc(R1_PUBLIC_IMPORT_RPC, {
      p_ashby_application_id: input.applicationId,
      p_ashby_candidate_id: input.ashbyCandidateId,
      p_ashby_job_id: input.jobId,
      p_ashby_stage_id: input.stageId,
      p_name: input.name,
      p_email: input.email,
      p_phone_e164: input.phoneE164,
      p_now: input.nowIso,
    }),
  );
  return readAnswer(answer.data);
}
