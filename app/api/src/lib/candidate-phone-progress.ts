/**
 * candidate-phone-progress.ts — how far the phone screen has got, per
 * candidate, for the candidate list and the candidate detail header.
 *
 * `candidates.status` stays `queued` for the whole life of a phone cycle: no
 * phone transition writes it except completion (`screened`) and the consent
 * route (`consent_declined`). So a candidate dialled five times, or one whose
 * cycle ended `abandoned_no_answer`, reads "Queued" with nothing else to go on.
 * This module supplies the missing facts: how many dials actually reached the
 * phone, the latest cycle's engagement state, a SAFE reason code and when the
 * last such dial was placed.
 *
 * WHAT IS NOT HERE, ON PURPOSE
 * - No phone number, SIP / room / lease / egress id or recording key. The
 *   select below names its columns; it cannot over-read.
 * - No free text. `phone_engagements.state_reason` has no CHECK constraint, and
 *   the list is a viewer-level route while the per-cycle view is
 *   interviewer-only, so the reason is projected through a closed allowlist and
 *   anything else becomes null.
 * - No import of the phone screening package. The route that consumes this
 *   keeps that structural boundary (phone-0114-identity-api.test.ts), so the
 *   two vocabularies used here are restated and pinned to their sources by
 *   candidates-phone-progress.test.ts.
 *
 * FAILURE IS "UNKNOWN", NEVER "ZERO"
 * `dial_count: null` means the count could not be stood behind (the read
 * failed, the payload was malformed, or the chunk hit PostgREST's row cap and
 * may be truncated). `0` means the candidate was never dialled. A confident
 * low number on a real candidate is worse than no number, so every doubtful
 * path degrades to null and nothing here ever fails the route.
 */

import { supabase } from './supabase.js';

/** At most this many candidate ids per `in (...)` query. */
export const PHONE_PROGRESS_CHUNK_SIZE = 100;

/**
 * PostgREST `max_rows` (app/supabase/config.toml). A response at or above this
 * many top-level rows may have been truncated SILENTLY, so such a chunk is
 * reported as unknown rather than undercounted.
 */
export const PHONE_PROGRESS_ROW_CAP = 1000;

/**
 * The thirteen `chk_phone_engagements_state` values. Restated from
 * `PHONE_ENGAGEMENT_STATES` (phone-screening/vocabulary.ts); a test pins the
 * two together. A value outside this list is reported as null, never echoed.
 */
export const PHONE_PROGRESS_ENGAGEMENT_STATES = [
  'pending_prereqs',
  'eligible',
  'scheduled',
  'dialing',
  'in_call',
  'reconnecting',
  'awaiting_retry',
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
] as const;

export type PhoneProgressEngagementState = (typeof PHONE_PROGRESS_ENGAGEMENT_STATES)[number];

const ENGAGEMENT_STATE_SET: ReadonlySet<string> = new Set(PHONE_PROGRESS_ENGAGEMENT_STATES);

/**
 * The `state_reason` codes allowed across the viewer-level boundary: exactly
 * the keys of the web's `ENGAGEMENT_REASON_LABELS`
 * (app/web/src/components/talent/status.ts), i.e. the reasons the UI already
 * has recruiter words for. Pinned to that map by a test. Any other value,
 * including any free text a future writer puts in the column, becomes null.
 */
export const PHONE_PROGRESS_REASON_ALLOWLIST = [
  'no_answer_budget_exhausted',
  'reconnect_budget_exhausted',
  'provider_budget_exhausted',
  'window_closed',
  'assessment_aborted',
  'wrong_number',
  'disclosure_refused',
  'candidate_opt_out',
  'hr_cancelled',
  'emergency_stop',
  'ashby_stage_left',
  'prereq_lost',
  'abandoned_pre_disclosure',
  'consent_gate_failed',
  'callback_deferred_in_call',
  'callback_deferral_limit',
  'late_score_after_stranded_abort',
] as const;

const REASON_SET: ReadonlySet<string> = new Set(PHONE_PROGRESS_REASON_ALLOWLIST);

