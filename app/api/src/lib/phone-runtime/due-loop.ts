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
import type { DuePhoneEngagement, PhoneRuntimeReader } from './read.js';
import type { DialableNumber } from '../../integrations/livekit-phone-dial/dialable-number.js';

/** Why a due row was not offered to admission. Stable, sanitized, countable. */
export const PHONE_DUE_SKIPS = [
  // `halted` is deliberately ABSENT. The halted case returns early with an
  // empty `skipped` map, so a code for it here could never be emitted — and a
  // vocabulary entry that nothing can produce reads to an operator as a state
  // that has never occurred rather than one that cannot.
  'not_yet_due',
  'no_dialable_number',
  'no_session',
  'appointment_not_due',
  'unknown_state',
] as const;

export type PhoneDueSkip = (typeof PHONE_DUE_SKIPS)[number];

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
  }): Promise<{ status: 'dialing' | 'refused'; refusal?: string }>;
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
  const ready: Array<{ row: DuePhoneEngagement; kind: PhoneAttemptKind }> = [];
  for (const row of due) {
    const kind = dueAttemptKind(row);
    if (kind === null) { bump(skipped, 'unknown_state'); continue; }
    if (!dueByClock(row, options.now, deps.config.reconnectBackoffSeconds)) {
      bump(skipped, 'not_yet_due');
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

    ready.push({ row, kind });
  }

  const numbers = await deps.reader.listDialableNumbers({
    candidateIds: ready.map((r) => r.row.candidateId),
  });

  for (const { row, kind } of ready) {
    const number = numbers.get(row.candidateId);
    if (number === undefined) { bump(skipped, 'no_dialable_number'); continue; }

    const sessionId = await deps.sessions.ensureSession({
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
    else bump(refusals, result.refusal ?? 'unknown');
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
