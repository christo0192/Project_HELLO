/**
 * ReviewScorecard: the reasoning pane of the phone Review screen.
 *
 * Logsheet's sheet with Readout's scorecard panel. Top to bottom: the AI recommendation in a box, a
 * pencilled one while it is provisional, with the 45 and 65 cut-offs on a ruler; one sentence built
 * from the data, never by a model; the provisional notice; "Check before deciding"; then every rubric
 * row, each with a seek chip. A row is one line, so a busy screening shows four whole on arrival at
 * 1440x900 and the rest are a short scroll away. The weakest metric alone opens with two lines of its
 * reasoning, one in a window under 820px tall. Everything else in a row, the weakest metric's quotes and
 * an unscored metric's reason included, sits behind its chevron, one press away. The owner reversed
 * "the weakest metric keeps its quotes open" on 2026-11-06: each quote stays marked in the transcript
 * and ticked on the strip, and any tick, chip or margin number still opens its row.
 *
 * The verdict and each rating take their family (`design/tones`): Select `ready`, Borderline
 * `unresolved`, Reject `closed`, and never crimson. What needs a second look is `unresolved`. Dashed
 * means not firm: Provisional and Insufficient evidence, nothing else. Every status carries a word, and
 * shape and figures stay, so colour is never the only signal. This is AI output and says so.
 *
 * A scorecard held for thin evidence (`held`) has no hue at all: `ready` is a good or ready result, and
 * the server has just said this one is neither. Its words do not change.
 *
 * Quotes come from `lib/evidence-quotes`. A quote that could not be placed is the same words with no
 * number and no button: it stays readable, and nothing claims a moment it does not have.
 */

import { useId } from 'react';
import { scoreLabel } from '../../types';
import type { CandidateResumeFacts, ScorecardAssessmentDisplay, ScorecardMetricDisplay } from '../../types';
import { formatWeightPercent } from '../../lib/scorecard-weights';
import { BORDERLINE_CUTOFF, SELECT_CUTOFF, scoreWhatIf, whatIfLine } from '../../lib/scorecard-what-if';
import type { Evidence, EvidenceQuote, PlacedQuote } from '../../lib/evidence-quotes';
import { cx } from '../design/cx';
import {
  evidenceNumberClass,
  FAMILY_CLASSES,
  ratingFamily,
  rulerLabelClass,
  verdictFamily,
  type JudgementFamily,
} from '../design/tones';
import { RulerZones } from '../session/RulerZones';
import { VerdictMark } from '../session/VerdictMark';
import { EvidenceMark } from './EvidenceMark';
import { finiteNumber, recommendationMeta } from '../session/scorecard-read';

export interface QuoteMoment {
  /** The turn number. */
  turn: number;
  /** Its position in a recording, or null for a turn with no time. */
  clock: string | null;
  /** Pressing it plays audio. A moment with none still cues, and must not say it plays. */
  playable: boolean;
}

export interface ReviewScorecardProps {
  scorecard: ScorecardAssessmentDisplay;
  evidence: Evidence;
  /** Where a placed quote stands. */
  momentOf: (quote: PlacedQuote) => QuoteMoment;
  /** The evidence number that is cued. */
  activeEvidence: number | null;
  /** `pressed` is the control, which stands in this pane and must not move under the pointer. */
  onCue: (number: number, pressed: HTMLElement) => void;
  /** The metrics opened by hand or by a cue: their reasoning in full, and their quote buttons. */
  openMetrics: ReadonlySet<string>;
  onToggleMetric: (metricId: string) => void;
  /** Lines for "Check before deciding", in words: a dropped call. */
  checks?: readonly string[];
  /** The AI's red flags. null when this scorecard does not say, so nothing is claimed. */
  redFlags?: readonly string[] | null;
  /**
   * This row scored another call: a viewer without transcript access gets the candidate's latest
   * screening. It is then named as that and never as this call's, and `checks` belong to this call.
   */
  otherCall?: boolean;
  /** Graded insufficient: not written to Ashby and no change of status, so nothing here takes a hue. */
  held?: boolean;
}

