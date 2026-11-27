/**
 * The on-the-spot import of the public booking page (M035 S12, dark; S12-PLAN R17, R19; contracts
 * 7.3 and 9).
 *
 * WHEN IT RUNS. Only when `decideR1PublicApplications` (match.ts) answers `import`: the typed email
 * matched nobody here, `candidate.search` found exactly one Ashby person, and exactly one of their
 * Active applications sits on a job with an enabled mapping and has no link yet. The owner's rule
 * is "only people already in Ashby can take it", so the import copies that one application from
 * Ashby; it never creates a person Ashby does not have. Nothing calls it until S06 (the public
 * routes, behind R1_MEET_PUBLIC_BOOKING_ENABLED, default off).
 *
 * WHAT IT READS, in this order (the first failing step answers):
 *   1. the input: two UUID-shaped ids (the application and its Ashby candidate) and a clock that
 *      gives a real instant; else `invalid`, before any call;
 *   2. `application.info` of the application; a throw -> `ashby_unavailable`;
 *   3. its ids: the application id and the candidate id must be present and equal the input (case
 *      ignored), and the job id must be present; else `invalid`;
 *   4. its status: exactly `Active` (absent included) or `not_active`, with no further call;
 *   5. `candidate.info` of the candidate application.info names; a throw -> `ashby_unavailable`;
 *   6. that candidate, read strictly (`readR1PublicAshbyCandidate`): it must be readable, be the
 *      same person and list the application; else `invalid`;
 *   7. the person's flags (`decideR1PublicCandidateFlags` with Ashby's own primary email): a
 *      do-not-contact or fraud flag, or no usable primary email -> `candidate_flagged`, and nothing
 *      is written (a flagged person never enters our database through this page);
 *   8. the contact profile (`extractAshbyCandidateProfile`): the sanitised name and email, and the
 *      number only when `deriveAshbyProfilePhone` says `dialable` (a placeholder, an invalid or a
 *      foreign number, or none, is sent as null);
 *   9. the 0144 RPC (import-store.ts) with the ids AS application.info returned them (verbatim, as
 *      the Ashby import stores them), the job, the stage (or null), the name, the email, the number
 *      and the clock's instant.
 *
 * WHAT IT SENDS. Only values from the two Ashby reads. The input carries no typed form field at all
 * (no name, email or phone), so a typed value can never reach the database through this module.
 *
 * WHAT IT ANSWERS (frozen): `{status:'imported'|'exists', candidateId}` (a new shell, or the
 * candidate of a link that already exists), or `{status:'refused', reason}` with a reason of
 * {@link R1_PUBLIC_IMPORT_REFUSALS}: the five RPC codes as they are, `not_active`,
 * `candidate_flagged`, `ashby_unavailable`, or `invalid` (unreadable or inconsistent Ashby data, or an
 * RPC `invalid_request`). S06 maps them (contracts 9, S12 entry).
 *
 * WHAT IT NEVER DOES. No retry, no other Ashby call, no write but the RPC, no queue job, and no
 * resume ingestion or phone engagement (0144 refuses both for this intake in any case).
 *
 * LOGS AND FAILURES. A failure that is ours or Ashby's logs ONE error-level line
 * `r1_meet_public_import_failed` (the alert) with a closed `error_type` (input_invalid,
 * application_info:<category>, candidate_info:<category>, application_unreadable,
 * application_mismatch, candidate_unreadable, candidate_mismatch, application_not_listed,
 * rpc_invalid_request:<field>, rpc_failed) and, for an Ashby error with a status number, that
 * `http_status`. Never an id, a name, an email, a number, a URL or a payload. A refusal that is a
 * fact about the person (the RPC codes, not_active, candidate_flagged) logs nothing here.
 * `r1PublicImportAlert` names the one alert S06 raises from a result (`r1_meet_public_unmapped_job`
 * for `mapping_unavailable`); S06 never logs `r1_meet_public_import_failed` again. A database failure
 * or a malformed RPC answer logs `rpc_failed` and THROWS `R1MeetJobError('r1_meet_db_error')`.
 *
 * Every dependency is an argument (type-only imports of the clients): loading this module reads no
 * environment and performs no I/O.
 */

