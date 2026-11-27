/**
 * One R1 per Ashby PERSON on the public booking page's book path (M035 S12 fix round, F3; dark).
 *
 * WHY. The owner's rule "Open application, no R1 yet" holds per person. One person can have several
 * local candidate rows (one per Ashby application, never merged: integrations/ashby/materialize.ts),
 * and the 0143 precheck answers `r1_completed` only for the candidate it is given. So before that
 * precheck, the book path (S06) asks migration 0144 §9 whether ANOTHER local candidate of the same
 * Ashby person has already done R1 (a sales_r1 round, any channel, completed or with a counted
 * attempt). The on-the-spot import refuses such a person itself (`candidate_ineligible`, 0144 §7).
 *
 * WHAT IT SENDS. `checkR1PublicPersonR1(db, input)` makes ONE call over the service-role client
 * (`db.rpc`, a POST): `screening_v2.r1_meet_public_person_r1_check(p_candidate_id uuid,
 * p_ashby_application_id text)`, with exactly those two keys, from the candidate and the Ashby
 * application the page is about to book (ids only; never a typed form value).
 *
 * WHAT IT ANSWERS. The RPC answers one of three closed shapes, read strictly into a frozen answer:
 *   {status:'eligible'}
 *   {status:'refused', code}            code in R1_PUBLIC_PERSON_R1_REFUSAL_CODES
 *   {status:'invalid_request', field}   field in R1_PUBLIC_PERSON_R1_INVALID_FIELDS
 * with exactly those keys; anything else is drift. S06 maps `eligible` -> go on to the precheck,
 * `refused` (either code) -> 404 `not_found` (timing floor), `invalid_request` or a thrown error ->
 * 503 `temporarily_unavailable`.
 *
 * WHAT IT NEVER DOES. It reads no table, writes nothing, logs nothing and never puts a value into
 * an error. A database failure, a rejected call, a throwing builder or an answer the contract does
 * not allow throws `R1MeetJobError('r1_meet_db_error')`: the code is the whole message.
 *
 * The client is an argument (type-only import of `lib/supabase`): loading this module reads no
 * environment and performs no I/O.
 */

import type { supabase } from '../../../supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../jobs.js';

type Db = typeof supabase;

/** The person check RPC (migration 0144 §9). */
export const R1_PUBLIC_PERSON_R1_RPC = 'r1_meet_public_person_r1_check';

/** Its refusal codes, in its order (0144 §9). Frozen. */
export const R1_PUBLIC_PERSON_R1_REFUSAL_CODES = Object.freeze(['application_unknown', 'r1_completed'] as const);
export type R1PublicPersonR1RefusalCode = (typeof R1_PUBLIC_PERSON_R1_REFUSAL_CODES)[number];

/** Its invalid_request fields, in its check order (0144 §9 step 1). Frozen. */
export const R1_PUBLIC_PERSON_R1_INVALID_FIELDS = Object.freeze(['candidate_id', 'application_id'] as const);
export type R1PublicPersonR1InvalidField = (typeof R1_PUBLIC_PERSON_R1_INVALID_FIELDS)[number];

/** What the call sends: the local candidate and the Ashby application about to be booked. */
export interface R1PublicPersonR1Input {
  readonly candidateId: string;
  readonly applicationId: string;
}

/** The RPC's answer, read strictly. */
export type R1PublicPersonR1Answer =
  | { readonly status: 'eligible' }
  | { readonly status: 'refused'; readonly code: R1PublicPersonR1RefusalCode }
  | { readonly status: 'invalid_request'; readonly field: R1PublicPersonR1InvalidField };

const REFUSAL_CODES: ReadonlySet<string> = new Set(R1_PUBLIC_PERSON_R1_REFUSAL_CODES);
const INVALID_FIELDS: ReadonlySet<string> = new Set(R1_PUBLIC_PERSON_R1_INVALID_FIELDS);

interface DbAnswer {
  readonly data: unknown;
  readonly error: unknown;
}

function dbError(): R1MeetJobError {
  return new R1MeetJobError(R1_MEET_DB_ERROR);
}

/** The object has exactly these keys (any order). */
function hasExactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(row);
  return own.length === keys.length && keys.every((name) => Object.prototype.hasOwnProperty.call(row, name));
}

/** One RPC answer, read strictly (see the header). */
function readAnswer(raw: unknown): R1PublicPersonR1Answer {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw dbError();
  const answer = raw as Record<string, unknown>;
  const status = answer.status;
  if (status === 'eligible') {
    if (!hasExactKeys(answer, ['status'])) throw dbError();
    return Object.freeze({ status });
  }
  if (status === 'refused') {
    if (!hasExactKeys(answer, ['status', 'code'])) throw dbError();
    const code = answer.code;
    if (typeof code !== 'string' || !REFUSAL_CODES.has(code)) throw dbError();
    return Object.freeze({ status, code: code as R1PublicPersonR1RefusalCode });
  }
  if (status === 'invalid_request') {
    if (!hasExactKeys(answer, ['status', 'field'])) throw dbError();
    const field = answer.field;
    if (typeof field !== 'string' || !INVALID_FIELDS.has(field)) throw dbError();
    return Object.freeze({ status, field: field as R1PublicPersonR1InvalidField });
  }
  throw dbError();
}

/**
 * Ask 0144 §9 whether another local candidate of this Ashby person has done R1 (see the header).
 * Throws `R1MeetJobError('r1_meet_db_error')` on any failure.
 */
export async function checkR1PublicPersonR1(db: Db, input: R1PublicPersonR1Input): Promise<R1PublicPersonR1Answer> {
  let answer: DbAnswer;
  try {
    answer = await db.rpc(R1_PUBLIC_PERSON_R1_RPC, {
      p_candidate_id: input.candidateId,
      p_ashby_application_id: input.applicationId,
    });
  } catch {
    throw dbError();
  }
  if (answer === null || typeof answer !== 'object' || answer.error) throw dbError();
  return readAnswer(answer.data);
}
