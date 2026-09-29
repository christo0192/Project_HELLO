/**
 * Scorecard — a screening's assessment on the session and screening pages.
 *
 * Two generations of assessment reach these pages, and this component picks:
 *
 *   - schema v2 (role scorecards) → `RoleScorecardView`. A v2 row carries NO
 *     legacy dimension fields on the wire; reading `tone.notes` off one used
 *     to throw and take the whole route into the error boundary.
 *   - legacy v1 (fixed dimensions: communication, motivation, tone, role
 *     fit) → rendered here.
 *
 * Every read below is defensive: a block that is missing or malformed is
 * left out (or says why), never thrown on, and a missing number is never
 * drawn as zero. Machine values (`positive`, `moderate`) are humanized.
 *
 * LAYOUT. No surface of its own: the host page's panel is the surface
 * (design rule 1, no glass in glass). The verdict comes first; the four
 * dimensions follow as one list separated by hairlines, each with its fixed
 * weight as a data label, not baked into the heading text. Communication's
 * sub-parts (English, speech signals) sit in one sunken grid under it, so
 * they read as part of that dimension rather than as dimensions of their
 * own. Bars fill in the accent for every reading: several of them (filler
 * "impact") are better when LOW, so a red/amber/green fill keyed to the
 * value painted a good result as an alarm. The number is the reading.
 *
 * `layout="split"` is for a full-width host (the screening console): from
 * `lg` up each dimension puts its heading in a left column and its readings
 * in a right one, instead of stretching one column across ~1100px.
 */

import type { ReactNode } from 'react';
import { isAssessmentV2 } from '../types';
import type { Assessment } from '../types';
import { humanizeEnum } from '../lib/humanize';
import { cx, StatusBadge } from './design';
import type { StatusTone } from './design';
import { RoleScorecardView } from './session/RoleScorecardView';
import { ScoreVerdict } from './session/ScoreVerdict';
import { finiteNumber, isRecord } from './session/scorecard-read';
import type { ScorecardLayout } from './session/scorecard-read';

type Loose = Record<string, unknown>;

/** The block itself, else the same block from `raw`, else null. */
function block(primary: unknown, fallback: unknown): Loose | null {
  if (isRecord(primary)) return primary;
  return isRecord(fallback) ? fallback : null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

/** Fixed weights of the legacy rubric, shown as data labels. */
const WEIGHT = {
  communication: '50%',
  motivation: '20%',
  tone: '10%',
  role_fit: '20%',
} as const;

const SIGNAL_TONE: Record<string, StatusTone> = {
  none: 'success',
  low: 'success',
  moderate: 'warning',
  high: 'danger',
};

/** A 0–10 reading with its bar. Renders nothing when there is no number to show. */
function ScoreBar({ label, value }: { label: string; value: unknown }) {
  const n = finiteNumber(value);
  if (n == null) return null;
  const safe = Math.max(0, Math.min(10, n));
  const shown = Math.round(safe * 10) / 10;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[13px] leading-5">
        <span className="text-ink-secondary">{label}</span>
        <span className="font-semibold tabular-nums text-ink">{`${shown}/10`}</span>
      </div>
      <div aria-hidden="true" className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink/[0.07]">
        <div className="h-full rounded-full bg-info" style={{ width: `${safe * 10}%` }} />
      </div>
    </div>
  );
}

/** Readings two to a row, so every bar is the same length wherever it appears. */
function Bars({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">{children}</div>;
}

function Prose({ children }: { children: string }) {
  if (!children) return null;
  return <p className="max-w-prose text-sm leading-6 text-ink-secondary">{children}</p>;
}

/** One dimension: heading + weight, then its readings. */
function Dimension({
  title,
  weight,
  split,
  children,
}: {
  title: string;
  weight?: string;
  split: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        'py-5 last:pb-0',
        split && 'lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-x-10',
      )}
    >
      <div
        className={cx(
          'flex items-baseline justify-between gap-3',
          split && 'lg:flex-col lg:items-start lg:justify-start lg:gap-0.5',
        )}
      >
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {weight && <span className="text-xs tabular-nums text-ink-tertiary">{`Weight ${weight}`}</span>}
      </div>
      <div className={cx('mt-3 space-y-4', split && 'lg:mt-0')}>{children}</div>
    </div>
  );
}

/** A sub-part of a dimension (English, a speech signal): a small heading over its readings. */
function Part({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="mb-2.5 flex items-center justify-between gap-3">
        <h4 className="text-[13px] font-semibold text-ink">{title}</h4>
        {aside}
      </div>
      <div className="space-y-3">{children}</div>
    </>
  );
}

