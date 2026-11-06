/**
 * A state keeps its family on every screen.
 *
 * The owner's real-data review of 2026-11-06 found the same state in two colours:
 * "Writing back to Ashby" blue on one screen and olive on another, and "Completed"
 * green here and grey there. Each vocabulary below is read through the functions the
 * screens themselves call, never a copy, and is pinned three ways: each state has its
 * family, a printed word has one family across every vocabulary that prints it, and
 * states that mean the same thing under different words agree.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  allowlistStateLabel,
  allowlistStateTone,
  auditResultTone,
  type AllowlistEntryState,
} from '../components/mission-control/statusMeta';
import { PHONE_STATE_ORDER, PHONE_STATUS_ORDER } from '../components/phone-calendar/phoneCalendarFilters';
import { appointmentStatusTerm, engagementStateTerm } from '../components/phone-calendar/phoneVocabulary';
import {
  ashbyIngestionLabel,
  ashbyLifecycleLabel,
  ashbyOperationStateLabel,
  ashbyTerminalStateLabel,
} from '../components/talent/AshbyWorkflowCard';
import { CANDIDATE_STATUS_ORDER } from '../components/talent/candidateFilters';
import {
  ashbyIngestionTone,
  ashbyLifecycleTone,
  ashbyOperationStateTone,
  ashbyTerminalTone,
  candidateStatusLabel,
  candidateStatusTone,
  sessionStatusLabel,
  sessionStatusTone,
} from '../components/talent/status';
import { humanizeEnum } from '../lib/humanize';
import { R1_STATUS_LABEL, r1StatusLabel, r1StatusTone } from '../lib/r1';
import { r1RecordingStateCopy } from '../lib/r1-recording';
import type { R1RecordingSummary } from '../lib/r1-types';

vi.mock('../api', () => ({ api: {}, ApiError: class extends Error {} }));

type Family = 'moving' | 'ready' | 'unresolved' | 'closed' | 'danger' | 'neutral';

/** A badge says `info`, a tag says `moving`: one family. `negative` is the tag's fault. */
const FAMILY_OF: Readonly<Record<string, Family>> = {
  info: 'moving',
  moving: 'moving',
  success: 'ready',
  ready: 'ready',
  warning: 'unresolved',
  unresolved: 'unresolved',
  closed: 'closed',
  danger: 'danger',
  negative: 'danger',
  neutral: 'neutral',
};

interface Vocabulary {
  name: string;
  term: (state: string) => { word: string; tone: string };
  families: Readonly<Record<string, Family>>;
}

