import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  captionSpeakerFor,
  isLeadCardVisible,
  mergeCaptions,
  parseR1Phase,
  R1_MAX_CAPTIONS,
  R1_NO_PHASE_LABELS,
  R1_PHASE_ATTRIBUTE,
  R1_PHASE_LABELS,
  R1_PHASES,
  type CaptionSegment,
  type R1Caption,
} from './r1-phase';

/**
 * PR-4a's `R1Phase` values in declaration order, as of `r1/pr4a-worker-core`
 * (`app/voice-livekit/r1_phases.py`). The worker publishes these as the `phase`
 * participant attribute and adds `ended` itself just before it closes the room.
 */
const WORKER_PHASES = [
  'pre_join',
  'opening',
  'icebreaker',
  'transition',
  'roleplay',
  'aside',
  'roleplay_exit',
  'wrapup',
  'closing',
  'finishing',
  'paused_disconnected',
  'aborted',
] as const;

const WORKER_PHASES_FILE = resolve(process.cwd(), '..', 'voice-livekit', 'r1_phases.py');

/** The string values of `class R1Phase(...)` in the worker source, in declaration order. */
function workerPhaseValues(source: string): string[] {
  const start = source.search(/^class R1Phase\b/m);
  if (start === -1) return [];
  const values: string[] = [];
  for (const line of source.slice(start).split('\n').slice(1)) {
    if (/^\S/.test(line)) break; // the next top-level statement ends the class body
    const member = /^ {4}[A-Z_]+ = "([a-z_]+)"/.exec(line);
    if (member) values.push(member[1]);
  }
  return values;
}

describe('phase vocabulary', () => {
  it('reads a plain lowercase attribute key', () => {
    expect(R1_PHASE_ATTRIBUTE).toBe('phase');
    expect(R1_PHASE_ATTRIBUTE).toMatch(/^[a-z]+$/);
  });

  it('is the worker R1Phase enum plus the terminal ended, value for value', () => {
    expect([...R1_PHASES]).toEqual([...WORKER_PHASES, 'ended']);
  });

  // Skipped, and named so in the report, until PR-4a's worker core is on this branch.
  it.skipIf(!existsSync(WORKER_PHASES_FILE))(
    'stays equal to app/voice-livekit/r1_phases.py R1Phase (SKIPPED until PR-4a is merged)',
    () => {
      expect(workerPhaseValues(readFileSync(WORKER_PHASES_FILE, 'utf8'))).toEqual([
        ...WORKER_PHASES,
      ]);
    },
  );

  it('reads the values of the worker enum class and nothing else in the file', () => {
    const source = [
      'class Other(str, Enum):',
      '    NOPE = "nope"',
      '',
      'class R1Phase(str, Enum):',
      '    PRE_JOIN = "pre_join"',
      '    OPENING = "opening"',
      '',
      '# 4:30 icebreaker',
      'NORMAL_PATH_MAX_SEC = 5',
      '    LATER = "later"',
    ].join('\n');
    expect(workerPhaseValues(source)).toEqual(['pre_join', 'opening']);
    expect(workerPhaseValues('class Unrelated:\n    X = "x"\n')).toEqual([]);
  });

  it('gives every phase a fixed label and detail', () => {
    for (const phase of R1_PHASES) {
      expect(R1_PHASE_LABELS[phase].label.length).toBeGreaterThan(0);
      expect(R1_PHASE_LABELS[phase].detail.length).toBeGreaterThan(0);
    }
  });

  it('accepts exact vocabulary only', () => {
    expect(parseR1Phase('roleplay')).toBe('roleplay');
    expect(parseR1Phase('ended')).toBe('ended');
    const bad = ['ROLEPLAY', 'Roleplay', ' roleplay', 'role-play', '', 'constructor', 7, null];
    for (const value of bad) expect(parseR1Phase(value)).toBeNull();
  });
});

describe('the label before a phase is announced', () => {
  it('has a waiting line and a neutral in-progress line', () => {
    expect(R1_NO_PHASE_LABELS.waiting.label).toBe('Connecting');
    expect(R1_NO_PHASE_LABELS.waiting.detail).toMatch(/Waiting for your interviewer/);
    expect(R1_NO_PHASE_LABELS.inProgress.label).toBe('Interview in progress');
    expect(R1_NO_PHASE_LABELS.inProgress.detail).not.toMatch(/waiting/i);
  });

  it('never reuses the wording of a real phase', () => {
    const real = new Set(Object.values(R1_PHASE_LABELS).map((copy) => copy.label));
    for (const copy of Object.values(R1_NO_PHASE_LABELS)) expect(real.has(copy.label)).toBe(false);
  });
});

describe('lead card visibility', () => {
  it('shows the card only while the role-play is on screen', () => {
    const visible = ['transition', 'roleplay', 'aside'] as const;
    for (const phase of R1_PHASES) {
      expect(isLeadCardVisible(phase, null)).toBe((visible as readonly string[]).includes(phase));
    }
    expect(isLeadCardVisible(null, null)).toBe(false);
  });

  it('follows the resume phase while the interview is paused for a disconnect', () => {
    expect(isLeadCardVisible('paused_disconnected', 'roleplay')).toBe(true);
    expect(isLeadCardVisible('paused_disconnected', 'icebreaker')).toBe(false);
    expect(isLeadCardVisible('paused_disconnected', null)).toBe(false);
  });
});

describe('captions', () => {
  it('attributes bot lines to the learner only during the role-play', () => {
    expect(captionSpeakerFor('roleplay')).toBe('learner');
    for (const phase of R1_PHASES.filter((p) => p !== 'roleplay')) {
      expect(captionSpeakerFor(phase)).toBe('interviewer');
    }
    expect(captionSpeakerFor(null)).toBe('interviewer');
  });

  it('adds segments, updates by id and skips blank text', () => {
    let captions: R1Caption[] = [];
    const merge = (segments: CaptionSegment[]) => {
      captions = mergeCaptions(captions, segments, 'interviewer');
    };
    merge([{ id: 's1', text: ' Hello ', final: false }]);
    merge([{ id: 's1', text: 'Hello there', final: true }]);
    merge([{ id: 's2', text: '   ', final: true }]);
    expect(captions).toEqual([
      { id: 's1', text: 'Hello there', final: true, speaker: 'interviewer' },
    ]);
  });

  it('keeps the speaker a line was first seen under', () => {
    let captions: R1Caption[] = [];
    const first = [{ id: 'a', text: 'Hmm', final: false }];
    const second = [{ id: 'a', text: 'Hmm, one second', final: true }];
    captions = mergeCaptions(captions, first, 'learner');
    captions = mergeCaptions(captions, second, 'interviewer');
    expect(captions[0].speaker).toBe('learner');
    expect(captions[0].final).toBe(true);
  });

  it('keeps only the most recent lines', () => {
    const segments = Array.from({ length: R1_MAX_CAPTIONS + 25 }, (_, index) => ({
      id: `s${index}`,
      text: `line ${index}`,
      final: true,
    }));
    const captions = mergeCaptions([], segments, 'interviewer');
    expect(captions).toHaveLength(R1_MAX_CAPTIONS);
    expect(captions[0].id).toBe('s25');
  });
});
