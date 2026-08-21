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
 * What changes is presentation, and only where the owner-supplied
 * screenshot showed a real defect:
 *
 *   - Four sections in a three-column grid left "Role fit" orphaned on a
 *     two-thirds-empty row. The layout is now explicit: Communication
 *     spans two rows beside the two short sections, Role fit takes the
 *     full width beneath. No breakpoint can orphan a cell.
 *   - Weights were baked into heading strings ("Communication - 50%"), so
 *     they read as titles and were not machine-readable. They are now data
 *     labels beside the heading.
 *   - Scores were 1.5px hairlines whose colour was the only signal. They
 *     are `Meter`s: number, band word, then colour (see design/Meter).
 *   - Notes were `text-xs` in a ~200px column — roughly a 22-character
 *     measure. Prose is now `text-sm leading-relaxed` at `max-w-prose`,
 *     full width within its section, and never in a narrow column.
 *   - Nested blocks repeated the parent's fill three levels deep. They are
 *     `SurfaceCard level="sunken"` inside a `base` card: exactly two
 *     levels, enforced by SurfaceCard's depth guard.
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

function Section({
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
    <SurfaceCard
      as="section"
      labelledBy={headingId}
      className={cx('p-4 sm:p-5', className)}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Heading
          level={headingLevel}
          id={headingId}
          className="text-sm font-semibold text-[var(--c-ink)]"
        >
          {title}
        </Heading>
        {weight && (
          <span className="text-xs text-[var(--c-ink-muted)]">
            Weight{' '}
            <span className="font-mono tabular-nums text-[var(--c-ink-secondary)]">
              {weight}
            </span>
          </span>
        )}
      </div>
      <div className="space-y-3">{children}</div>
      <Prose>{notes}</Prose>
    </SurfaceCard>
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
    <div>
      <p className="mb-1.5 text-xs font-medium text-[var(--c-ink-secondary)]">
        {label}
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--c-ink-muted)]">None</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
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

export interface CandidateScorecardProps {
  assessment: Assessment;
  /**
   * Heading level for the section titles, so the card slots into whatever
   * outline its host page already has without skipping a level.
   */
  headingLevel?: HeadingLevel;
}