import type { AshbyClient } from '../../../../integrations/ashby/client.js';
import {
  extractAshbyApplicationStatus,
  extractAshbyCandidateProfile,
} from '../../../../integrations/ashby/candidate-profile.js';
import { AshbyError, type AshbyErrorCategory } from '../../../../integrations/ashby/errors.js';
import { extractApplicationInfo } from '../../../../integrations/ashby/extractors.js';
import { deriveAshbyProfilePhone } from '../../../candidate-phone.js';
import type { supabase } from '../../../supabase.js';
import { R1MeetJobError, R1_MEET_DB_ERROR } from '../jobs.js';
import { createR1MeetLog, type R1MeetLog, type R1MeetLogMeta } from '../recall-actions.js';
import { callR1PublicImportRpc, type R1PublicImportRpcAnswer } from './import-store.js';
import {
  decideR1PublicCandidateFlags,
  readR1PublicAshbyCandidate,
  resolveR1PublicOnFileEmail,
} from './match.js';

type Db = typeof supabase;

/** Every reason an import is refused (contracts 9, S12 entry). Frozen. */
export const R1_PUBLIC_IMPORT_REFUSALS = Object.freeze([
  'mapping_unavailable',
  'application_terminal',
  'link_unbound',
  'not_active',
  'dsar_hold',
  'candidate_ineligible',
  'candidate_flagged',
  'ashby_unavailable',
  'invalid',
] as const);
export type R1PublicImportRefusal = (typeof R1_PUBLIC_IMPORT_REFUSALS)[number];

export type R1PublicImportResult =
  | { readonly status: 'imported' | 'exists'; readonly candidateId: string }
  | { readonly status: 'refused'; readonly reason: R1PublicImportRefusal };

/** The alerts of the import, closed words (contracts 8). Frozen. */
export const R1_PUBLIC_IMPORT_ALERTS = Object.freeze([
  'r1_meet_public_import_failed',
  'r1_meet_public_unmapped_job',
] as const);
export type R1PublicImportAlert = (typeof R1_PUBLIC_IMPORT_ALERTS)[number];

/** What the import needs; all of it injected. */
export interface R1PublicImportDeps {
  readonly db: Db;
  readonly ashby: Pick<AshbyClient, 'applicationInfo' | 'candidateInfo'>;
  readonly now: () => number;
  /** Defaults to the structured `r1-meet` logger. */
  readonly log?: R1MeetLog;
}

