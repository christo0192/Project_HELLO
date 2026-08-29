/**
 * plivo-phone/stores.ts — the SERVER-SIDE reads the Plivo answer callback
 * needs, and NOTHING the request is allowed to supply.
 *
 * ── WHY A DEDICATED READER ────────────────────────────────────────────
 * The answer callback resolves an attempt id (arriving on the forwarded SIP
 * header, validated as a uuid) into two facts it must decide server-side:
 *
 *   1. Is this attempt LIVE and AWAITING ANSWER — i.e. a leg we are legitimately
 *      bridging, not a terminal, superseded or already-classified one.
 *   2. The candidate's dialable E.164 — looked up HERE, never read from the
 *      request, because the request comes from the bounce endpoint and a
 *      number in it would be attacker-influenceable.
 *
 * The number is returned WRAPPED (`DialableNumber`), self-redacting exactly as
 * the dialer's is; the answer route unwraps it at the single point it builds
 * the `<Dial><Number>` XML, and that XML is never logged.
 *
 * Column discipline mirrors `read-stores.ts`: narrow, explicit selects, in the
 * pinned lock order (attempt → engagement → candidate), never a join that could
 * smuggle a provider-bearing column in later.
 */

import {
  isLiveAttemptState,
  isTerminalEngagementState,
} from '../../lib/phone-screening/index.js';
import {
  wrapDialableNumber,
  type DialableNumber,
} from '../livekit-phone-dial/dialable-number.js';

/** Minimal PostgREST surface, matching the shape the rest of the lane uses. */
interface MinimalClient {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string,
      ): { maybeSingle(): Promise<{ data: Record<string, unknown> | null; error: unknown }> };
    };
  };
}

export interface PlivoAttemptResolution {
  /** True iff the attempt is in a live, awaiting-answer state and non-terminal. */
  readonly bridgeable: boolean;
  /** True iff the engagement is terminal (used only by the answered-state read). */
  readonly terminal: boolean;
  /** True iff the attempt has been answered (answered_at set OR answered family). */
  readonly answered: boolean;
  /**
   * The candidate's dialable number, wrapped and self-redacting. Present ONLY
   * when `bridgeable` — a leg we will not bridge never resolves a number.
   */
  readonly candidateNumber?: DialableNumber;
}

/**
 * The states in which a leg is legitimately AWAITING an answer we are about to
 * bridge. `admitted`/`ringing` are pre-answer; `answered_unclassified` is
 * answered-but-not-yet-consented. `human`/`machine` are ALREADY classified —
 * the bounce endpoint answering again for those is a redelivery we do not
 * re-bridge — and every other state is not a leg at all. So the answer
 * callback bridges from exactly `admitted`/`ringing`/`answered_unclassified`.
 */
const AWAITING_ANSWER_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  'admitted',
  'ringing',
  'answered_unclassified',
]);

/** The three answered-family attempt states (answered, whatever the outcome). */
const ANSWERED_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  'answered_unclassified',
  'human',
  'machine',
]);

export interface PlivoBounceStore {
  /**
   * Resolve an attempt for the ANSWER callback: is it a bridgeable leg, and if
   * so, what is the candidate number. FAIL-CLOSED: any missing row, any read
   * error, a terminal engagement, a non-awaiting attempt, or an
   * unwrappable/invalid number all yield `bridgeable: false` and NO number.
   */
  resolveForAnswer(attemptId: string): Promise<PlivoAttemptResolution>;
  /**
   * The tiny answered-state read for the worker poll. Never throws for a
   * missing row (returns not-answered/not-terminal); a read error propagates so
   * the caller can 500 rather than assert a state it did not read.
   */
  readAnsweredState(attemptId: string): Promise<{ answered: boolean; terminal: boolean }>;
}

