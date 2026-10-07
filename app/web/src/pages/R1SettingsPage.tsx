/**
 * R1 settings: the admin page for the R1 sales role-play.
 *
 * Reads `GET /api/admin/r1/settings` and writes `PUT /api/admin/r1/settings`
 * (admin-only on the server; the route is also behind `requireRole="admin"`,
 * a UX gate only). What it edits:
 *   - the two switches (enabled, paused);
 *   - the monthly cap (R1's own allocation) and the pause line (the shared Cloud
 *     pool's line), in WebRTC minutes;
 *   - the advance and hold score thresholds, and automatic status changes;
 *   - the LiveKit dashboard reading, which the Cloud pool's guard never goes
 *     below.
 * `livekit_target` is shown but not editable: moving R1 to another media
 * server is an infrastructure change, not a setting.
 *
 * Behaviour that matters:
 *  - Only changed fields are sent, so two admins editing different fields do
 *    not overwrite each other.
 *  - Switching R1 on or off, and turning automatic status changes on or off,
 *    ask for a second click that says what will happen.
 *  - Nothing is applied optimistically: the form shows what the server
 *    answered. The PUT response carries no `runtime`, so the last known one
 *    is kept.
 *  - The dashboard reading is its own form: it stamps `dashboard_read_at`
 *    with the moment it is recorded, which the API never does on its own.
 *    Recording one moves the saved row, so the draft is rebased onto it:
 *    fields the person has not touched follow the server (another admin's
 *    pause stays a pause), fields they edited keep their edit.
 *  - Since 0119 the cap is the R1 ALLOCATION (sessions x hold): it is checked
 *    against R1's own committed minutes (used plus the links already sent) on
 *    both media servers, and phone use never counts against it. The pause line
 *    belongs to the shared Cloud pool (phone and legacy browser included) and
 *    gates sends ONLY while `livekit_target` is `cloud`; on `r1` it gates
 *    nothing. The page says so, per target, and shows no combined ceiling.
 *    Mission Control reads the same snapshot, so the two pages agree.
 *  - Every change is audited server-side (DB trigger plus route audit).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import {
  Button,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  SectionHeader,
  Switch,
  TextField,
} from '../components/design';
import { buttonClass } from '../components/design/Button';
import type { NoticeTone } from '../components/design';
import { formatDateTime } from '../lib/datetime';
import {
  currentMonthStart,
  draftFromSettings,
  formatMinutes,
  formatReading,
  isReadingStale,
  needsConfirmation,
  parseDashboardMinutes,
  r1RunState,
  readingMonthLabel,
  rebaseDraft,
  settingsPatch,
  validateSettingsDraft,
} from '../lib/r1';
import type { R1SettingsDraft, R1SettingsDraftErrors, UsageTone } from '../lib/r1';
import type { R1SettingsResponse } from '../lib/r1-types';

type Load =
  | { status: 'loading' }
  | { status: 'error'; message: string; forbidden: boolean }
  | { status: 'ready' };

/** Control ids, in page order, so a failed validation can focus the first bad one. */
const FIELD_ORDER: ReadonlyArray<[keyof R1SettingsDraft, string]> = [
  ['monthly_cap_minutes', 'r1-monthly-cap'],
  ['pause_line_minutes', 'r1-pause-line'],
  ['advance_threshold', 'r1-advance-threshold'],
  ['hold_threshold', 'r1-hold-threshold'],
];

/** `r1RunState` never yields `info`; the map keeps the type honest all the same. */
const NOTICE_TONE: Record<UsageTone, NoticeTone> = {
  neutral: 'neutral',
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
};

const PAGE_DESCRIPTION =
  'Switches, allowance, scoring thresholds and the LiveKit dashboard reading for the R1 sales ' +
  'role-play. Every change is audited.';
const SWITCHES_DESCRIPTION =
  'R1 takes sends only when it is enabled here and R1_ENABLED is true on the API.';
const SCORING_DESCRIPTION =
  'Scores run from 0 to 100. At or above advance is a recommendation to advance; at or above ' +
  'hold is hold; below is reject.';
const AUTO_STATUS_DESCRIPTION =
  'Off until calibration is signed off. When on, R1 advances candidates itself and rejects ' +
  'after a 24-hour window HR can cancel.';
const READING_DESCRIPTION =
  'Copy the month-to-date WebRTC minutes from the LiveKit dashboard. The Cloud-pool guard never ' +
  'goes below it, and counts the pool’s growth since as its baseline. Record a new one each ' +
  'month: the guard keeps counting the last reading until you do.';