export function CandidateScorecard({
  assessment,
  headingLevel = 3,
}: CandidateScorecardProps) {
  const uid = useId();
  const conflictsId = `${uid}-conflicts`;
  const summaryId = `${uid}-summary`;
  // Identical field + fallback chain to components/Scorecard.tsx.
  const raw = assessment.raw ?? {};
  const { tone, role_fit, overall_score, recommendation, summary } = assessment;
  const communication = assessment.communication ?? raw.communication;
  const english = communication?.english_proficiency ?? assessment.english;
  const motivation = assessment.motivation ?? raw.motivation;
  const conflicts = assessment.resume_conflicts ?? raw.resume_conflicts ?? [];

  const recoLabel = RECOMMENDATION_LABEL[recommendation] ?? RECOMMENDATION_LABEL.hold;
  const recoTone = RECOMMENDATION_TONE[recommendation] ?? RECOMMENDATION_TONE.hold;
  const roundedOverall = Math.round(overall_score);

  return (
    <div className="space-y-4">
      {/* ── Verdict band ─────────────────────────────────────────── */}
      <SurfaceCard as="section" label="Overall assessment" className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-2">
            <span
              className="font-mono text-4xl font-bold tabular-nums"
              style={{ color: OVERALL_FILL[overallTone(overall_score)] }}
            >
              {roundedOverall}
            </span>
            <span className="text-sm text-[var(--c-ink-muted)]">/ 100</span>
          </div>
          <Tag tone={recoTone} srPrefix="Recommendation:" className="px-3 py-1 text-sm">
            {recoLabel}
          </Tag>
        </div>

        <div className="mt-4">
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

        <div className="mt-4 border-t border-[var(--c-border-light)] pt-3">
          <p className="mb-1.5 text-xs font-medium text-[var(--c-ink-muted)]">
            Section weights
          </p>
          <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
            <WeightItem label="Communication" weight={SECTION_WEIGHTS.communication} />
            <WeightItem label="Motivation" weight={SECTION_WEIGHTS.motivation} />
            <WeightItem label="Tone" weight={SECTION_WEIGHTS.tone} />
            <WeightItem label="Role fit" weight={SECTION_WEIGHTS.role_fit} />
          </dl>
        </div>
      </SurfaceCard>

      {/* ── Sections ─────────────────────────────────────────────────
          Explicit placement, so no breakpoint can leave an orphan cell:
            <640px   one column
            ≥640px   two columns — Communication and Role fit full width
            ≥1024px  Communication spans both short sections' rows
          `items-start` keeps unrelated cards at their natural heights. */}
      <div
        data-scorecard-grid="true"
        className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-12"
      >
        <Section
          title="Communication"
          weight={SECTION_WEIGHTS.communication}
          headingLevel={headingLevel}
          notes={
            communication?.notes ??
            'No candidate responses are available to assess communication.'
          }
          className="sm:col-span-2 lg:col-span-7 lg:row-span-2"
        >
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
              <div className="space-y-2 sm:grid sm:grid-cols-2 sm:gap-3 sm:space-y-0">
                <Meter label="Grammar" value={english.grammar} />
                <Meter label="Vocabulary" value={english.vocabulary} />
                <Meter label="Fluency" value={english.fluency} />
                <Meter label="Coherence" value={english.coherence} />
              </div>
              <Prose>{english.notes}</Prose>
            </SurfaceCard>
          )}
          <SignalBlock label="Filler usage" signal={communication?.filler_usage} />
          <SignalBlock
            label="Native-language usage"
            signal={communication?.native_language_usage}
          />
        </Section>

        <Section
          title="Motivation"
          weight={SECTION_WEIGHTS.motivation}
          headingLevel={headingLevel}
          notes={
            motivation?.notes ??
            'No candidate responses are available to assess motivation.'
          }
          className="lg:col-span-5"
        >
          <Meter label="Score" value={motivation?.score ?? 0} />
        </Section>

        <Section
          title="Tone"
          weight={SECTION_WEIGHTS.tone}
          headingLevel={headingLevel}
          notes={tone.notes}
          className="lg:col-span-5"
        >
          <Meter label="Clarity" value={tone.clarity} />
          <Meter label="Confidence" value={tone.confidence} />
          <Meter label="Professionalism" value={tone.professionalism} />
          <LabelledRow label="Sentiment">
            <Tag srPrefix="Sentiment:">{tone.sentiment}</Tag>
          </LabelledRow>
        </Section>

        <Section
          title="Role fit"
          weight={SECTION_WEIGHTS.role_fit}
          headingLevel={headingLevel}
          notes={role_fit.notes}
          className="sm:col-span-2 lg:col-span-12"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Meter label="Fit score" value={role_fit.score} />
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
          </div>
        </Section>
      </div>

      {/* ── Resume conflicts ─────────────────────────────────────── */}
      {conflicts.length > 0 && (
        <SurfaceCard as="section" labelledBy={conflictsId} className="p-4 sm:p-5">
          <Heading
            level={headingLevel}
            id={conflictsId}
            className="mb-3 flex flex-wrap items-center gap-2 text-sm font-semibold text-[var(--c-ink)]"
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

      {/* ── Summary ──────────────────────────────────────────────── */}
      {summary && (
        <SurfaceCard as="section" labelledBy={summaryId} className="p-4 sm:p-5">
          <Heading
            level={headingLevel}
            id={summaryId}
            className="mb-1.5 text-sm font-semibold text-[var(--c-ink)]"
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

function WeightItem({ label, weight }: { label: string; weight: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <dt className="text-[var(--c-ink-secondary)]">{label}</dt>
      <dd className="font-mono tabular-nums text-[var(--c-ink)]">{weight}</dd>
    </div>
  );
}
