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
 *
 * LAYOUT. This renders inside the Roles page's SlideOver, which is already a
 * surface — so no card-in-card here (design system rule 1). The library is ONE
 * list: each metric a row that opens to its instruction and rubric, so eight
 * metrics read as eight names, not eight walls of text. Creating a metric is
 * an explicit act ("New metric"), and the form's rubric is laid out in the
 * same shape as the rubric it produces (`RubricScale`).
 *
 * FOCUS. Every action puts focus somewhere deliberate (the field being
 * edited, the row acted on, the next row, "New metric") and a reload keeps
 * the list mounted instead of swapping it for a loader — a keyboard or
 * screen-reader user never lands on `<body>` or loses their place.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  InlineNotice,
  LoadingPanel,
  Pagination,
  controlClass,
  cx,
  usePagination,
} from '../design';
import { ConfirmButton } from './ConfirmButton';
import { MetricAskHello } from './MetricAskHello';
import { LevelHeading, RubricScale } from './RubricScale';
import { RUBRIC_LEVELS } from './rubric';
import { stableMutationMessage } from './statusMeta';

type RubricDraft = Record<ScoreValue, string>;

interface MetricDraft {
  name: string;
  description: string;
  instruction: string;
  rubric: RubricDraft;
}

/** Which input a validation problem belongs to — its message renders there. */
type DraftField = 'name' | 'description' | 'instruction' | `rubric-${ScoreValue}`;

interface DraftIssue {
  field: DraftField;
  message: string;
}

const PAGE_SIZE = 10;
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

/**
 * Client-side pre-flight; the API + DB remain the authority on the invariants.
 * EVERY problem at once, in form order — one-at-a-time made an empty form
 * take seven submits to clear.
 */
function draftIssues(draft: MetricDraft): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const name = draft.name.trim();
  if (!name) issues.push({ field: 'name', message: 'A metric name is required.' });
  else if (name.length > SCORECARD_MAX_NAME_LENGTH) {
    issues.push({ field: 'name', message: `The name must be at most ${SCORECARD_MAX_NAME_LENGTH} characters.` });
  }
  if (draft.description.trim().length > SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH) {
    issues.push({
      field: 'description',
      message: `The description must be at most ${SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH} characters.`,
    });
  }
  const instruction = draft.instruction.trim();
  if (!instruction) issues.push({ field: 'instruction', message: 'A scoring instruction is required.' });
  else if (instruction.length > SCORECARD_MAX_INSTRUCTION_LENGTH) {
    issues.push({
      field: 'instruction',
      message: `The instruction must be at most ${SCORECARD_MAX_INSTRUCTION_LENGTH} characters.`,
    });
  }
  for (const level of RUBRIC_LEVELS) {
    const text = draft.rubric[level].trim();
    if (!text) {
      issues.push({ field: `rubric-${level}`, message: `Rubric level ${level} (${SCORE_LABELS[level]}) is required.` });
    } else if (text.length > SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH) {
      issues.push({
        field: `rubric-${level}`,
        message: `Rubric level ${level} must be at most ${SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH} characters.`,
      });
    }
  }
  return issues;
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