/** The two Ashby ids of the application to import. No typed form value. */
export interface R1PublicImportInput {
  readonly applicationId: string;
  readonly ashbyCandidateId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every Ashby error category, so a log word is always one of them (a new category fails to compile). */
const ASHBY_CATEGORIES: ReadonlySet<string> = new Set(
  Object.keys({
    invalid_request: true,
    logical_failure: true,
    http_client_error: true,
    rate_limited: true,
    http_server_error: true,
    malformed_response: true,
    timeout: true,
    network: true,
    output_limit: true,
    retry_exhausted: true,
  } satisfies Record<AshbyErrorCategory, true>),
);

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function refused(reason: R1PublicImportRefusal): R1PublicImportResult {
  return Object.freeze({ status: 'refused' as const, reason });
}

/** The ISO instant of the clock, or null when the clock gives no real instant. */
function clockIso(now: () => number): string | null {
  let ms: number;
  try {
    ms = now();
  } catch {
    return null;
  }
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** One alert line: the closed category, a closed type, and an Ashby status number when there is one. */
function failed(log: R1MeetLog, errorType: string, httpStatus?: number | null): void {
  const meta: R1MeetLogMeta = typeof httpStatus === 'number' && Number.isInteger(httpStatus)
    ? { error_category: 'r1_meet_public_import_failed', error_type: errorType, http_status: httpStatus }
    : { error_category: 'r1_meet_public_import_failed', error_type: errorType };
  log.error(meta);
}

/** Log a failed Ashby read as `<read>:<category>` (or `:unexpected`), with its status number. */
function ashbyFailed(log: R1MeetLog, read: 'application_info' | 'candidate_info', error: unknown): void {
  if (error instanceof AshbyError) {
    const category = ASHBY_CATEGORIES.has(error.category) ? error.category : 'unexpected';
    failed(log, `${read}:${category}`, error.httpStatus);
    return;
  }
  failed(log, `${read}:unexpected`);
}

/**
 * Import one Ashby application for the public booking page, or refuse (see the header). Throws
 * `R1MeetJobError('r1_meet_db_error')` when the database fails or answers outside the contract.
 */
export async function importR1PublicApplication(
  deps: R1PublicImportDeps,
  input: R1PublicImportInput,
): Promise<R1PublicImportResult> {
  const log = deps.log ?? createR1MeetLog();

  // 1. The input and the clock.
  const applicationId = asObject(input)?.applicationId;
  const ashbyCandidateId = asObject(input)?.ashbyCandidateId;
  const nowIso = clockIso(deps.now);
  if (!isUuid(applicationId) || !isUuid(ashbyCandidateId) || nowIso === null) {
    failed(log, 'input_invalid');
    return refused('invalid');
  }

  // 2. application.info.
  let applicationAnswer: unknown;
  try {
    applicationAnswer = await deps.ashby.applicationInfo(applicationId);
  } catch (error) {
    ashbyFailed(log, 'application_info', error);
    return refused('ashby_unavailable');
  }
  const applicationResults = asObject(applicationAnswer)?.results;

  // 3. Its ids and its job.
  const view = extractApplicationInfo(applicationResults);
  const ashbyApplicationId = view.applicationId;
  const ashbyPersonId = view.candidateId;
  const jobId = view.jobId;
  if (ashbyApplicationId === undefined || ashbyPersonId === undefined || jobId === undefined) {
    failed(log, 'application_unreadable');
    return refused('invalid');
  }
  if (!sameId(ashbyApplicationId, applicationId) || !sameId(ashbyPersonId, ashbyCandidateId)) {
    failed(log, 'application_mismatch');
    return refused('invalid');
  }

  // 4. Exactly Active, or nothing further happens.
  if (extractAshbyApplicationStatus(applicationResults) !== 'Active') return refused('not_active');

  // 5. candidate.info of the person application.info names.
  let candidateAnswer: unknown;
  try {
    candidateAnswer = await deps.ashby.candidateInfo(ashbyPersonId);
  } catch (error) {
    ashbyFailed(log, 'candidate_info', error);
    return refused('ashby_unavailable');
  }
  const candidateResults = asObject(candidateAnswer)?.results;

  // 6. The same person, and they list this application.
  const person = readR1PublicAshbyCandidate(candidateResults);
  if (person === null) {
    failed(log, 'candidate_unreadable');
    return refused('invalid');
  }
  if (!sameId(person.id, ashbyPersonId)) {
    failed(log, 'candidate_mismatch');
    return refused('invalid');
  }
  if (!person.applicationIds.some((id) => sameId(id, ashbyApplicationId))) {
    failed(log, 'application_not_listed');
    return refused('invalid');
  }

  // 7. Do-not-contact, fraud and the on-file email: a flagged person is never written.
  const flags = decideR1PublicCandidateFlags({
    doNotContact: person.doNotContact,
    fraudStatus: person.fraudStatus,
    onFileEmail: resolveR1PublicOnFileEmail(candidateResults, null),
  });
  if (!flags.ok) return refused('candidate_flagged');

  // 8. The contact profile, from Ashby only; the number only when it is dialable.
  const profile = extractAshbyCandidateProfile(applicationResults, candidateResults);
  const phone = deriveAshbyProfilePhone({ primary: profile.primaryNumber, others: profile.otherNumbers });

  // 9. The RPC.
  let answer: R1PublicImportRpcAnswer;
  try {
    answer = await callR1PublicImportRpc(deps.db, {
      applicationId: ashbyApplicationId,
      ashbyCandidateId: ashbyPersonId,
      jobId,
      stageId: view.currentStageId ?? null,
      name: profile.name,
      email: profile.email,
      phoneE164: phone.verdict === 'dialable' ? phone.e164 : null,
      nowIso,
    });
  } catch (error) {
    failed(log, 'rpc_failed');
    throw error instanceof R1MeetJobError ? error : new R1MeetJobError(R1_MEET_DB_ERROR);
  }
  switch (answer.status) {
    case 'imported':
    case 'exists':
      return Object.freeze({ status: answer.status, candidateId: answer.candidateId });
    case 'refused':
      return refused(answer.code);
    case 'invalid_request':
      failed(log, `rpc_invalid_request:${answer.field}`);
      return refused('invalid');
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

/** The alert S06 raises for an import result, or null (contracts 9, S12 entry; R19). */
export function r1PublicImportAlert(result: R1PublicImportResult): R1PublicImportAlert | null {
  return result?.status === 'refused' && result.reason === 'mapping_unavailable' ? 'r1_meet_public_unmapped_job' : null;
}
