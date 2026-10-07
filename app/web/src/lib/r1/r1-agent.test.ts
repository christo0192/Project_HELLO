import { describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  ParticipantKind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
}));

import { isAgentParticipant, trustedPhase } from './r1-agent';

const AGENT = 4;
const STANDARD = 0;

describe('who may drive the page', () => {
  it('trusts the phase only from an agent participant', () => {
    const attributes = { phase: 'roleplay' };
    expect(trustedPhase({ kind: AGENT, attributes })).toBe('roleplay');
    expect(trustedPhase({ kind: STANDARD, attributes })).toBeNull();
  });

  it('cannot be spoofed by an attribute that merely claims to be the interviewer', () => {
    const attributes = { phase: 'ended', hello_speaker: 'interviewer' };
    expect(trustedPhase({ kind: STANDARD, attributes })).toBeNull();
  });

  it('ignores a missing participant, a missing attribute and an unknown value', () => {
    expect(trustedPhase(null)).toBeNull();
    expect(trustedPhase(undefined)).toBeNull();
    expect(trustedPhase({ kind: AGENT, attributes: {} })).toBeNull();
    expect(trustedPhase({ kind: AGENT })).toBeNull();
    expect(trustedPhase({ kind: AGENT, attributes: { phase: '<b>ended</b>' } })).toBeNull();
  });

  it('identifies the agent by kind alone', () => {
    expect(isAgentParticipant({ kind: AGENT })).toBe(true);
    expect(isAgentParticipant({ kind: STANDARD })).toBe(false);
    expect(isAgentParticipant(undefined)).toBe(false);
    expect(isAgentParticipant({ kind: 'agent' })).toBe(false);
  });
});
