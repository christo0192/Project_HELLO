/**
 * Evidence quotes on the transcript. A scorecard stores each quote as the words the model copied
 * from the candidate, with no turn number, so the words are the only reference there is. A quote is
 * placed only where those words stand, unmistakably. Anything else stays readable as text and gets
 * no position: an invented position would send a reviewer to a moment that proves nothing.
 */
import { describe, expect, it } from 'vitest';
import { buildEvidence, markedSpans, placeQuote } from '../evidence-quotes';
import type { EvidenceRow } from '../evidence-quotes';

const candidate = (row: number, text: string, atSec: number | null = row * 10): EvidenceRow => ({
  row,
  speaker: 'candidate',
  text,
  isGate: false,
  atSec,
});

const rows: EvidenceRow[] = [
  { row: 0, speaker: 'bot', text: 'Tell me about pricing and your target.', isGate: false, atSec: 0 },
  candidate(1, 'My target is twelve a month. I hit it in August.'),
  { row: 2, speaker: 'bot', text: 'What do you say when the fee is too high?', isGate: false, atSec: 20 },
  candidate(3, 'I’d tell them about the EMI option,  and ask what they tried.'),
  candidate(4, 'Yes, that works.'),
  candidate(5, 'Yes, that works. Then I book a follow-up.'),
  { row: 6, speaker: 'candidate', text: 'Yes, I consent to the recording.', isGate: true, atSec: 1 },
];

describe('placeQuote', () => {
  it('finds the words in the one candidate turn that holds them', () => {
    const placed = placeQuote('My target is twelve a month', rows);
    expect(placed).toEqual({ row: 1, start: 0, end: 27 });
  });

  it('marks the original characters, whatever the spacing and the typographic quotes were', () => {
    const placed = placeQuote("I'd tell them about the EMI option, and ask", rows)!;
    expect(placed.row).toBe(3);
    expect(rows[3].text.slice(placed.start, placed.end)).toBe('I’d tell them about the EMI option,  and ask');
  });

  it('ignores case and the quotation marks the model may have wrapped around the words', () => {
    expect(placeQuote('"my target is twelve a month"', rows)?.row).toBe(1);
    expect(placeQuote('“I hit it in August.”', rows)?.row).toBe(1);
  });

  it('accepts a quote our own normaliser cut short, by the words before the ellipsis', () => {
    expect(placeQuote('My target is twelve a mon…', rows)?.row).toBe(1);
  });

  it('never places a quote that is not verbatim: no fuzzy match', () => {
    expect(placeQuote('My goal is twelve a month', rows)).toBeNull();
    expect(placeQuote('My target is twelve per month', rows)).toBeNull();
  });

  it('never places a quote on the interviewer', () => {
    expect(placeQuote('What do you say when the fee is too high', rows)).toBeNull();
  });

  it('never places a quote on the consent gate, which the scorer never saw', () => {
    expect(placeQuote('I consent to the recording', rows)).toBeNull();
  });

  it('leaves a quote unplaced when two turns could hold it', () => {
    expect(placeQuote('Yes, that works', rows)).toBeNull();
  });

  it('does not match inside a longer word', () => {
    expect(placeQuote('arget is twelve', rows)).toBeNull();
  });

  it('places nothing for an empty reference', () => {
    expect(placeQuote('  “”  ', rows)).toBeNull();
  });
});

describe('buildEvidence', () => {
  const metrics = [
    { id: 'm1', name: 'Closing', evidenceRefs: ['Then I book a follow-up', 'not in the transcript at all'] },
    { id: 'm2', name: 'Objection handling', evidenceRefs: ['I hit it in August', 'Then I book a follow-up'] },
    { id: 'm3', name: 'Rapport', evidenceRefs: [] },
  ];

  it('numbers placed quotes in the order of the call, and leaves the rest without a number', () => {
    const evidence = buildEvidence(metrics, rows);
    expect(evidence.placed.map((q) => [q.number, q.metricName, q.row])).toEqual([
      [1, 'Objection handling', 1],
      [2, 'Closing', 5],
      [3, 'Objection handling', 5],
    ]);
    expect(evidence.byMetric.m1.map((q) => q.number)).toEqual([2, null]);
    expect(evidence.byMetric.m3).toEqual([]);
  });

  it('keeps an unplaced quote readable, as the words alone', () => {
    const [, unplaced] = buildEvidence(metrics, rows).byMetric.m1;
    expect(unplaced).toMatchObject({ text: 'not in the transcript at all', number: null, row: null });
  });

  it('shows a quote our normaliser cut short as cut, and still matches it by the words before the ellipsis', () => {
    const [cut, dotted, wrapped] = buildEvidence(
      [{ id: 'm', name: 'M', evidenceRefs: ['My target is twelve a mon…', 'I hit it in Aug...', '“Then I book a fol…”'] }],
      rows,
    ).byMetric.m;
    expect(cut).toMatchObject({ text: 'My target is twelve a mon…', row: 1, start: 0, end: 25 });
    expect(dotted).toMatchObject({ text: 'I hit it in Aug...', row: 1 });
    expect(wrapped).toMatchObject({ text: 'Then I book a fol…', row: 5 });
  });

  it('a quote that could not be placed keeps its ellipsis too', () => {
    const [quote] = buildEvidence([{ id: 'm', name: 'M', evidenceRefs: ['Words that were never sa…'] }], rows).byMetric.m;
    expect(quote).toMatchObject({ text: 'Words that were never sa…', number: null });
  });

  it('with no transcript every quote stays text', () => {
    const evidence = buildEvidence(metrics, []);
    expect(evidence.placed).toEqual([]);
    expect(evidence.byMetric.m2.map((q) => q.text)).toEqual(['I hit it in August', 'Then I book a follow-up']);
  });

  it('survives a stored list that is not one', () => {
    const evidence = buildEvidence([{ id: 'm', name: 'M', evidenceRefs: 'oops' as unknown as string[] }], rows);
    expect(evidence.byMetric.m).toEqual([]);
  });
});

describe('markedSpans', () => {
  it('cuts a turn into plain and cited words', () => {
    expect(markedSpans('abcdefghij', [{ number: 1, start: 2, end: 5 }])).toEqual([
      { text: 'ab', numbers: [] },
      { text: 'cde', numbers: [1] },
      { text: 'fghij', numbers: [] },
    ]);
  });

  it('joins two quotes that overlap into one highlight carrying both numbers', () => {
    expect(
      markedSpans('abcdefghij', [
        { number: 1, start: 2, end: 6 },
        { number: 2, start: 4, end: 8 },
      ]),
    ).toEqual([
      { text: 'ab', numbers: [] },
      { text: 'cdefgh', numbers: [1, 2] },
      { text: 'ij', numbers: [] },
    ]);
  });

  it('with nothing cited the turn is one plain span', () => {
    expect(markedSpans('abc', [])).toEqual([{ text: 'abc', numbers: [] }]);
  });
});