interface PartCell {
  key: string;
  /** Spans both columns (English carries four readings). */
  wide: boolean;
  node: ReactNode;
}

/**
 * The sub-parts as ONE sunken object divided by hairlines (`gap-px` over a
 * faint ink ground, the Scorebar rubric's construction), never floating
 * cards. A lone half-width cell spans the row so no empty ground shows.
 */
function PartGrid({ cells }: { cells: PartCell[] }) {
  if (cells.length === 0) return null;
  const halves = cells.filter((c) => !c.wide);
  const stretch = halves.length % 2 === 1 ? halves[halves.length - 1].key : null;
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-[14px] bg-ink/[0.07] sm:grid-cols-2">
      {cells.map((c) => (
        <div
          key={c.key}
          className={cx('bg-white/70 px-4 py-3.5', (c.wide || c.key === stretch) && 'sm:col-span-2')}
        >
          {c.node}
        </div>
      ))}
    </div>
  );
}

function ChipGroup({ label, items, tone }: { label: string; items: string[]; tone: StatusTone }) {
  return (
    <div>
      <p className="mb-1.5 text-[13px] font-medium text-ink-secondary">{label}</p>
      {items.length === 0 ? (
        <p className="text-[13px] text-ink-tertiary">None</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {items.map((item, i) => (
            <StatusBadge dot={false} key={`${i}-${item}`} tone={tone}>
              {item}
            </StatusBadge>
          ))}
        </div>
      )}
    </div>
  );
}

function signalCell(key: string, label: string, signal: unknown): PartCell | null {
  if (!isRecord(signal)) return null;
  const level = text(signal.level);
  const examples = strings(signal.examples);
  const notes = text(signal.notes);
  return {
    key,
    wide: false,
    node: (
      <Part
        title={label}
        aside={
          level ? (
            <StatusBadge dot={false} tone={SIGNAL_TONE[level] ?? 'neutral'}>
              {humanizeEnum(level)}
            </StatusBadge>
          ) : null
        }
      >
        <ScoreBar label="Impact" value={signal.impact_score} />
        {examples.length > 0 && (
          <p className="text-[13px] leading-5 text-ink-secondary">
            <span className="font-medium text-ink">Examples:</span> {examples.join(', ')}
          </p>
        )}
        {notes && <p className="max-w-prose text-[13px] leading-5 text-ink-tertiary">{notes}</p>}
      </Part>
    ),
  };
}

