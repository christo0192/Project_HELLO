/**
 * HeaderRatings: the scorecard at a glance, in the candidate page header, on the Phone screening tab. So a
 * reader sees where a candidate scored and where they lacked with the reasoning pane scrolled anywhere.
 *
 * It holds no data of its own. `TranscriptionSyncWorkspace` portals it into a place the header offers
 * (`onRatingsSlot`), and hands it the very card the reasoning pane is showing, already gated. So it hides
 * wherever the panel hides scores, it follows the session picker, and it goes when the workspace goes.
 *
 * Provisional comes first whenever the verdict box says it, because AI ratings away from that box
 * otherwise read as firm. Then one item per metric, in rubric order: its name, the same `Pips` as the
 * rubric row, and the figure. The rating word does not fit, so it is in `title` and the accessible name.
 * Pressing an item opens that row and moves focus to it, and plays nothing.
 *
 * Where it sits is the header's call, by the room left beside the name, and it says so on the row
 * (`data-ratings-fit`), which is an ancestor through the portal: three columns by two rows in the name row,
 * or its own line under the name. Below `sm` it stacks.
 */

import { useId } from 'react';
import { scoreLabel } from '../../types';
import type { ScorecardAssessmentDisplay, ScorecardMetricDisplay } from '../../types';
import { cx } from '../design/cx';
import { FAMILY_CLASSES, ratingFamily } from '../design/tones';
import { finiteNumber } from '../session/scorecard-read';
import { metricDisplayName, Pips, scoredOfTotal } from './ReviewScorecard';

/**
 * Whether a card has anything for the header to print. The verdict box says "Not scored" with no overall
 * score, and a rubric with no rating has nothing to see at a glance: no box in either case.
 */
export function showsHeaderRatings(scorecard: ScorecardAssessmentDisplay): boolean {
  return finiteNumber(scorecard.overallScore) !== null && scorecard.metrics.some((metric) => finiteNumber(metric.score) !== null);
}

/** "Communication, Good, 3 of 4", from words the rubric row already prints. */
function ratingName(metric: ScorecardMetricDisplay, name: string, max: ScorecardAssessmentDisplay['scoreScaleMax']): string {
  const score = finiteNumber(metric.score);
  return score === null ? `${name}, Insufficient evidence` : `${name}, ${scoreLabel(score, max)}, ${score} of ${max}`;
}

const FRAME = 'flex min-w-0 flex-col gap-x-3.5 sm:flex-row sm:items-start';

/**
 * Up to three columns by two rows in the name row, filled across, as the rubric reads. On its own line as
 * many as fit at 136px: six across from 1350 wide after the Provisional words, and from 1180 without them.
 * Each column keeps a name, pips and a figure. Whole class names, or Tailwind would not see them.
 */
const IN_THE_ROW: Readonly<Record<number, string>> = {
  1: 'sm:group-data-[ratings-fit=row]/header:grid-cols-[minmax(0,13rem)]',
  2: 'sm:group-data-[ratings-fit=row]/header:grid-cols-[repeat(2,minmax(0,13rem))]',
  3: 'sm:group-data-[ratings-fit=row]/header:grid-cols-[repeat(3,minmax(0,13rem))]',
};

function listClass(metrics: number): string {
  const columns = Math.min(3, Math.max(1, Math.ceil(metrics / 2)));
  return cx('grid min-w-0 flex-1 grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-x-3.5', IN_THE_ROW[columns]);
}

/** One line of the block. 24px is this app's smallest target, and two of them are the 48px name row. */
const ITEM_HEIGHT = 'min-h-6 [@media(pointer:coarse)]:min-h-11';

/**
 * The lead's room, one width for the words and for the blank that holds their place: the list takes what is
 * left, so its columns follow this, and so does the header's height. It fits the widest count, "20 of 20
 * metrics", on one line and stacked, and the digits are tabular, so no count needs more.
 */
const LEAD_ROOM = 'sm:group-data-[ratings-fit=line]/header:w-40 sm:group-data-[ratings-fit=row]/header:w-[5.75rem]';