/** The disclosure button of a metric's row — where focus returns after acting on it. */
function rowHeader(metricId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-metric-row="${CSS.escape(metricId)}"] [data-metric-header]`);
}

export function ScorebarSection() {
  const [metrics, setMetrics] = useState<ScorecardMetricTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<MetricDraft>(EMPTY_DRAFT);
  const [createIssues, setCreateIssues] = useState<DraftIssue[]>([]);
  const [creating, setCreating] = useState(false);
  const [createdCount, setCreatedCount] = useState(0); // resets Ask Hello's status with the form

  /** The one metric whose details are open. Editing implies open. */
  const [openId, setOpenId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<MetricDraft>(EMPTY_DRAFT);
  const [editIssues, setEditIssues] = useState<DraftIssue[]>([]);
  const [saving, setSaving] = useState(false);

  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);

  const newMetricButton = useRef<HTMLButtonElement | null>(null);
  /**
   * Where focus should land once the next render commits: an element id, a
   * metric row, or the "New metric" button. Set by the action, applied by the
   * effect below — the target often does not exist until after the re-render.
   */
  const pendingFocus = useRef<{ kind: 'id'; id: string } | { kind: 'row'; metricId: string } | { kind: 'new' } | null>(
    null,
  );

  /**
   * Read the library. The FIRST read shows the loader; every later one keeps
   * the list on screen (marked busy), so a reload never unmounts the control
   * that has focus or scrolls the drawer back to the top.
   */
  const load = useCallback(async (initial = false) => {
    setLoadError(null);
    if (!initial) setRefreshing(true);
    try {
      const rows = await api.listScorecardMetrics();
      setMetrics(rows);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Failed to load scorecard metrics.');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(true);
  }, [load]);

  const page = usePagination(metrics ?? [], PAGE_SIZE);

  // Apply a pending focus move after the render that created its target.
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    const el =
      target.kind === 'id'
        ? document.getElementById(target.id)
        : target.kind === 'row'
          ? rowHeader(target.metricId)
          : newMetricButton.current;
    if (!el) return;
    pendingFocus.current = null;
    el.focus();
  });

  if (loadError && !metrics) {
    return <ErrorPanel message={loadError} onRetry={() => void load(true)} />;
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
  /** Ask Hello's draft fills the create form; nothing is saved. */
  function applyHelloDraft(instruction: string, rubric: RubricDraft) {
    setDraft((prev) => ({ ...prev, instruction, rubric: { ...rubric } }));
    setCreateIssues([]);
  }
  function setEditField<K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) {
    setEditDraft((prev) => ({ ...prev, [key]: value }));
  }
  function setEditRubric(level: ScoreValue, value: string) {
    setEditDraft((prev) => ({ ...prev, rubric: { ...prev.rubric, [level]: value } }));
  }

  function openCreate() {
    setCreateOpen(true);
    setMessage(null);
    pendingFocus.current = { kind: 'id', id: 'new-metric-name' };
  }
  function closeCreate() {
    setCreateOpen(false);
    setCreateIssues([]);
    pendingFocus.current = { kind: 'new' };
  }

  async function createMetric() {
    const issues = draftIssues(draft);
    setCreateIssues(issues);
    if (issues.length > 0) {
      document.getElementById(`new-metric-${issues[0].field}`)?.focus();
      return;
    }
    setMessage(null);
    setCreating(true);
    try {
      const created = await api.createScorecardMetric(draftToBody(draft));
      setDraft({ name: '', description: '', instruction: '', rubric: { ...EMPTY_RUBRIC } });
      setCreatedCount((n) => n + 1);
      setCreateOpen(false);
      setMessage({ text: `Metric “${created.name}” created.`, tone: 'ok' });
      await load();
      // Land on the new metric's row — proof it exists, and the natural next
      // step (open it, check it) is one key away.
      pendingFocus.current = { kind: 'row', metricId: created.id };
      setOpenId(created.id);
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to create the metric.',
        ),
        tone: 'error',
      });
      // The button disabled itself for the request, which dropped focus to
      // <body>; put it back on the button so "try again" is one key away.
      pendingFocus.current = { kind: 'id', id: 'new-metric-submit' };
    } finally {
      setCreating(false);
    }
  }

  function startEdit(metric: ScorecardMetricTemplate) {
    setOpenId(metric.id);
    setEditId(metric.id);
    setEditIssues([]);
    setEditDraft(draftFromMetric(metric));
    setMessage(null);
    pendingFocus.current = { kind: 'id', id: `edit-${metric.id}-name` };
  }

  function cancelEdit(metric: ScorecardMetricTemplate) {
    setEditId(null);
    setEditIssues([]);
    pendingFocus.current = { kind: 'row', metricId: metric.id };
  }

  async function saveEdit(metric: ScorecardMetricTemplate) {
    const issues = draftIssues(editDraft);
    setEditIssues(issues);
    if (issues.length > 0) {
      document.getElementById(`edit-${metric.id}-${issues[0].field}`)?.focus();
      return;
    }
    setMessage(null);
    setSaving(true);
    try {
      await api.updateScorecardMetric(metric.id, draftToBody(editDraft));
      setEditId(null);
      setMessage({ text: `Metric “${editDraft.name.trim()}” updated.`, tone: 'ok' });
      await load();
      pendingFocus.current = { kind: 'row', metricId: metric.id };
    } catch (e) {
      setMessage({
        text: stableMutationMessage(
          e instanceof ApiError ? e.message : null,
          'Failed to update the metric.',
        ),
        tone: 'error',
      });
      pendingFocus.current = { kind: 'id', id: `edit-${metric.id}-save` };
    } finally {
      setSaving(false);
    }
  }

  async function archiveMetric(metric: ScorecardMetricTemplate) {
    setMessage(null);
    // Where focus goes once this row is gone: the next row, else the one
    // before, else "New metric".
    const list = metrics ?? [];
    const at = list.findIndex((m) => m.id === metric.id);
    const neighbour = list[at + 1] ?? list[at - 1] ?? null;
    try {
      await api.archiveScorecardMetric(metric.id);
      if (editId === metric.id) setEditId(null);
      if (openId === metric.id) setOpenId(null);
      setMessage({ text: `Metric “${metric.name}” archived.`, tone: 'ok' });
      await load();
      pendingFocus.current = neighbour ? { kind: 'row', metricId: neighbour.id } : { kind: 'new' };
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
    <div className="space-y-4">
      {/* A toolbar, not a second header: the drawer's own title and
          description already say what this library is. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] font-medium tabular-nums text-ink-secondary">
          {metrics.length} metric{metrics.length === 1 ? '' : 's'}
        </p>
        <Button
          ref={newMetricButton}
          variant="primary"
          onClick={() => (createOpen ? closeCreate() : openCreate())}
          aria-expanded={createOpen}
          aria-controls="new-metric-panel"
          icon={<PlusIcon />}
        >
          New metric
        </Button>
      </div>

      {/* Always mounted, so a change of text is announced. */}
      <div role="status" aria-live="polite">
        {message && (
          <InlineNotice tone={message.tone === 'ok' ? 'success' : 'danger'} role="none">
            {message.text}
          </InlineNotice>
        )}
      </div>

      {createOpen && (
        <section
          id="new-metric-panel"
          aria-labelledby="new-metric-title"
          className="disclosure-body glass-sunken rounded-[18px] p-4 sm:p-5"
        >
          <h3 id="new-metric-title" className="text-[15px] font-semibold tracking-[-0.01em] text-ink">
            Add a metric
          </h3>
          <p className="mt-1 max-w-prose text-[13px] leading-5 text-ink-secondary">
            Name it, tell the scorer what to look for, and describe what each of the four levels
            looks like.
          </p>
          <MetricFields
            className="mt-5"
            idPrefix="new-metric"
            draft={draft}
            onField={setDraftField}
            onRubric={setDraftRubric}
            issues={createIssues}
            // Ask Hello drafts the instruction AND the rubric from the name, so
            // it sits above both. The create form only; editing has none.
            instructionAction={
              <MetricAskHello idPrefix="new-metric" draft={draft} onApply={applyHelloDraft} resetKey={createdCount} />
            }
            footer={
              <>
                <Button variant="ghost" onClick={closeCreate} disabled={creating}>
                  Cancel
                </Button>
                <Button
                  id="new-metric-submit"
                  variant="primary"
                  onClick={() => void createMetric()}
                  loading={creating}
                >
                  Create metric
                </Button>
              </>
            }
          />
        </section>
      )}

      {metrics.length === 0 ? (
        <EmptyPanel
          title="No scorecard metrics yet"
          hint="Create the first metric to start the library roles score against."
        />
      ) : (
        <div>
          {/* `role="list"`: Safari drops list semantics from a list styled
              without markers. */}
          <ul
            role="list"
            aria-busy={refreshing || undefined}
            className="overflow-hidden rounded-[18px] bg-white/80 shadow-[0_0_0_1px_var(--glass-ring-strong)]"
          >
            {page.items.map((metric) => (
              <MetricRow
                key={metric.id}
                metric={metric}
                open={openId === metric.id}
                onToggle={() => setOpenId((id) => (id === metric.id ? null : metric.id))}
              >
                {editId === metric.id ? (
                  <MetricFields
                    idPrefix={`edit-${metric.id}`}
                    draft={editDraft}
                    onField={setEditField}
                    onRubric={setEditRubric}
                    issues={editIssues}
                    footer={
                      <>
                        <Button variant="ghost" onClick={() => cancelEdit(metric)} disabled={saving}>
                          Cancel edit
                        </Button>
                        {/* Saving is not destructive — it publishes a new
                            version and roles keep their copies — so there is
                            no second "are you sure" step. */}
                        <Button
                          id={`edit-${metric.id}-save`}
                          variant="primary"
                          onClick={() => void saveEdit(metric)}
                          loading={saving}
                        >
                          Save changes
                        </Button>
                      </>
                    }
                  />
                ) : (
                  <MetricDetails
                    metric={metric}
                    actions={
                      <>
                        <Button onClick={() => startEdit(metric)}>Edit</Button>
                        <ConfirmButton
                          label="Archive"
                          variant="danger"
                          quiet
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
                      </>
                    }
                  />
                )}
              </MetricRow>
            ))}
          </ul>
          {/* Paging controls only when there is more than one page — "1/1"
              with disabled arrows was a third way of saying "8 metrics". */}
          {metrics.length > PAGE_SIZE && <Pagination state={page} noun="metrics" />}
        </div>
      )}
    </div>
  );
}

/**
 * One metric: a disclosure header (name, version, one-line description) that
 * opens to its details. The header is a real `<button>` inside a heading,
 * with `aria-expanded` — the APG disclosure pattern. Its accessible NAME is
 * just "name vN"; the description is its description, not part of its name.
 */
function MetricRow({
  metric,
  open,
  onToggle,
  children,
}: {
  metric: ScorecardMetricTemplate;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const uid = useId().replace(/:/g, '');
  const headerId = `metric-${uid}-header`;
  const panelId = `metric-${uid}-panel`;
  const descId = `metric-${uid}-desc`;
  return (
    <li data-metric-row={metric.id} className="border-t border-ink/[0.07] first:border-t-0">
      <h3 className="m-0">
        <button
          id={headerId}
          data-metric-header=""
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${metric.name} v${metric.version}`}
          aria-describedby={metric.description ? descId : undefined}
          onClick={onToggle}
          className={cx(
            'flex w-full min-w-0 items-start gap-3 px-4 py-3.5 text-left transition-colors duration-150',
            'hover:bg-ink/[0.025] focus:outline-none focus-visible:bg-info/[0.06] focus-visible:shadow-[inset_0_0_0_2px_var(--info)]',
            open && 'bg-ink/[0.02]',
          )}
        >
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">
                {metric.name}
              </span>
              <span className="shrink-0 rounded-full bg-ink/[0.06] px-1.5 py-px text-[11px] font-medium tabular-nums text-ink-secondary">
                v{metric.version}
              </span>
            </span>
            {metric.description && (
              // Two lines closed, in full once open — the open row does not
              // repeat it underneath.
              <span
                id={descId}
                className={cx('mt-0.5 text-[13px] leading-5 text-ink-secondary', !open && 'line-clamp-2')}
              >
                {metric.description}
              </span>
            )}
          </span>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={cx(
              'mt-1 h-4 w-4 shrink-0 text-ink-tertiary transition-transform duration-200 ease-soft',
              open && 'rotate-180',
            )}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </h3>
      {open && (
        <div id={panelId} role="region" aria-labelledby={headerId} className="disclosure-body px-4 pb-4 pt-1">
          {children}
        </div>
      )}
    </li>
  );
}

