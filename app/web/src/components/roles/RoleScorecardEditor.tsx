/**
 * RoleScorecardEditor — the per-role scorecard configuration panel.
 *
 * Shown beneath the role form for an EXISTING role (a new, unsaved role has no
 * id to attach a scorecard to). It reads the role's active immutable scorecard
 * (GET /scorecard), lets an owner attach library metrics, edit each metric's
 * per-role INSTRUCTION and DISPLAY ORDER, and drag a WEIGHT slider per metric.
 * Weights always total 100%: a slider drag pins one metric and redistributes
 * the remainder with the exact server math (mirrored client-side so the slider
 * is instant), and attaching/removing a metric re-splits the set evenly. Save
 * writes a new immutable version (PUT /scorecard).
 *
 * Role gating is UX-delegated to the API here (as elsewhere in this SPA — the
 * server enforces "interviewer owns own role, admin all" on every request);
 * a viewer's Save simply surfaces the API's 403.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import {
  SCORECARD_MAX_INSTRUCTION_LENGTH,
  SCORECARD_MAX_METRICS,
} from '../../types';
import type {
  PutRoleScorecardInput,
  RoleScorecardMetric,
  ScorecardMetricTemplate,
  ScorecardRubric,
} from '../../types';
import {
  Button,
  Field,
  GlassPanel,
  InlineNotice,
  SectionHeader,
  SelectField,
  Slider,
  TextArea,
} from '../design';
import {
  evenWeights,
  formatWeightPercent,
  redistributeWeights,
  totalWeightBps,
  weightsAreComplete,
} from '../../lib/scorecard-weights';

interface EditorMetric {
  /** Stable local key (the immutable snapshot id for loaded rows). */
  id: string;
  libraryMetricId: string;
  key: string;
  name: string;
  instruction: string;
  rubric: ScorecardRubric;
  weightBps: number;
  displayOrder: number;
}

function fromRoleMetric(metric: RoleScorecardMetric): EditorMetric {
  return {
    id: metric.id,
    libraryMetricId: metric.libraryMetricId,
    key: metric.key,
    name: metric.name,
    instruction: metric.instruction,
    rubric: metric.rubric,
    weightBps: metric.weightBps,
    displayOrder: metric.displayOrder,
  };
}

/** Renumber displayOrder 0..n-1 in current array order. */
function renumber(metrics: EditorMetric[]): EditorMetric[] {
  return metrics.map((m, i) => ({ ...m, displayOrder: i }));
}