/** The exact embed this module reads. Named columns only. */
export const PHONE_PROGRESS_SELECT =
  'candidate_id, cycle_number, created_at, state, state_reason, phone_call_attempts ( state, abandon_reason, outcome_class, admitted_at, answered_at )';

export interface PhoneProgress {
  /** Dials that reached the phone, across every cycle. null = unknown. */
  dial_count: number | null;
  /** The latest cycle's engagement state; null = never engaged, or unknown. */
  phone_state: PhoneProgressEngagementState | null;
  /** The latest cycle's reason, only if allowlisted; otherwise null. */
  phone_state_reason: string | null;
  /** max(admitted_at) over counted dials; null when none, or unknown. */
  last_dialed_at: string | null;
}

/** A candidate with no engagement at all: never dialled. */
export const NEVER_ENGAGED: Readonly<PhoneProgress> = Object.freeze({
  dial_count: 0,
  phone_state: null,
  phone_state_reason: null,
  last_dialed_at: null,
});

/** The count could not be stood behind. Every field null. */
export const PHONE_PROGRESS_UNKNOWN: Readonly<PhoneProgress> = Object.freeze({
  dial_count: null,
  phone_state: null,
  phone_state_reason: null,
  last_dialed_at: null,
});

export interface RawAttemptRow {
  state?: unknown;
  abandon_reason?: unknown;
  outcome_class?: unknown;
  admitted_at?: unknown;
  answered_at?: unknown;
}

export interface RawEngagementRow {
  candidate_id?: unknown;
  cycle_number?: unknown;
  created_at?: unknown;
  state?: unknown;
  state_reason?: unknown;
  phone_call_attempts?: unknown;
}

/**
 * Did this attempt reach the candidate's phone?
 *
 * - `abandoned` + `infra_deferred` (0083): given up before any carrier
 *   contact. The phone never rang. NOT counted.
 * - `abandoned` with a null reason: lease-reclaimed, i.e. the worker died
 *   mid-call. These rang (in production every one was answered) and 0083's
 *   one-per-IST-day index treats them as charged dials. COUNTED.
 * - `outcome_class = 'provider_error'`: the carrier refused the originate
 *   before ringing. NOT counted.
 * - `outcome_class` 'cancelled' or 'window_closed' with no `answered_at`:
 *   apply_phone_event (0095, 0113) also ends an attempt still sitting in
 *   `admitted` this way on hr.cancelled / emergency.stop / ashby.stage_left /
 *   prereq.lost, before any originate. There is no evidence such an attempt
 *   rang, so it is NOT counted. (A rare cancel that landed while an
 *   unanswered call was ringing is undercounted by one: the label claims
 *   "reached the phone", so it errs towards not claiming a ring.)
 * - Everything else, every attempt kind (reconnect legs included: each is a
 *   separate call that rang the candidate), including an in-flight `admitted`
 *   attempt. COUNTED.
 *
 * SQL equivalent: `(state <> 'abandoned' OR abandon_reason IS DISTINCT FROM
 * 'infra_deferred') AND outcome_class IS DISTINCT FROM 'provider_error' AND
 * NOT (outcome_class IN ('cancelled','window_closed') AND answered_at IS NULL)`.
 */
export function isReachedDial(a: {
  state?: unknown;
  abandon_reason?: unknown;
  outcome_class?: unknown;
  answered_at?: unknown;
}): boolean {
  if (a.state === 'abandoned' && a.abandon_reason === 'infra_deferred') return false;
  if (a.outcome_class === 'provider_error') return false;
  if ((a.outcome_class === 'cancelled' || a.outcome_class === 'window_closed')
      && (a.answered_at === null || a.answered_at === undefined)) return false;
  return true;
}

/** The allowlisted reason, or null. */
export function projectPhoneStateReason(reason: unknown): string | null {
  return typeof reason === 'string' && REASON_SET.has(reason) ? reason : null;
}

