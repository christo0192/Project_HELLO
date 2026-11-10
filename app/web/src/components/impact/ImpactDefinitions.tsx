/**
 * "How these numbers are calculated": every definition of the contract's Rules
 * section (`.gsd/milestones/M031/API-CONTRACT.md`) in plain English, built like
 * the Dashboard's `ScreeningKpis` notes (a closed disclosure at the foot, never
 * a wiki page): the moment someone doubts a figure is the moment they need its
 * definition.
 */
import { cx } from '../design';
import { impactDefinitions } from './rules';

export function ImpactDefinitions({ minTimingN }: { minTimingN: number }) {
  return (
    <details className="group mt-8 border-t border-glass-ring">
      <summary
        className={cx(
          'flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 text-label font-medium text-ink',
          'transition-colors duration-hover ease-out hover:bg-ink/[0.025] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--info)]',
          '[&::-webkit-details-marker]:hidden',
        )}
      >
        How these numbers are calculated
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4 shrink-0 text-ink-tertiary transition-transform duration-150 ease-out group-open:rotate-180"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </summary>
      <div className="disclosure-body pb-5">
        <p className="max-w-prose text-label text-ink-secondary">
          Every figure is a count of Ashby applications; nothing is estimated. These figures show what happened after
          Christy, not what Christy caused. A person decides in Ashby.
        </p>
        <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
          {impactDefinitions(minTimingN).map(([term, definition]) => (
            <div key={term}>
              <dt className="text-label font-medium text-ink">{term}</dt>
              <dd className="mt-0.5 text-label text-ink-secondary">{definition}</dd>
            </div>
          ))}
        </dl>
      </div>
    </details>
  );
}
