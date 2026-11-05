/**
 * Overview: the AI result, labelled AI, and everything that should slow a reader down before they
 * trust it. All five metric rows are open: this is Readout's scorecard panel, drawn as printed rows
 * rather than a band. A quote is a button that opens Recording at the turn it came from.
 *
 * What it says depends on where the round stands (`reviewStage`), and an appeal outranks everything.
 * The appeal and recording sentences are the existing ones, used verbatim.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { InlineNotice, StatusBadge } from '../design';
import { ScorePips } from '../session/ScoreVerdict';
import { formatDateTime } from '../../lib/datetime';
import { R1_RESULT_WITHHELD } from '../../lib/r1';
import { clockText } from '../../lib/r1-recording';
import {
  evidenceMarks,
  neededReveals,
  notScoredSentence,
  placeTurns,
  reviewStage,
  trustChecks,
  verdictOf,
} from '../../lib/r1-review';
import type { EvidenceMark, NeedReveal, PlacedTurn } from '../../lib/r1-review';
import { RECOMMENDATION_LABELS } from '../../lib/recommendation-labels';
import type { R1ReviewAttempt, R1ReviewMetric, R1ReviewResponse } from '../../lib/r1-types';
import { formatWeightPercent } from '../../lib/scorecard-weights';
import { scoreLabel } from '../../types';
import { VerdictBlock } from './VerdictBlock';

/** Where a seek chip or a quote points. */
export interface TurnTarget {
  attemptNumber: number;
  row: number;
  sec: number | null;
}

