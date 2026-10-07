/**
 * The trusted R1 administration log (plan 6.2), parsed from `r1_admin_log`.
 *
 * The worker, not the LLM, schedules every objection and decides every reveal, so these rows
 * are ground truth for the scorer and the coverage/fidelity gate. They hold structured
 * numbers and identifiers only, never candidate speech. `routes/r1.ts` accepts the rows;
 * this module reads them.
 *
 * ORDERING CONTRACT (PR-4b must conform). Every row, `session_facts` included, MUST be posted
 * BEFORE the session's terminal transition (`complete_session`). `POST /api/internal/r1/
 * admin-log` answers 409 `r1_session` once the session has left `waiting`/`in_progress`, and the
 * `r1.assessment` job is enqueued by the 0116 trigger at that same transition, so a row posted
 * afterwards is refused and the scorer fails the gate closed (`fidelity_facts_missing`). This is
 * the opposite of the natural "post facts after the call ends" order, and it differs from the
 * attempt outcome, which PR-4a posts after the transition. Pinned by
 * `r1-routes.test.ts` ("refuses admin-log rows once the session is terminal").
 *
 * The payload contract per event type (anything missing fails the gate closed):
 *
 *   need_revealed      turn_index = reveal turn.
 *                      payload { need: 'H1'|'H2'|'H3', probed_turn: int|null }
 *   family_delivered   family_id 'F1'..'F4' (the primary line), turn_index = delivery turn.
 *                      payload { slip_seconds: number >= 0 }
 *   push_delivered     same as family_delivered, for the family's push line.
 *   counter_delivered  family_id 'F1', the counter after the first concession or refusal.
 *                      payload { slip_seconds: number >= 0 }
 *   discount_detected  turn_index = turn of the candidate's offer.
 *                      payload { amount_usd: number, conditional: bool, value_before: bool }
 *   guard_hit          payload { kind: 'commitment'|'concession'|'control'|'persona'|
 *                                'feedback'|'other' }
 *   time_cue           payload { roleplay_seconds: number }, the learner time cue (R about 660).
 *   session_facts      once per session. payload { roleplay_seconds, talk_share_pct,
 *                      longest_monologue_seconds, barge_in_count, question_count,
 *                      interruption_count, first_audio_p95_ms }
 */

export interface R1AdminLogRow {
  readonly event_type: string;
  readonly turn_index: number | null;
  readonly family_id: string | null;
  readonly payload: unknown;
  readonly created_at?: string;
}

export const R1_FAMILIES = ['F1', 'F2', 'F3', 'F4'] as const;
export type R1Family = (typeof R1_FAMILIES)[number];

export interface R1Delivery {
  readonly turn: number | null;
  readonly slipSeconds: number | null;
}

export interface R1NeedReveal {
  readonly need: string;
  readonly probedTurn: number | null;
  readonly revealedTurn: number | null;
}

export interface R1DiscountEvent {
  readonly turn: number | null;
  readonly amountUsd: number | null;
  readonly conditional: boolean | null;
  readonly valueBefore: boolean | null;
}

export interface R1SessionFacts {
  readonly roleplaySeconds: number | null;
  readonly talkSharePct: number | null;
  readonly longestMonologueSeconds: number | null;
  readonly bargeInCount: number | null;
  readonly questionCount: number | null;
  readonly interruptionCount: number | null;
  readonly firstAudioP95Ms: number | null;
}

export interface R1AdministrationLog {
  readonly needs: readonly R1NeedReveal[];
  readonly families: Readonly<Record<R1Family, {
    readonly primary: R1Delivery | null;
    readonly push: R1Delivery | null;
  }>>;
  readonly counter: R1Delivery | null;
  readonly discounts: readonly R1DiscountEvent[];
  readonly guardHits: readonly { readonly kind: string; readonly turn: number | null }[];
  /** Role-play clock at the learner time cue; null when it was never delivered. */
  readonly timeCueRoleplaySeconds: number | null;
  readonly facts: R1SessionFacts | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function turnOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function boolOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function isFamily(value: unknown): value is R1Family {
  return typeof value === 'string' && (R1_FAMILIES as readonly string[]).includes(value);
}

/** The guard kinds the gate recognises; anything else is recorded as `other`. */
const GUARD_KINDS: ReadonlySet<string> = new Set([
  'commitment',
  'concession',
  'control',
  'persona',
  'feedback',
  'other',
]);

/**
 * Parse rows (any order is accepted: they are sorted by creation time) into the typed log.
 * Tolerant by design: a malformed row degrades to null fields, which the gate then treats as
 * unknown and fails closed. The FIRST delivery of a line wins; the LATEST session_facts wins.
 */
export function parseR1AdministrationLog(rows: readonly R1AdminLogRow[]): R1AdministrationLog {
  const ordered = [...rows].sort((a, b) =>
    String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  const needs: R1NeedReveal[] = [];
  const families: Record<R1Family, { primary: R1Delivery | null; push: R1Delivery | null }> = {
    F1: { primary: null, push: null },
    F2: { primary: null, push: null },
    F3: { primary: null, push: null },
    F4: { primary: null, push: null },
  };
  let counter: R1Delivery | null = null;
  const discounts: R1DiscountEvent[] = [];
  const guardHits: { kind: string; turn: number | null }[] = [];
  let timeCue: number | null = null;
  let facts: R1SessionFacts | null = null;

  for (const row of ordered) {
    const payload = asRecord(row.payload);
    const turn = turnOf(row.turn_index);
    const delivery: R1Delivery = { turn, slipSeconds: finiteNonNegative(payload.slip_seconds) };
    switch (row.event_type) {
      case 'need_revealed':
        needs.push({
          need: typeof payload.need === 'string' ? payload.need.slice(0, 8) : 'unknown',
          probedTurn: turnOf(payload.probed_turn),
          revealedTurn: turn,
        });
        break;
      case 'family_delivered':
        if (isFamily(row.family_id) && families[row.family_id].primary === null) {
          families[row.family_id].primary = delivery;
        }
        break;
      case 'push_delivered':
        if (isFamily(row.family_id) && families[row.family_id].push === null) {
          families[row.family_id].push = delivery;
        }
        break;
      case 'counter_delivered':
        if (counter === null) counter = delivery;
        break;
      case 'discount_detected':
        discounts.push({
          turn,
          amountUsd: finiteNonNegative(payload.amount_usd),
          conditional: boolOrNull(payload.conditional),
          valueBefore: boolOrNull(payload.value_before),
        });
        break;
      case 'guard_hit': {
        const kind = typeof payload.kind === 'string' && GUARD_KINDS.has(payload.kind)
          ? payload.kind
          : 'other';
        guardHits.push({ kind, turn });
        break;
      }
      case 'time_cue':
        if (timeCue === null) timeCue = finiteNonNegative(payload.roleplay_seconds);
        break;
      case 'session_facts':
        facts = {
          roleplaySeconds: finiteNonNegative(payload.roleplay_seconds),
          talkSharePct: finiteNonNegative(payload.talk_share_pct),
          longestMonologueSeconds: finiteNonNegative(payload.longest_monologue_seconds),
          bargeInCount: finiteNonNegative(payload.barge_in_count),
          questionCount: finiteNonNegative(payload.question_count),
          interruptionCount: finiteNonNegative(payload.interruption_count),
          firstAudioP95Ms: finiteNonNegative(payload.first_audio_p95_ms),
        };
        break;
      default:
        break;
    }
  }
  return {
    needs,
    families,
    counter,
    discounts,
    guardHits,
    timeCueRoleplaySeconds: timeCue,
    facts,
  };
}
