/**
 * Mission Control — Scorebar (the global scorecard metric LIBRARY).
 *
 * Admin-only CRUD of reusable metric templates. Each template carries a name, an
 * optional description, an INSTRUCTION (the LLM-direction prompt the scorer is
 * given for this metric) and a 1..4 RUBRIC (four short descriptors, Poor →
 * Excellent — the same four levels as Ashby's Score fields). Writes go only
 * through the audited scorecard API
 * (POST/PATCH/archive /api/scorecards/metrics); editing a template bumps its
 * version and never rewrites the immutable snapshots already copied into role
 * scorecards. Archiving soft-hides a template — existing role scorecards keep
 * working against their copies.
 */

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../../api';
import {
  SCORECARD_MAX_INSTRUCTION_LENGTH,
  SCORECARD_MAX_NAME_LENGTH,
  SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH,
  SCORE_LABELS,
} from '../../types';
import type { ScorecardMetricTemplate, ScoreValue } from '../../types';
import {
  Button,
  EmptyPanel,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  Pagination,
  RevealGroup,
  RevealItem,
  SectionHeader,
  TextArea,
  TextField,
  usePagination,
} from '../design';
import { ConfirmButton } from './ConfirmButton';
import { stableMutationMessage } from './statusMeta';

const SCORE_VALUES: ScoreValue[] = [1, 2, 3, 4];

type RubricDraft = Record<ScoreValue, string>;

interface MetricDraft {
  name: string;
  description: string;
  instruction: string;
  rubric: RubricDraft;
}

const EMPTY_RUBRIC: RubricDraft = { 1: '', 2: '', 3: '', 4: '' };
const EMPTY_DRAFT: MetricDraft = {
  name: '',
  description: '',
  instruction: '',
  rubric: { ...EMPTY_RUBRIC },
};

function draftFromMetric(metric: ScorecardMetricTemplate): MetricDraft {
  return {
    name: metric.name,
    description: metric.description ?? '',
    instruction: metric.default_instruction,
    rubric: {
      1: metric.rubric?.[1] ?? '',
      2: metric.rubric?.[2] ?? '',
      3: metric.rubric?.[3] ?? '',
      4: metric.rubric?.[4] ?? '',
    },
  };
}

/** Client-side pre-flight; the API + DB remain the authority on the invariants. */
function draftIssue(draft: MetricDraft): string | null {
  if (!draft.name.trim()) return 'A metric name is required.';
  if (draft.name.trim().length > SCORECARD_MAX_NAME_LENGTH) {
    return `The name must be at most ${SCORECARD_MAX_NAME_LENGTH} characters.`;
  }
  if (draft.description.trim().length > SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH) {
    return `The description must be at most ${SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH} characters.`;
  }
  if (!draft.instruction.trim()) return 'A scoring instruction is required.';
  if (draft.instruction.trim().length > SCORECARD_MAX_INSTRUCTION_LENGTH) {
    return `The instruction must be at most ${SCORECARD_MAX_INSTRUCTION_LENGTH} characters.`;
  }
  for (const level of SCORE_VALUES) {
    const text = draft.rubric[level].trim();
    if (!text) return `Rubric level ${level} (${SCORE_LABELS[level]}) is required.`;
    if (text.length > SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH) {
      return `Rubric level ${level} must be at most ${SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH} characters.`;
    }
  }
  return null;
}

function draftToBody(draft: MetricDraft) {
  return {
    name: draft.name.trim(),
    description: draft.description.trim() ? draft.description.trim() : null,
    default_instruction: draft.instruction.trim(),
    rubric: {
      1: draft.rubric[1].trim(),
      2: draft.rubric[2].trim(),
      3: draft.rubric[3].trim(),
      4: draft.rubric[4].trim(),
    } as RubricDraft,
  };
}

