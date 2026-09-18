/**
 * RoleScorecardEditor — the per-role scorecard configuration panel.
 *
 * Shown beneath the role form for an EXISTING role (a new, unsaved role has no
 * id to attach a scorecard to). It reads the role's active immutable scorecard
 * (GET /scorecard), lets an owner attach library metrics, edit each metric's
 * per-role INSTRUCTION and DISPLAY ORDER, and TYPE a weight per metric. Save
 * writes a new immutable version (PUT /scorecard).
 *
 * WEIGHTS ARE TYPED, NOT DRAGGED (owner request 2026-09-18). The weight was a
 * slider that auto-redistributed: pinning one metric silently rewrote every
 * other one so the set always read 100%. That is tidy but it takes the decision
 * away — an owner who wants 30/30/20/10/10 could not simply say so, and could
 * not see a deliberate in-progress total.
 *
 * So a weight is now a number box and NOTHING is redistributed on edit. The
 * consequence is the point: the set CAN sit at 97% or 104% while editing. So a
 * running total says how far off 100% it is and Save stays blocked until it is
 * exactly right, and that total is stated TWICE — in the section header and
 * again beside Save, because a scorecard runs to 20 metrics and the header has
 * scrolled away by the time the number matters.
 *
 * NOTHING rewrites a typed weight — not even attach or remove. A new metric
 * takes whatever is left of 100%, a removed one just goes, and the running
 * total reports whatever that leaves. The old even re-split on attach/remove
 * was the same silent overwrite in a different costume.
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
  TextField,
  TextArea,
} from '../design';
import {
  SCORECARD_WEIGHT_TOTAL_BPS,
  bpsToPercent,
  everyWeightIsPositive,
  formatWeightPercent,
  totalWeightBps,
  weightDeltaBps,
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

/**
 * Is this box text a weight we are willing to COMMIT?
 *
 * Deliberately strict, and deliberately shared by the change and blur
 * handlers: if the two disagreed about what counts as typed, a value could be
 * committed on the way in and then treated as abandoned on the way out (or
 * the reverse). Out of range is not committed — the box keeps showing it while
 * the owner is still typing, and blur decides its fate.
 */
function isTypedPercent(raw: string): boolean {
  if (raw.trim() === '') return false;
  const pct = Number(raw);
  return Number.isFinite(pct) && pct >= 0 && pct <= 100;
}

