/**
 * Evidence quotes, placed on the transcript from what is stored and nothing else.
 *
 * A phone scorecard stores each quote as `evidenceRefs`: the words the model copied from the
 * candidate, with no turn number (scorecards/prompt.ts). Those words are therefore the reference, and
 * a quote is placed only where they stand: verbatim, in a turn the scorer saw, by the candidate, in
 * exactly one turn. Folding covers only what is not the words themselves: case, runs of whitespace,
 * typographic quotes, the marks a model wraps a quote in, and the ellipsis our own normaliser adds
 * when it cuts one short.
 *
 * There is no fuzzy match and no guess. A quote that fails stays readable as text with no number and
 * no position, and nothing says it was "not found": it is the matching that is strict, not the
 * transcript that is wrong.
 *
 * The consent gate is left out because the scorer never reads it (`services/assessment.ts`).
 */

export interface EvidenceRow {
  /** The turn's index in the session transcript. */
  row: number;
  speaker: 'bot' | 'candidate';
  text: string;
  isGate: boolean;
  /** Seconds along the call, for the order of the numbers; null when unknown. */
  atSec: number | null;
}

export interface QuotePlace {
  row: number;
  /** Offsets into the turn's own text, end exclusive. */
  start: number;
  end: number;
}

export interface EvidenceMetric {
  id: string;
  name: string;
  evidenceRefs: readonly string[];
}

export interface EvidenceQuote {
  metricId: string;
  metricName: string;
  /** The words, without any marks the model wrapped them in. One cut short keeps its ellipsis. */
  text: string;
  /** Numbered in call order. null means it could not be placed. */
  number: number | null;
  row: number | null;
  start: number | null;
  end: number | null;
}

export type PlacedQuote = EvidenceQuote & { number: number; row: number; start: number; end: number };

export interface Evidence {
  /** Every placed quote, in number order. */
  placed: PlacedQuote[];
  /** Every quote of each metric, in the order the scorecard lists them. */
  byMetric: Record<string, EvidenceQuote[]>;
}

const SINGLE_QUOTES = /[‘’‚‛ʼ′]/;
const DOUBLE_QUOTES = /[“”„‟″]/;
const WRAPPING_MARKS = /^["'“”‘’`]+|["'“”‘’`]+$/g;
const TRAILING_ELLIPSIS = /(?:…|\.\.\.)$/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** The match key of `text`, and where each of its characters came from. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = '';
  const origin: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (/\s/.test(character)) {
      if (folded === '' || folded.endsWith(' ')) continue;
      folded += ' ';
      origin.push(index);
      continue;
    }
    const plain = SINGLE_QUOTES.test(character) ? "'" : DOUBLE_QUOTES.test(character) ? '"' : character;
    for (const lower of plain.toLowerCase()) {
      folded += lower;
      origin.push(index);
    }
  }
  return { folded, origin };
}

/** The words of a stored reference: `shown` as they read, `text` as they are matched, with no ellipsis. */
function cleanReference(reference: string): { shown: string; text: string; cut: boolean } {
  const shown = reference.trim().replace(WRAPPING_MARKS, '').trim();
  const cut = TRAILING_ELLIPSIS.test(shown);
  return { shown, text: cut ? shown.replace(TRAILING_ELLIPSIS, '').trim() : shown, cut };
}

/** A word cut in half is not a quote of it, unless our own normaliser did the cutting. */
function onWordEdges(text: string, start: number, end: number, cut: boolean): boolean {
  const before = text[start - 1];
  const after = text[end];
  const first = text[start];
  const last = text[end - 1];
  if (before !== undefined && WORD_CHARACTER.test(before) && WORD_CHARACTER.test(first)) return false;
  if (cut) return true;
  return !(after !== undefined && WORD_CHARACTER.test(after) && WORD_CHARACTER.test(last));
}

function findIn(row: EvidenceRow, needle: string, cut: boolean): QuotePlace | null {
  const { folded, origin } = fold(row.text);
  for (let at = folded.indexOf(needle); at !== -1; at = folded.indexOf(needle, at + 1)) {
    const start = origin[at];
    const end = origin[at + needle.length - 1] + 1;
    if (onWordEdges(row.text, start, end, cut)) return { row: row.row, start, end };
  }
  return null;
}

/** Where a stored quote stands, or null when it cannot be said for certain. */
export function placeQuote(reference: string, rows: readonly EvidenceRow[]): QuotePlace | null {
  const { text, cut } = cleanReference(reference);
  const needle = fold(text).folded;
  if (!needle) return null;
  const hits = rows
    .filter((row) => row.speaker === 'candidate' && !row.isGate)
    .map((row) => findIn(row, needle, cut))
    .filter((hit): hit is QuotePlace => hit !== null);
  return hits.length === 1 ? hits[0] : null;
}

/** Every metric's quotes, placed and numbered in the order of the call. */
export function buildEvidence(metrics: readonly EvidenceMetric[], rows: readonly EvidenceRow[]): Evidence {
  const byMetric: Record<string, EvidenceQuote[]> = {};
  const unnumbered: EvidenceQuote[] = [];
  for (const metric of metrics) {
    const references = Array.isArray(metric.evidenceRefs) ? metric.evidenceRefs : [];
    byMetric[metric.id] = references
      .filter((reference): reference is string => typeof reference === 'string' && reference.trim() !== '')
      .map((reference) => {
        const place = placeQuote(reference, rows);
        const quote: EvidenceQuote = {
          metricId: metric.id,
          metricName: metric.name,
          text: cleanReference(reference).shown,
          number: null,
          row: place?.row ?? null,
          start: place?.start ?? null,
          end: place?.end ?? null,
        };
        if (place) unnumbered.push(quote);
        return quote;
      });
  }

  const atSec = new Map(rows.map((row) => [row.row, row.atSec]));
  const order = (quote: EvidenceQuote) => atSec.get(quote.row!) ?? Number.POSITIVE_INFINITY;
  const placed = unnumbered
    .map((quote, listed) => ({ quote, listed }))
    .sort(
      (a, b) =>
        order(a.quote) - order(b.quote)
        || a.quote.row! - b.quote.row!
        || a.quote.start! - b.quote.start!
        || a.listed - b.listed,
    )
    .map(({ quote }, index) => {
      quote.number = index + 1;
      return quote as PlacedQuote;
    });
  return { placed, byMetric };
}

export interface MarkRange {
  number: number;
  start: number;
  end: number;
}

export interface MarkedSpan {
  text: string;
  /** The evidence numbers this span carries. Empty for plain words. */
  numbers: number[];
}

/** A turn's words cut into plain and cited spans. Quotes that overlap share one highlight. */
export function markedSpans(text: string, ranges: readonly MarkRange[]): MarkedSpan[] {
  const merged: MarkRange[][] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const current = merged[merged.length - 1];
    const reach = current ? Math.max(...current.map((r) => r.end)) : -1;
    if (current && range.start < reach) current.push(range);
    else merged.push([range]);
  }

  const spans: MarkedSpan[] = [];
  let at = 0;
  for (const group of merged) {
    const start = Math.min(...group.map((r) => r.start));
    const end = Math.max(...group.map((r) => r.end));
    if (start > at) spans.push({ text: text.slice(at, start), numbers: [] });
    spans.push({ text: text.slice(start, end), numbers: group.map((r) => r.number).sort((a, b) => a - b) });
    at = end;
  }
  if (at < text.length || spans.length === 0) spans.push({ text: text.slice(at), numbers: [] });
  return spans;
}