export function createPlivoBounceStore(client: MinimalClient): PlivoBounceStore {
  async function readAttempt(attemptId: string): Promise<{
    engagementId: string;
    attemptState: string;
    answeredAt: string | null;
  } | null> {
    const r = await client
      .from('phone_call_attempts')
      .select('id,engagement_id,state,answered_at')
      .eq('id', attemptId)
      .maybeSingle();
    if (r.error) throw new Error('plivo_attempt_read_error');
    const row = r.data;
    if (row === null) return null;
    const engagementId = typeof row.engagement_id === 'string' ? row.engagement_id : undefined;
    const attemptState = typeof row.state === 'string' ? row.state : undefined;
    if (engagementId === undefined || attemptState === undefined) return null;
    return {
      engagementId,
      attemptState,
      answeredAt: typeof row.answered_at === 'string' ? row.answered_at : null,
    };
  }

  async function readEngagement(engagementId: string): Promise<{
    candidateId: string;
    state: string;
    terminal: boolean;
  } | null> {
    const r = await client
      .from('phone_engagements')
      .select('id,candidate_id,state,terminal_at')
      .eq('id', engagementId)
      .maybeSingle();
    if (r.error) throw new Error('plivo_engagement_read_error');
    const row = r.data;
    if (row === null) return null;
    const candidateId = typeof row.candidate_id === 'string' ? row.candidate_id : undefined;
    const state = typeof row.state === 'string' ? row.state : undefined;
    if (candidateId === undefined || state === undefined) return null;
    // Terminal from EITHER the timestamp or the state name — the two are kept
    // in step by 0042, and reading both means a drift in one does not hide it.
    const terminal = row.terminal_at !== null && row.terminal_at !== undefined
      ? true
      : isTerminalEngagementState(state);
    return { candidateId, state, terminal };
  }

  async function readCandidateNumber(candidateId: string): Promise<DialableNumber | undefined> {
    const r = await client
      .from('candidates')
      .select('id,phone_e164,phone_valid')
      .eq('id', candidateId)
      .maybeSingle();
    if (r.error) throw new Error('plivo_candidate_read_error');
    const row = r.data;
    if (row === null) return undefined;
    // Honour the operator-visible validity verdict before parsing, exactly as
    // the runtime's `listDialableNumbers` does.
    if (row.phone_valid !== true) return undefined;
    const raw = row.phone_e164;
    if (typeof raw !== 'string') return undefined;
    try {
      return wrapDialableNumber(raw);
    } catch {
      // `phone_number_not_dialable` — dropped and never named.
      return undefined;
    }
  }

  return {
    async resolveForAnswer(attemptId: string): Promise<PlivoAttemptResolution> {
      const attempt = await readAttempt(attemptId);
      if (attempt === null) {
        return { bridgeable: false, terminal: false, answered: false };
      }
      const engagement = await readEngagement(attempt.engagementId);
      if (engagement === null) {
        return { bridgeable: false, terminal: false, answered: false };
      }
      const answered =
        attempt.answeredAt !== null || ANSWERED_ATTEMPT_STATES.has(attempt.attemptState);
      // Bridgeable requires a NON-terminal engagement and an awaiting-answer
      // attempt. `isLiveAttemptState` is the fleet-slot predicate; the
      // awaiting-answer set is a strict subset of it, so a leg that is live but
      // already classified does not bridge.
      const bridgeable =
        !engagement.terminal
        && isLiveAttemptState(attempt.attemptState)
        && AWAITING_ANSWER_ATTEMPT_STATES.has(attempt.attemptState);
      if (!bridgeable) {
        return { bridgeable: false, terminal: engagement.terminal, answered };
      }
      const candidateNumber = await readCandidateNumber(engagement.candidateId);
      if (candidateNumber === undefined) {
        // No dialable number ⇒ nothing to bridge to. Fail closed.
        return { bridgeable: false, terminal: engagement.terminal, answered };
      }
      return { bridgeable: true, terminal: engagement.terminal, answered, candidateNumber };
    },

    async readAnsweredState(attemptId: string): Promise<{ answered: boolean; terminal: boolean }> {
      const attempt = await readAttempt(attemptId);
      if (attempt === null) return { answered: false, terminal: false };
      const engagement = await readEngagement(attempt.engagementId);
      const answered =
        attempt.answeredAt !== null || ANSWERED_ATTEMPT_STATES.has(attempt.attemptState);
      return { answered, terminal: engagement?.terminal ?? false };
    },
  };
}
