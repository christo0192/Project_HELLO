/**
 * lib/phone-runtime/due-loop.ts — the pass that decides which engagements are
 * OFFERED to admission, and offers them.
 *
 * ── CANDIDACY IS NOT PERMISSION ───────────────────────────────────────
 * This file decides only which rows to put in front of `admit_phone_attempt`.
 * Permission is decided there, under the advisory lock, where the halt switch,
 * the IST window, consent, suppression, the per-IST-day index, the fleet cap
 * and the number's validity are all re-checked together. Nothing below
 * re-implements any of them, because two copies of a gate are two things that
 * can disagree and only one of them is enforced.
 *
 * Three timing rules ARE this file's, because 0042 says so explicitly: the
 * reconnect backoff (`#26`, "a worker clock rather than a database fact"), the
 * moment a scheduled appointment becomes due, and the batch size. Everything
 * else is borrowed.
 *
 * ── THE HALT IS CONSULTED BEFORE ANY WORK, AND FAILS CLOSED ───────────
 * Admission would refuse a halted lane anyway. The pass still asks first, for
 * two reasons: a halted lane should not be minting `call_sessions` rows on the
 * way to a refusal, and an operator who has pulled the switch is entitled to
 * see the loops go quiet rather than keep churning. An unreadable control row
 * is treated as HALTED — the same inversion `0042` chose, and the opposite of
 * the recording lane's fail-open halt, which is deliberate on both sides.
 */

import type {
  PhoneAttemptKind,
  PhoneScreeningConfig,
  PhoneStores,
} from '../phone-screening/index.js';
// A VALUE import, and the only one this module takes from the domain package:
// the single shared definition of the IST window, so the runtime cannot grow
// a second copy of 09:00/21:00 that drifts from admission's.
import { istWindowOpen } from '../phone-screening/index.js';
// The CLOSED admission vocabulary, imported rather than restated. The whole
// safety of expanding `admission_refused` into per-detail buckets rests on the
// detail being a member of a fixed set; a local copy of that set would be a
// second thing to keep in step with 0042 and the first place it drifted would
// be the moment an unrecognised string reached a health surface.
import { ADMIT_PHONE_ATTEMPT_STATUSES } from '../phone-screening/rpc-contract.js';
import type { DuePhoneEngagement, PhoneRuntimeReader } from './read.js';
import type { DialableNumber } from '../../integrations/livekit-phone-dial/dialable-number.js';

/** Why a due row was not offered to admission. Stable, sanitized, countable. */
export const PHONE_DUE_SKIPS = [
  // `halted` is deliberately ABSENT. The halted case returns early with an
  // empty `skipped` map, so a code for it here could never be emitted — and a
  // vocabulary entry that nothing can produce reads to an operator as a state
  // that has never occurred rather than one that cannot.
  'not_yet_due',
  'outside_ist_window',
  'candidate_already_offered',
  'no_dialable_number',
  'no_session',
  'appointment_not_due',
  'unknown_state',
] as const;

export type PhoneDueSkip = (typeof PHONE_DUE_SKIPS)[number];

/**
 * The refusal code the dial controller answers when ADMISSION is what said no.
 * Named rather than spelled inline because it is the one refusal whose count
 * key is built rather than copied.
 */
export const PHONE_ADMISSION_REFUSAL = 'admission_refused';

/**
 * The bucket an unrecognised admission detail collapses into.
 *
 * NOT the detail itself, and that is the entire point. The health surface is
 * published; interpolating an unrecognised string into a key would turn a
 * counter map into a disclosure channel fed by whatever the dial controller —
 * or a future edit of it, or a provider error laundered through it — happened
 * to put in `detail`. A fixed bucket loses one bit of resolution in the case
 * nobody has a name for, and closes the channel in every case.
 */
export const PHONE_UNKNOWN_ADMISSION_DETAIL = 'unknown';

/**
 * Every value `dialPhoneAttempt` can legitimately carry in `detail` alongside
 * `admission_refused`.
 *
 * That is `admit_phone_attempt`'s own status vocabulary minus `ok` — `ok` is
 * never a refusal — plus the one code the controller mints itself when
 * admission answers `ok` WITHOUT the identifiers that make the attempt
 * addressable (`dial.ts`). Frozen, and exported so a test can assert the
 * closure rather than trust it.
 */