/** Lowest score, then the heaviest of those, so it is the one that costs the most. */
export function weakestMetric(metrics: readonly ScorecardMetricDisplay[]): ScorecardMetricDisplay | null {
  const scored = metrics.filter((m) => finiteNumber(m.score) !== null);
  if (scored.length === 0) return null;
  return [...scored].sort(
    (a, b) => finiteNumber(a.score)! - finiteNumber(b.score)! || (b.weightBps ?? 0) - (a.weightBps ?? 0),
  )[0];
}

/** One sentence from the figures. Deterministic, so it can never say more than the row does. */
export function verdictSentence(scorecard: ScorecardAssessmentDisplay): string | null {
  const overall = finiteNumber(scorecard.overallScore);
  if (overall === null) return null;
  const score = Math.round(overall);
  const reach =
    score === SELECT_CUTOFF
      ? 'at the Select cut-off'
      : score > SELECT_CUTOFF
        ? `${score - SELECT_CUTOFF} above the Select cut-off`
        : score >= BORDERLINE_CUTOFF
          ? `${SELECT_CUTOFF - score} short of Select`
          : `${BORDERLINE_CUTOFF - score} short of Borderline`;
  const parts = [`${score} of 100, ${reach}.`];

  const scored = scorecard.metrics.filter((m) => finiteNumber(m.score) !== null);
  const weakest = weakestMetric(scorecard.metrics);
  if (weakest && scored.length > 1) {
    const words = scored.map((m) => scoreLabel(finiteNumber(m.score)!, scorecard.scoreScaleMax));
    const counts = new Map<string, number>();
    for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
    const [commonWord, commonCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const weight = weakest.weightBps === null ? '' : `, ${formatWeightPercent(weakest.weightBps)} of the weight`;
    const word = scoreLabel(finiteNumber(weakest.score)!, scorecard.scoreScaleMax);
    parts.push(
      `${commonCount} of the ${scored.length} scored metrics ${commonCount === 1 ? 'is' : 'are'} ${commonWord}; `
        + `the weakest is ${weakest.name} (${word}${weight}).`,
    );
  }
  return parts.join(' ');
}

/** A rubric row's printed columns. A chip past the hour needs the wider one, or it runs over the rating. */
const RUBRIC_COLUMNS = 'sm:grid-cols-[minmax(0,1fr)_2.25rem_6.75rem_8.5rem]';
const RUBRIC_COLUMNS_HOURS = 'sm:grid-cols-[minmax(0,1fr)_2.25rem_8.75rem_8.5rem]';

/** A metric with no human name is "Metric N", its opaque id never a heading. */
export const metricDisplayName = (metric: ScorecardMetricDisplay, index: number): string =>
  metric.name && metric.name !== metric.id ? metric.name : `Metric ${index + 1}`;

/** How many metrics a provisional score rests on: the words the verdict box prints, and the header's summary too. */
export function scoredOfTotal(scorecard: ScorecardAssessmentDisplay): string {
  const metrics = Array.isArray(scorecard.metrics) ? scorecard.metrics : [];
  const scored = metrics.filter((m) => finiteNumber(m.score) !== null).length;
  return `${scored} of ${metrics.length} metrics`;
}

/**
 * The rating as form tick-boxes, in its family. Decoration: the word and the figure beside it are the text.
 * The header's summary prints this same component, so the two can never disagree.
 */
export function Pips({ level, max, family }: { level: number; max: number; family: JudgementFamily | null }) {
  const filled = family ? cx(FAMILY_CLASSES[family].edge, FAMILY_CLASSES[family].fill) : 'border-ink bg-ink';
  return (
    <span aria-hidden="true" data-rating-pips="" className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, at) => (
        <span
          key={at}
          className={cx(
            'h-2.5 w-2.5 rounded-evidence border',
            at < level ? cx('data-fill', filled) : 'border-control',
          )}
        />
      ))}
    </span>
  );
}

/**
 * The 0-100 ruler: three painted zones, each with its word under it. The stored verdict decides which
 * is emphasised, so it can never say more than the word above it. The mark is the score, in ink to read
 * across any zone.
 */
