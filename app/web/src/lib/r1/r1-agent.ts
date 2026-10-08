/**
 * Who is allowed to tell the candidate page what is happening in the interview.
 *
 * Invariants:
 *   - The phase, the learner's name, the role-play clock and the "waiting for
 *     you to say ready" flag are trusted ONLY from a participant whose kind is
 *     AGENT. The candidate, and anyone else who might share the room, cannot
 *     move the page between phases, end the interview, rename the learner,
 *     stop the clock or show a button by setting an attribute.
 *   - Trust is by kind alone. An attribute that merely claims to be the
 *     interviewer is not evidence of anything.
 *   - Every value is validated before it is used. A value outside its shape is
 *     treated as absent, never rendered: the page shows fixed vocabulary, a
 *     name made only of letters, and a number.
 *
 * The attribute keys are single plain lowercase words on purpose (see the
 * worker's `r1_session.py`): the server SDK camel-cases a dotted key, and the
 * values are strings, with an empty string meaning "removed".
 */

import { ParticipantKind } from 'livekit-client';
import { parseR1Phase, R1_PHASE_ATTRIBUTE, type R1Phase } from './r1-phase';

/** The learner's display name, published with the `transition` phase and kept afterwards. */
export const R1_LEAD_NAME_ATTRIBUTE = 'leadname';
/** Whole seconds of role-play budget left, while the role-play is active or paused. */
export const R1_ROLEPLAY_LEFT_ATTRIBUTE = 'rpleft';
/** `ready` while the interviewer is waiting for the candidate to say they are ready. */
export const R1_AWAITING_ATTRIBUTE = 'awaiting';

/** Every attribute key the page reads from the interviewer. */
export const R1_AGENT_ATTRIBUTES: readonly string[] = Object.freeze([
  R1_PHASE_ATTRIBUTE,
  R1_LEAD_NAME_ATTRIBUTE,
  R1_ROLEPLAY_LEFT_ATTRIBUTE,
  R1_AWAITING_ATTRIBUTE,
]);

/** The longest budget the worker publishes (one hour); anything above is not a clock. */
const MAX_ROLEPLAY_LEFT_SECONDS = 3600;

/** Letters (any script, with combining marks), spaces, apostrophes and hyphens; 40 characters. */
const LEAD_NAME = /^\p{L}[\p{L}\p{M} '’-]{0,39}$/u;

/** The minimal participant surface the trust rule reads. */
export interface PhaseSource {
  kind: unknown;
  attributes?: Readonly<Record<string, string>>;
}

/** True only for the interviewer agent: the one identity allowed to drive the page. */
export function isAgentParticipant(participant: { kind: unknown } | null | undefined): boolean {
  const agentKind = (ParticipantKind as unknown as { AGENT?: unknown } | undefined)?.AGENT;
  return participant != null && agentKind !== undefined && participant.kind === agentKind;
}

/**
 * The phase carried by a participant, or null when that participant is not the
 * agent, carries no phase, or carries a value outside the vocabulary.
 */
export function trustedPhase(participant: PhaseSource | null | undefined): R1Phase | null {
  if (!participant || !isAgentParticipant(participant)) return null;
  return parseR1Phase(participant.attributes?.[R1_PHASE_ATTRIBUTE]);
}

/** The learner's name when it is one the card may show, else null. */
export function parseLeadName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return LEAD_NAME.test(name) ? name : null;
}

/** Whole seconds of role-play left (0 to 3600) from a plain decimal string, else null. */
export function parseRoleplayLeft(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{1,4}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= MAX_ROLEPLAY_LEFT_SECONDS ? seconds : null;
}

/** `ready` is the only flag the interviewer can raise; any other value is no flag. */
export function parseAwaiting(value: unknown): 'ready' | null {
  return value === 'ready' ? 'ready' : null;
}

/** What the interviewer is currently telling the page, every field validated. */
export interface AgentSignals {
  phase: R1Phase | null;
  leadName: string | null;
  /** Seconds of role-play budget left when the interviewer last said, or null. */
  rpleft: number | null;
  awaiting: 'ready' | null;
}

/**
 * Everything the interviewer publishes, from an AGENT-kind participant only: null for anyone
 * else. A missing or malformed attribute reads as absent (null), so a snapshot always describes
 * the participant's CURRENT attributes, and a cleared one (the SDK drops an empty value)
 * reads as gone.
 */
export function trustedSignals(participant: PhaseSource | null | undefined): AgentSignals | null {
  if (!participant || !isAgentParticipant(participant)) return null;
  const attributes = participant.attributes;
  return {
    phase: parseR1Phase(attributes?.[R1_PHASE_ATTRIBUTE]),
    leadName: parseLeadName(attributes?.[R1_LEAD_NAME_ATTRIBUTE]),
    rpleft: parseRoleplayLeft(attributes?.[R1_ROLEPLAY_LEFT_ATTRIBUTE]),
    awaiting: parseAwaiting(attributes?.[R1_AWAITING_ATTRIBUTE]),
  };
}