export function ScorebarSection() {
  const [metrics, setMetrics] = useState<ScorecardMetricTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState<MetricDraft>(EMPTY_DRAFT);
  const [createIssue, setCreateIssue] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<MetricDraft>(EMPTY_DRAFT);
  const [editIssue, setEditIssue] = useState<string | null>(null);

  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setMetrics(null);
    api
      .listScorecardMetrics()
      .then((rows) => setMetrics(rows))
      .catch((e: ApiError) => setLoadError(e.message));
  }, []);

  useEffect(load, [load]);

  const page = usePagination(metrics ?? [], 10);

  if (loadError && !metrics) {
    return <ErrorPanel message={loadError} onRetry={load} />;
  }
  if (!metrics) {
    return <LoadingPanel label="Loading scorecard metrics…" />;
  }

  function setDraftField<K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }
  function setDraftRubric(level: ScoreValue, value: string) {
    setDraft((prev) => ({ ...prev, rubric: { ...prev.rubric, [level]: value } }));
  }
  function setEditField<K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) {
    setEditDraft((prev) => ({ ...prev, [key]: value }));
  }
  function setEditRubric(level: ScoreValue, value: string) {
    setEditDraft((prev) => ({ ...prev, rubric: { ...prev.rubric, [level]: value } }));
  }

  async function createMetric() {
    const issue = draftIssue(draft);
    setCreateIssue(issue);
    if (issue) return;
    setMessage(null);
    try {
      const created = await api.createScorecardMetric(draftToBody(draft));
      setDraft({ name: '', description: '', instruction: '', rubric: { ...EMPTY_RUBRIC } });
      setMessage({ text: `Metric “${created.name}” created.`, tone: 'ok' });
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to create the metric.',
        ),
        tone: 'error',
      });
    }
  }

  function startEdit(metric: ScorecardMetricTemplate) {
    setEditId(metric.id);
    setEditIssue(null);
    setEditDraft(draftFromMetric(metric));
  }

  async function saveEdit(metric: ScorecardMetricTemplate) {
    const issue = draftIssue(editDraft);
    setEditIssue(issue);
    if (issue) return;
    setMessage(null);
    try {
      await api.updateScorecardMetric(metric.id, draftToBody(editDraft));
      setEditId(null);
      setMessage({ text: `Metric “${editDraft.name.trim()}” updated.`, tone: 'ok' });
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to update the metric.',
        ),
        tone: 'error',
      });
    }
  }

  async function archiveMetric(metric: ScorecardMetricTemplate) {
    setMessage(null);
    try {
      await api.archiveScorecardMetric(metric.id);
      if (editId === metric.id) setEditId(null);
      setMessage({ text: `Metric “${metric.name}” archived.`, tone: 'ok' });
      await load();
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to archive the metric.',
        ),
        tone: 'error',
      });
    }
  }

  return (
    <div className="space-y-5">
      <SectionHeader
        title="Scorecard metrics"
        description="The reusable metric library. Each metric carries a scoring instruction and a 1–4 rubric (Poor, Average, Good, Excellent — matching Ashby's four-point Score fields); roles attach these and set per-role weights. Editing a metric bumps its version and never rewrites the copies already inside role scorecards."
        meta={
          <span className="text-[13px] tabular-nums text-ink-tertiary">
            {metrics.length} metric{metrics.length === 1 ? '' : 's'}
          </span>
        }
        actions={
          <Button size="sm" onClick={load}>
            Refresh
          </Button>
        }
      />

      {message && (
        <InlineNotice tone={message.tone === 'ok' ? 'success' : 'danger'} role="status">
          {message.text}
        </InlineNotice>
      )}

      {metrics.length === 0 ? (
        <EmptyPanel
          title="No scorecard metrics yet"
          hint="Add a metric below to start building the library roles can score against."
        />
      ) : (
        <div>
          <RevealGroup className="space-y-3">
            {page.items.map((metric) => (
              <RevealItem key={metric.id}>
                <GlassPanel padding="sm" data-metric-row={metric.id}>
                  <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{metric.name}</p>
                      <p className="font-mono text-xs text-ink-tertiary">
                        {metric.key} · v{metric.version}
                      </p>
                      {metric.description && (
                        <p className="mt-1 max-w-prose text-[13px] leading-5 text-ink-secondary">
                          {metric.description}
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap items-start gap-2">
                      {editId === metric.id ? (
                        <Button size="sm" variant="secondary" onClick={() => setEditId(null)}>
                          Cancel edit
                        </Button>
                      ) : (
                        <Button size="sm" onClick={() => startEdit(metric)}>
                          Edit
                        </Button>
                      )}
                      <ConfirmButton
                        label="Archive"
                        variant="danger"
                        confirmLabel="Confirm archive"
                        summary={
                          <span>
                            Archive <strong>{metric.name}</strong>? It will no longer be
                            attachable, but role scorecards already using it keep their
                            immutable copy.
                          </span>
                        }
                        onConfirm={() => archiveMetric(metric)}
                      />
                    </div>
                  </div>

                  {editId !== metric.id && (
                    <div className="mt-3 space-y-2">
                      <p className="text-xs font-medium uppercase tracking-wide text-ink-tertiary">
                        Instruction
                      </p>
                      <p className="max-w-prose text-[13px] leading-5 text-ink-secondary">
                        {metric.default_instruction}
                      </p>
                      <dl className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {SCORE_VALUES.map((level) => (
                          <div key={level} className="flex gap-2 text-xs">
                            <dt className="shrink-0 font-medium text-ink-secondary">
                              {level} · {SCORE_LABELS[level]}
                            </dt>
                            <dd className="min-w-0 text-ink-tertiary">{metric.rubric?.[level]}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  )}

                  {editId === metric.id && (
                    <MetricFields
                      idPrefix={`edit-${metric.id}`}
                      draft={editDraft}
                      onField={setEditField}
                      onRubric={setEditRubric}
                      issue={editIssue}
                      footer={
                        <ConfirmButton
                          label="Save changes"
                          variant="primary"
                          confirmLabel="Confirm update"
                          summary={
                            <span>
                              Update <strong>{metric.name}</strong> (a new version)?
                            </span>
                          }
                          onConfirm={() => saveEdit(metric)}
                        />
                      }
                    />
                  )}
                </GlassPanel>
              </RevealItem>
            ))}
          </RevealGroup>
          <Pagination state={page} noun="metrics" />
        </div>
      )}

      {/* Create */}
      <GlassPanel>
        <SectionHeader
          level={3}
          title="Add a metric"
          description="Name the metric, describe it, give the scorer an instruction, and fill all four rubric levels."
        />
        <div className="mt-4">
          <MetricFields
            idPrefix="new-metric"
            draft={draft}
            onField={setDraftField}
            onRubric={setDraftRubric}
            issue={createIssue}
            footer={
              <Button variant="primary" onClick={createMetric}>
                Create metric
              </Button>
            }
          />
        </div>
      </GlassPanel>
    </div>
  );
}

function MetricFields({
  idPrefix,
  draft,
  onField,
  onRubric,
  issue,
  footer,
}: {
  idPrefix: string;
  draft: MetricDraft;
  onField: <K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) => void;
  onRubric: (level: ScoreValue, value: string) => void;
  issue: string | null;
  footer: React.ReactNode;
}) {
  return (
    <div className="glass-sunken space-y-4 rounded-[14px] p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Name" id={`${idPrefix}-name`}>
          {({ id }) => (
            <TextField
              id={id}
              value={draft.name}
              maxLength={SCORECARD_MAX_NAME_LENGTH}
              onChange={(e) => onField('name', e.target.value)}
              placeholder="e.g. Technical depth"
            />
          )}
        </Field>
        <Field label="Description" id={`${idPrefix}-description`} hint="Optional — a short note for recruiters.">
          {({ id, describedBy }) => (
            <TextField
              id={id}
              aria-describedby={describedBy}
              value={draft.description}
              maxLength={SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH}
              onChange={(e) => onField('description', e.target.value)}
              placeholder="What this metric measures"
            />
          )}
        </Field>
      </div>

      <Field
        label="Scoring instruction"
        id={`${idPrefix}-instruction`}
        hint="The direction given to the scoring model for this metric."
      >
        {({ id, describedBy }) => (
          <TextArea
            id={id}
            aria-describedby={describedBy}
            value={draft.instruction}
            maxLength={SCORECARD_MAX_INSTRUCTION_LENGTH}
            rows={3}
            onChange={(e) => onField('instruction', e.target.value)}
            placeholder="Assess how deeply the candidate understands…"
          />
        )}
      </Field>

      <fieldset className="space-y-3">
        <legend className="text-[13px] font-medium text-ink-secondary">
          Rubric — 1 (Poor) to 4 (Excellent)
        </legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {SCORE_VALUES.map((level) => (
            <Field key={level} label={`${level} · ${SCORE_LABELS[level]}`} id={`${idPrefix}-rubric-${level}`}>
              {({ id }) => (
                <TextField
                  id={id}
                  value={draft.rubric[level]}
                  maxLength={SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH}
                  onChange={(e) => onRubric(level, e.target.value)}
                  placeholder={`What a ${SCORE_LABELS[level].toLowerCase()} answer looks like`}
                />
              )}
            </Field>
          ))}
        </div>
      </fieldset>

      {issue && (
        <InlineNotice tone="danger" role="alert">
          {issue}
        </InlineNotice>
      )}

      <div>{footer}</div>
    </div>
  );
}
