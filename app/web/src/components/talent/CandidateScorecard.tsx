/**
 * CandidateScorecard — the candidate-scoped assessment card.
 *
 * Additive: `components/Scorecard.tsx` is rendered by Session Detail, the
 * live-call panel and Screening, all out of scope, so it is left
 * byte-identical and this component is wired in only through the shared
 * candidate `TranscriptionSyncWorkspace`. Normal Candidate Review and the
 * authenticated Ashby-scoped Review therefore match automatically.
 *
 * It reads the SAME `Assessment` shape, with the SAME `raw.*` fallback
 * chain and the SAME empty-state copy, so no field or fallback is lost.
 * What changes is presentation:
 *
 *   - The card used to be a column of four full cards plus two more, each
 *     with its own title bar and padding, so reading it meant scrolling
 *     past ~1600px of chrome. The scored signals are now ONE "Signals"
 *     card whose groups are cells of a two-column grid; the chrome is paid
 *     for once instead of six times.
 *   - Weights were baked into heading strings ("Communication - 50%"), so
 *     they read as titles and were not machine-readable. They are data
 *     labels beside the group heading and a single line in the verdict
 *     band.
 *   - Scores were 1.5px hairlines whose colour was the only signal. They
 *     are `Meter`s: number, band word, then colour (see design/Meter).
 *   - Notes were `text-xs` in a ~200px column. Prose is `text-sm
 *     leading-relaxed` at `max-w-prose`, and the two groups that carry the
 *     long notes (Communication, Role fit) span both grid columns.
 *   - Nested blocks repeated the parent's fill three levels deep. They are
 *     `SurfaceCard level="sunken"` inside a `base` card: exactly two
 *     levels, enforced by SurfaceCard's depth guard.
 *   - Resume conflicts and Summary are read once, so they are split out
 *     (`narrative="none"` + `CandidateScorecardNarrative`) and the host can
 *     put them full width beneath a sticky scorecard column instead of
 *     letting them stretch it past the viewport.
 *
 * Deliberately NOT added: any computed "contribution to the overall
 * score". The overall score is produced by the model, not by summing the
 * weighted sections, so presenting such arithmetic would be a fabricated
 * metric. The weights are shown as the data labels they are.
 */

import { useId } from 'react';
import type { ReactNode } from 'react';
import type { Assessment, Recommendation } from '../../types';
import { Meter, SurfaceCard, Tag } from '../design/candidate';
import { cx } from '../design/cx';

/** Fixed rubric weights — the same values the legacy card printed. */
export const SECTION_WEIGHTS = {
  communication: '50%',
  motivation: '20%',
  tone: '10%',
  role_fit: '20%',
} as const;

const RECOMMENDATION_LABEL: Record<Recommendation, string> = {
  advance: 'Advance',
  hold: 'Hold',
  reject: 'Reject',
};

const RECOMMENDATION_TONE: Record<Recommendation, 'positive' | 'caution' | 'negative'> = {
  advance: 'positive',
  hold: 'caution',
  reject: 'negative',
};

/** Same thresholds the legacy card used for its score colour. */
function overallTone(score: number): 'positive' | 'caution' | 'negative' {
  if (score >= 75) return 'positive';
  if (score >= 50) return 'caution';
  return 'negative';
}

const OVERALL_THRESHOLDS = { fair: 0.5, strong: 0.75 };

const OVERALL_FILL: Record<'positive' | 'caution' | 'negative', string> = {
  positive: 'var(--c-positive)',
  caution: 'var(--c-caution)',
  negative: 'var(--c-negative)',
};

const SIGNAL_TONE: Record<string, 'positive' | 'caution' | 'negative'> = {
  none: 'positive',
  low: 'positive',
  moderate: 'caution',
  high: 'negative',
};

export type HeadingLevel = 2 | 3 | 4;

/**
 * Where the read-once narrative (Resume conflicts, Summary) is rendered.
 * `inline` keeps the card self-contained; `none` lets the host place
 * `CandidateScorecardNarrative` full width, outside a sticky column.
 */
