/**
 * RoleScorecardView — a role-scorecard (schema v2) assessment on the session
 * and screening pages.
 *
 * ONE VIEW, TWO PLACES. `RoleScorecardBody` is also what the candidate
 * page's Review tab renders (`talent/CandidateScorecardV2`), so a recruiter
 * reads a scorecard the same way wherever they open it: the verdict first,
 * then one list of metrics separated by hairlines, each with its rubric
 * word, a pip reading, its weight, the model's rationale and the evidence
 * it quoted. (The Review tab used to stack a card per metric inside a card.)
 *
 * DEFENSIVE BY CONSTRUCTION. A throw inside render takes the whole route
 * into the error boundary, which is the crash this view exists to end. So
 * the row is read through `readRoleScorecard` (cleaned, guarded), every
 * field is treated as `unknown`, and a metric with no human name is called
 * "Metric N" (its opaque id one hover away) instead of printing the id as a
 * heading.
 */

import { useId } from 'react';
import { scoreLabel } from '../../types';
import type {
  Assessment,
  ScorecardAssessmentDisplay,
  ScorecardMetricDisplay,
  ScoreScaleMax,
} from '../../types';
import { formatWeightPercent } from '../../lib/scorecard-weights';
import { cx, InlineNotice, StatusBadge } from '../design';
import { ScorePips, ScoreVerdict } from './ScoreVerdict';
import { finiteNumber, readRoleScorecard } from './scorecard-read';
import type { ScorecardLayout } from './scorecard-read';

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function MetricRow({
  metric,
  index,
  scaleMax,
  split,
}: {
  metric: ScorecardMetricDisplay;
  index: number;
  scaleMax: ScoreScaleMax;
  split: boolean;
}) {
  const id = text(metric.id);
  const rawName = text(metric.name);
  // The raw-less fallback names a metric by its config id; never a heading.
  const named = rawName !== '' && rawName !== id;
  const name = named ? rawName : `Metric ${index + 1}`;
  const score = finiteNumber(metric.score);
  const weightBps = finiteNumber(metric.weightBps);
  const rationale = text(metric.rationale);
  const refs = Array.isArray(metric.evidenceRefs) ? metric.evidenceRefs.map(text).filter(Boolean) : [];

  return (
    <li
      className={cx('py-4 last:pb-0', split && 'lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-x-10')}
      data-metric-row={id || undefined}
    >
      {/* Name + weight + reading. Stacked on a phone (the reading always
          sits under the name, never wherever the wrap drops it); a row from
          `sm`; the left column of the split layout from `lg`. */}
      <div
        className={cx(
          'flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
          split && 'lg:flex-col lg:justify-start lg:gap-2',
        )}
      >
        <div className="min-w-0">
          <h4 className="text-sm font-semibold text-ink" title={named ? undefined : id || undefined}>
            {name}
          </h4>
          {weightBps != null && (
            <p className="mt-0.5 text-xs tabular-nums text-ink-tertiary">
              Weight {formatWeightPercent(weightBps)}
            </p>
          )}
        </div>
        {score != null ? (
          <p className="flex items-center gap-2.5 whitespace-nowrap">
            <span className="text-label font-semibold text-ink">{scoreLabel(score, scaleMax)}</span>
            <ScorePips level={score} max={scaleMax} />
            <span aria-hidden="true" className="text-xs tabular-nums text-ink-tertiary">
              {score}/{scaleMax}
            </span>
            <span className="sr-only">
              {score} out of {scaleMax}
            </span>
          </p>
        ) : (
          <span className="self-start">
            <StatusBadge tone="warning">Insufficient evidence</StatusBadge>
          </span>
        )}
      </div>
      {(rationale || refs.length > 0) && (
        <div className={cx('mt-2.5 space-y-2.5', split && 'lg:mt-0')}>
          {rationale && <p className="max-w-prose text-sm leading-6 text-ink-secondary">{rationale}</p>}
          {refs.length > 0 && (
            <div>
              <p className="text-xs font-medium text-ink-secondary">Evidence</p>
              <ul className="mt-1 space-y-1">
                {refs.map((ref, i) => (
                  <li key={i} className="max-w-prose text-label text-ink-tertiary">
                    “{ref}”
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function RoleScorecardView({
  assessment,
  layout = 'stacked',
}: {
  assessment: Assessment;
  layout?: ScorecardLayout;
}) {
  const scorecard = readRoleScorecard(assessment);

  if (!scorecard) {
    return (
      <p className="glass-sunken px-4 py-6 text-center text-sm text-ink-secondary">
        This scorecard could not be read. The screening itself is unaffected.
      </p>
    );
  }
  return <RoleScorecardBody scorecard={scorecard} summary={assessment.summary} layout={layout} />;
}

/** The verdict and the metric list for an already-read v2 scorecard. */
export function RoleScorecardBody({
  scorecard,
  summary,
  layout = 'stacked',
}: {
  scorecard: ScorecardAssessmentDisplay;
  /** The model's summary, shown under the verdict; omit where the page shows it elsewhere. */
  summary?: unknown;
  layout?: ScorecardLayout;
}) {
  const metricsId = useId();
  const scaleMax = scorecard.scoreScaleMax;
  const metrics = Array.isArray(scorecard.metrics) ? scorecard.metrics : [];
  const total = metrics.length;
  const scored = metrics.filter((m) => finiteNumber(m.score) != null).length;
  const overall = finiteNumber(scorecard.overallScore);
  const weighted = finiteNumber(scorecard.weightedScore5);
  const incomplete = scorecard.status === 'incomplete_evidence';

  return (
    <div className="space-y-6">
      <ScoreVerdict
        overall={overall}
        recommendation={scorecard.recommendation}
        summary={summary}
        detail={
          weighted != null ? (
            <span className="text-ink-tertiary">
              {' · '}
              <span className="tabular-nums">{weighted.toFixed(2)}</span> of {scaleMax} on the rubric
            </span>
          ) : null
        }
      >
        {incomplete && (
          <InlineNotice tone="warning" role="none" className="mt-4">
            {overall == null
              ? 'No metric had enough evidence to score. This screening needs a human review.'
              : `Provisional: scored from ${scored} of ${total} metrics. The others lacked evidence and are left out of the weighted score, so confirm before deciding.`}
          </InlineNotice>
        )}
      </ScoreVerdict>

      <div>
        <div className="flex items-baseline justify-between gap-3 border-b border-glass-ring pb-2.5">
          <h3 id={metricsId} className="text-label font-semibold text-ink">
            Metrics
          </h3>
          {total > 0 && (
            <span className="text-xs tabular-nums text-ink-tertiary">
              {scored} of {total} scored
            </span>
          )}
        </div>
        {total === 0 ? (
          <p className="pt-4 text-sm text-ink-secondary">This assessment carries no per-metric results.</p>
        ) : (
          <ol aria-labelledby={metricsId} className="divide-y divide-glass-ring">
            {metrics.map((metric, i) => (
              <MetricRow
                key={`${text(metric.id) || 'metric'}-${i}`}
                metric={metric}
                index={i}
                scaleMax={scaleMax}
                split={layout === 'split'}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
