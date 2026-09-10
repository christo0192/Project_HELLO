/**
 * CandidateScorecardV2 — the candidate-scoped view of a schema_version=2
 * (role-scorecard) assessment.
 *
 * Rendered by `TranscriptionSyncWorkspace` when the selected assessment is v2;
 * the legacy 1–10 `CandidateScorecard` is rendered unchanged for v1 rows. It
 * shows the weighted OVERALL score, each metric's score with its rubric-label
 * word (or "Insufficient evidence" when the model could not score it), the
 * verbose per-metric RATIONALE, and any evidence references.
 *
 * Every score is rendered on the assessment's OWN scale (`scoreScaleMax`): new
 * rows are 1–4 (Poor/Average/Good/Excellent, matching Ashby's four-point Score
 * fields); rows scored before the four-level rubric stay 1–5 with the legacy
 * labels and are never re-bucketed. It reuses the same
 * candidate primitives (SurfaceCard, Meter, Tag) as the legacy card, so it reads
 * as one system, keeps the two-level depth rule, and stays colour-redundant.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import { scoreLabel } from '../../types';
import type {
  ScorecardAssessmentDisplay,
  ScorecardMetricDisplay,
  ScorecardRecommendation,
  ScoreScaleMax,
} from '../../types';
import { Meter, SurfaceCard, Tag } from '../design/candidate';
import { formatWeightPercent } from '../../lib/scorecard-weights';
import { cx } from '../design/cx';

const CARD_TITLE = 'text-[15px] font-semibold tracking-tight text-[var(--c-ink)]';

const RECOMMENDATION: Record<
  ScorecardRecommendation,
  { label: string; tone: 'positive' | 'caution' | 'negative'; fill: string }
> = {
  advance: { label: 'Advance', tone: 'positive', fill: 'var(--c-positive)' },
  hold: { label: 'Hold', tone: 'caution', fill: 'var(--c-caution)' },
  reject: { label: 'Reject', tone: 'negative', fill: 'var(--c-negative)' },
  human_review: { label: 'Needs human review', tone: 'caution', fill: 'var(--c-caution)' },
};

function Prose({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      data-prose="true"
      className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]"
    >
      {children}
    </p>
  );
}

function MetricCard({
  metric,
  scaleMax,
}: {
  metric: ScorecardMetricDisplay;
  /** The assessment's own rubric scale — the meter max and the label vocabulary. */
  scaleMax: ScoreScaleMax;
}) {
  const headingId = useId();
  const scored = metric.score != null;
  return (
    <SurfaceCard level="sunken" as="section" labelledBy={headingId} className="p-3 sm:p-4">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 id={headingId} className="text-[13px] font-medium text-[var(--c-ink)]">
          {metric.name}
        </h4>
        {metric.weightBps != null && (
          <span className="text-xs text-[var(--c-ink-secondary)]">
            Weight{' '}
            <span className="font-mono tabular-nums text-[var(--c-ink-secondary)]">
              {formatWeightPercent(metric.weightBps)}
            </span>
          </span>
        )}
      </div>

      {scored ? (
        <Meter
          label={`Score · ${scoreLabel(metric.score as number, scaleMax)}`}
          value={metric.score as number}
          max={scaleMax}
        />
      ) : (
        <Tag tone="caution" srPrefix="Evidence:">
          Insufficient evidence
        </Tag>
      )}

      <Prose>{metric.rationale}</Prose>

      {metric.evidenceRefs.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-[var(--c-ink-secondary)]">Evidence</p>
          <ul className="mt-1 space-y-1">
            {metric.evidenceRefs.map((ref, i) => (
              <li
                key={i}
                className="max-w-prose text-xs leading-relaxed text-[var(--c-ink-secondary)]"
              >
                “{ref}”
              </li>
            ))}
          </ul>
        </div>
      )}
    </SurfaceCard>
  );
}

export interface CandidateScorecardV2Props {
  scorecard: ScorecardAssessmentDisplay;
}

export function CandidateScorecardV2({ scorecard }: CandidateScorecardV2Props) {
  const signalsId = useId();
  const reco = RECOMMENDATION[scorecard.recommendation] ?? RECOMMENDATION.human_review;
  const overall = scorecard.overallScore;
  const incomplete = scorecard.status === 'incomplete_evidence';
  const totalCount = scorecard.metrics.length;
  const scoredCount = scorecard.metrics.filter((metric) => metric.score != null).length;

  return (
    <div className="space-y-4">
      {/* ── Verdict band ─────────────────────────────────────────── */}
      <SurfaceCard as="section" label="Overall assessment" className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-[2.25rem] font-bold leading-none tabular-nums"
              style={{ color: reco.fill }}
            >
              {overall == null ? '—' : Math.round(overall)}
            </span>
            <span className="text-sm text-[var(--c-ink-secondary)]">/ 100</span>
            {scorecard.weightedScore5 != null && (
              <span className="ml-1 text-xs text-[var(--c-ink-secondary)]">
                <span className="font-mono tabular-nums">
                  {scorecard.weightedScore5.toFixed(2)}
                </span>{' '}
                / {scorecard.scoreScaleMax} weighted
              </span>
            )}
          </div>
          <Tag tone={reco.tone} srPrefix="Recommendation:" className="px-3 py-1 text-sm">
            {reco.label}
          </Tag>
        </div>

        {overall != null && (
          <div className="mt-3">
            <Meter label="Overall score" value={overall} max={100} emphasis />
          </div>
        )}

        {incomplete && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--c-border-light)] pt-2.5">
            <Tag tone="caution" srPrefix="Status:">
              {overall == null ? 'Incomplete evidence' : 'Provisional score'}
            </Tag>
            <span className="text-xs text-[var(--c-ink-secondary)]">
              {overall == null
                ? 'No metric could be scored from the available evidence — this screening needs human review.'
                : `Provisional score from ${scoredCount} of ${totalCount} metrics — the rest lacked evidence and were excluded from the weighted score. Confirm before a decision.`}
            </span>
          </div>
        )}
      </SurfaceCard>

      {/* ── Metrics ──────────────────────────────────────────────── */}
      <SurfaceCard as="section" labelledBy={signalsId} className="p-4 sm:p-5">
        <h3 id={signalsId} className={cx('mb-4', CARD_TITLE)}>
          Metrics
        </h3>
        {scorecard.metrics.length === 0 ? (
          <p className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]">
            This assessment carries no per-metric results.
          </p>
        ) : (
          <div className="space-y-3" data-scorecard-v2-metrics="true">
            {scorecard.metrics.map((metric) => (
              <MetricCard
                key={metric.id || metric.name}
                metric={metric}
                scaleMax={scorecard.scoreScaleMax}
              />
            ))}
          </div>
        )}
      </SurfaceCard>
    </div>
  );
}