export type ScorecardNarrative = 'inline' | 'none';

const CARD_TITLE =
  'text-[15px] font-semibold tracking-tight text-[var(--c-ink)]';

function Heading({
  level,
  id,
  children,
  className,
}: {
  level: HeadingLevel;
  id?: string;
  children: ReactNode;
  className?: string;
}) {
  const Tag_ = `h${level}` as 'h2' | 'h3' | 'h4';
  return (
    <Tag_ id={id} className={className}>
      {children}
    </Tag_>
  );
}

/** Prose block. `data-prose` is what the readability test looks for. */
function Prose({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p
      data-prose="true"
      className="mt-3 max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]"
    >
      {children}
    </p>
  );
}

/**
 * One scored group inside the Signals card. A `section` named by its
 * heading — so it is still individually addressable as a region — but NOT a
 * card: the Signals card is the one surface, and the group pays no chrome.
 */
function Group({
  title,
  weight,
  headingLevel,
  notes,
  className,
  children,
}: {
  title: string;
  weight?: string;
  headingLevel: HeadingLevel;
  notes?: string;
  className?: string;
  children: ReactNode;
}) {
  // Ids must be unique per MOUNT, not per title: two scorecards in one
  // document (a comparison view, a print sheet) would otherwise share an id
  // and `aria-labelledby` would silently resolve to the first one.
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cx('min-w-0', className)}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Heading
          level={headingLevel}
          id={headingId}
          className="text-[13px] font-medium text-[var(--c-ink)]"
        >
          {title}
        </Heading>
        {weight && (
          <span className="text-xs text-[var(--c-ink-secondary)]">
            Weight{' '}
            <span className="font-mono tabular-nums text-[var(--c-ink-secondary)]">
              {weight}
            </span>
          </span>
        )}
      </div>
      <div className="space-y-3">{children}</div>
      <Prose>{notes}</Prose>
    </section>
  );
}

function LabelledRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
      <span className="text-[var(--c-ink-secondary)]">{label}</span>
      {children}
    </div>
  );
}

function TagGroup({
  label,
  srPrefix,
  items,
  tone,
}: {
  label: string;
  srPrefix: string;
  items: string[];
  tone: 'positive' | 'caution' | 'negative';
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
      <p className="w-28 shrink-0 text-xs font-medium text-[var(--c-ink-secondary)]">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--c-ink-secondary)]">None</p>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {items.map((item) => (
            <Tag key={item} tone={tone} srPrefix={srPrefix}>
              {item}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
}

function SignalBlock({
  label,
  signal,
}: {
  label: string;
  signal?: {
    level: string;
    examples: string[];
    impact_score: number;
    notes: string;
  };
}) {
  if (!signal) return null;
  const tone = SIGNAL_TONE[signal.level] ?? 'caution';
  return (
    <SurfaceCard level="sunken" className="p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-medium text-[var(--c-ink-secondary)]">{label}</span>
        <Tag tone={tone} srPrefix={`${label} level:`}>
          {signal.level}
        </Tag>
      </div>
      <Meter label="Impact" value={signal.impact_score} />
      {signal.examples.length > 0 && (
        <Prose>
          <span className="font-medium">Examples:</span>{' '}
          {signal.examples.join(', ')}
        </Prose>
      )}
      <Prose>{signal.notes}</Prose>
    </SurfaceCard>
  );
}

function WeightItem({ label, weight }: { label: string; weight: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-[var(--c-ink-secondary)]">{label}</dt>
      <dd className="font-mono tabular-nums text-[var(--c-ink)]">{weight}</dd>
    </div>
  );
}

/** Where the Role fit group is rendered: inside the Signals grid, or by the host. */
export type ScorecardRoleFit = 'inline' | 'none';

export interface CandidateScorecardProps {
  assessment: Assessment;
  /**
   * Heading level for the section titles, so the card slots into whatever
   * outline its host page already has without skipping a level.
   */
  headingLevel?: HeadingLevel;
  /** Where Resume conflicts + Summary go. See `ScorecardNarrative`. */
  narrative?: ScorecardNarrative;
  /**
   * `none` leaves Role fit out of the Signals grid so the host can render
   * `CandidateScorecardRoleFit` as a full-width horizontal row instead.
   */
  roleFit?: ScorecardRoleFit;
}