function projectState(state: unknown): PhoneProgressEngagementState | null {
  return typeof state === 'string' && ENGAGEMENT_STATE_SET.has(state)
    ? (state as PhoneProgressEngagementState)
    : null;
}

function cycleOf(row: RawEngagementRow): number {
  const n = typeof row.cycle_number === 'number' ? row.cycle_number : Number(row.cycle_number);
  return Number.isFinite(n) ? n : -Infinity;
}

function timeOf(value: unknown): number {
  if (typeof value !== 'string') return -Infinity;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Engagement states that end a cycle (`terminal_at` set, 0042). Every other
 * known state is a live cycle.
 */
const TERMINAL_ENGAGEMENT_STATES: ReadonlySet<string> = new Set([
  'completed',
  'abandoned_no_answer',
  'opted_out',
  'wrong_number',
  'failed',
  'cancelled',
]);

function isLiveCycle(row: RawEngagementRow): boolean {
  return typeof row.state === 'string'
    && ENGAGEMENT_STATE_SET.has(row.state)
    && !TERMINAL_ENGAGEMENT_STATES.has(row.state);
}

/**
 * Is `a` the better "latest cycle" than `b`? LINK-AWARE.
 *
 * `cycle_number` is scoped per application link (0057: unique
 * (application_link_id, cycle_number)) and one candidate may have several
 * links, so comparing cycle numbers across engagements is meaningless: link
 * A's terminal cycle 2 would outrank link B's live cycle 1. Instead:
 *
 * 1. A live (non-terminal) cycle beats any terminal one: while any link is
 *    still dialling the candidate, that is what the status must say.
 * 2. Then the newer `created_at` wins.
 * 3. Then, only as a tie-break, the higher `cycle_number`.
 */
function isLater(a: RawEngagementRow, b: RawEngagementRow): boolean {
  const la = isLiveCycle(a);
  const lb = isLiveCycle(b);
  if (la !== lb) return la;
  const ta = timeOf(a.created_at);
  const tb = timeOf(b.created_at);
  if (ta !== tb) return ta > tb;
  return cycleOf(a) > cycleOf(b);
}

interface Accumulator {
  dials: number;
  lastDialedMs: number;
  lastDialedAt: string | null;
  latest: RawEngagementRow | null;
  malformed: boolean;
}

/**
 * Reduce engagement rows (each with its attempts embedded) to one
 * `PhoneProgress` per candidate. Pure. A candidate with no engagement row is
 * absent from the result; the caller reports it as `NEVER_ENGAGED`. A
 * candidate any of whose rows is malformed (attempts not an array) is reported
 * as `PHONE_PROGRESS_UNKNOWN` rather than undercounted.
 */
export function reducePhoneProgress(rows: readonly RawEngagementRow[]): Map<string, PhoneProgress> {
  const acc = new Map<string, Accumulator>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const candidateId = row.candidate_id;
    if (typeof candidateId !== 'string' || candidateId === '') continue;

    let a = acc.get(candidateId);
    if (!a) {
      a = { dials: 0, lastDialedMs: -Infinity, lastDialedAt: null, latest: null, malformed: false };
      acc.set(candidateId, a);
    }

    if (!a.latest || isLater(row, a.latest)) a.latest = row;

    const attempts = row.phone_call_attempts;
    if (!Array.isArray(attempts)) {
      a.malformed = true;
      continue;
    }
    for (const attempt of attempts as RawAttemptRow[]) {
      if (!attempt || typeof attempt !== 'object' || !isReachedDial(attempt)) continue;
      a.dials += 1;
      const t = timeOf(attempt.admitted_at);
      if (t > a.lastDialedMs) {
        a.lastDialedMs = t;
        a.lastDialedAt = new Date(t).toISOString();
      }
    }
  }

  const out = new Map<string, PhoneProgress>();
  for (const [candidateId, a] of acc) {
    if (a.malformed) {
      out.set(candidateId, { ...PHONE_PROGRESS_UNKNOWN });
      continue;
    }
    out.set(candidateId, {
      dial_count: a.dials,
      phone_state: projectState(a.latest?.state),
      phone_state_reason: projectPhoneStateReason(a.latest?.state_reason),
      last_dialed_at: a.lastDialedAt,
    });
  }
  return out;
}