export interface OverviewPanelProps {
  review: R1ReviewResponse;
  /** The attempt on screen. What is checked below is the attempt that was scored, when that differs. */
  attempt: R1ReviewAttempt | null;
  candidateName: string;
  onOpenTurn: (target: TurnTarget) => void;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 border-b border-line pb-2">
        <h2 id={id} className="text-section text-ink">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** "T12 · 2:05", or "T12" when nothing anchors the turn on a recording. */
function SeekChip({ turnIndex, sec }: { turnIndex: number; sec: number | null }) {
  return (
    <span className="shrink-0 whitespace-nowrap font-mono text-meta text-ink-secondary">
      T{turnIndex}
      {sec !== null && ` · ${clockText(sec)}`}
    </span>
  );
}

function Quote({ mark, onOpen }: { mark: EvidenceMark; onOpen: () => void }) {
  const body = (
    <>
      <span aria-hidden="true" className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-evidence border border-ink px-0.5 font-mono text-meta leading-none text-ink">
        {mark.number}
      </span>
      <SeekChip turnIndex={mark.turnIndex} sec={mark.startSec} />
      <span className="min-w-0 text-sm text-ink">
        <span className="bg-wash">{mark.quote}</span>
      </span>
    </>
  );
  const shape = 'flex w-full items-start gap-2 rounded-control border px-2.5 py-1.5 text-left';
  if (mark.row === null) return <p className={`${shape} border-line`}>{body}</p>;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${shape} border-[var(--control)] transition-colors duration-hover ease-out hover:bg-surface-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]`}
    >
      {body}
    </button>
  );
}

function MetricRow({
  metric,
  index,
  scaleMax,
  quotes,
  onOpenQuote,
}: {
  metric: R1ReviewMetric;
  index: number;
  scaleMax: number;
  quotes: readonly EvidenceMark[];
  onOpenQuote: (mark: EvidenceMark) => void;
}) {
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="min-w-0">
          <span className="text-sm font-semibold text-ink">{metric.name?.trim() || `Metric ${index + 1}`}</span>
          {metric.weight_bps !== null && (
            <span className="ml-2 text-meta tabular-nums text-ink-tertiary">{formatWeightPercent(metric.weight_bps)}</span>
          )}
        </p>
        {metric.score !== null ? (
          <p className="flex items-center gap-2 whitespace-nowrap">
            <span className="text-label font-semibold text-ink">{scoreLabel(metric.score, scaleMax as 4)}</span>
            <ScorePips level={metric.score} max={scaleMax} />
            <span aria-hidden="true" className="text-meta tabular-nums text-ink-tertiary">
              {metric.score}/{scaleMax}
            </span>
            <span className="sr-only">
              {metric.score} out of {scaleMax}
            </span>
          </p>
        ) : (
          <StatusBadge tone="warning">Insufficient evidence</StatusBadge>
        )}
      </div>
      {metric.rationale && <p className="mt-1 max-w-prose text-sm leading-6 text-ink-secondary">{metric.rationale}</p>}
      {quotes.length > 0 && (
        <div className="mt-2 space-y-1.5">
          {quotes.map((mark) => (
            <Quote key={mark.number} mark={mark} onOpen={() => onOpenQuote(mark)} />
          ))}
        </div>
      )}
    </li>
  );
}

function Needs({ reveals, onOpen }: { reveals: readonly NeedReveal[]; onOpen: (reveal: NeedReveal) => void }) {
  const revealed = reveals.filter((reveal) => reveal.turnIndex !== null).length;
  return (
    <Section
      title="Needs revealed"
      aside={<span className="text-meta tabular-nums text-ink-tertiary">{revealed} of {reveals.length} revealed</span>}
    >
      <ul className="divide-y divide-line">
        {reveals.map((reveal) => (
          <li key={reveal.need} className="flex min-h-9 items-center justify-between gap-3 py-1.5 text-sm">
            <span className="text-ink">{reveal.label}</span>
            {reveal.turnIndex === null ? (
              <span className="text-ink-tertiary">Not revealed</span>
            ) : reveal.row === null ? (
              <SeekChip turnIndex={reveal.turnIndex} sec={null} />
            ) : (
              <button
                type="button"
                onClick={() => onOpen(reveal)}
                className="rounded-control border border-[var(--control)] px-2 py-0.5 transition-colors duration-hover ease-out hover:bg-surface-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
              >
                <SeekChip turnIndex={reveal.turnIndex} sec={reveal.startSec} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}

function StateLine({ children }: { children: ReactNode }) {
  return <p className="max-w-prose py-8 text-sm text-ink-secondary">{children}</p>;
}

function PhoneLine({ review }: { review: R1ReviewResponse }) {
  const phone = review.phone_screening;
  if (!phone) return null;
  const word = phone.recommendation
    ? (RECOMMENDATION_LABELS as Readonly<Record<string, string>>)[phone.recommendation]
    : null;
  const result = [word, phone.overall_score === null ? null : Math.round(phone.overall_score)].filter((part) => part !== null && part !== undefined).join(' ');
  return (
    <p className="text-sm text-ink-secondary">
      Phone screening: {result ? `${result} (AI). ` : ''}
      <Link
        to={`/candidates/${review.round.candidate_id}?tab=review`}
        className="text-ink underline underline-offset-2 hover:text-ink-secondary focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]"
      >
        Open the candidate
      </Link>
    </p>
  );
}

export function OverviewPanel({ review, attempt, candidateName, onOpenTurn }: OverviewPanelProps) {
  const { round, assessment, attempts, events } = review;
  const stage = reviewStage(review);

  if (stage === 'withheld') return <StateLine>{R1_RESULT_WITHHELD}</StateLine>;
  if (stage === 'invited') return <StateLine>Link valid until {formatDateTime(round.expires_at)}.</StateLine>;
  if (stage === 'in_progress') return <StateLine>The interview is in progress. The review opens here once it ends.</StateLine>;
  if (stage === 'scoring') return <StateLine>Scoring in progress. The result appears here once it is ready.</StateLine>;
  if (stage === 'closed') return <StateLine>This round ended without a scored interview.</StateLine>;
  if (!assessment) return null;

  // Evidence belongs to the attempt that was scored, whichever attempt is on screen.
  const scored = attempts.find((item) => item.session_id === assessment.session_id) ?? attempt;
  const turns: PlacedTurn[] = scored ? placeTurns(scored, candidateName, assessment) : [];
  const marks = evidenceMarks(assessment, turns);
  const reveals = scored ? neededReveals(events, scored.session_id, turns) : [];
  const checks = trustChecks(assessment, scored);
  const scaleMax = assessment.score_scale_max ?? 4;
  const verdict = stage === 'scored' ? verdictOf(round) : null;
  const metrics = assessment.metric_results;
  const scoredCount = metrics.filter((metric) => metric.score !== null).length;
  const provisional = assessment.scoring_status === 'incomplete_evidence' && verdict !== null;
  // A placeholder row repeats one operator's sentence five times, and scores nothing.
  const showMetrics = stage === 'scored' || assessment.r1.outcome === 'scored';
  const open = (row: number | null, sec: number | null) => {
    if (scored && row !== null) onOpenTurn({ attemptNumber: scored.attempt_number, row, sec });
  };

  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <div className="min-w-0 space-y-6">
        <Section
          title="AI recommendation"
          aside={<span className="text-meta text-ink-tertiary">AI scoring of this interview. Not a hiring decision.</span>}
        >
          <div className="mt-3">
            {stage === 'not_scored' ? (
              <p className="text-section text-ink">{notScoredSentence(assessment)}</p>
            ) : (
              verdict && (
                <VerdictBlock
                  verdict={verdict}
                  provisionalNote={provisional ? `Provisional · ${scoredCount} of ${metrics.length} metrics` : null}
                  thresholds={assessment.r1.thresholds}
                />
              )
            )}
            {provisional && (
              <InlineNotice tone="warning" role="none" className="mt-3">
                {`Provisional: scored from ${scoredCount} of ${metrics.length} metrics. The others lacked evidence and are left out of the weighted score, so confirm before deciding.`}
              </InlineNotice>
            )}
          </div>
        </Section>

        {showMetrics && metrics.length > 0 && (
          <Section
            title="Rubric"
            aside={<span className="text-meta text-ink-tertiary">Weight, rating out of {scaleMax}</span>}
          >
            <ul aria-label="Rubric" className="divide-y divide-line">
              {metrics.map((metric, index) => (
                <MetricRow
                  key={metric.metric_id || index}
                  metric={metric}
                  index={index}
                  scaleMax={scaleMax}
                  quotes={marks.filter((mark) => mark.metricId === metric.metric_id)}
                  onOpenQuote={(mark) => open(mark.row, mark.startSec)}
                />
              ))}
            </ul>
          </Section>
        )}
      </div>

      <div className="min-w-0 space-y-6">
        <Section title="Check before trusting it">
          {checks.length === 0 ? (
            <p className="pt-3 text-sm text-ink-secondary">Nothing to flag.</p>
          ) : (
            <ul className="divide-y divide-line">
              {checks.map((check) => (
                <li key={check.key} className="py-2 text-sm text-ink">
                  {check.text}
                </li>
              ))}
            </ul>
          )}
        </Section>
        {reveals.length > 0 && <Needs reveals={reveals} onOpen={(reveal) => open(reveal.row, reveal.startSec)} />}
        <PhoneLine review={review} />
      </div>
    </div>
  );
}
