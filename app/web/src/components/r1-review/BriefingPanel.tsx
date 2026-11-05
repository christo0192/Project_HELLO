/**
 * Briefing: what the candidate was told, what they were scored on, and how the interview runs.
 *
 * The scenario is the candidate's own card (`r1-scenario.ts`), and the rubric comes from the API, so
 * neither can drift from what was shown or scored.
 *
 * The learner section names her and says which persona she was. Her held-back needs and objection
 * plan are not here: they exist only in the worker (`r1_personas.py`), and they are what the
 * candidate is assessed on finding out.
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import { R1_SCENARIO_COPY } from '../candidate-r1/r1-scenario';
import { formatWeightPercent } from '../../lib/scorecard-weights';
import { learnerLabel } from '../../lib/r1-review';
import type { R1ReviewAttempt, R1ReviewRubricMetric } from '../../lib/r1-types';
import { scoreLabel } from '../../types';

function Block({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="border-b border-line pb-2 text-section text-ink">
        {title}
      </h2>
      {children}
    </section>
  );
}

const PHASES: ReadonlyArray<{ name: string; detail: string }> = [
  { name: 'Opening', detail: 'Christy (AI interviewer) introduces the interview.' },
  { name: 'Icebreaker', detail: 'A short conversation about the candidate, over by 4:30 into the interview.' },
  { name: 'Transition', detail: 'Christy sets up the role-play and takes questions. It starts only when the candidate is ready.' },
  { name: 'Role-play', detail: 'The candidate is the Program Advisor; the AI learner is the prospective student. It runs up to 20:00 on its own clock, which stops during an aside. From 14:00 Christy may offer to wrap up.' },
  { name: 'Wrap-up', detail: 'Christy asks whether the candidate has questions about the role or the next steps.' },
  { name: 'Closing', detail: 'Christy closes the interview.' },
];

export interface BriefingPanelProps {
  rubric: readonly R1ReviewRubricMetric[];
  attempt: R1ReviewAttempt | null;
}

export function BriefingPanel({ rubric, attempt }: BriefingPanelProps) {
  const copy = R1_SCENARIO_COPY;
  return (
    <div className="grid gap-x-8 gap-y-6 lg:grid-cols-[21rem_minmax(0,1fr)]">
      <div className="min-w-0 space-y-6">
        <Block title="What the candidate saw">
          <div className="space-y-3 pt-3 text-sm text-ink-secondary">
            <p>{copy.intro}</p>
            <dl className="divide-y divide-line">
              {[
                [copy.priceLabel, copy.price],
                [copy.durationLabel, copy.duration],
                [copy.discountsLabel, copy.discounts],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 py-1.5">
                  <dt className="form-label">{label}</dt>
                  <dd className="text-right text-ink">{value}</dd>
                </div>
              ))}
            </dl>
            <p>{copy.goal}</p>
            <p>{copy.inCharacter}</p>
          </div>
        </Block>

        {attempt && (
          <Block title="The AI learner">
            <p className="pt-3 text-sm text-ink">{learnerLabel(attempt.learner_name)}</p>
            {attempt.persona_label && <p className="text-sm text-ink-secondary">{attempt.persona_label}</p>}
          </Block>
        )}

        <Block title="How the interview runs">
          <ol className="divide-y divide-line">
            {PHASES.map((phase) => (
              <li key={phase.name} className="py-2 text-sm">
                <p className="font-medium text-ink">{phase.name}</p>
                <p className="text-ink-secondary">{phase.detail}</p>
              </li>
            ))}
          </ol>
        </Block>
      </div>

      <Block title="Rubric">
        <ul className="divide-y divide-line">
          {rubric.map((metric) => (
            <li key={metric.key} className="py-3">
              <p>
                <span className="text-sm font-semibold text-ink">{metric.name}</span>
                <span className="ml-2 text-meta tabular-nums text-ink-tertiary">{formatWeightPercent(metric.weight_bps)}</span>
              </p>
              <dl className="mt-1 space-y-1">
                {[1, 2, 3, 4].map((level) => (
                  <div key={level} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 text-sm">
                    <dt className="form-label pt-0.5">{scoreLabel(level, 4)}, {level}/4</dt>
                    <dd className="text-ink-secondary">{metric.levels[String(level)]}</dd>
                  </div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      </Block>
    </div>
  );
}