const capHint = (hold: number) =>
  `R1’s own allocation for the month (sessions × ${hold} minutes), on either media server. It ` +
  'is checked against R1’s used minutes plus the minutes held by links already sent. Phone ' +
  'and legacy browser use do not count against it.';
const PAUSE_LINE_HINT: Record<'cloud' | 'r1', string> = {
  cloud:
    'The Cloud pool’s line: R1, phone and legacy browser together. R1 stops taking sends when ' +
    'the month’s pool use reaches it.',
  r1:
    'The Cloud pool’s line. R1 runs on its own media server, so this gates nothing now; it ' +
    'applies again only if R1 moves back to LiveKit Cloud.',
};
const ALLOWANCE_NOTE: Record<'cloud' | 'r1', string> = {
  cloud: 'Both limits must have room: R1’s allocation and the Cloud pool’s pause line.',
  r1: 'Only R1’s allocation applies; the Cloud pool’s pause line gates nothing here.',
};

const TARGET_LABEL: Record<string, string> = {
  cloud: 'LiveKit Cloud, shared with phone',
  r1: 'Dedicated R1 media server',
};

function sameDraft(a: R1SettingsDraft, b: R1SettingsDraft): boolean {
  return (Object.keys(a) as Array<keyof R1SettingsDraft>).every((key) => a[key] === b[key]);
}