export const PHONE_ADMISSION_REFUSAL_DETAILS: readonly string[] = Object.freeze([
  ...ADMIT_PHONE_ATTEMPT_STATUSES.filter((status) => status !== 'ok'),
  'ok_without_attempt',
]);

const ADMISSION_REFUSAL_DETAILS = new Set<string>(PHONE_ADMISSION_REFUSAL_DETAILS);

/**
 * The key an outcome is counted under.
 *
 * ── WHY `admission_refused` IS EXPANDED AND THE OTHERS ARE NOT ────────
 * `window_closed`, `at_capacity`, `daily_attempt_exists`, `consent_missing`,
 * `suppressed`, `phone_invalid`, `halt_unreadable` and `ingestion_not_ready`
 * all arrive as ONE refusal code with the distinguishing answer in `detail`.
 * Collapsed, they are a single number that cannot tell "the lane is working
 * and today's quota is spent" from "consent is broken and nobody is being
 * called" — which are the two readings an operator most needs to separate.
 * Every other member of `PHONE_DIAL_REFUSALS` is already distinct on its own,
 * so nothing else is expanded and no other refusal grows a suffix.
 *
 * The vocabulary stays CLOSED: an unrecognised detail becomes
 * `admission_refused:unknown`, never the string itself.
 */
export function phoneRefusalCountKey(refusal: string, detail: string | undefined): string {
  if (refusal !== PHONE_ADMISSION_REFUSAL) return refusal;
  const known = detail !== undefined && ADMISSION_REFUSAL_DETAILS.has(detail);
  return `${PHONE_ADMISSION_REFUSAL}:${known ? detail : PHONE_UNKNOWN_ADMISSION_DETAIL}`;
}

export interface PhoneDueResult {
  readonly status: 'disabled' | 'halted' | 'ok';
  readonly examined: number;
  readonly offered: number;
  readonly dialing: number;
  readonly skipped: Readonly<Record<string, number>>;
  /** Stable refusal codes from the dial controller, counted. Never a row. */
  readonly refusals: Readonly<Record<string, number>>;
}

/**
 * Provisioning a session is a WRITE, so it is a port rather than a direct
 * call: a test must be able to prove the pass creates no session when the lane
 * is halted, and that is only observable through a seam.
 */
export interface PhoneSessionPort {
  /**
   * Adopt or create the session this conversation will use, already carrying
   * its deterministic room name and in a state `start_phone_assessment`
   * accepts (`waiting`). Returns null when it could not be provisioned — the
   * engagement is then skipped, never dialled blind.
   */
  ensureSession(input: {
    /**
     * Load-bearing. Adoption resolves a session by CANDIDATE, and a candidate
     * is not unique per engagement — so the port needs to know which
     * engagement is asking in order to refuse a session another one owns.
     */
    engagementId: string;
    candidateId: string;
    roleId: string | null;
    existingSessionId: string | null;
  }): Promise<string | null>;
}

export interface PhoneDialPort {
  /** `dialPhoneAttempt`, narrowed to what this pass needs to know. */
  dial(input: {
    engagementId: string;
    candidateId: string;
    sessionId: string;
    kind: PhoneAttemptKind;
    number: DialableNumber;
    now: Date;
  }): Promise<{
    status: 'dialing' | 'refused';
    refusal?: string;
    /**
     * Admission's stable sub-code, when admission is what refused. Carried
     * through the port rather than dropped at it: the port is exactly where
     * the old code lost it, and a value that never crosses the seam cannot be
     * counted on the other side.
     */
    detail?: string;
  }>;
}

export interface PhoneDueDeps {
  readonly config: PhoneScreeningConfig;
  readonly reader: PhoneRuntimeReader;
  readonly stores: Pick<PhoneStores, 'backlog'>;
  readonly sessions: PhoneSessionPort;
  readonly dialer: PhoneDialPort;
  /** The live appointment of an engagement, for the `scheduled` case only. */
  readonly liveAppointmentStart: (engagementId: string) => Promise<string | null>;
}

export interface PhoneDueOptions {
  readonly now: Date;
  readonly limit: number;
}

const ZERO: PhoneDueResult = Object.freeze({
  status: 'disabled',
  examined: 0,
  offered: 0,
  dialing: 0,
  skipped: Object.freeze({}),
  refusals: Object.freeze({}),
});