/** Sub-headings inside an open metric: at least as strong as the text under them. */
const DETAIL_HEADING = 'text-[13px] font-semibold text-ink';

/** The open metric, read-only: its instruction and rubric. */
function MetricDetails({ metric, actions }: { metric: ScorecardMetricTemplate; actions: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <section>
        <h4 className={DETAIL_HEADING}>Scoring instruction</h4>
        <p className="mt-1.5 rounded-[12px] bg-ink/[0.035] px-3.5 py-3 text-[13px] leading-6 text-ink-secondary">
          {metric.default_instruction}
        </p>
      </section>
      <section>
        <h4 className={DETAIL_HEADING}>Rubric</h4>
        <RubricScale className="mt-1.5" rubric={metric.rubric} />
      </section>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink/[0.07] pt-3">
        {actions}
      </div>
    </div>
  );
}

/**
 * The create / edit form. Same fields in the same order as `MetricDetails`,
 * and the rubric in the same four-cell shape as `RubricScale`.
 *
 * Every validation problem is shown ON the input it concerns (and the caller
 * moves focus to the first). The message is the input's description — read
 * when focus lands — and deliberately NOT also an alert, which would say it
 * twice.
 */
function MetricFields({
  idPrefix,
  draft,
  onField,
  onRubric,
  issues,
  footer,
  instructionAction,
  className,
}: {
  idPrefix: string;
  draft: MetricDraft;
  onField: <K extends keyof MetricDraft>(key: K, value: MetricDraft[K]) => void;
  onRubric: (level: ScoreValue, value: string) => void;
  issues: DraftIssue[];
  footer: ReactNode;
  /**
   * Optional row, right-aligned, above the Scoring instruction — the CREATE
   * form's Ask Hello, which drafts the instruction and all four levels.
   */
  instructionAction?: ReactNode;
  className?: string;
}) {
  const errorFor = (field: DraftField) => issues.find((i) => i.field === field)?.message ?? null;
  const errorId = (field: DraftField) => `${idPrefix}-${field}-error`;
  const instructionError = errorFor('instruction');

  return (
    <div className={cx('flex flex-col gap-5', className)}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-5">
        <TextInput
          className="sm:col-span-2"
          id={`${idPrefix}-name`}
          label="Name"
          value={draft.name}
          max={SCORECARD_MAX_NAME_LENGTH}
          placeholder="e.g. Technical depth"
          onChange={(v) => onField('name', v)}
          error={errorFor('name')}
          errorId={errorId('name')}
        />
        <TextInput
          className="sm:col-span-3"
          id={`${idPrefix}-description`}
          label="Description"
          optional
          value={draft.description}
          max={SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH}
          placeholder="What this metric measures, for recruiters"
          onChange={(v) => onField('description', v)}
          error={errorFor('description')}
          errorId={errorId('description')}
        />
      </div>

      {/* Between the name it reads and the fields it fills. */}
      {instructionAction && <div className="flex justify-end">{instructionAction}</div>}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${idPrefix}-instruction`} className="text-[13px] font-medium text-ink">
          Scoring instruction
        </label>
        <textarea
          id={`${idPrefix}-instruction`}
          value={draft.instruction}
          maxLength={SCORECARD_MAX_INSTRUCTION_LENGTH}
          rows={4}
          onChange={(e) => onField('instruction', e.target.value)}
          placeholder="Assess how deeply the candidate understands…"
          aria-invalid={instructionError ? true : undefined}
          aria-describedby={instructionError ? errorId('instruction') : `${idPrefix}-instruction-hint`}
          className={cx(controlClass, 'min-h-28 resize-y py-2.5 leading-6', instructionError && INVALID)}
        />
        <div className="flex items-start justify-between gap-3">
          {instructionError ? (
            <p id={errorId('instruction')} className="text-xs leading-5 text-error-text">
              {instructionError}
            </p>
          ) : (
            <p id={`${idPrefix}-instruction-hint`} className="text-xs leading-5 text-ink-tertiary">
              What the scoring model is told to look for. Be specific about evidence. Up to{' '}
              {SCORECARD_MAX_INSTRUCTION_LENGTH.toLocaleString('en-GB')} characters.
            </p>
          )}
          <CharCount value={draft.instruction} max={SCORECARD_MAX_INSTRUCTION_LENGTH} />
        </div>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="text-[13px] font-medium text-ink">Rubric</legend>
        <p className="text-xs leading-5 text-ink-tertiary">
          Describe what an answer at each level looks like. The levels are Ashby&apos;s four-point
          Score.
        </p>
        <div className="mt-1 grid grid-cols-1 gap-px overflow-hidden rounded-[14px] bg-ink-muted/40 shadow-[0_0_0_1px_var(--ink-muted)] sm:grid-cols-2">
          {RUBRIC_LEVELS.map((level) => {
            const field: DraftField = `rubric-${level}`;
            const id = `${idPrefix}-${field}`;
            const error = errorFor(field);
            return (
              <div
                key={level}
                className={cx(
                  'flex flex-col gap-2 bg-white px-3.5 py-3 transition-shadow duration-150',
                  // An invalid cell stays RED while focused — focus is exactly
                  // when the admin is looking at what is wrong with it.
                  error
                    ? 'shadow-[inset_0_0_0_1.5px_var(--error)]'
                    : 'focus-within:shadow-[inset_0_0_0_1.5px_var(--info)]',
                )}
              >
                <LevelHeading level={level} htmlFor={id} />
                <textarea
                  id={id}
                  value={draft.rubric[level]}
                  maxLength={SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH}
                  rows={3}
                  onChange={(e) => onRubric(level, e.target.value)}
                  placeholder={`What ${withArticle(SCORE_LABELS[level].toLowerCase())} answer looks like`}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId(field) : undefined}
                  className="w-full resize-none bg-transparent text-[13px] leading-5 text-ink placeholder:text-ink-tertiary focus:outline-none"
                />
                {(error || nearLimit(draft.rubric[level], SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH)) && (
                  <div className="flex items-start justify-between gap-2">
                    {error ? (
                      <p id={errorId(field)} className="text-xs leading-5 text-error-text">
                        {error}
                      </p>
                    ) : (
                      <span />
                    )}
                    <CharCount value={draft.rubric[level]} max={SCORECARD_MAX_RUBRIC_DESCRIPTION_LENGTH} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-start justify-end gap-2 border-t border-ink/[0.07] pt-4">
        {footer}
      </div>
    </div>
  );
}

/**
 * `!important`: `controlClass` carries its own arbitrary border shadows, and
 * two arbitrary shadows on one element resolve by STYLESHEET order — the
 * grey/blue ones were emitted later and the red ring never showed.
 */
const INVALID = '!shadow-[inset_0_0_0_1.5px_var(--error)]';

/** "a poor", "an average", "a good", "an excellent" — the rubric placeholders read as English. */
function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`;
}

/** Counters only earn their space near the limit. */
function nearLimit(value: string, max: number): boolean {
  return value.length >= max * 0.8;
}

function TextInput({
  id,
  label,
  optional = false,
  value,
  max,
  placeholder,
  onChange,
  error,
  errorId,
  className,
}: {
  id: string;
  label: string;
  optional?: boolean;
  value: string;
  max: number;
  placeholder: string;
  onChange: (value: string) => void;
  error: string | null;
  errorId: string;
  className?: string;
}) {
  return (
    <div className={cx('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        {optional && <span className="text-xs text-ink-tertiary">Optional</span>}
      </div>
      <input
        id={id}
        value={value}
        maxLength={max}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cx(controlClass, 'h-10', error && INVALID)}
      />
      {/* Only when there is something to say — an always-present empty row
          opened a dead gap under every input. */}
      {(error || nearLimit(value, max)) && (
        <div className="flex items-start justify-between gap-2">
          {error ? (
            <p id={errorId} className="text-xs leading-5 text-error-text">
              {error}
            </p>
          ) : (
            <span />
          )}
          <CharCount value={value} max={max} />
        </div>
      )}
    </div>
  );
}

/**
 * Characters used, shown only near the limit and turning amber past 90%.
 * Decorative (`aria-hidden`): `maxLength` already stops the input, the
 * instruction's hint states its limit in words, and announcing a count on
 * every keystroke would drown a screen reader.
 */
function CharCount({ value, max }: { value: string; max: number }) {
  if (!nearLimit(value, max)) return null;
  const near = value.length >= max * 0.9;
  return (
    <span
      aria-hidden="true"
      className={cx('shrink-0 text-[11px] tabular-nums', near ? 'text-warning-text' : 'text-ink-tertiary')}
    >
      {value.length}/{max}
    </span>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" aria-hidden="true" className="h-4 w-4">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}