export function CandidateScorecard({
  assessment,
  headingLevel = 3,
  narrative = 'inline',
  roleFit = 'inline',
}: CandidateScorecardProps) {
  const signalsId = useId();
  // Identical field + fallback chain to components/Scorecard.tsx.
  const raw = assessment.raw ?? {};
  const { tone, role_fit, overall_score, recommendation } = assessment;
  const communication = assessment.communication ?? raw.communication;
  const english = communication?.english_proficiency ?? assessment.english;
  const motivation = assessment.motivation ?? raw.motivation;

  const recoLabel = RECOMMENDATION_LABEL[recommendation] ?? RECOMMENDATION_LABEL.hold;
  const recoTone = RECOMMENDATION_TONE[recommendation] ?? RECOMMENDATION_TONE.hold;
  const roundedOverall = Math.round(overall_score);

  const hasSignalBlocks =
    communication?.filler_usage != null || communication?.native_language_usage != null;

  return (
    <div className="space-y-4">
      {/* ── Verdict band ─────────────────────────────────────────── */}
      <SurfaceCard as="section" label="Overall assessment" className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-[2.25rem] font-bold leading-none tabular-nums"
              style={{ color: OVERALL_FILL[overallTone(overall_score)] }}
            >
              {roundedOverall}
            </span>
            <span className="text-sm text-[var(--c-ink-secondary)]">/ 100</span>
          </div>
          <Tag tone={recoTone} srPrefix="Recommendation:" className="px-3 py-1 text-sm">
            {recoLabel}
          </Tag>
        </div>

        <div className="mt-3">
          <Meter
            label="Overall score"
            value={overall_score}
            max={100}
            emphasis
            // The legacy card coloured the overall score at 75 and 50 of
            // 100 — not the 7/5-of-10 fractions the per-metric bars use.
            thresholds={OVERALL_THRESHOLDS}
          />
        </div>

        {/* Weights as one 12px line, not a four-row block. */}
        <dl className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--c-border-light)] pt-2.5 text-xs">
          <WeightItem label="Communication" weight={SECTION_WEIGHTS.communication} />
          <span aria-hidden className="text-[var(--c-ink-secondary)]">·</span>
          <WeightItem label="Motivation" weight={SECTION_WEIGHTS.motivation} />
          <span aria-hidden className="text-[var(--c-ink-secondary)]">·</span>
          <WeightItem label="Tone" weight={SECTION_WEIGHTS.tone} />
          <span aria-hidden className="text-[var(--c-ink-secondary)]">·</span>
          <WeightItem label="Role fit" weight={SECTION_WEIGHTS.role_fit} />
        </dl>
      </SurfaceCard>

      {/* ── Signals ──────────────────────────────────────────────────
          ONE card, four groups as cells of a two-column grid:
            <640px   one column
            ≥640px   two columns — Communication and Role fit span both
          Four cells with two spanners fill exactly, so no breakpoint can
          leave an orphan; `items-start` keeps short groups at their own
          height instead of stretching to the tallest in the row. */}
      <SurfaceCard as="section" labelledBy={signalsId} className="p-4 sm:p-5">
        <Heading level={headingLevel} id={signalsId} className={cx('mb-4', CARD_TITLE)}>
          Signals
        </Heading>
        <div
          data-scorecard-grid="true"
          className="grid grid-cols-1 items-start gap-x-6 gap-y-5 sm:grid-cols-2"
        >
          <Group
            title="Communication"
            weight={SECTION_WEIGHTS.communication}
            headingLevel={headingLevel}
            notes={
              communication?.notes ??
              'No candidate responses are available to assess communication.'
            }
            className="sm:col-span-2"
          >
            <div className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <Meter label="Score" value={communication?.score ?? 0} />
              {communication?.clarity != null && (
                <Meter label="Clarity" value={communication.clarity} />
              )}
              {communication?.structure != null && (
                <Meter label="Structure" value={communication.structure} />
              )}
              {communication?.listening != null && (
                <Meter label="Listening" value={communication.listening} />
              )}
              {communication?.rapport != null && (
                <Meter label="Rapport" value={communication.rapport} />
              )}
            </div>
            {english && (
              <SurfaceCard level="sunken" className="p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-[var(--c-ink-secondary)]">
                    English band
                  </span>
                  <Tag tone="accent" srPrefix="English band:">
                    {english.band}
                  </Tag>
                </div>
                <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                  <Meter label="Grammar" value={english.grammar} />
                  <Meter label="Vocabulary" value={english.vocabulary} />
                  <Meter label="Fluency" value={english.fluency} />
                  <Meter label="Coherence" value={english.coherence} />
                </div>
                <Prose>{english.notes}</Prose>
              </SurfaceCard>
            )}
            {hasSignalBlocks && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SignalBlock label="Filler usage" signal={communication?.filler_usage} />
                <SignalBlock
                  label="Native-language usage"
                  signal={communication?.native_language_usage}
                />
              </div>
            )}
          </Group>

          <Group
            title="Tone"
            weight={SECTION_WEIGHTS.tone}
            headingLevel={headingLevel}
            notes={tone.notes}
          >
            <Meter label="Clarity" value={tone.clarity} />
            <Meter label="Confidence" value={tone.confidence} />
            <Meter label="Professionalism" value={tone.professionalism} />
            <LabelledRow label="Sentiment">
              <Tag srPrefix="Sentiment:">{tone.sentiment}</Tag>
            </LabelledRow>
          </Group>

          <Group
            title="Motivation"
            weight={SECTION_WEIGHTS.motivation}
            headingLevel={headingLevel}
            notes={
              motivation?.notes ??
              'No candidate responses are available to assess motivation.'
            }
          >
            <Meter label="Score" value={motivation?.score ?? 0} />
          </Group>

          {roleFit === 'inline' && (
          <Group
            title="Role fit"
            weight={SECTION_WEIGHTS.role_fit}
            headingLevel={headingLevel}
            notes={role_fit.notes}
            className="sm:col-span-2"
          >
            <Meter label="Fit score" value={role_fit.score} />
            <SurfaceCard level="sunken" className="space-y-2 p-3">
              <TagGroup
                label="Matched skills"
                srPrefix="Matched skill:"
                items={role_fit.matched_skills}
                tone="positive"
              />
              <TagGroup
                label="Gaps"
                srPrefix="Gap:"
                items={role_fit.gaps}
                tone="caution"
              />
              <TagGroup
                label="Red flags"
                srPrefix="Red flag:"
                items={role_fit.red_flags}
                tone="negative"
              />
            </SurfaceCard>
          </Group>
          )}
        </div>
      </SurfaceCard>

      {narrative === 'inline' && (
        <CandidateScorecardNarrative
          assessment={assessment}
          headingLevel={headingLevel}
        />
      )}
    </div>
  );
}