/** One line, as the verdict box prints it, on its own line and on a phone. Two lines in the name row. */
const LEAD = cx(
  'shrink-0 whitespace-nowrap text-meta leading-6 text-ink-secondary sm:group-data-[ratings-fit=row]/header:flex sm:group-data-[ratings-fit=row]/header:flex-col sm:group-data-[ratings-fit=row]/header:items-start',
  LEAD_ROOM,
);

/**
 * The panes' floor at 1180px and up, where the page does not scroll. What the summary adds to the header comes
 * out of it, so a window that held the page with no summary still holds it with one: at most two rows (48px)
 * for a role's six metrics, and 120px at the API's 20, seven rows in the name row and five on its own line.
 * With no summary nothing changes.
 */
export function reviewFloorClass(metrics: number): string {
  if (metrics === 0) return 'min-[1180px]:min-h-[34rem]';
  return metrics > 6 ? 'min-[1180px]:min-h-[26.5rem]' : 'min-[1180px]:min-h-[31rem]';
}

export interface HeaderRatingsProps {
  /** The card the reasoning pane is showing. */
  scorecard: ScorecardAssessmentDisplay;
  /** Held for thin evidence: no hue, as the rubric rows have none. */
  held: boolean;
  onOpen: (metricId: string) => void;
}

export function HeaderRatings({ scorecard, held, onOpen }: HeaderRatingsProps) {
  const max = scorecard.scoreScaleMax;
  const leadId = useId();
  const provisional = scorecard.status === 'incomplete_evidence';
  return (
    // Named by the lead, so a keyboard reader hears Provisional on the way in. The items read as firm otherwise.
    <div className={FRAME} role={provisional ? 'group' : undefined} aria-labelledby={provisional ? leadId : undefined}>
      {provisional && (
        <p id={leadId} data-header-ratings-lead="" className={LEAD}>
          <span className="font-semibold text-unresolved-text">Provisional</span>{' '}
          {/* The verdict box's own words. Stacked in the name row the line break parts them instead. */}
          <span className="sm:group-data-[ratings-fit=row]/header:hidden">·</span>{' '}
          <span>{scoredOfTotal(scorecard)}</span>
        </p>
      )}
      {/* "Rubric" is the name the panel gives these same rows. */}
      <ul aria-label="Rubric" className={listClass(scorecard.metrics.length)}>
        {scorecard.metrics.map((metric, index) => {
          const score = finiteNumber(metric.score);
          const name = metricDisplayName(metric, index);
          const label = ratingName(metric, name, max);
          const family = held ? null : ratingFamily(score, max);
          return (
            <li key={`${metric.id}-${index}`} className="min-w-0">
              <button
                type="button"
                data-header-rating={metric.id}
                onClick={() => onOpen(metric.id)}
                title={label}
                aria-label={label}
                className={cx(
                  '-mx-1 flex w-[calc(100%+0.5rem)] max-w-[13.5rem] items-center gap-1.5 rounded-chip px-1 text-left text-meta leading-5 transition-colors duration-hover ease-out hover:bg-field',
                  ITEM_HEIGHT,
                )}
              >
                <span className="min-w-0 flex-1 truncate text-ink">{name}</span>
                {score !== null ? (
                  <span className={cx('flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums', family ? FAMILY_CLASSES[family].text : 'text-ink')}>
                    <Pips level={score} max={max} family={family} />
                    <span>{score}/{max}</span>
                  </span>
                ) : (
                  <span className="flex shrink-0 items-center gap-1.5 text-ink-tertiary">
                    <span aria-hidden="true" data-rating-none="" className="h-2.5 w-[1.875rem] rounded-evidence border border-dashed border-unresolved" />
                    <span>—</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The summary's height with nothing in it, before the scorecard arrives, because the panes are measured
 * from the header and must not jump. The same frame, so it takes the same room. No figure and no word.
 */
export function HeaderRatingsReserve({ metrics, provisional }: { metrics: number; provisional: boolean }) {
  return (
    <div aria-hidden="true" data-header-ratings-reserve="" className={FRAME}>
      {provisional && <span className={cx('block h-6 shrink-0', LEAD_ROOM)} />}
      <div className={listClass(metrics)}>
        {Array.from({ length: metrics }, (_, index) => (
          <span key={index} data-header-ratings-cell="" className={cx('block', ITEM_HEIGHT)} />
        ))}
      </div>
    </div>
  );
}