/**
 * The kind this engagement's next attempt must carry.
 *
 * `admit_phone_attempt` refuses `kind_not_admissible` when the state and the
 * kind disagree, so this is not a preference — it is the only kind that state
 * can be admitted with. The one genuine choice is `initial` versus
 * `no_answer_retry`, and it is decided by whether the candidate has been
 * dialled before, which is what the counter records.
 */
export function dueAttemptKind(row: DuePhoneEngagement): PhoneAttemptKind | null {
  if (row.state === 'reconnecting') return 'reconnect';
  if (row.state === 'scheduled') return 'scheduled';
  if (row.state === 'eligible') return row.noAnswerAttempts > 0 ? 'no_answer_retry' : 'initial';
  return null;
}

/**
 * Whether the runtime-side clock says this row is due yet.
 *
 * `eligible` defers to `next_eligible_at`, which the database also enforces —
 * checking it here saves a refusal, it does not replace one.
 *
 * `reconnecting` is the case the database CANNOT decide: 0042 leaves the
 * reconnect backoff to "a worker clock rather than a database fact", so this
 * is the only place it exists. Dialling a dropped call back instantly would be
 * both useless and hostile.
 */
export function dueByClock(
  row: DuePhoneEngagement,
  now: Date,
  reconnectBackoffSeconds: number,
): boolean {
  if (row.state === 'reconnecting') {
    if (row.updatedAt === null) return false;
    const since = Date.parse(row.updatedAt);
    if (!Number.isFinite(since)) return false;
    return now.getTime() >= since + reconnectBackoffSeconds * 1_000;
  }
  if (row.nextEligibleAt === null) return true;
  const at = Date.parse(row.nextEligibleAt);
  if (!Number.isFinite(at)) return true;
  return now.getTime() >= at;
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export async function runPhoneDuePass(
  deps: PhoneDueDeps,
  options: PhoneDueOptions,
): Promise<PhoneDueResult> {
  // ── THE THREE SWITCHES, AND WHY `dialMode` IS ONE OF THEM ───────────
  // The two flags are obvious. `dialMode === 'off'` belongs here with them,
  // and putting it anywhere later would be a real hazard.
  //
  // The dial controller does NOT gate on the mode: it gates on the two flags
  // and a configured trunk, then ADMITS, and only afterwards hands the
  // originate to whichever client `resolvePhoneSipClient` chose — which for
  // `off` is the synthetic one. So `off` already guarantees no carrier is
  // reached. What it does NOT guarantee, once P5 supplies the first
  // production caller, is that nothing is spent: admission writes a real
  // `phone_call_attempts` row, takes one of the ten fleet slots, and charges
  // the candidate's IST-day index and no-answer budget. An operator who set
  // `off` and armed the runtime expecting a dry run would silently burn a
  // day of every due candidate's budget against calls that never happened.
  //
  // `synthetic` is deliberately NOT gated here: rehearsing admission is the
  // entire point of that mode. `off` means off.
  if (
    !deps.config.screeningEnabled
    || !deps.config.runtimeEnabled
    || deps.config.dialMode === 'off'
  ) {
    return ZERO;
  }

  // ── THE HALT, FIRST, AND FAIL CLOSED ────────────────────────────────
  // A control row we cannot read is a stop, not a go. `phone_backlog` already
  // reports a missing singleton as `halted: true`; a thrown read is treated
  // the same way here rather than being allowed to mean "carry on".
  let halted = true;
  try {
    const backlog = await deps.stores.backlog({ now: options.now });
    halted = backlog.admission?.halted !== false || backlog.admission?.controlPresent !== true;
  } catch {
    halted = true;
  }
  if (halted) {
    return { ...ZERO, status: 'halted' };
  }

  const due = await deps.reader.listDueEngagements({
    nowIso: options.now.toISOString(),
    limit: options.limit,
  });

  const skipped: Record<string, number> = {};
  const refusals: Record<string, number> = {};
  let offered = 0;
  let dialing = 0;

  // EVERY time-based gate runs before a single number is read, because a
  // number is the one value in this lane worth not fetching speculatively.
  // An earlier draft fetched numbers after the clock filter but before the
  // appointment gate, which meant a `scheduled` row whose slot was still an
  // hour away had its number read anyway — a read that could not change the
  // outcome. The gate order here is the one the comment always claimed.
  // ── THE IST WINDOW, BEFORE ANY WRITE OR ANY NUMBER READ ─────────────
  // `admit_phone_attempt` is the AUTHORITY on the window and re-checks it
  // under the advisory lock; this is a cheap preflight, not a second opinion,
  // and it reuses `istWindowOpen` — the same predicate `admission.ts` calls,
  // over the same `PHONE_IST_WINDOW` bounds — so there is exactly one
  // definition of 09:00 inclusive / 21:00 exclusive in TypeScript and it
  // cannot drift from the one in 0042.
  //
  // Without it the pass reached admission before the window was consulted,
  // which meant that through the closed hours it read every due candidate's
  // phone number out of SQL and minted a `call_sessions` row for each, four
  // times a minute, only to be refused `window_closed` every time. A write
  // and a number read that cannot change the outcome are exactly what the
  // gate order in this file exists to prevent.
  if (!istWindowOpen(options.now)) {
    return {
      status: 'ok',
      examined: due.length,
      offered: 0,
      dialing: 0,
      skipped: { outside_ist_window: due.length },
      refusals: {},
    };
  }

  // One engagement per CANDIDATE per pass. `uq_phone_engagements_application`
  // keys an engagement to an application link and the candidate index is not
  // unique, so one person applying to two roles has two engagements — two
  // independent budgets, two independent IST-day slots, and nothing in 0042
  // that stops both being admitted in the same second. The result would be
  // one phone ringing twice from a single pass.
  //
  // This bounds the hazard to a pass. It does NOT close it across passes or
  // across replicas: that needs a per-candidate guard inside
  // `admit_phone_attempt`, which is a 0042 change and is recorded as a
  // residual rather than smuggled in here.
  const offeredCandidates = new Set<string>();

  const ready: Array<{ row: DuePhoneEngagement; kind: PhoneAttemptKind }> = [];
  for (const row of due) {
    const kind = dueAttemptKind(row);
    if (kind === null) { bump(skipped, 'unknown_state'); continue; }
    if (!dueByClock(row, options.now, deps.config.reconnectBackoffSeconds)) {
      bump(skipped, 'not_yet_due');
      continue;
    }
    if (offeredCandidates.has(row.candidateId)) {
      bump(skipped, 'candidate_already_offered');
      continue;
    }

    if (kind === 'scheduled') {
      // The appointment's START is the due moment, and 0042 does not carry it
      // on the engagement — only the `scheduled` state. So it is read, and a
      // slot that has not arrived is simply not due yet.
      const startsAt = await deps.liveAppointmentStart(row.engagementId);
      const at = startsAt === null ? Number.NaN : Date.parse(startsAt);
      if (!Number.isFinite(at) || options.now.getTime() < at) {
        bump(skipped, 'appointment_not_due');
        continue;
      }
    }

    // The candidate's one offer per pass is claimed HERE, after every gate,
    // and not at the check above. A `scheduled` row whose slot has not
    // arrived is skipped `appointment_not_due` — it was never offered, so
    // spending the candidate's slot on it would silently suppress a sibling
    // engagement that IS due, and the health surface would show one
    // `appointment_not_due` and one `candidate_already_offered` with nothing
    // to say the second was caused by the first.
    offeredCandidates.add(row.candidateId);
    ready.push({ row, kind });
  }

  const numbers = await deps.reader.listDialableNumbers({
    candidateIds: ready.map((r) => r.row.candidateId),
  });

  for (const { row, kind } of ready) {
    const number = numbers.get(row.candidateId);
    if (number === undefined) { bump(skipped, 'no_dialable_number'); continue; }

    const sessionId = await deps.sessions.ensureSession({
      engagementId: row.engagementId,
      candidateId: row.candidateId,
      roleId: row.roleId,
      existingSessionId: row.sessionId,
    });
    if (sessionId === null) { bump(skipped, 'no_session'); continue; }

    offered += 1;
    const result = await deps.dialer.dial({
      engagementId: row.engagementId,
      candidateId: row.candidateId,
      sessionId,
      kind,
      number,
      now: options.now,
    });
    if (result.status === 'dialing') dialing += 1;
    else bump(refusals, phoneRefusalCountKey(result.refusal ?? 'unknown', result.detail));
  }

  return {
    status: 'ok',
    examined: due.length,
    offered,
    dialing,
    skipped: Object.freeze(skipped),
    refusals: Object.freeze(refusals),
  };
}