const VOCABULARIES: readonly Vocabulary[] = [
  {
    name: 'candidate status',
    term: (state) => ({ word: candidateStatusLabel(state), tone: candidateStatusTone(state) }),
    families: {
      new: 'moving',
      queued: 'moving',
      screening: 'moving',
      screened: 'ready',
      advanced: 'ready',
      rejected: 'closed',
      consent_declined: 'closed',
      opted_out: 'closed',
      phone_cancelled: 'closed',
      abandoned_no_answer: 'unresolved',
      wrong_number: 'unresolved',
      screening_abandoned: 'unresolved',
      phone_failed: 'danger',
    },
  },
  {
    name: 'session',
    term: (state) => ({ word: sessionStatusLabel(state), tone: sessionStatusTone(state) }),
    families: {
      created: 'moving',
      waiting: 'moving',
      in_progress: 'moving',
      completed: 'ready',
      abandoned: 'unresolved',
      cancelled: 'closed',
      expired: 'closed',
      deleted: 'closed',
      failed: 'danger',
    },
  },
  {
    name: 'engagement',
    term: (state) => {
      const { label, tone } = engagementStateTerm(state);
      return { word: label, tone };
    },
    families: {
      pending_prereqs: 'unresolved',
      eligible: 'moving',
      scheduled: 'moving',
      dialing: 'moving',
      in_call: 'moving',
      reconnecting: 'moving',
      awaiting_retry: 'moving',
      completed: 'ready',
      abandoned_no_answer: 'unresolved',
      opted_out: 'closed',
      wrong_number: 'unresolved',
      failed: 'danger',
      cancelled: 'closed',
    },
  },
  {
    name: 'appointment',
    term: (state) => {
      const { label, tone } = appointmentStatusTerm(state);
      return { word: label, tone };
    },
    families: {
      scheduled: 'moving',
      confirmed: 'moving',
      fulfilled: 'ready',
      missed: 'unresolved',
      cancelled: 'closed',
      superseded: 'closed',
    },
  },
  {
    name: 'R1 round',
    term: (state) => ({ word: r1StatusLabel(state), tone: r1StatusTone(state) }),
    families: { invited: 'moving', in_progress: 'moving', completed: 'ready', expired: 'closed', cancelled: 'closed' },
  },
  {
    name: 'recording',
    term: (state) => {
      const { tag, tone } = r1RecordingStateCopy({ state } as R1RecordingSummary);
      return { word: tag, tone };
    },
    families: {
      none: 'neutral',
      recording: 'moving',
      processing: 'moving',
      ready: 'ready',
      partial: 'unresolved',
      deleted: 'closed',
      failed: 'danger',
    },
  },
  {
    name: 'Ashby lifecycle',
    term: (state) => ({ word: ashbyLifecycleLabel(state), tone: ashbyLifecycleTone(state) }),
    families: {
      imported: 'moving',
      processing: 'moving',
      ready: 'moving',
      writeback_pending: 'moving',
      completed: 'ready',
      cancelled: 'closed',
    },
  },
  {
    name: 'Ashby resume import',
    term: (state) => ({ word: ashbyIngestionLabel(state), tone: ashbyIngestionTone(state) }),
    families: {
      queued: 'moving',
      fetching: 'moving',
      scanning: 'moving',
      extracting: 'moving',
      structuring: 'moving',
      ready: 'ready',
      failed_review: 'unresolved',
      cancelled: 'closed',
    },
  },
  {
    name: 'Ashby operation',
    term: (state) => ({ word: ashbyOperationStateLabel(state), tone: ashbyOperationStateTone(state) }),
    families: {
      pending: 'moving',
      running: 'moving',
      succeeded: 'ready',
      blocked: 'unresolved',
      failed: 'danger',
      cancelled: 'closed',
    },
  },
  {
    // TERMINAL_TRIGGERS in the API. Any value says the application ended.
    name: 'Ashby terminal state',
    term: (state) => ({ word: ashbyTerminalStateLabel(state), tone: ashbyTerminalTone() }),
    families: { withdrawn: 'closed', deleted: 'closed', manual_stage_cancel: 'closed' },
  },
  {
    name: 'access entry',
    term: (state) => {
      const entry = state as AllowlistEntryState;
      return { word: allowlistStateLabel(entry), tone: allowlistStateTone(entry) };
    },
    families: { linked: 'ready', pending: 'unresolved', disabled: 'closed' },
  },
  {
    name: 'audit result',
    term: (state) => ({ word: humanizeEnum(state), tone: auditResultTone(state) }),
    families: { success: 'ready', failure: 'unresolved', pending: 'moving' },
  },
];

const vocabulary = (name: string): Vocabulary => {
  const found = VOCABULARIES.find((entry) => entry.name === name);
  if (!found) throw new Error(`no vocabulary named "${name}"`);
  return found;
};

const familyOf = (name: string, state: string): Family => {
  const family = FAMILY_OF[vocabulary(name).term(state).tone];
  if (!family) throw new Error(`${name} ${state} has no family`);
  return family;
};

const everyState = VOCABULARIES.flatMap(({ name, families }) =>
  Object.entries(families).map(([state, family]) => [name, state, family] as const),
);

/**
 * One printed word that means two things, on purpose, and the only one.
 *
 * A pending access entry waits on a person who has not signed in, so it is unresolved,
 * as the brief asks. A pending Ashby operation or audit row is queued work the process
 * has, so it is moving. Forcing one family would say something untrue on one screen.
 * Recorded in docs/design/logsheet-colour-decision-2026-11-06.md.
 */
const TWO_MEANINGS: Readonly<Record<string, readonly Family[]>> = {
  pending: ['moving', 'unresolved'],
};

