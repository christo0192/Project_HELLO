import { describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  ParticipantKind: { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 },
}));

import {
  isAgentParticipant,
  parseAwaiting,
  parseLeadName,
  parseRoleplayLeft,
  R1_AGENT_ATTRIBUTES,
  trustedPhase,
  trustedSignals,
} from './r1-agent';

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

describe('the learner name', () => {
  it.each(['Meera Iyer', 'Anne-Marie', "Siobhan O'Neil", 'Zoë Ålund', 'Mei Ling', 'A'])(
    'accepts %s',
    (name) => {
      expect(parseLeadName(name)).toBe(name);
    },
  );

  it('trims the edges and accepts a name in another script, with its combining marks', () => {
    expect(parseLeadName('  Meera Iyer ')).toBe('Meera Iyer');
    expect(parseLeadName('मीरा अय्यर')).toBe('मीरा अय्यर');
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['markup', '<b>Meera</b>'],
    ['digits', 'Meera 2'],
    ['a url', 'meera.example.com/x'],
    ['a comma (that is a city)', 'Meera Iyer, Edison'],
    ['too long', 'M'.repeat(41)],
    ['a leading hyphen', '-Meera'],
    ['a newline', 'Meera\nIyer'],
    ['not a string', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, value) => {
    expect(parseLeadName(value)).toBeNull();
  });

  it('accepts exactly 40 characters', () => {
    expect(parseLeadName('M'.repeat(40))).toBe('M'.repeat(40));
  });
});

describe('the role-play clock value', () => {
  it.each([
    ['0', 0],
    ['1', 1],
    ['480', 480],
    ['840', 840],
    ['3600', 3600],
    ['0042', 42],
  ])('reads %s as %i seconds', (value, seconds) => {
    expect(parseRoleplayLeft(value)).toBe(seconds);
  });

  it.each([
    '',
    '-1',
    '3601',
    '99999',
    '12.5',
    '1e3',
    ' 480',
    '480 ',
    '0x10',
    'soon',
    'NaN',
    'Infinity',
  ])('ignores %j', (value) => {
    expect(parseRoleplayLeft(value)).toBeNull();
  });

  it('ignores a value that is not a string', () => {
    expect(parseRoleplayLeft(480)).toBeNull();
    expect(parseRoleplayLeft(undefined)).toBeNull();
    expect(parseRoleplayLeft(null)).toBeNull();
  });
});

describe('the waiting-for-ready flag', () => {
  it('is raised only by the exact word', () => {
    expect(parseAwaiting('ready')).toBe('ready');
    for (const value of ['', 'Ready', 'READY', 'ready ', 'true', '1', 'yes', undefined, null, true]) {
      expect(parseAwaiting(value), String(value)).toBeNull();
    }
  });
});

describe('everything the interviewer publishes', () => {
  const FULL = { phase: 'transition', leadname: 'Meera Iyer', rpleft: '840', awaiting: 'ready' };

  it('reads all four from the agent, validated', () => {
    expect(trustedSignals({ kind: AGENT, attributes: FULL })).toEqual({
      phase: 'transition',
      leadName: 'Meera Iyer',
      rpleft: 840,
      awaiting: 'ready',
    });
  });

  it('reads each attribute independently: a worker that publishes only some leaves the rest absent', () => {
    expect(trustedSignals({ kind: AGENT, attributes: { phase: 'roleplay' } })).toEqual({
      phase: 'roleplay',
      leadName: null,
      rpleft: null,
      awaiting: null,
    });
    expect(trustedSignals({ kind: AGENT, attributes: { rpleft: '65' } })).toEqual({
      phase: null,
      leadName: null,
      rpleft: 65,
      awaiting: null,
    });
    expect(trustedSignals({ kind: AGENT })).toEqual({
      phase: null,
      leadName: null,
      rpleft: null,
      awaiting: null,
    });
  });

  it('treats each invalid value as absent and keeps the valid ones', () => {
    expect(
      trustedSignals({
        kind: AGENT,
        attributes: { phase: 'jailbreak', leadname: '<img src=x>', rpleft: '99999', awaiting: 'now' },
      }),
    ).toEqual({ phase: null, leadName: null, rpleft: null, awaiting: null });
    expect(
      trustedSignals({ kind: AGENT, attributes: { ...FULL, rpleft: 'soon', leadname: '' } }),
    ).toEqual({ phase: 'transition', leadName: null, rpleft: null, awaiting: 'ready' });
  });

  it('trusts none of it from anyone who is not the agent', () => {
    for (const kind of [STANDARD, 1, 2, 3, 'agent', undefined]) {
      expect(trustedSignals({ kind, attributes: FULL }), String(kind)).toBeNull();
    }
    expect(trustedSignals(null)).toBeNull();
    expect(trustedSignals(undefined)).toBeNull();
  });

  it('lists exactly the four keys the page reads, each a single lowercase word', () => {
    expect([...R1_AGENT_ATTRIBUTES].sort()).toEqual(['awaiting', 'leadname', 'phase', 'rpleft']);
    for (const key of R1_AGENT_ATTRIBUTES) expect(key).toMatch(/^[a-z]+$/);
  });
});