/** Split into chunks of at most `size`. */
export function chunkIds(ids: readonly string[], size = PHONE_PROGRESS_CHUNK_SIZE): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

async function loadChunk(chunk: string[]): Promise<Map<string, PhoneProgress>> {
  const unknown = (): Map<string, PhoneProgress> =>
    new Map(chunk.map((id) => [id, { ...PHONE_PROGRESS_UNKNOWN }]));
  try {
    const { data, error } = await supabase
      .from('phone_engagements')
      .select(PHONE_PROGRESS_SELECT)
      .in('candidate_id', chunk);
    if (error || !Array.isArray(data)) return unknown();
    // At the row cap the response may have been truncated with no signal.
    if (data.length >= PHONE_PROGRESS_ROW_CAP) return unknown();

    const reduced = reducePhoneProgress(data as RawEngagementRow[]);
    const out = new Map<string, PhoneProgress>();
    for (const id of chunk) out.set(id, reduced.get(id) ?? { ...NEVER_ENGAGED });
    return out;
  } catch {
    return unknown();
  }
}

/**
 * Phone progress for every id given. Always resolves, never rejects: each
 * requested id is present in the result, as its progress, `NEVER_ENGAGED`, or
 * `PHONE_PROGRESS_UNKNOWN` when its chunk could not be read in full.
 *
 * The caller must pass ONLY ids it has already authorized (the service-role
 * client bypasses RLS; the phone tables are service-role only by 0042). One
 * query per chunk of 100 ids: no N+1.
 */
export async function loadPhoneProgress(candidateIds: readonly string[]): Promise<Map<string, PhoneProgress>> {
  const ids = [...new Set(candidateIds.filter((id) => typeof id === 'string' && id !== ''))];
  const out = new Map<string, PhoneProgress>();
  if (ids.length === 0) return out;
  try {
    const results = await Promise.all(chunkIds(ids).map((chunk) => loadChunk(chunk)));
    for (const m of results) for (const [id, p] of m) out.set(id, p);
  } catch {
    for (const id of ids) out.set(id, { ...PHONE_PROGRESS_UNKNOWN });
  }
  return out;
}

/**
 * The route entry point: `loadPhoneProgress` behind the phone feature flag.
 *
 * With `PHONE_SCREENING_ENABLED !== 'true'` the phone tables are not read at
 * all, matching `/:id/phone-cycles` and every other phone route: each id is
 * reported with no phone facts (dial_count 0, every other field null), which
 * the UI renders as the plain stored status with no "unavailable" notice.
 * The caller's authorization contract is the same as `loadPhoneProgress`.
 */
export async function loadCandidatePhoneProgress(candidateIds: readonly string[]): Promise<Map<string, PhoneProgress>> {
  if (process.env.PHONE_SCREENING_ENABLED !== 'true') {
    return new Map(
      candidateIds
        .filter((id) => typeof id === 'string' && id !== '')
        .map((id) => [id, { ...NEVER_ENGAGED }]),
    );
  }
  return loadPhoneProgress(candidateIds);
}

/**
 * The four public fields for one candidate, defaulting to unknown.
 *
 * `phone_state_reason` goes only to roles that may already read the per-cycle
 * view (`/:id/phone-cycles` is interviewer+). A viewer keeps `phone_state`,
 * which is what the display status is derived from, but never learns WHY a
 * cycle ended (opt-out, refused the recording notice, emergency stop...).
 */
export function phoneProgressFields(
  progress: Map<string, PhoneProgress>,
  candidateId: string,
  appRole?: string | null,
): PhoneProgress {
  const p = { ...(progress.get(candidateId) ?? PHONE_PROGRESS_UNKNOWN) };
  if (appRole !== 'admin' && appRole !== 'interviewer') p.phone_state_reason = null;
  return p;
}