export interface CandidateScorecardRoleFitProps {
  assessment: Assessment;
  headingLevel?: HeadingLevel;
  className?: string;
}

/**
 * Role fit as a full-width horizontal row: fit-score meter on the left, the
 * three tag groups side by side, notes beneath. Rendered by hosts that pass
 * `roleFit="none"` to the scorecard.
 */
export function CandidateScorecardRoleFit({
  assessment,
  headingLevel = 3,
  className,
}: CandidateScorecardRoleFitProps) {
  const headingId = useId();
  const { role_fit } = assessment;
  return (
    <SurfaceCard as="section" labelledBy={headingId} className={cx('p-4 sm:p-5', className)}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <Heading level={headingLevel} id={headingId} className={CARD_TITLE}>
          Role fit
        </Heading>
        <span className="text-xs text-[var(--c-ink-secondary)]">
          Weight{' '}
          <span className="font-mono tabular-nums text-[var(--c-ink-secondary)]">
            {SECTION_WEIGHTS.role_fit}
          </span>
        </span>
      </div>
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <Meter label="Fit score" value={role_fit.score} />
        <SurfaceCard level="sunken" className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-3">
          <TagGroup
            label="Matched skills"
            srPrefix="Matched skill:"
            items={role_fit.matched_skills}
            tone="positive"
          />
          <TagGroup label="Gaps" srPrefix="Gap:" items={role_fit.gaps} tone="caution" />
          <TagGroup
            label="Red flags"
            srPrefix="Red flag:"
            items={role_fit.red_flags}
            tone="negative"
          />
        </SurfaceCard>
      </div>
      <Prose>{role_fit.notes}</Prose>
    </SurfaceCard>
  );
}