describe('each state has its family', () => {
  it.each(everyState)('%s %s is %s', (name, state, family) => {
    expect(familyOf(name, state)).toBe(family);
  });

  it.each([
    ['candidate status', CANDIDATE_STATUS_ORDER],
    ['engagement', PHONE_STATE_ORDER],
    ['appointment', PHONE_STATUS_ORDER],
    ['R1 round', Object.keys(R1_STATUS_LABEL)],
  ] as const)('leaves no %s out of this table', (name, states) => {
    expect(Object.keys(vocabulary(name).families).sort()).toEqual([...states].sort());
  });

  it('gives a state no one has taught it no meaning', () => {
    for (const { name } of VOCABULARIES) {
      if (name === 'access entry') continue; // A closed union, derived from two columns.
      if (name === 'Ashby terminal state') continue; // Any value here already means it ended.
      expect(familyOf(name, 'a_later_state'), name).toBe('neutral');
    }
  });
});

describe('a printed word has one family, whichever screen prints it', () => {
  const screensOf = new Map<string, Map<Family, string[]>>();
  for (const [name, state] of everyState) {
    const word = vocabulary(name).term(state).word.toLowerCase();
    const families = screensOf.get(word) ?? new Map<Family, string[]>();
    const family = familyOf(name, state);
    families.set(family, [...(families.get(family) ?? []), name]);
    screensOf.set(word, families);
  }

  it('finds no second family except the one recorded below', () => {
    const split = [...screensOf].filter(([, families]) => families.size > 1).map(([word]) => word);
    expect(split).toEqual(Object.keys(TWO_MEANINGS));
  });

  it('keeps the recorded exception to exactly what the record says', () => {
    for (const [word, families] of Object.entries(TWO_MEANINGS)) {
      expect([...screensOf.get(word)!.keys()].sort()).toEqual([...families].sort());
    }
    expect(screensOf.get('pending')!.get('unresolved')).toEqual(['access entry']);
    expect(screensOf.get('pending')!.get('moving')).toEqual(['Ashby operation', 'audit result']);
  });

  it('really is looking at words several screens share', () => {
    const shared = [...screensOf].filter(([, families]) => [...families.values()].flat().length > 1).map(([word]) => word);
    expect(shared).toEqual(
      expect.arrayContaining(['completed', 'cancelled', 'failed', 'in progress', 'ready', 'queued', 'deleted', 'processing']),
    );
  });
});

describe('the same state under different words agrees', () => {
  it.each([
    [
      'underway',
      'moving',
      [
        ['session', 'in_progress'],
        ['R1 round', 'in_progress'],
        ['engagement', 'in_call'],
        ['Ashby operation', 'running'],
        ['Ashby lifecycle', 'writeback_pending'],
        ['recording', 'processing'],
      ],
    ],
    [
      'a good result',
      'ready',
      [
        ['session', 'completed'],
        ['engagement', 'completed'],
        ['R1 round', 'completed'],
        ['appointment', 'fulfilled'],
        ['Ashby lifecycle', 'completed'],
        ['Ashby operation', 'succeeded'],
      ],
    ],
    [
      'unfinished, and not known to be our fault',
      'unresolved',
      [
        ['candidate status', 'abandoned_no_answer'],
        ['engagement', 'abandoned_no_answer'],
        ['candidate status', 'wrong_number'],
        ['engagement', 'wrong_number'],
        ['session', 'abandoned'],
        ['appointment', 'missed'],
      ],
    ],
    [
      'ended, no judgement implied',
      'closed',
      [
        ['candidate status', 'phone_cancelled'],
        ['engagement', 'cancelled'],
        ['session', 'cancelled'],
        ['appointment', 'cancelled'],
        ['R1 round', 'cancelled'],
        ['Ashby lifecycle', 'cancelled'],
        ['Ashby operation', 'cancelled'],
        ['Ashby terminal state', 'withdrawn'],
        ['Ashby terminal state', 'manual_stage_cancel'],
      ],
    ],
    [
      'a fault on our side',
      'danger',
      [
        ['candidate status', 'phone_failed'],
        ['engagement', 'failed'],
        ['session', 'failed'],
        ['Ashby operation', 'failed'],
        ['recording', 'failed'],
      ],
    ],
  ] as const)('%s is %s', (_meaning, family, states) => {
    for (const [name, state] of states) expect(familyOf(name, state), `${name} ${state}`).toBe(family);
  });
});