function ScoreRuler({ score, current }: { score: number | null; current: JudgementFamily | null }) {
  return (
    <div aria-hidden="true" data-score-ruler="" className="relative mt-2">
      <RulerZones current={current} borderline={BORDERLINE_CUTOFF} select={SELECT_CUTOFF} className="h-1.5" />
      {[BORDERLINE_CUTOFF, SELECT_CUTOFF].map((cut) => (
        <span key={cut} data-score-cut="" className="data-fill absolute -top-1 h-3.5 w-px bg-control" style={{ left: `${cut}%` }} />
      ))}
      {score !== null && (
        <span data-score-mark="" className="data-fill absolute -top-1.5 h-[1.125rem] w-0.5 -translate-x-px bg-ink" style={{ left: `${score}%` }} />
      )}
      <div className="relative mt-0.5 h-4 text-meta text-ink-tertiary">
        <span className={cx('absolute left-0', rulerLabelClass('closed', current))}>Reject</span>
        {/* Back to back on the Select tick, as R1's ruler sets them: the zone between the cut-offs is too narrow on a phone to hold a label. */}
        <span className={cx('absolute -translate-x-full whitespace-nowrap pr-1', rulerLabelClass('unresolved', current))} style={{ left: `${SELECT_CUTOFF}%` }}>Borderline {BORDERLINE_CUTOFF}</span>
        <span className={cx('absolute whitespace-nowrap pl-1', rulerLabelClass('ready', current))} style={{ left: `${SELECT_CUTOFF}%` }}>Select {SELECT_CUTOFF}</span>
        <span className="absolute right-0">100</span>
      </div>
    </div>
  );
}

function AlertIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" className="shrink-0 text-unresolved-text">
      <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M8 4.5v4.25M8 10.75v.75" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="10" height="10" className="shrink-0">
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="14"
      height="14"
      className={cx('shrink-0 text-ink-tertiary transition-transform duration-150 ease-soft', open && 'rotate-180')}
    >
      <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The chip a rubric row carries: its first placed quote, "T16 · 05:38". */
function SeekChip({ quote, moment, pressed, onCue }: {
  quote: PlacedQuote;
  moment: QuoteMoment;
  pressed: boolean;
  onCue: ReviewScorecardProps['onCue'];
}) {
  const text = moment.clock === null ? `T${moment.turn}` : `T${moment.turn} · ${moment.clock}`;
  return (
    <button
      type="button"
      data-seek-chip={quote.number}
      onClick={(event) => onCue(quote.number, event.currentTarget)}
      aria-pressed={pressed}
      aria-label={`${text}, evidence ${quote.number}, ${quote.metricName}. ${moment.playable ? 'Play from here.' : 'Go to this turn.'}`}
      className={cx(
        'inline-flex min-h-6 items-center gap-1 whitespace-nowrap rounded-chip border px-1.5 font-mono text-meta transition-colors duration-hover ease-out',
        pressed ? 'border-ink bg-ink text-paper' : 'border-control bg-paper text-ink hover:bg-field',
      )}
    >
      {moment.playable && <PlayIcon />}
      {text}
    </button>
  );
}