function LegacyScorecard({ assessment, layout }: { assessment: Assessment; layout: ScorecardLayout }) {
  const split = layout === 'split';
  const row = assessment as unknown as Loose;
  const raw = isRecord(row.raw) ? row.raw : {};

  const communication = block(row.communication, raw.communication);
  const english = block(communication?.english_proficiency, row.english);
  const motivation = block(row.motivation, raw.motivation);
  const tone = block(row.tone, raw.tone);
  const roleFit = block(row.role_fit, raw.role_fit);
  const conflictsSource = Array.isArray(row.resume_conflicts)
    ? row.resume_conflicts
    : Array.isArray(raw.resume_conflicts)
      ? raw.resume_conflicts
      : [];
  const conflicts = conflictsSource.filter(isRecord);

  const sentiment = text(tone?.sentiment);
  const band = text(english?.band);
  const hasDimension = Boolean(communication || motivation || tone || roleFit);

  const parts = [
    english
      ? {
          key: 'english',
          wide: true,
          node: (
            <Part
              title="English band"
              aside={
                band ? (
                  <StatusBadge dot={false} tone="info">
                    {band}
                  </StatusBadge>
                ) : null
              }
            >
              <Bars>
                <ScoreBar label="Grammar" value={english.grammar} />
                <ScoreBar label="Vocabulary" value={english.vocabulary} />
                <ScoreBar label="Fluency" value={english.fluency} />
                <ScoreBar label="Coherence" value={english.coherence} />
              </Bars>
              {text(english.notes) && (
                <p className="max-w-prose text-[13px] leading-5 text-ink-tertiary">{text(english.notes)}</p>
              )}
            </Part>
          ),
        }
      : null,
    signalCell('filler', 'Filler usage', communication?.filler_usage),
    signalCell('native', 'Native-language usage', communication?.native_language_usage),
  ].filter((cell): cell is PartCell => cell !== null);

  return (
    <div>
      <ScoreVerdict overall={row.overall_score} recommendation={row.recommendation} summary={row.summary} />

      <div className="mt-6 divide-y divide-glass-ring border-t border-glass-ring">
        {hasDimension && (
          <Dimension title="Communication" weight={WEIGHT.communication} split={split}>
            {communication ? (
              <>
                <Bars>
                  <ScoreBar label="Score" value={communication.score} />
                  <ScoreBar label="Clarity" value={communication.clarity} />
                  <ScoreBar label="Structure" value={communication.structure} />
                  <ScoreBar label="Listening" value={communication.listening} />
                  <ScoreBar label="Rapport" value={communication.rapport} />
                </Bars>
                <Prose>{text(communication.notes)}</Prose>
              </>
            ) : (
              <Prose>No candidate responses are available to assess communication.</Prose>
            )}
            <PartGrid cells={parts} />
          </Dimension>
        )}

        {hasDimension && (
          <Dimension title="Motivation" weight={WEIGHT.motivation} split={split}>
            {motivation && finiteNumber(motivation.score) != null && (
              <Bars>
                <ScoreBar label="Score" value={motivation.score} />
              </Bars>
            )}
            <Prose>
              {text(motivation?.notes) || 'No candidate responses are available to assess motivation.'}
            </Prose>
          </Dimension>
        )}

        {tone && (
          <Dimension title="Tone" weight={WEIGHT.tone} split={split}>
            <Bars>
              <ScoreBar label="Clarity" value={tone.clarity} />
              <ScoreBar label="Confidence" value={tone.confidence} />
              <ScoreBar label="Professionalism" value={tone.professionalism} />
            </Bars>
            {sentiment && (
              <div className="flex items-center gap-3 text-[13px]">
                <span className="text-ink-secondary">Sentiment</span>
                <StatusBadge dot={false}>{humanizeEnum(sentiment)}</StatusBadge>
              </div>
            )}
            <Prose>{text(tone.notes)}</Prose>
          </Dimension>
        )}

        {roleFit && (
          <Dimension title="Role fit" weight={WEIGHT.role_fit} split={split}>
            {finiteNumber(roleFit.score) != null && (
              <Bars>
                <ScoreBar label="Fit score" value={roleFit.score} />
              </Bars>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <ChipGroup label="Matched skills" items={strings(roleFit.matched_skills)} tone="success" />
              <ChipGroup label="Gaps" items={strings(roleFit.gaps)} tone="warning" />
              <ChipGroup label="Red flags" items={strings(roleFit.red_flags)} tone="danger" />
            </div>
            <Prose>{text(roleFit.notes)}</Prose>
          </Dimension>
        )}

        {!hasDimension && (
          <p className="py-5 text-sm text-ink-secondary">This assessment carries no dimension scores.</p>
        )}

        {conflicts.length > 0 && (
          <div
            className={cx(
              'py-5 last:pb-0',
              split && 'lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-x-10',
            )}
          >
            <div className="flex items-center gap-2 self-start">
              <h3 className="text-sm font-semibold text-ink">Resume conflicts</h3>
              <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs font-medium tabular-nums text-warning-text">
                {conflicts.length}
              </span>
            </div>
            <ul className={cx('mt-2 divide-y divide-glass-ring', split && 'lg:mt-0')}>
              {conflicts.map((c, i) => {
                const resolved = c.resolved === true;
                const note = text(c.note);
                return (
                  <li key={i} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-[13px] font-semibold text-ink">{text(c.topic) || 'Conflict'}</p>
                      <StatusBadge tone={resolved ? 'success' : 'warning'}>
                        {resolved ? 'Resolved' : 'Unresolved'}
                      </StatusBadge>
                    </div>
                    <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px] leading-5">
                      <dt className="text-ink-tertiary">Resume:</dt>
                      <dd className="text-ink-secondary">{text(c.resume_says) || 'Not stated'}</dd>
                      <dt className="text-ink-tertiary">Said on call:</dt>
                      <dd className="text-ink-secondary">{text(c.candidate_said) || 'Not stated'}</dd>
                    </dl>
                    {note && <p className="mt-1.5 max-w-prose text-[13px] leading-5 text-ink-tertiary">{note}</p>}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export interface ScorecardProps {
  assessment: Assessment;
  /** `split` for a full-width host: heading column + readings column from `lg` up. */
  layout?: ScorecardLayout;
}

export function Scorecard({ assessment, layout = 'stacked' }: ScorecardProps) {
  if (!isRecord(assessment)) {
    return <p className="text-sm text-ink-secondary">This scorecard could not be read.</p>;
  }
  if (isAssessmentV2(assessment)) return <RoleScorecardView assessment={assessment} layout={layout} />;
  return <LegacyScorecard assessment={assessment} layout={layout} />;
}
