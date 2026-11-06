/**
 * The AI verdict on an R1 round: a full, half or empty circle beside the word, the figure, and a ruler
 * with the two cut-offs. Readout's scorecard mark.
 *
 * It takes the verdict's family, as the phone Review does (`design/tones`): the wash, the edge, the
 * circle, the word, the figure and the ruler's zones. The mark still says the position and the word
 * still says the verdict, so colour is never the only signal. A Reject is `closed`, never crimson.
 * `scripts/validate-hr-design-system.mjs` holds this file to that.
 *
 * The stored verdict decides the ruler's emphasis, not the score: the integrity floor caps a score
 * above the Select cut-off at Borderline, and the ruler must not say Select beside that word.
 */
import { cx } from '../design/cx';
import { FAMILY_CLASSES, rulerLabelClass, type JudgementFamily } from '../design/tones';
import type { R1Verdict } from '../../lib/r1-review';
import { RulerZones } from '../session/RulerZones';

const FAMILY_OF_MARK: Readonly<Record<R1Verdict['mark'], JudgementFamily>> = {
  full: 'ready',
  half: 'unresolved',
  empty: 'closed',
};

export function VerdictMark({ mark }: { mark: R1Verdict['mark'] }) {
  return (
    <svg
      data-verdict-mark={mark}
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={cx('h-5 w-5 shrink-0', FAMILY_CLASSES[FAMILY_OF_MARK[mark]].glyph)}
    >
      <circle cx="10" cy="10" r="8.25" fill={mark === 'full' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      {mark === 'half' && <path d="M10 1.75a8.25 8.25 0 0 1 0 16.5z" fill="currentColor" />}
    </svg>
  );
}

function Ruler({ overall, hold, advance, current }: { overall: number; hold: number; advance: number; current: JudgementFamily }) {
  const scale = (value: number) => `${Math.min(100, Math.max(0, value))}%`;
  return (
    <div className="mt-4" aria-hidden="true">
      <div className="relative h-2">
        <RulerZones current={current} borderline={hold} select={advance} className="h-full" />
        <span data-cut="" className="data-fill absolute -inset-y-px w-px bg-[var(--control)]" style={{ left: scale(hold) }} />
        <span data-cut="" className="data-fill absolute -inset-y-px w-px bg-[var(--control)]" style={{ left: scale(advance) }} />
        <span data-mark="" className="data-fill absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-ink" style={{ left: scale(overall) }} />
      </div>
      <div className="relative mt-1 h-4 text-meta text-ink-tertiary">
        <span className={cx('absolute left-0', rulerLabelClass('closed', current))}>Reject</span>
        <span className={cx('absolute -translate-x-full pr-1', rulerLabelClass('unresolved', current))} style={{ left: scale(advance) }}>
          Borderline {hold}
        </span>
        <span className={cx('absolute pl-1', rulerLabelClass('ready', current))} style={{ left: scale(advance) }}>
          Select {advance}
        </span>
        <span className="absolute right-0">100</span>
      </div>
    </div>
  );
}

export interface VerdictBlockProps {
  verdict: R1Verdict;
  /** Scored from fewer metrics than the rubric has: the box's edge is dashed, and it says so. */
  provisionalNote: string | null;
  thresholds: { advance?: number; hold?: number } | null;
}

export function VerdictBlock({ verdict, provisionalNote, thresholds }: VerdictBlockProps) {
  const { word, mark, overall } = verdict;
  const { advance, hold } = thresholds ?? {};
  const family = FAMILY_OF_MARK[mark];
  const shades = FAMILY_CLASSES[family];
  return (
    <div className={cx('rounded-card border p-4', shades.wash, shades.edge, provisionalNote && 'border-dashed')}>
      {provisionalNote && <p className="mb-2 text-meta font-medium text-unresolved-text">{provisionalNote}</p>}
      <div className="flex items-center justify-between gap-4">
        <p className={cx('flex items-center gap-2.5 text-title', shades.text)}>
          <VerdictMark mark={mark} />
          {word}
        </p>
        {overall !== null && (
          <p className="flex items-baseline gap-0.5">
            <span className={cx('text-stat tabular-nums', shades.text)}>{Math.round(overall)}</span>
            <span className="text-sm tabular-nums text-ink-tertiary">/100</span>
          </p>
        )}
      </div>
      {overall !== null && typeof advance === 'number' && typeof hold === 'number' && (
        <Ruler overall={overall} hold={hold} advance={advance} current={family} />
      )}
    </div>
  );
}