/** A placed quote's button, or the same words as plain text when it has no moment. */
function QuoteRow({ quote, moment, pressed, family, onCue }: {
  quote: EvidenceQuote;
  moment: QuoteMoment | null;
  pressed: boolean;
  /** The family of the rating it cites. A metric with no score has none, and stays ink. */
  family: JudgementFamily | null;
  onCue: ReviewScorecardProps['onCue'];
}) {
  if (quote.number === null || moment === null) {
    return <p className="text-sm leading-[1.3125rem] text-ink-secondary">“{quote.text}”</p>;
  }
  const number = quote.number;
  const where = moment.clock === null ? `T${moment.turn}` : `T${moment.turn} · ${moment.clock}`;
  return (
    <button
      type="button"
      data-quote-button={number}
      onClick={(event) => onCue(number, event.currentTarget)}
      aria-pressed={pressed}
      // A ruled line, and only the pressed one a box. Every side has its edge, so a press moves nothing.
      className={cx(
        'grid w-full grid-cols-[auto_minmax(0,1fr)_0.75rem] items-start gap-x-2.5 border px-2.5 py-1 text-left transition-colors duration-hover ease-out',
        pressed ? 'rounded-control border-ink' : 'border-transparent border-b-rule hover:border-b-control',
      )}
    >
      <span className="flex items-center gap-1.5 whitespace-nowrap font-mono text-meta leading-5 text-ink-secondary">
        <span
          data-evidence-number={number}
          className={cx(
            'flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-evidence border px-0.5 leading-none',
            evidenceNumberClass(family, pressed),
          )}
        >
          {number}
        </span>
        {where}
      </span>
      <span className="text-sm leading-[1.3125rem] text-ink">
        <EvidenceMark>{quote.text}</EvidenceMark>
      </span>
      <span className="pt-1 text-ink">
        {moment.playable && <PlayIcon />}
        <span className="sr-only">{moment.playable ? 'Play this moment' : 'Go to this turn'}</span>
      </span>
    </button>
  );
}