export function RoleScorecardEditor({ roleId }: { roleId: string }) {
  const [metrics, setMetrics] = useState<EditorMetric[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [library, setLibrary] = useState<ScorecardMetricTemplate[] | null>(null);
  const [libraryForbidden, setLibraryForbidden] = useState(false);
  const [addSelection, setAddSelection] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const newRowCounter = useRef(0);

  const load = useCallback(() => {
    setLoadError(null);
    setMetrics(null);
    setMessage(null);
    api
      .getRoleScorecard(roleId)
      .then((r) => {
        const sorted = [...(r.scorecard?.metrics ?? [])].sort(
          (a, b) => a.displayOrder - b.displayOrder,
        );
        setMetrics(sorted.map(fromRoleMetric));
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, [roleId]);

  const loadLibrary = useCallback(() => {
    setLibraryForbidden(false);
    api
      .listScorecardMetrics()
      .then((rows) => setLibrary(rows))
      .catch((e: ApiError) => {
        // The library list is admin-only server-side. An interviewer who owns
        // the role can still adjust the metrics already attached; only ADDING
        // new ones is unavailable to them.
        if (e.status === 403) {
          setLibraryForbidden(true);
          setLibrary([]);
        } else {
          setLibrary([]);
        }
      });
  }, []);

  useEffect(() => {
    load();
    loadLibrary();
  }, [load, loadLibrary]);

  if (loadError) {
    return (
      <GlassPanel>
        <SectionHeader level={3} title="Scorecard" />
        <InlineNotice tone="danger" role="alert" className="mt-4" action={<Button size="sm" onClick={load}>Try again</Button>}>
          {loadError}
        </InlineNotice>
      </GlassPanel>
    );
  }
  if (!metrics) {
    return (
      <GlassPanel>
        <SectionHeader level={3} title="Scorecard" />
        <p className="mt-3 text-sm text-ink-tertiary">Loading scorecard…</p>
      </GlassPanel>
    );
  }

  const total = totalWeightBps(metrics);
  const complete = weightsAreComplete(metrics);
  const attachedLibIds = new Set(metrics.map((m) => m.libraryMetricId));
  const available = (library ?? []).filter((m) => !attachedLibIds.has(m.id));
  const atCap = metrics.length >= SCORECARD_MAX_METRICS;

  function onSlider(id: string, percent: number) {
    setMetrics((prev) => (prev ? redistributeWeights(prev, id, Math.round(percent * 100)) : prev));
  }

  function onInstruction(id: string, value: string) {
    setMetrics((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, instruction: value } : m)) : prev,
    );
  }

  function move(id: string, direction: -1 | 1) {
    setMetrics((prev) => {
      if (!prev) return prev;
      const index = prev.findIndex((m) => m.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return renumber(next);
    });
  }

  function removeMetric(id: string) {
    setMetrics((prev) => {
      if (!prev) return prev;
      const kept = renumber(prev.filter((m) => m.id !== id));
      return kept.length > 0 ? evenWeights(kept) : kept;
    });
  }

  function addMetric() {
    const lib = (library ?? []).find((m) => m.id === addSelection);
    if (!lib) return;
    setMetrics((prev) => {
      const base = prev ?? [];
      if (base.some((m) => m.libraryMetricId === lib.id) || base.length >= SCORECARD_MAX_METRICS) {
        return prev;
      }
      const next: EditorMetric[] = renumber([
        ...base,
        {
          id: `new-${newRowCounter.current++}`,
          libraryMetricId: lib.id,
          key: lib.key,
          name: lib.name,
          instruction: lib.default_instruction,
          rubric: lib.rubric,
          weightBps: 0,
          displayOrder: base.length,
        },
      ]);
      return evenWeights(next);
    });
    setAddSelection('');
  }

  async function save() {
    setMessage(null);
    if (!metrics) return;
    if (metrics.length === 0) {
      setMessage({ text: 'Attach at least one metric before saving.', tone: 'error' });
      return;
    }
    if (!complete) {
      setMessage({ text: 'Weights must total 100% before saving.', tone: 'error' });
      return;
    }
    const body: PutRoleScorecardInput = {
      metrics: [...metrics]
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .map((m) => ({
          libraryMetricId: m.libraryMetricId,
          instruction: m.instruction.trim() ? m.instruction.trim() : undefined,
          weightBps: m.weightBps,
          displayOrder: m.displayOrder,
        })),
    };
    setSaving(true);
    try {
      await api.putRoleScorecard(roleId, body);
      setMessage({ text: 'Scorecard saved as a new version.', tone: 'ok' });
      load();
    } catch (e) {
      setMessage({
        text: e instanceof ApiError ? e.message : 'Failed to save the scorecard.',
        tone: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <GlassPanel>
      <SectionHeader
        level={3}
        title="Scorecard"
        description="Attach metrics from the library, tune each metric's instruction, order and weight. Weights always total 100%."
        meta={
          <span
            className={`text-[13px] font-medium tabular-nums ${complete ? 'text-ink-tertiary' : 'text-error-text'}`}
            data-weight-total-bps={total}
          >
            Total {formatWeightPercent(total)}
          </span>
        }
      />

      {message && (
        <InlineNotice tone={message.tone === 'ok' ? 'success' : 'danger'} role="status" className="mt-4">
          {message.text}
        </InlineNotice>
      )}

      {metrics.length === 0 ? (
        <p className="mt-4 text-sm text-ink-tertiary">
          No metrics attached yet. This role uses the legacy scoring until a scorecard is saved.
        </p>
      ) : (
        <ul className="mt-4 space-y-3" data-scorecard-metrics>
          {metrics.map((m, index) => (
            <li key={m.id} className="glass-sunken space-y-3 p-4" data-metric-row={m.id}>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{m.name}</p>
                  <p className="font-mono text-xs text-ink-tertiary">{m.key}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => move(m.id, -1)}
                    disabled={index === 0}
                    aria-label={`Move ${m.name} up`}
                  >
                    ↑
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => move(m.id, 1)}
                    disabled={index === metrics.length - 1}
                    aria-label={`Move ${m.name} down`}
                  >
                    ↓
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => removeMetric(m.id)}
                    aria-label={`Remove ${m.name}`}
                  >
                    Remove
                  </Button>
                </div>
              </div>

              <Field
                label="Instruction for this role"
                id={`metric-${m.id}-instruction`}
                hint="Overrides the library default for this role only."
              >
                {({ id, describedBy }) => (
                  <TextArea
                    id={id}
                    aria-describedby={describedBy}
                    value={m.instruction}
                    maxLength={SCORECARD_MAX_INSTRUCTION_LENGTH}
                    rows={2}
                    onChange={(e) => onInstruction(m.id, e.target.value)}
                  />
                )}
              </Field>

              <div className="flex items-center gap-3">
                <span
                  aria-hidden="true"
                  className="w-20 shrink-0 text-[13px] font-medium text-ink-secondary"
                >
                  Weight
                </span>
                <Slider
                  id={`metric-${m.id}-weight`}
                  className="min-w-0 flex-1"
                  value={Math.round(m.weightBps / 100)}
                  min={1}
                  max={metrics.length > 1 ? 99 : 100}
                  step={1}
                  onValueChange={(pct) => onSlider(m.id, pct)}
                  aria-label={`Weight for ${m.name}`}
                  aria-valuetext={formatWeightPercent(m.weightBps)}
                />
                <span
                  className="w-16 shrink-0 text-right font-mono text-sm tabular-nums text-ink"
                  data-metric-weight-bps={m.weightBps}
                >
                  {formatWeightPercent(m.weightBps)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Attach + save */}
      <div className="mt-4 flex flex-col gap-3 border-t border-ink/10 pt-4 sm:flex-row sm:items-end sm:justify-between">
        {libraryForbidden ? (
          <p className="max-w-prose text-[13px] leading-5 text-ink-tertiary">
            Adding metrics from the library requires an admin. You can still adjust the
            weights, instructions and order of the metrics already attached.
          </p>
        ) : (
          <div className="flex w-full flex-wrap items-end gap-2 sm:w-auto">
            <Field label="Add a metric" id="scorecard-add-metric" className="min-w-52">
              {({ id }) => (
                <SelectField
                  id={id}
                  value={addSelection}
                  onChange={(e) => setAddSelection(e.target.value)}
                  disabled={atCap || available.length === 0}
                >
                  <option value="">
                    {atCap
                      ? 'Maximum metrics reached'
                      : available.length === 0
                        ? 'No more metrics to add'
                        : 'Choose a metric…'}
                  </option>
                  {available.map((lib) => (
                    <option key={lib.id} value={lib.id}>
                      {lib.name}
                    </option>
                  ))}
                </SelectField>
              )}
            </Field>
            <Button variant="secondary" onClick={addMetric} disabled={!addSelection}>
              Attach
            </Button>
          </div>
        )}

        <Button variant="primary" onClick={save} loading={saving} disabled={metrics.length === 0}>
          Save scorecard
        </Button>
      </div>
    </GlassPanel>
  );
}