export function RoleScorecardEditor({ roleId }: { roleId: string }) {
  const [metrics, setMetrics] = useState<EditorMetric[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [library, setLibrary] = useState<ScorecardMetricTemplate[] | null>(null);
  const [libraryForbidden, setLibraryForbidden] = useState(false);
  const [addSelection, setAddSelection] = useState('');
  /**
   * In-progress text per metric weight box, keyed by metric id.
   *
   * Only what the user is CURRENTLY typing lives here; the committed value is
   * always `metric.weightBps`. Cleared on blur so the box re-formats from the
   * committed number (and rounds to the 2dp the server stores).
   *
   * `restore` is the weight the metric held when this edit STARTED, and it is
   * what makes an abandoned edit safe. Every in-range keystroke commits so the
   * running total tracks live, which means typing "1000" (meaning 10.00)
   * commits 1 → 10 → 100 on the way past before the final string is rejected
   * for being over 100. Without `restore`, blurring there would leave the
   * weight at 100% — a number the owner never chose. With it, a box that ends
   * on anything unparseable or out of range goes back to where it started.
   */
  const [weightDrafts, setWeightDrafts] = useState<
    Record<string, { text: string; restore: number }>
  >({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const newRowCounter = useRef(0);

  /**
   * Re-read the active scorecard.
   *
   * `keepMessage` exists because a successful save does `setMessage(ok)` and
   * then reloads, and React batches both updates into ONE render — so clearing
   * the message here threw away the confirmation before it could ever paint.
   * The only visible result of an irreversible new-version write was the panel
   * blinking through "Loading scorecard…", which is indistinguishable from
   * nothing having happened.
   */
  const load = useCallback((keepMessage = false) => {
    setLoadError(null);
    setMetrics(null);
    if (!keepMessage) setMessage(null);
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
        <InlineNotice tone="danger" role="alert" className="mt-4"           // `() => load()`, not `load`: as a bare handler React hands it the
          // MouseEvent, which lands in `keepMessage` and is truthy — a retry
          // would preserve a stale message instead of clearing it.
          action={
            <Button size="sm" onClick={() => load()}>
              Try again
            </Button>
          }>
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
  const delta = weightDeltaBps(metrics);
  const allPositive = everyWeightIsPositive(metrics);
  /**
   * How far off 100% the set is, in words. Derived ONCE and used by all three
   * places that state it — the header total, the total beside Save, and the
   * refusal message — so they cannot word the same fact differently.
   *
   * Always a string (it reads "0% short" on a complete set) rather than null,
   * so no caller can stringify a null into the UI; `complete` gates whether it
   * is shown at all.
   */
  const offBy =
    delta > 0 ? `${formatWeightPercent(delta)} over` : `${formatWeightPercent(-delta)} short`;
  const attachedLibIds = new Set(metrics.map((m) => m.libraryMetricId));
  const available = (library ?? []).filter((m) => !attachedLibIds.has(m.id));
  const atCap = metrics.length >= SCORECARD_MAX_METRICS;

  /**
   * Commit a typed weight for ONE metric. No redistribution: the owner's number
   * is the owner's number, and the running total reports the consequence.
   *
   * `percent` is accepted at 2dp (the bps resolution), so 33.33 round-trips.
   */
  function onWeightPercent(id: string, percent: number) {
    const bps = Math.round(percent * 100);
    setMetrics((prev) =>
      prev ? prev.map((m) => (m.id === id ? { ...m, weightBps: bps } : m)) : prev,
    );
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

  /**
   * Remove a metric and leave every OTHER weight exactly as typed.
   *
   * This used to re-split the survivors evenly. Under typed weights that is
   * the same sin the slider committed: an owner who set 40/30/20/10 and then
   * removed the 10 would find the other three silently rewritten to
   * 33.34/33.33/33.33. Now the set simply goes 10% short and the running
   * total says so — which is what the running total is for.
   */
  function removeMetric(id: string) {
    setMetrics((prev) => (prev ? renumber(prev.filter((m) => m.id !== id)) : prev));
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
          // The new metric takes WHAT IS LEFT, and no existing weight is
          // touched. On a fresh scorecard that hands the first metric the
          // whole 100%; on a complete set it gives the newcomer 0% and Save
          // asks for a weight; on a set sitting at 80% it completes it. No
          // path rewrites a number the owner typed.
          weightBps: Math.max(0, SCORECARD_WEIGHT_TOTAL_BPS - totalWeightBps(base)),
          displayOrder: base.length,
        },
      ]);
      return next;
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
      // Say WHICH WAY and BY HOW MUCH. "Weights must total 100%" leaves the
      // owner to do the arithmetic the editor already did. Same `offBy` the
      // two on-screen totals use, so the refusal cannot word it differently.
      setMessage({
        text: `Weights total ${formatWeightPercent(total)} — ${offBy}. They must total exactly 100% before saving.`,
        tone: 'error',
      });
      return;
    }
    if (!allPositive) {
      // Totals 100% but a metric sits at 0, which the server rejects. Reported
      // separately so the message names the real problem.
      setMessage({
        text: 'Every metric needs a weight above 0%. Remove the metric instead if it should not count.',
        tone: 'error',
      });
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
      load(true);
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
        description="Attach metrics from the library, then set each metric's instruction, order and weight. Weights must total exactly 100% to save."
        meta={
          // THE RUNNING TOTAL IS THE SAFETY NET for typed weights. It states the
          // total, and when that is not 100% it also states the direction and
          // the size of the gap, so the owner never has to add five numbers by
          // hand to find out why Save is refusing.
          // Hidden entirely at zero metrics: "No metrics attached yet" is a
          // legitimate state the panel describes in plain words, and a red
          // "Total 0% - 100% short" over it is an alarm about nothing. The
          // footer total already hides itself there.
          metrics.length === 0 ? undefined : (
          <span
            className={`text-[13px] font-medium tabular-nums ${complete ? 'text-ink-tertiary' : 'text-error-text'}`}
            data-weight-total-bps={total}
            data-weight-delta-bps={delta}
            // The live region is PERMANENT, not toggled on when the total goes
            // wrong. A region that appears at the same moment its content
            // changes is not reliably announced — a screen reader has to be
            // watching it beforehand. Keeping it mounted also means reaching
            // 100% is announced, which is the confirmation a sighted owner
            // gets from the colour.
            role="status"
            aria-live="polite"
          >
            Total {formatWeightPercent(total)}
            {!complete && ` · ${offBy}`}
          </span>
          )
        }
      />

      {message && (
        <InlineNotice
          tone={message.tone === 'ok' ? 'success' : 'danger'}
          // A save REFUSAL is inserted into the DOM at the same instant it
          // needs announcing, and a polite `status` region created in that
          // same moment is unreliable. `alert` is assertive and announces on
          // insertion, which is exactly this case.
          role={message.tone === 'ok' ? 'status' : 'alert'}
          className="mt-4"
        >
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
                <div className="flex items-center gap-1.5">
                  {/* The WRAPPER carries the width, not the input. `cx` is a
                      plain joiner, not tailwind-merge, so a `w-24` on the
                      input would sit alongside `controlClass`'s `w-full` and
                      lose on stylesheet order — the box would silently render
                      full-width. Sizing the wrapper and leaving the input
                      `w-full` has no such collision. `w-28` because "100.00"
                      in a mono face plus the native spin buttons does not fit
                      in `w-24`. */}
                  <div className="w-28 shrink-0">
                  <TextField
                    id={`metric-${m.id}-weight`}
                    type="number"
                    inputMode="decimal"
                    size="sm"
                    className="text-right font-mono tabular-nums"
                    // 0 is ALLOWED to be typed even though the server rejects
                    // it: blocking the keystroke would make clearing a field to
                    // retype it impossible. `everyWeightIsPositive` catches it
                    // at save with a message that says which problem it is.
                    min={0}
                    max={100}
                    // 1, not 0.01. This is the ARROW-KEY step, and at 0.01 a
                    // keyboard user needed 6,666 presses to go from 33.34 to
                    // 100 — a straight regression from the slider, which
                    // stepped by 1. Typing 2dp still works: `isTypedPercent`
                    // never consults `step`, and nothing here reads native
                    // validity, so a 33.33 "stepMismatch" has no effect.
                    step={1}
                    value={weightDrafts[m.id]?.text ?? String(bpsToPercent(m.weightBps))}
                    aria-label={`Weight for ${m.name}`}
                    aria-describedby={`metric-${m.id}-weight-unit`}
                    onChange={(e) => {
                      const raw = e.target.value;
                      // The DRAFT is what the box shows while typing. Without it
                      // a controlled numeric input fights the user: parsing
                      // every keystroke turns "" into 0 and makes "33." or a
                      // cleared field impossible to type through. The first
                      // keystroke of an edit also records what to fall back to.
                      setWeightDrafts((d) => ({
                        ...d,
                        [m.id]: { text: raw, restore: d[m.id]?.restore ?? m.weightBps },
                      }));
                      if (isTypedPercent(raw)) onWeightPercent(m.id, Number(raw));
                    }}
                    // A FOCUSED number input eats the scroll wheel and steps
                    // its own value. On a 20-metric card an owner scrolls past
                    // the box they just typed into and the weight silently
                    // moves — the precise mistake the running total exists to
                    // catch, introduced by the control itself. Blur instead,
                    // so the wheel scrolls the page and the box settles on its
                    // committed weight.
                    onWheel={(e) => e.currentTarget.blur()}
                    onBlur={(e) => {
                      // An edit that ends on something we never committed —
                      // empty, "33.", "1000" — is ABANDONED, not partially
                      // applied: put the weight back where the edit found it.
                      const draft = weightDrafts[m.id];
                      if (draft && !isTypedPercent(e.target.value)) {
                        setMetrics((prev) =>
                          prev
                            ? prev.map((x) =>
                                x.id === m.id ? { ...x, weightBps: draft.restore } : x,
                              )
                            : prev,
                        );
                      }
                      // Drop the draft so the box re-renders from the committed
                      // bps, normalising "07" to "7" and 2dp-rounding the rest.
                      setWeightDrafts((d) => {
                        const next = { ...d };
                        delete next[m.id];
                        return next;
                      });
                    }}
                  />
                  </div>
                  <span
                    id={`metric-${m.id}-weight-unit`}
                    className="text-[13px] text-ink-tertiary"
                    data-metric-weight-bps={m.weightBps}
                  >
                    %
                  </span>
                </div>
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

        {/* The total sits WITH Save because that is where it is acted on; the
            header states it too, for the at-a-glance read. */}
        <div className="flex flex-wrap items-center justify-end gap-3">
          {metrics.length > 0 && (
            <span
              className={`text-[13px] font-medium tabular-nums ${
                complete ? 'text-ink-tertiary' : 'text-error-text'
              }`}
              data-weight-total-footer={total}
            >
              {complete ? 'Weights total 100%' : `Weights total ${formatWeightPercent(total)} — ${offBy}`}
            </span>
          )}
          <Button variant="primary" onClick={save} loading={saving} disabled={metrics.length === 0}>
            Save scorecard
          </Button>
        </div>
      </div>
    </GlassPanel>
  );
}
