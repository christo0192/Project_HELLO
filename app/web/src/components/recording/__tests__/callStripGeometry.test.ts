/**
 * The call strip's geometry: pure arithmetic, pinned without a browser. Phone turns have no end
 * time, so a segment is an estimate, and the rule that matters is the one that keeps silence from
 * being drawn as talk.
 */
import { describe, expect, it } from 'vitest';
import {
  MS_PER_CHARACTER,
  STRIP_BREAK_AFTER_SEC,
  STRIP_BREAK_PERCENT,
  STRIP_MAX_MARKS,
  layoutTickLabels,
  stripAlternative,
  stripAxis,
  stripBreaks,
  stripEndSec,
  stripPercent,
  stripScale,
  stripSegments,
  stripTalk,
  timecode,
} from '../callStripGeometry';
import type { StripSegment, StripTurn } from '../callStripGeometry';

const say = (chars: number) => 'x'.repeat(chars);

const turn = (over: Partial<StripTurn> & Pick<StripTurn, 'startSec'>): StripTurn => ({
  speaker: 'candidate',
  text: say(100),
  ...over,
});

describe('stripSegments', () => {
  it('sets speech at about 60 ms per character', () => {
    expect(MS_PER_CHARACTER).toBe(60);
    const [segment] = stripSegments([turn({ startSec: 10, text: say(100) })]);
    expect(segment.startSec).toBe(10);
    expect(segment.endSec).toBeCloseTo(16);
  });

  it('ends a turn at the next turn when the estimate would run past it', () => {
    const [first] = stripSegments([
      turn({ startSec: 10, text: say(1000) }),
      turn({ startSec: 14, speaker: 'ai', text: say(10) }),
    ]);
    expect(first.endSec).toBe(14);
  });

  it('never draws silence as talk: a long pause before the next turn stays empty', () => {
    const [first, second] = stripSegments([
      turn({ startSec: 10, text: say(50) }),
      turn({ startSec: 60, speaker: 'ai', text: say(50) }),
    ]);
    expect(first.endSec).toBeCloseTo(13);
    expect(second.startSec).toBe(60);
  });

  it('draws a candidate turn, an AI turn and a gate turn as their own kinds', () => {
    const kinds = stripSegments([
      turn({ startSec: 0, speaker: 'ai', gate: true, text: say(10) }),
      turn({ startSec: 2, speaker: 'candidate', gate: true, text: say(10) }),
      turn({ startSec: 4, speaker: 'ai', text: say(10) }),
      turn({ startSec: 6, speaker: 'candidate', text: say(10) }),
    ]).map((s) => s.kind);
    expect(kinds).toEqual(['gate', 'gate', 'ai', 'candidate']);
  });

  it('places turns by time, whatever order they arrive in', () => {
    const segments = stripSegments([turn({ startSec: 20, text: say(10) }), turn({ startSec: 5, text: say(1000) })]);
    expect(segments.map((s) => s.startSec)).toEqual([5, 20]);
    expect(segments[0].endSec).toBe(20);
  });

  it('draws nothing for a turn with no room or no words, and no two turns overlap', () => {
    const segments = stripSegments([
      turn({ startSec: 5, text: say(100) }),
      turn({ startSec: 5, speaker: 'ai', text: say(100) }),
      turn({ startSec: 30, text: '   ' }),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('ai');
  });

  it('a known end wins over the estimate, and still stops at the next turn', () => {
    const [known, capped] = stripSegments([
      turn({ startSec: 0, endSec: 2, text: say(1000) }),
      turn({ startSec: 5, endSec: 50, text: say(10) }),
      turn({ startSec: 8, text: say(10) }),
    ]);
    expect(known.endSec).toBe(2);
    expect(capped.endSec).toBe(8);
  });

  it('skips a turn with no time rather than placing it anywhere', () => {
    expect(stripSegments([turn({ startSec: Number.NaN })])).toEqual([]);
  });

  it('stops a turn where its call stopped: the line that was cut off is never drawn past the drop', () => {
    const [cut, next] = stripSegments([
      turn({ startSec: 98, text: say(300), limitSec: 100 }),
      turn({ startSec: 200, text: say(10) }),
    ]);
    expect(cut.endSec).toBe(100);
    expect(next.startSec).toBe(200);
  });

  it('a limit that does not bind leaves the estimate alone', () => {
    const [segment] = stripSegments([turn({ startSec: 10, text: say(100), limitSec: 300 })]);
    expect(segment.endSec).toBeCloseTo(16);
  });

  it('a limit before the turn began says nothing about it, and the turn is still drawn', () => {
    const [segment] = stripSegments([turn({ startSec: 100, text: say(100), limitSec: 90 })]);
    expect(segment.endSec).toBeCloseTo(106);
  });
});

describe('stripTalk', () => {
  it('sums the talk of each side, leaving the consent gate out of the share', () => {
    const talk = stripTalk(
      stripSegments([
        turn({ startSec: 0, speaker: 'ai', gate: true, text: say(100) }),
        turn({ startSec: 10, speaker: 'ai', text: say(100) }),
        turn({ startSec: 20, speaker: 'candidate', text: say(300) }),
      ]),
    );
    expect(talk.aiSec).toBeCloseTo(6);
    expect(talk.candidateSec).toBeCloseTo(18);
    expect(talk.candidateShare).toBe(75);
  });

  it('has no share when nobody spoke, never a zero', () => {
    expect(stripTalk([]).candidateShare).toBeNull();
  });
});

describe('stripEndSec', () => {
  it('is the last talk, or a later known end of the call', () => {
    const segments = stripSegments([turn({ startSec: 60, text: say(100) })]);
    expect(stripEndSec(segments, [])).toBeCloseTo(66);
    expect(stripEndSec(segments, [120, null])).toBe(120);
  });
});

describe('stripPercent', () => {
  it('places a moment on the width of the call, inside it', () => {
    expect(stripPercent(30, 120)).toBe(25);
    expect(stripPercent(500, 120)).toBe(100);
    expect(stripPercent(-5, 120)).toBe(0);
    expect(stripPercent(10, 0)).toBe(0);
  });
});

describe('stripScale', () => {
  it('prints a minute mark for an ordinary call and fewer on a long one', () => {
    expect(stripScale(150)).toEqual([0, 60, 120]);
    expect(stripScale(1500).slice(0, 3)).toEqual([0, 300, 600]);
    expect(stripScale(40)).toEqual([0, 15, 30]);
  });

  it('never prints more marks than fit, however long the strip', () => {
    for (const endSec of [3_600, 7_200, 86_400, 200_000]) {
      expect(stripScale(endSec).length).toBeLessThanOrEqual(STRIP_MAX_MARKS);
    }
  });
});

describe('the axis across a long gap', () => {
  // Eight minutes, a reconnect put off to the next IST day, two more minutes.
  const NEXT_DAY = 86_400;
  const END = NEXT_DAY + 120;
  const drops = [{ fromSec: 480, toSec: NEXT_DAY }];
  const segments: StripSegment[] = [
    { kind: 'candidate', startSec: 0, endSec: 480 },
    { kind: 'ai', startSec: NEXT_DAY, endSec: END },
  ];

  it('leaves an ordinary reconnect to scale', () => {
    expect(stripBreaks([{ fromSec: 100, toSec: 200 }], segments)).toEqual([]);
    const axis = stripAxis(1000, []);
    expect(axis.percent(250)).toBe(25);
    expect(axis.breakCentres).toEqual([]);
    expect(axis.marks).toEqual(stripScale(1000));
  });

  it('breaks a gap past the threshold, and only past it', () => {
    const at = STRIP_BREAK_AFTER_SEC;
    expect(stripBreaks([{ fromSec: 0, toSec: at }], segments)).toEqual([]);
    expect(stripBreaks([{ fromSec: 0, toSec: at + 1 }], segments)).toEqual([{ fromSec: 0, toSec: at + 1 }]);
  });

  it('measures an unobserved drop from the last talk before the reconnect', () => {
    expect(stripBreaks([{ fromSec: null, toSec: NEXT_DAY }], segments)).toEqual([{ fromSec: 480, toSec: NEXT_DAY }]);
  });

  describe('a gap with an end nobody saw and no talk before it', () => {
    const later: StripSegment[] = [{ kind: 'ai', startSec: NEXT_DAY, endSec: END }];
    const gap = { fromSec: null, drawFromSec: 0, toSec: NEXT_DAY };

    it('is cut from the start it was given, so the interview keeps the strip', () => {
      expect(stripBreaks([gap], later)).toEqual([{ fromSec: 0, toSec: NEXT_DAY }]);
      const axis = stripAxis(END, stripBreaks([gap], later));
      expect(axis.percent(NEXT_DAY)).toBeCloseTo(STRIP_BREAK_PERCENT);
      expect(axis.percent(END)).toBeCloseTo(100);
    });

    it('with no start to draw from it is left to scale, as before', () => {
      expect(stripBreaks([{ fromSec: null, toSec: NEXT_DAY }], later)).toEqual([]);
    });

    it('takes the later of that start and the last talk', () => {
      expect(stripBreaks([{ ...gap, drawFromSec: 100 }], segments)).toEqual([{ fromSec: 480, toSec: NEXT_DAY }]);
      expect(stripBreaks([{ ...gap, drawFromSec: 1_000 }], segments)).toEqual([{ fromSec: 1_000, toSec: NEXT_DAY }]);
    });

    it('still claims no end in words: that start is for drawing only', () => {
      const words = stripAlternative({
        endSec: END,
        calls: 2,
        candidateName: 'Asha',
        talk: { candidateSec: 0, aiSec: 120, candidateShare: 0 },
        consentAt: null,
        drops: [gap],
        quotes: 0,
      });
      expect(words).toContain('Line dropped and reconnected at 24:00:00.');
      expect(words).not.toContain('Line dropped at');
    });
  });

  it('a drop that reaches past a call in between cuts only the last stretch, so two cuts never overlap', () => {
    const between = NEXT_DAY / 2;
    const talk: StripSegment[] = [
      { kind: 'candidate', startSec: 0, endSec: 480 },
      { kind: 'ai', startSec: between, endSec: between + 20 },
      { kind: 'ai', startSec: NEXT_DAY, endSec: END },
    ];
    const breaks = stripBreaks(
      [
        { fromSec: 480, drawFromSec: between, toSec: NEXT_DAY },
        { fromSec: 480, drawFromSec: 480, toSec: between },
      ],
      talk,
    );
    expect(breaks).toEqual([
      { fromSec: 480, toSec: between },
      { fromSec: between + 20, toSec: NEXT_DAY },
    ]);
    const axis = stripAxis(END, breaks);
    expect(axis.percent(END)).toBeCloseTo(100);
    expect(axis.percent(between + 20) - axis.percent(between)).toBeGreaterThan(0);
  });

  it('gives the break a fixed width and the talk the rest, in proportion', () => {
    const axis = stripAxis(END, stripBreaks(drops, segments));
    const talkWidth = 100 - STRIP_BREAK_PERCENT;
    // 480 of 600 drawn seconds is four fifths of what the break leaves.
    expect(axis.percent(480)).toBeCloseTo(talkWidth * 0.8);
    expect(axis.percent(NEXT_DAY)).toBeCloseTo(talkWidth * 0.8 + STRIP_BREAK_PERCENT);
    expect(axis.percent(END)).toBeCloseTo(100);
    expect(axis.breakCentres).toHaveLength(1);
    expect(axis.breakCentres[0]).toBeCloseTo(talkWidth * 0.8 + STRIP_BREAK_PERCENT / 2);
  });

  it('keeps every moment in order, and on the strip', () => {
    const axis = stripAxis(END, stripBreaks(drops, segments));
    const moments = [-5, 0, 240, 480, 5_000, NEXT_DAY - 1, NEXT_DAY, NEXT_DAY + 60, END, END + 100];
    const places = moments.map(axis.percent);
    expect([...places].sort((a, b) => a - b)).toEqual(places);
    expect(places[0]).toBe(0);
    expect(places[places.length - 1]).toBeCloseTo(100);
  });

  it('prints a sane number of marks, restarting at the moment the next call began', () => {
    const { marks, percent } = stripAxis(END, stripBreaks(drops, segments));
    expect(marks.length).toBeLessThanOrEqual(STRIP_MAX_MARKS);
    expect(marks[0]).toBe(0);
    expect(marks).toContain(NEXT_DAY);
    const gaps = marks.slice(1).map((sec, index) => percent(sec) - percent(marks[index]));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(6);
  });

  it('shares the width out when there are several breaks', () => {
    const breaks = Array.from({ length: 6 }, (_, index) => ({ fromSec: index * 10_000 + 100, toSec: (index + 1) * 10_000 }));
    const axis = stripAxis(60_100, breaks);
    expect(axis.percent(100)).toBeGreaterThan(0);
    expect(axis.percent(60_100)).toBeCloseTo(100);
  });

  it('falls back to scale when there is no talk to give the width to', () => {
    expect(stripAxis(5_000, [{ fromSec: 0, toSec: 5_000 }]).percent(2_500)).toBe(50);
  });
});

describe('timecode', () => {
  it('reads minutes and seconds, zero padded, in whole seconds', () => {
    expect(timecode(0)).toBe('00:00');
    expect(timecode(20.9)).toBe('00:20');
    expect(timecode(338)).toBe('05:38');
    expect(timecode(3_599)).toBe('59:59');
  });

  it('gives hours their own place, so a next-day reconnect does not read 1440:13', () => {
    expect(timecode(3_600)).toBe('1:00:00');
    expect(timecode(6_000)).toBe('1:40:00');
    expect(timecode(86_413)).toBe('24:00:13');
  });
});

describe('layoutTickLabels', () => {
  it('leaves labels above their own moment when they fit', () => {
    expect(layoutTickLabels([100, 300], 1000, 18)).toEqual([100, 300]);
  });

  it('moves a label aside when two moments share a place, so each stays pressable', () => {
    const [a, b, c] = layoutTickLabels([200, 200, 205], 1000, 18);
    expect(b - a).toBeGreaterThanOrEqual(18);
    expect(c - b).toBeGreaterThanOrEqual(18);
  });

  it('keeps the last label inside the strip', () => {
    const placed = layoutTickLabels([990, 995, 998], 1000, 18);
    expect(placed[2]).toBeLessThanOrEqual(1000 - 9);
    expect(placed[1] - placed[0]).toBeGreaterThanOrEqual(18);
    expect(placed[2] - placed[1]).toBeGreaterThanOrEqual(18);
  });
});

describe('stripAlternative', () => {
  const base = {
    endSec: 426,
    calls: 2,
    candidateName: 'Asha',
    talk: { candidateSec: 287, aiSec: 95, candidateShare: 75 },
    consentAt: '00:20',
    drops: [{ fromSec: 378, toSec: 392 }],
    quotes: 7,
  };

  it('says the length, the share, the consent time, the drop and the quote count', () => {
    expect(stripAlternative(base)).toBe(
      'Call strip: 7 min 6 s across 2 calls. Asha spoke about 4 min 47 s, about 75% of the talk. '
        + 'Consent given at 00:20. Line dropped at 06:18 and reconnected at 06:32. 7 evidence quotes.',
    );
  });

  it('claims nothing it does not know: no consent line, no share, one call, no quotes', () => {
    expect(
      stripAlternative({
        ...base,
        calls: 1,
        talk: { candidateSec: 0, aiSec: 0, candidateShare: null },
        consentAt: null,
        drops: [],
        quotes: 0,
      }),
    ).toBe('Call strip: 7 min 6 s. No evidence quotes.');
  });

  it('a drop whose end nobody observed gives only the reconnect', () => {
    expect(stripAlternative({ ...base, drops: [{ fromSec: null, toSec: 392 }] })).toContain(
      'Line dropped and reconnected at 06:32.',
    );
  });

  it('gives a gap no drop explains as the next call, and says nothing dropped', () => {
    const words = stripAlternative({ ...base, drops: [], gaps: [{ fromSec: 100, toSec: 200 }] });
    expect(words).toContain('Next call at 03:20.');
    expect(words).not.toContain('Line dropped');
    expect(words).not.toContain('reconnected');
  });

  it('says a next-day reconnect in hours, because the picture no longer shows the gap to scale', () => {
    const words = stripAlternative({ ...base, endSec: 86_520, drops: [{ fromSec: 480, toSec: 86_400 }] });
    expect(words).toContain('Call strip: 24 h 2 min 0 s across 2 calls.');
    expect(words).toContain('Line dropped at 08:00 and reconnected at 24:00:00.');
  });
});