function RubricRow({ metric, index, scorecard, quotes, weakest, open, columns, held, onToggle, momentOf, activeEvidence, onCue }: {
  metric: ScorecardMetricDisplay;
  index: number;
  scorecard: ScorecardAssessmentDisplay;
  quotes: readonly EvidenceQuote[];
  weakest: boolean;
  open: boolean;
  columns: string;
  held: boolean;
  onToggle: () => void;
  momentOf: (quote: PlacedQuote) => QuoteMoment;
  activeEvidence: number | null;
  onCue: ReviewScorecardProps['onCue'];
}) {
  const bodyId = useId();
  const score = finiteNumber(metric.score);
  const name = metricDisplayName(metric, index);
  const rationale = typeof metric.rationale === 'string' ? metric.rationale.trim() : '';
  const placed = quotes.filter((quote): quote is PlacedQuote => quote.number !== null);
  const chip = placed.find((quote) => quote.number === activeEvidence) ?? placed[0];
  const hasMore = rationale !== '' || quotes.length > 0;
  // Closed, only the weakest metric says anything more, and in a short window less of it.
  const rationaleLines = open ? null : weakest ? 'line-clamp-2 [@media(max-height:819.98px)]:line-clamp-1' : 'hidden';
  const family = held ? null : ratingFamily(score, scorecard.scoreScaleMax);

  return (
    // Focusable only with no toggle to take the focus when the header's summary brings a reader here. The
    // scroll margin is what that press keeps clear: 16px, past the 56px app bar that sticks below `lg`.
    <li
      data-rubric-row={metric.id}
      tabIndex={hasMore ? undefined : -1}
      className="scroll-mt-[4.5rem] border-b border-rule py-0.5 lg:scroll-mt-4"
    >
      {/* Printed columns, so the weights, chips and ratings of every row line up as on a form. As narrow
          as their widest content, so a two-word metric keeps one line at 1366px. */}
      <div className={cx('flex flex-wrap items-center gap-x-1.5 gap-y-1 sm:grid', columns)}>
        <h4 className="min-w-0 flex-1 basis-40 text-sm font-medium leading-[1.125rem] text-ink">
          {hasMore ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-controls={bodyId}
              className="inline-flex max-w-full items-center gap-1 text-left"
            >
              <span className="min-w-0">{name}</span>
              <Chevron open={open} />
            </button>
          ) : (
            name
          )}
        </h4>
        <span className="text-right text-label tabular-nums text-ink-tertiary">
          {metric.weightBps === null ? '' : formatWeightPercent(metric.weightBps)}
        </span>
        {score !== null && (
          <span>
            {chip && (
              <SeekChip
                quote={chip}
                moment={momentOf(chip)}
                pressed={chip.number === activeEvidence}
                onCue={onCue}
              />
            )}
          </span>
        )}
        {score !== null ? (
          <span className={cx('flex items-center gap-2 whitespace-nowrap text-label', family ? FAMILY_CLASSES[family].text : 'text-ink')}>
            <Pips level={score} max={scorecard.scoreScaleMax} family={family} />
            <span>
              {scoreLabel(score, scorecard.scoreScaleMax)}, {score}/{scorecard.scoreScaleMax}
            </span>
          </span>
        ) : (
          <span className="col-span-2 flex items-center gap-2 whitespace-nowrap text-label">
            <span className="rounded-chip border border-dashed border-unresolved px-2 py-0.5 text-meta text-unresolved-text">
              Insufficient evidence
            </span>
            <span className="text-ink-tertiary">not counted</span>
          </span>
        )}
      </div>

      {hasMore && (
        <div id={bodyId}>
          {rationale && (
            <p className={cx('mt-0.5 text-label leading-5 text-ink-secondary', rationaleLines)}>{rationale}</p>
          )}
          {open && quotes.length > 0 && (
            <ul aria-label={`Quotes for ${name}`} className="mb-0.5 mt-1 space-y-1">
              {quotes.map((quote, at) => (
                <li key={at}>
                  <QuoteRow
                    quote={quote}
                    moment={quote.number === null ? null : momentOf(quote as PlacedQuote)}
                    pressed={quote.number !== null && quote.number === activeEvidence}
                    family={family}
                    onCue={onCue}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/** What the parsed resume says, as a ruled block. Only the facts it has. */
export function FromTheResume({ facts }: { facts: CandidateResumeFacts | null | undefined }) {
  const recent = facts?.recent_role;
  const rows = [
    ['Current role', facts?.current_role],
    ['Recent role', [recent?.title, recent?.employer, recent?.period].filter(Boolean).join(', ')],
    ['Education', facts?.education?.join('; ')],
  ].filter((row): row is [string, string] => typeof row[1] === 'string' && row[1].trim() !== '');
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">From the resume</h3>
      <dl className="mt-1 border-t border-rule-2 text-label leading-5">
        {rows.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2.5 border-b border-rule py-1">
            <dt className="text-ink-tertiary">{label}</dt>
            <dd className="text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function ReviewScorecard({
  scorecard,
  evidence,
  momentOf,
  activeEvidence,
  onCue,
  openMetrics,
  onToggleMetric,
  checks = [],
  redFlags = null,
  otherCall = false,
  held = false,
}: ReviewScorecardProps) {
  const metrics = Array.isArray(scorecard.metrics) ? scorecard.metrics : [];
  const total = metrics.length;
  const unscored = metrics.filter((m) => finiteNumber(m.score) === null);
  const scoredCount = total - unscored.length;
  const overall = finiteNumber(scorecard.overallScore);
  const score = overall === null ? null : Math.round(overall);
  const provisional = scorecard.status === 'incomplete_evidence';
  const verdict = recommendationMeta(scorecard.recommendation);
  const family = held ? null : verdictFamily(scorecard.recommendation);
  const sentence = verdictSentence(scorecard);
  const whatIf = scoreWhatIf({ metrics, scoreScaleMax: scorecard.scoreScaleMax });
  const weakest = weakestMetric(metrics);
  // Any placed quote can become its row's chip when it is pressed, so every row is set for the widest.
  const pastTheHour = evidence.placed.some((quote) => (momentOf(quote).clock?.split(':').length ?? 0) > 2);

  const flags = redFlags ?? [];
  const anyCheck = unscored.length > 0 || checks.length > 0 || flags.length > 0;
  const showChecks = anyCheck || redFlags !== null;

  return (
    // Not a landmark of its own: the pane around it is the region, under this same name.
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-section text-ink">{otherCall ? 'Latest scorecard' : 'AI recommendation'}</h2>
        <p className="text-meta text-ink-tertiary">
          {otherCall ? 'AI scoring. Not a hiring decision.' : 'AI scoring of this call. Not a hiring decision.'}
        </p>
      </div>

      <div
        data-verdict-box={provisional ? 'provisional' : 'firm'}
        className={cx(
          'relative mt-2 rounded-control border px-4 pb-1 pt-1.5',
          provisional && 'border-dashed',
          family
            ? cx(FAMILY_CLASSES[family].wash, FAMILY_CLASSES[family].edge)
            : provisional
              ? 'border-ink-secondary'
              : 'border-rule-2',
        )}
      >
        {provisional && (
          <p className="absolute -top-2 right-3 bg-paper px-1.5 text-meta text-ink-secondary">
            <span className="font-semibold text-unresolved-text">Provisional</span> · {scoredOfTotal(scorecard)}
          </p>
        )}
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center text-xl font-semibold text-ink">
            {verdict ? <VerdictMark recommendation={scorecard.recommendation} size="xl" plain={held} /> : 'Not scored'}
          </p>
          {score !== null ? (
            <p className="flex items-baseline gap-0.5 whitespace-nowrap">
              <span className={cx('text-stat', family ? FAMILY_CLASSES[family].text : 'text-ink')}>{score}</span>
              <span className="text-sm text-ink-tertiary">/100</span>
            </p>
          ) : (
            <p className="text-sm text-ink-secondary">Not scored</p>
          )}
        </div>
        <ScoreRuler score={score} current={family} />
      </div>

      {sentence && <p className="mt-1.5 text-sm leading-[1.3125rem] text-ink">{sentence}</p>}
      {provisional && (
        <p className="mt-1 text-label leading-5 text-ink-secondary">
          {overall === null ? (
            'No metric had enough evidence to score. This screening needs a human review.'
          ) : (
            <>
              <span className="font-semibold text-unresolved-text">Provisional:</span>{' '}
              {`scored from ${scoredCount} of ${total} metrics. The others lacked evidence and are left out of the weighted score, so confirm before deciding.`}
            </>
          )}
        </p>
      )}

      {showChecks && (
        <div className="mt-4">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3">
            {/* One icon for the list. With nothing on it there is nothing to warn of. */}
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              {anyCheck && <AlertIcon />}
              Check before deciding
            </h3>
            {redFlags !== null && flags.length === 0 && (
              <p className="text-meta text-ink-tertiary">Red flags: none identified</p>
            )}
          </div>
          <ul className="mt-0.5 border-t border-rule text-label leading-5 text-ink-secondary">
            {unscored.map((metric, at) => (
              <li key={metric.id} className="border-b border-rule py-0.5">
                <span className="font-semibold text-unresolved-text">
                  {metricDisplayName(metric, metrics.indexOf(metric))}: insufficient evidence.
                </span>
                {whatIf && at === unscored.length - 1 && (
                  <>
                    {' '}
                    <span data-what-if="">{whatIfLine(whatIf)}</span>
                  </>
                )}
              </li>
            ))}
            {checks.map((check) => (
              <li key={check} className="border-b border-rule py-0.5">
                {check}
              </li>
            ))}
            {flags.map((flag) => (
              <li key={flag} className="border-b border-rule py-0.5">
                <span className="font-semibold text-unresolved-text">Red flag:</span> {flag}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3">
          <h3 className="text-sm font-semibold text-ink">Rubric</h3>
          <p className="text-meta text-ink-tertiary">Weight · rating out of {scorecard.scoreScaleMax}</p>
        </div>
        {total === 0 ? (
          <p className="mt-2 text-sm text-ink-secondary">This assessment carries no per-metric results.</p>
        ) : (
          <ol className="mt-0.5 border-t border-rule-2">
            {metrics.map((metric, index) => (
              <RubricRow
                key={`${metric.id}-${index}`}
                metric={metric}
                index={index}
                scorecard={scorecard}
                quotes={evidence.byMetric[metric.id] ?? []}
                weakest={metric === weakest}
                open={openMetrics.has(metric.id)}
                columns={pastTheHour ? RUBRIC_COLUMNS_HOURS : RUBRIC_COLUMNS}
                held={held}
                onToggle={() => onToggleMetric(metric.id)}
                momentOf={momentOf}
                activeEvidence={activeEvidence}
                onCue={onCue}
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
