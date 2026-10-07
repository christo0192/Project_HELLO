/**
 * Who is allowed to tell the candidate page what phase the interview is in.
 *
 * Invariants:
 *   - The phase is trusted ONLY from a participant whose kind is AGENT. The
 *     candidate, and anyone else who might share the room, cannot move the
 *     page between phases or end the interview by setting an attribute.
 *   - Trust is by kind alone. An attribute that merely claims to be the
 *     interviewer is not evidence of anything.
 */

import { ParticipantKind } from 'livekit-client';
import { parseR1Phase, R1_PHASE_ATTRIBUTE, type R1Phase } from './r1-phase';

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
