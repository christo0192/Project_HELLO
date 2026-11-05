/**
 * The AI verdict on an R1 round: a full, half or empty circle beside the word, the figure, and a ruler
 * with the two cut-offs. Readout's scorecard mark, in Logsheet's ink.
 *
 * Verdicts stay in ink. The mark says the position and the word says the verdict, so there is no
 * traffic light here: a selection outcome is not coloured good or bad, which also avoids anchoring the
 * reviewer. `scripts/validate-hr-design-system.mjs` holds this file to that.
 */
import { cx } from '../design/cx';
import type { R1Verdict } from '../../lib/r1-review';

export function VerdictMark({ mark }: { mark: R1Verdict['mark'] }) {
  return (
    <svg data-verdict-mark={mark} aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5 shrink-0 text-ink">
      <circle cx="10" cy="10" r="8.25" fill={mark === 'full' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" />
      {mark === 'half' && <path d="M10 1.75a8.25 8.25 0 0 1 0 16.5z" fill="currentColor" />}
    </svg>
  );
}

function Ruler({ overall, hold, advance }: { overall: number; hold: number; advance: number }) {
  const scale = (value: number) => `${Math.min(100, Math.max(0, value))}%`;
  return (
    <div className="mt-4" aria-hidden="true">
      <div className="relative h-2 rounded-evidence border border-[var(--control)]">
        <span className="absolute -inset-y-px w-px bg-[var(--control)]" style={{ left: scale(hold) }} />
        <span className="absolute -inset-y-px w-px bg-[var(--control)]" style={{ left: scale(advance) }} />
        <span data-mark="" className="absolute -inset-y-1 w-0.5 -translate-x-1/2 bg-ink" style={{ left: scale(overall) }} />
      </div>
      <div className="relative mt-1 h-4 text-meta text-ink-tertiary">
        <span className="absolute left-0">Reject</span>
        <span className="absolute -translate-x-full pr-1" style={{ left: scale(advance) }}>
          Borderline {hold}
        </span>
        <span className="absolute pl-1" style={{ left: scale(advance) }}>
          Select {advance}
        </span>
        <span className="absolute right-0">100</span>
      </div>
    </div>
  );
}

export interface VerdictBlockProps {
  verdict: R1Verdict;
  /** Scored from fewer metrics than the rubric has: the box is pencilled, and says so. */
  provisionalNote: string | null;
  thresholds: { advance?: number; hold?: number } | null;
}

export function VerdictBlock({ verdict, provisionalNote, thresholds }: VerdictBlockProps) {
  const { word, mark, overall } = verdict;
  const { advance, hold } = thresholds ?? {};
  return (
    <div className={cx('rounded-card border p-4', provisionalNote ? 'border-dashed border-ink-secondary' : 'border-line-strong')}>
      {provisionalNote && <p className="mb-2 text-meta font-medium text-ink-secondary">{provisionalNote}</p>}
      <div className="flex items-center justify-between gap-4">
        <p className="flex items-center gap-2.5 text-title text-ink">
          <VerdictMark mark={mark} />
          {word}
        </p>
        {overall !== null && (
          <p className="flex items-baseline gap-0.5 text-ink">
            <span className="text-stat tabular-nums">{Math.round(overall)}</span>
            <span className="text-sm tabular-nums text-ink-tertiary">/100</span>
          </p>
        )}
      </div>
      {overall !== null && typeof advance === 'number' && typeof hold === 'number' && (
        <Ruler overall={overall} hold={hold} advance={advance} />
      )}
    </div>
  );
}