export interface CandidateScorecardNarrativeProps {
  assessment: Assessment;
  headingLevel?: HeadingLevel;
  className?: string;
  /** Render both blocks (default) or just one, so a host can place them apart. */
  parts?: 'both' | 'conflicts' | 'summary';
}

/**
 * Resume conflicts + Summary — the read-once half of the scorecard.
 *
 * Split out so a host can render it full width BENEATH a sticky scorecard
 * column: both are read once and neither needs to track the transcript, so
 * keeping them in the sticky column only made that column taller than the
 * viewport, which is what stops a sticky column sticking at all.
 *
 * Side by side when both exist, full width when only one does — so a
 * single block never sits in a half-empty row.
 */
export function CandidateScorecardNarrative({
  assessment,
  headingLevel = 3,
  className,
  parts = 'both',
}: CandidateScorecardNarrativeProps) {
  const uid = useId();
  const conflictsId = `${uid}-conflicts`;
  const summaryId = `${uid}-summary`;
  const raw = assessment.raw ?? {};
  const summary = parts === 'conflicts' ? '' : assessment.summary;
  const conflicts =
    parts === 'summary' ? [] : (assessment.resume_conflicts ?? raw.resume_conflicts ?? []);

  if (conflicts.length === 0 && !summary) return null;
  const both = conflicts.length > 0 && Boolean(summary);

  return (
    <div
      className={cx(
        'grid grid-cols-1 items-start gap-4',
        both && 'sm:grid-cols-2',
        className,
      )}
    >
      {conflicts.length > 0 && (
        <SurfaceCard as="section" labelledBy={conflictsId} className="p-4 sm:p-5">
          <Heading
            level={headingLevel}
            id={conflictsId}
            className={cx('mb-3 flex flex-wrap items-center gap-2', CARD_TITLE)}
          >
            Resume conflicts
            <Tag tone="caution" srPrefix="Count:">
              <span className="font-mono tabular-nums">{conflicts.length}</span>
            </Tag>
          </Heading>
          <ul className="space-y-3">
            {conflicts.map((c, i) => (
              <li key={i}>
                <SurfaceCard level="sunken" className="p-3">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[var(--c-ink)]">
                      {c.topic}
                    </span>
                    <Tag
                      tone={c.resolved ? 'positive' : 'caution'}
                      srPrefix="Status:"
                    >
                      {c.resolved ? 'resolved' : 'unresolved'}
                    </Tag>
                  </div>
                  <p
                    data-prose="true"
                    className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]"
                  >
                    <span className="font-medium">Resume:</span> {c.resume_says}
                  </p>
                  <p
                    data-prose="true"
                    className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]"
                  >
                    <span className="font-medium">Said on call:</span>{' '}
                    {c.candidate_said}
                  </p>
                  {c.note && <Prose>{c.note}</Prose>}
                </SurfaceCard>
              </li>
            ))}
          </ul>
        </SurfaceCard>
      )}

      {summary && (
        <SurfaceCard as="section" labelledBy={summaryId} className="p-4 sm:p-5">
          <Heading
            level={headingLevel}
            id={summaryId}
            className={cx('mb-1.5', CARD_TITLE)}
          >
            Summary
          </Heading>
          <p
            data-prose="true"
            className="max-w-prose text-sm leading-relaxed text-[var(--c-ink-secondary)]"
          >
            {summary}
          </p>
        </SurfaceCard>
      )}
    </div>
  );
}