export function R1SettingsPage() {
  const uid = useId().replace(/:/g, '');
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [saved, setSaved] = useState<R1SettingsResponse | null>(null);
  // The latest saved row, for the reading form's async rebase (its closure is stale by then).
  const savedRef = useRef<R1SettingsResponse | null>(null);
  const [draft, setDraft] = useState<R1SettingsDraft | null>(null);
  const [errors, setErrors] = useState<R1SettingsDraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string[] | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);

  const [readingText, setReadingText] = useState('');
  const [readingError, setReadingError] = useState<string | null>(null);
  const [readingSaving, setReadingSaving] = useState(false);

  const read = useCallback(() => {
    setLoad({ status: 'loading' });
    api
      .getR1Settings()
      .then((settings) => {
        setSaved(settings);
        setDraft(draftFromSettings(settings));
        setErrors({});
        setConfirming(null);
        setLoad({ status: 'ready' });
      })
      .catch((e: unknown) => {
        const forbidden = e instanceof ApiError && e.status === 403;
        setLoad({
          status: 'error',
          forbidden,
          message: e instanceof ApiError ? e.message : 'R1 settings could not be loaded.',
        });
      });
  }, []);

  useEffect(read, [read]);

  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);

  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  if (load.status === 'loading') return <LoadingPanel label="Loading R1 settings…" />;
  if (load.status === 'error') {
    if (load.forbidden) {
      return (
        <div>
          <PageHeader eyebrow="Operations" title="R1 settings" />
          <GlassPanel className="mt-6">
            <p className="text-sm text-ink">
              Admin access required. R1 settings are available to admin operators only.
            </p>
          </GlassPanel>
        </div>
      );
    }
    return <ErrorPanel message={load.message} onRetry={read} />;
  }
  if (!saved || !draft) return <LoadingPanel label="Loading R1 settings…" />;

  const run = r1RunState(saved, saved.runtime);
  const dirty = !sameDraft(draft, draftFromSettings(saved));
  const cap = Number(draft.monthly_cap_minutes);
  const allocationKnown = Number.isInteger(cap) && cap > 0;
  const hold = saved.admission_hold_minutes ?? 55;
  // The pause line gates sends only on LiveKit Cloud; an unknown target is read as gating,
  // the cautious reading (as in Mission Control).
  const target: 'cloud' | 'r1' = saved.livekit_target === 'r1' ? 'r1' : 'cloud';
  // The dashboard reading feeds the Cloud pool's guard, so a stale one can block sends only
  // while the pool gates them.
  const readingStale =
    target === 'cloud' && isReadingStale(saved.dashboard_read_at, currentMonthStart());

  function update<K extends keyof R1SettingsDraft>(key: K, value: R1SettingsDraft[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setNotice(null);
    setSaveError(null);
    setConfirming(null);
    setErrors((current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function persist() {
    if (!saved || !draft) return;
    const patch = settingsPatch(draft, saved);
    setSaving(true);
    setSaveError(null);
    setNotice(null);
    try {
      const next = await api.updateR1Settings(patch);
      setSaved({ ...next, runtime: saved.runtime });
      setDraft(draftFromSettings(next));
      setConfirming(null);
      setNotice('Settings saved.');
    } catch (e) {
      setSaveError(
        e instanceof ApiError && e.status === 400
          ? 'The server rejected those values. Check the numbers and that hold is not above ' +
            'advance.'
          : e instanceof ApiError && e.status === 403
            ? 'Only an admin can change R1 settings.'
            : 'The settings could not be saved. Nothing was changed; try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!saved || !draft || saving) return;
    const found = validateSettingsDraft(draft);
    setErrors(found);
    const firstBad = FIELD_ORDER.find(([key]) => found[key]);
    if (firstBad) {
      document.getElementById(firstBad[1])?.focus();
      return;
    }
    const patch = settingsPatch(draft, saved);
    if (Object.keys(patch).length === 0) {
      setNotice('There are no changes to save.');
      return;
    }
    const reasons = needsConfirmation(patch);
    if (reasons.length > 0 && confirming === null) {
      setNotice(null);
      setConfirming(reasons);
      return;
    }
    void persist();
  }

  async function recordReading(event: FormEvent) {
    event.preventDefault();
    if (readingSaving) return;
    const minutes = parseDashboardMinutes(readingText);
    if (minutes === null) {
      setReadingError(
        'Enter the month-to-date minutes from the LiveKit dashboard, for example 1234.5.',
      );
      document.getElementById(`r1-reading-${uid}`)?.focus();
      return;
    }
    setReadingSaving(true);
    setReadingError(null);
    setNotice(null);
    try {
      const next = await api.updateR1Settings({
        dashboard_minutes: minutes,
        dashboard_read_at: new Date().toISOString(),
      });
      // The saved copy moves to the server's row. The main form keeps the person's own
      // unsaved edits and follows the server on every field they have not touched, so a
      // change another admin made (a pause) is not undone by the next Save.
      const previous = savedRef.current;
      if (previous) {
        setDraft((current) => (current ? rebaseDraft(current, previous, next) : current));
      }
      setSaved((current) => ({ ...next, runtime: current?.runtime }));
      setConfirming(null);
      setReadingText('');
      setNotice('Dashboard reading recorded.');
    } catch {
      setReadingError('The reading could not be saved. Nothing was changed; try again.');
    } finally {
      setReadingSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Operations"
        title="R1 settings"
        description={PAGE_DESCRIPTION}
        actions={
          <Link to="/mission-control#r1" className={buttonClass('secondary', 'md')}>
            Back to Mission Control
          </Link>
        }
      />

      <InlineNotice tone={NOTICE_TONE[run.tone]} role={run.tone === 'danger' ? 'alert' : 'status'}>
        <span className="font-medium">R1: {run.label}.</span> {run.detail}
      </InlineNotice>

      <form onSubmit={submit} noValidate className="space-y-6" aria-label="R1 settings">
        <GlassPanel as="section" aria-labelledby={`r1-switches-${uid}`}>
          <SectionHeader
            id={`r1-switches-${uid}`}
            level={2}
            title="Switches"
            description={SWITCHES_DESCRIPTION}
          />
          <div className="mt-4 space-y-4">
            <Switch
              id="r1-enabled"
              checked={draft.enabled}
              onCheckedChange={(next) => update('enabled', next)}
              label="R1 enabled"
              description="Off: no new links can be sent and no interview can start."
            />
            <Switch
              id="r1-paused"
              checked={draft.paused}
              onCheckedChange={(next) => update('paused', next)}
              label="Paused"
              description="Blocks new sends and new interview starts without switching R1 off."
            />
          </div>
        </GlassPanel>

        <GlassPanel as="section" aria-labelledby={`r1-allowance-${uid}`}>
          <SectionHeader
            id={`r1-allowance-${uid}`}
            level={2}
            title="Monthly allowance"
            description={
              `WebRTC minutes. Each send reserves ${hold} minutes of R1’s allocation. ` +
              ALLOWANCE_NOTE[target]
            }
            meta={allocationKnown ? `${formatMinutes(cap)} min R1 allocation` : undefined}
          />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="r1-monthly-cap"
              label="Monthly cap (minutes)"
              hint={capHint(hold)}
              error={errors.monthly_cap_minutes}
            >
              {({ id, describedBy, invalid }) => (
                <TextField
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft.monthly_cap_minutes}
                  onChange={(e) => update('monthly_cap_minutes', e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="r1-pause-line"
              label="Pause line (minutes)"
              hint={PAUSE_LINE_HINT[target]}
              error={errors.pause_line_minutes}
            >
              {({ id, describedBy, invalid }) => (
                <TextField
                  id={id}
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft.pause_line_minutes}
                  onChange={(e) => update('pause_line_minutes', e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </Field>
          </div>
        </GlassPanel>

        <GlassPanel as="section" aria-labelledby={`r1-scoring-${uid}`}>
          <SectionHeader
            id={`r1-scoring-${uid}`}
            level={2}
            title="Scoring and status"
            description={SCORING_DESCRIPTION}
          />
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              id="r1-advance-threshold"
              label="Advance threshold"
              hint="Default 65."
              error={errors.advance_threshold}
            >
              {({ id, describedBy, invalid }) => (
                <TextField
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.advance_threshold}
                  onChange={(e) => update('advance_threshold', e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </Field>
            <Field
              id="r1-hold-threshold"
              label="Hold threshold"
              hint="Default 45. Cannot be above advance."
              error={errors.hold_threshold}
            >
              {({ id, describedBy, invalid }) => (
                <TextField
                  id={id}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.hold_threshold}
                  onChange={(e) => update('hold_threshold', e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid || undefined}
                />
              )}
            </Field>
          </div>
          <div className="mt-4">
            <Switch
              id="r1-auto-status"
              checked={draft.auto_status_enabled}
              onCheckedChange={(next) => update('auto_status_enabled', next)}
              label="Automatic status changes"
              description={AUTO_STATUS_DESCRIPTION}
            />
          </div>
        </GlassPanel>

        {confirming && (
          <div
            ref={confirmRef}
            role="group"
            tabIndex={-1}
            aria-labelledby={`r1-confirm-${uid}`}
            className="glass-sunken rounded-[14px] p-4 outline-none focus-visible:ring-2 focus-visible:ring-info"
          >
            <h2 id={`r1-confirm-${uid}`} className="text-label font-medium text-ink">
              Confirm these changes
            </h2>
            <p className="mt-1 text-sm text-ink">
              Saving will {confirming.join(', and ')}.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                variant="primary"
                size="lg"
                loading={saving}
                onClick={() => void persist()}
              >
                Confirm and save
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="lg"
                disabled={saving}
                onClick={() => setConfirming(null)}
              >
                Keep editing
              </Button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="primary"
            size="lg"
            disabled={!dirty || saving || confirming !== null}
          >
            Save changes
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="lg"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(draftFromSettings(saved));
              setErrors({});
              setConfirming(null);
              setSaveError(null);
              setNotice(null);
            }}
          >
            Discard changes
          </Button>
          {saved.updated_at && (
            <span className="text-label text-ink-tertiary">
              Last saved {formatDateTime(saved.updated_at)}
            </span>
          )}
        </div>
      </form>

      {/* Always mounted, so a saved or failed message is announced reliably. */}
      <div role="status" className="min-h-5 text-sm text-ink">
        {notice}
      </div>
      {saveError && (
        <InlineNotice tone="danger" role="alert">
          {saveError}
        </InlineNotice>
      )}

      <GlassPanel as="section" aria-labelledby={`r1-reading-heading-${uid}`}>
        <SectionHeader
          id={`r1-reading-heading-${uid}`}
          level={2}
          title="LiveKit dashboard reading"
          description={READING_DESCRIPTION}
        />
        <p className="mt-3 text-sm text-ink-secondary">
          {saved.dashboard_read_at
            ? `Current reading: ${formatReading(Number(saved.dashboard_minutes))} min, ` +
              `read ${formatDateTime(saved.dashboard_read_at)}.`
            : 'No reading has been recorded yet.'}
        </p>
        {readingStale && saved.dashboard_read_at && (
          <InlineNotice tone="warning" role="status" className="mt-3">
            This reading is from {readingMonthLabel(saved.dashboard_read_at)}, but the capacity
            guard still counts it this month, so it can block sends. Record this month’s reading.
          </InlineNotice>
        )}
        <form
          onSubmit={(event) => void recordReading(event)}
          noValidate
          className="mt-3 flex flex-wrap items-end gap-3"
        >
          <Field
            id={`r1-reading-${uid}`}
            label="New reading (minutes)"
            error={readingError ?? undefined}
            className="w-full sm:w-64"
          >
            {({ id, describedBy, invalid }) => (
              <TextField
                id={id}
                inputMode="decimal"
                autoComplete="off"
                value={readingText}
                onChange={(e) => {
                  setReadingText(e.target.value);
                  setReadingError(null);
                }}
                aria-describedby={describedBy}
                aria-invalid={invalid || undefined}
              />
            )}
          </Field>
          <Button type="submit" variant="secondary" size="lg" loading={readingSaving}>
            Record reading
          </Button>
        </form>
      </GlassPanel>

      <p className="text-label text-ink-tertiary">
        Media server: {TARGET_LABEL[saved.livekit_target] ?? saved.livekit_target}. This is changed
        by deployment, not here.
      </p>
    </div>
  );
}
