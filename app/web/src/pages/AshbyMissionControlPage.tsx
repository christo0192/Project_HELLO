import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api';
import type {
  Role,
  AshbyJob,
  AshbyMcMapping,
  AshbyMcWorkflow,
  AshbyFeedbackForm,
  AshbyScorecardBindingPreview,
  AshbyScorecardBindingPreviewResponse,
  AshbyBacklogPreview,
} from '../types';
import {
  Button,
  buttonClass,
  Dialog,
  EmptyPanel,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  RevealGroup,
  RevealItem,
  ScrollArea,
  SectionHeader,
  StatusBadge,
  TextField,
} from '../components/design';
import type { StatusTone } from '../components/design';

/**
 * Ashby Mission Control — admin-gated HR surface for the Ashby screening
 * workflow. Shows job-mapping health (paused/drift/completeness) and the
 * per-application workflow state (lifecycle, terminal, ingestion, operations),
 * with audited actions (pause/resume/cancel/retry) and the manual invite
 * hand-off. All LIST data is sanitized by the API: no candidate PII, invite
 * tokens, presigned URLs, or transcripts. The APIs are authoritative; this UI
 * is admin-gated for UX only.
 *
 * ADDING A MAPPING: `Add mapping` opens a dialog with exactly two pickers — a
 * live OPEN Ashby job, shown by name, and an active dashboard role. There is
 * no stage field and no free-text label: the route fixes the screening stage
 * on create, and the label is simply the job's own title. A new mapping saves
 * PAUSED; Resume stays the separate, database-gated switch.
 *
 * DELETING A MAPPING: `Delete` ARCHIVES it. The row leaves this list, but the
 * calls, scores and history of every candidate it screened are kept, and
 * adding the same job again later brings the mapping back, paused. The
 * database refuses to archive an ENABLED mapping, so the button stays disabled
 * until the mapping is paused and says why in words, and it always asks
 * first, in a dialog that names the job.
 *
 * JOB NAMES, NEVER JOB IDS: an Ashby job id means nothing to the person
 * reading this page, and typing one by hand is how a mapping lands on the
 * wrong job with nothing on screen to show it. Rows name each job from the
 * live job list (falling back to the title saved as its label), and the
 * picker's option values are list positions, so no job id is rendered
 * anywhere — not as text, not in an option `value`, not in a `title` tooltip.
 * The ids stay inside handlers, where the API needs them.
 *
 * INVITE HANDLING: `Get invite link` calls the admin-only delivery endpoint,
 * which returns a one-time candidate URL. That URL is held in component state
 * ONLY — never localStorage/sessionStorage, never the page URL, never
 * telemetry — and the token rides in the URL fragment so it is not sent to any
 * server or written to an access log. The server keeps only its SHA-256
 * digest, so the link genuinely cannot be shown again; reissuing revokes the
 * previous one.
 *
 * FEEDBACK-FORM DISCOVERY: `Discover feedback form` calls an admin-only
 * READ-ONLY endpoint that performs one provider read of the job's interview
 * plan and returns form SCHEMA — opaque ids, labels, input types, and scale
 * options. It never returns a submitted answer, score, or comment, and it
 * changes nothing: the result is unverified reference material an admin copies
 * by hand into the approved configuration process. The ids are held in
 * component state only and are never logged or sent to analytics.
 */

/** Row separator inside a glass panel — a hairline, never a card border. */
const ROW = 'border-b border-glass-ring py-3 last:border-0';
/** Small neutral pill for ingestion / operation state. */
/**
 * Operator-facing form of a backend enum: underscores become spaces and the
 * first letter is capitalised. The raw value is kept in a `title` so the
 * exact vocabulary the API used stays one hover away.
 */
function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const PILL =
  'inline-flex items-center whitespace-nowrap rounded-full bg-ink/[0.05] px-2 py-0.5 text-xs text-ink-secondary';
/** Above this many rows the workflow list scrolls instead of running down the page. */
const WORKFLOW_SCROLL_AFTER = 6;
/**
 * The add-mapping dialog's native selects. `w-full min-w-0` because a native
 * select otherwise sizes itself to its LONGEST option, and one long job title
 * would push the dialog wider than a phone screen.
 */
const SELECT =
  'h-10 w-full min-w-0 rounded-control border border-glass-ring bg-surface px-3 text-sm text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info focus-visible:ring-offset-2 focus-visible:ring-offset-surface-secondary disabled:cursor-not-allowed disabled:opacity-60';
/**
 * The route's cap on a mapping `label` (its `MAX_LABEL_LEN`, counted in UTF-16
 * units like `String.length`). A longer job title would be refused whole as
 * `invalid_label`, so it is cut here instead.
 */
const MAX_MAPPING_LABEL = 120;
/**
 * Why an ENABLED mapping's Delete is disabled — the button's `title` and the
 * visible line under its row's actions, one string so the two cannot drift.
 */
const PAUSE_BEFORE_DELETE = 'Pause this mapping before deleting it';
/**
 * The `id` of that line, by the row's list POSITION — like the picker's
 * option values, so no id of any kind is written into the markup.
 */
const deleteHintId = (row: number): string => `ashby-mapping-delete-hint-${row}`;

export function AshbyMissionControlPage() {
  const [mappings, setMappings] = useState<AshbyMcMapping[]>([]);
  /**
   * Roles to point a new mapping at.
   *
   * A PICKER, not a uuid field. `role_id` is a uuid FK and the route rejects
   * anything else with `invalid_role_id`; asking an admin to paste one from
   * another tab is how you get a mapping pointed at the wrong role with no
   * way to notice — the id never appears on screen again.
   */
  const [roles, setRoles] = useState<Role[]>([]);
  /**
   * The live Ashby job list — every status, for naming mapping rows; the
   * dialog's picker narrows it to `Open`. `null` until the first read lands,
   * which is what lets a row say it is still loading rather than claim the
   * name is unavailable while Ashby is merely slow to answer.
   */
  const [jobs, setJobs] = useState<AshbyJob[] | null>(null);
  const [jobsStatus, setJobsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [jobsTruncated, setJobsTruncated] = useState(false);
  /**
   * Only the LATEST jobs read may land. The page-load read and the one the
   * dialog fires on open can overlap, and an older failure must not
   * overwrite a newer list — or an older list a newer failure.
   */
  const jobsRequest = useRef(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  /** Focus returns here when the dialog closes; `useModal` says why the caller owns it. */
  const addMappingTrigger = useRef<HTMLButtonElement | null>(null);
  /**
   * `jobKey` is a POSITION in the picker's current list, not a job id — that
   * is what keeps the id out of the DOM. A position only means something
   * against the list it was picked from, so every jobs read clears it.
   */
  const [draft, setDraft] = useState({ jobKey: '', roleId: '' });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /**
   * The mapping the Delete confirmation is about. A SNAPSHOT of the row, not
   * an id looked up in `mappings`: a reload after `not_found` drops the row
   * from the list, and the open dialog must go on naming the job it asked
   * about.
   */
  const [deleteTarget, setDeleteTarget] = useState<AshbyMcMapping | null>(null);
  const [deleting, setDeleting] = useState(false);
  /**
   * `retryable: false` when pressing Delete again cannot succeed — the
   * mapping is already gone, or is enabled — so the confirm button turns off
   * and Cancel is the way out.
   */
  const [deleteError, setDeleteError] = useState<{ message: string; retryable: boolean } | null>(
    null,
  );
  /**
   * Where focus goes when the Delete confirmation closes.
   *
   * ONE ref, pointed at the clicked Delete button from its own click handler
   * (`e.currentTarget`) — not a ref per row. `Button` does not forward refs,
   * so a per-row ref map would mean hand-rolling six plain `<button>`s per
   * row; and the click is the one moment that knows exactly which row's
   * button opened the dialog. `useModal` reads the ref at CLOSE, so
   * `closeDeleteDialog` re-points it first whenever that button can no
   * longer take focus.
   */
  const deleteReturnFocus = useRef<HTMLElement | null>(null);
  const [workflows, setWorkflows] = useState<AshbyMcWorkflow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /**
   * The one-time invite link for a single application, held in COMPONENT STATE
   * ONLY. It is never written to localStorage/sessionStorage, never put in the
   * URL, and never sent to analytics — the API returns it exactly once and the
   * server keeps only its SHA-256 digest.
   */
  const [invite, setInvite] = useState<
    { linkId: string; joinUrl: string; expiresAt: string } | null
  >(null);
  const [inviteError, setInviteError] = useState<{ linkId: string; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * Discovered feedback-form schema for ONE mapping, held in component state
   * only. Never persisted, never logged, never sent to analytics — these are
   * tenant configuration ids, and this view is read-only reference material.
   */
  const [formSchema, setFormSchema] = useState<
    { jobId: string; forms: AshbyFeedbackForm[]; truncated: boolean } | null
  >(null);
  const [formError, setFormError] = useState<{ jobId: string; message: string } | null>(null);
  /**
   * Read-only scorecard binding preview for ONE mapping (issue #275). Same
   * discipline as the schema panel: structure only, nothing is bound by
   * viewing it.
   */
  const [bindingPreview, setBindingPreview] = useState<
    { mappingId: string; scoringPath: NonNullable<AshbyScorecardBindingPreviewResponse['scoringPath']>; preview: AshbyScorecardBindingPreview } | null
  >(null);
  const [bindingError, setBindingError] = useState<{ mappingId: string; message: string } | null>(null);
  const [backlogPreview, setBacklogPreview] = useState<{ mappingId: string; preview: AshbyBacklogPreview } | null>(null);
  const [backlogError, setBacklogError] = useState<{ mappingId: string; message: string } | null>(null);
  const [backlogConfirmArmed, setBacklogConfirmArmed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([api.listAshbyMappings(), api.listAshbyWorkflows()]);
      setMappings(m.mappings);
      // Best effort. A failure here costs the picker, not the page — the
      // mapping list and its pause/resume actions are what this screen is
      // for, and they do not need roles.
      void api
        .listRoles()
        .then((r) => setRoles(r.filter((role) => role.is_active)))
        .catch(() => setRoles([]));
      setWorkflows(w.workflows);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load Mission Control');
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Read the live job list. Best effort, like roles: a failure costs the job
   * names and the picker, never the page. It runs on page load for the row
   * names, and again every time the dialog opens because the list is LIVE —
   * a job opened in Ashby a minute ago should be pickable without a reload.
   * Deliberately not part of `load()`: that runs after every row action, and
   * a pause should not cost a provider read.
   */
  const loadJobs = useCallback(async () => {
    const ticket = ++jobsRequest.current;
    setJobsStatus('loading');
    setJobsError(null);
    setDraft((d) => ({ ...d, jobKey: '' }));
    try {
      const res = await api.listAshbyJobs();
      if (ticket !== jobsRequest.current) return;
      setJobs(res.jobs ?? []);
      setJobsTruncated(res.truncated === true);
      setJobsStatus('ready');
    } catch (e) {
      if (ticket !== jobsRequest.current) return;
      setJobsError(jobsErrorCopy(e));
      setJobsStatus('error');
    }
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  /** Row names: every job with a usable title, whatever its status. */
  const jobTitles = useMemo(() => {
    if (jobs === null) return null;
    const titles = new Map<string, string>();
    for (const job of jobs) {
      const title = job.title?.trim();
      if (title) titles.set(job.id, title);
    }
    return titles;
  }, [jobs]);
  /** The first jobs read is still in flight — "unavailable" would be a false alarm. */
  const jobsPending = jobTitles === null && jobsStatus === 'loading';

  /**
   * The picker: OPEN jobs only, in the API's title order, each labelled
   * uniquely without an id. A job that is already mapped stays LISTED but
   * disabled — dropping it would read as "Ashby has no such job" to an admin
   * looking for it.
   */
  const jobOptions = useMemo(() => {
    const open = (jobs ?? []).filter((job) => job.status === 'Open');
    const labels = jobOptionLabels(open);
    const mapped = new Set(mappings.map((m) => m.externalJobId));
    return open.map((job, i) => ({ job, label: labels[i], mapped: mapped.has(job.id) }));
  }, [jobs, mappings]);

  const chosenJob = draft.jobKey === '' ? null : (jobOptions[Number(draft.jobKey)] ?? null);
  const canSave = chosenJob !== null && !chosenJob.mapped && draft.roleId !== '';
  const noOpenJobs = jobsStatus === 'ready' && jobOptions.length === 0;
  const jobsClipped = jobsStatus === 'ready' && jobsTruncated;
  /** Whatever sits under the job picker also DESCRIBES it, for a screen reader. */
  const hasJobNote = jobsStatus === 'error' || noOpenJobs || jobsClipped;

  /** Each opening is a fresh form over a fresh read of the job list. */
  const openDialog = useCallback(() => {
    setDraft({ jobKey: '', roleId: '' });
    setCreateError(null);
    setDialogOpen(true);
    void loadJobs();
  }, [loadJobs]);

  const closeDialog = useCallback(() => setDialogOpen(false), []);

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      try {
        const res = await action();
        if (!res.ok) setError(res.error ?? 'Action rejected');
        else setError(null);
        await load();
      } catch (e) {
        setError(e instanceof ApiError ? e.message : 'Action failed');
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  /** Request a fresh invite link for one application (admin-only server-side). */
  const deliverInvite = useCallback(
    async (linkId: string) => {
      setBusy(true);
      setInviteError(null);
      setCopied(false);
      try {
        const res = await api.deliverAshbyManualInvite(linkId);
        if (res.ok && res.join_url && res.expires_at) {
          setInvite({ linkId, joinUrl: res.join_url, expiresAt: res.expires_at });
        } else {
          setInvite(null);
          setInviteError({ linkId, message: res.error ?? 'Could not issue an invite link' });
        }
      } catch (e) {
        setInvite(null);
        setInviteError({
          linkId,
          message: e instanceof ApiError ? e.message : 'Could not issue an invite link',
        });
      } finally {
        setBusy(false);
        // Reload so the delivery operation's new state is reflected truthfully.
        await load();
      }
    },
    [load],
  );

  const copyInvite = useCallback(async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.joinUrl);
      setCopied(true);
    } catch {
      // Clipboard can be denied; the link stays selectable in the field.
      setCopied(false);
    }
  }, [invite]);

  /**
   * Read the feedback-form schema for one job. Read-only end to end: the API
   * performs a single provider READ and writes nothing, and this handler binds
   * nothing — it only renders what came back.
   */
  const discoverForm = useCallback(async (externalJobId: string) => {
    setBusy(true);
    setFormError(null);
    setFormSchema(null);
    try {
      const res = await api.discoverAshbyFeedbackForm(externalJobId);
      if (res.ok) {
        setFormSchema({ jobId: externalJobId, forms: res.forms ?? [], truncated: res.truncated === true });
      } else {
        setFormError({ jobId: externalJobId, message: res.error ?? 'Could not read the feedback form' });
      }
    } catch (e) {
      setFormError({
        jobId: externalJobId,
        message: e instanceof ApiError ? e.message : 'Could not read the feedback form',
      });
    } finally {
      setBusy(false);
    }
  }, []);

  /**
   * Preview what a v2 scorecard write would bind for this mapping's role.
   * Read-only end to end: the API performs one provider READ of the verified
   * form definition plus two table reads, writes nothing, and this handler
   * only renders the result.
   */
  const previewBinding = useCallback(async (mappingId: string) => {
    setBusy(true);
    setBindingError(null);
    setBindingPreview(null);
    try {
      const res = await api.previewAshbyScorecardBinding(mappingId);
      if (res.ok && res.preview && res.scoringPath) {
        setBindingPreview({ mappingId, scoringPath: res.scoringPath, preview: res.preview });
      } else {
        setBindingError({ mappingId, message: bindingErrorCopy(res.error) });
      }
    } catch (e) {
      setBindingError({
        mappingId,
        message: e instanceof ApiError ? e.message : 'Could not preview the scorecard binding',
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const previewBacklog = useCallback(async (mappingId: string) => {
    setBusy(true);
    setBacklogError(null);
    setBacklogPreview(null);
    setBacklogConfirmArmed(false);
    try {
      const res = await api.previewAshbyBacklog(mappingId);
      if (res.ok && res.preview) setBacklogPreview({ mappingId, preview: res.preview });
      else setBacklogError({ mappingId, message: backlogErrorCopy(res.error) });
    } catch (e) {
      setBacklogError({ mappingId, message: e instanceof ApiError ? backlogErrorCopy(e.message) : 'Could not preview the existing backlog' });
    } finally {
      setBusy(false);
    }
  }, []);

  const confirmBacklog = useCallback(async (mappingId: string, preview: AshbyBacklogPreview) => {
    if (!backlogConfirmArmed) return;
    setBusy(true);
    setBacklogError(null);
    try {
      const res = await api.confirmAshbyBacklog(mappingId, preview.runId, preview.expectedCount);
      if (!res.ok) setBacklogError({ mappingId, message: backlogErrorCopy(res.error ?? res.status) });
      else { setBacklogPreview(null); setBacklogConfirmArmed(false); await load(); }
    } catch (e) {
      setBacklogError({ mappingId, message: e instanceof ApiError ? backlogErrorCopy(e.message) : 'Could not confirm the backlog import' });
    } finally {
      setBusy(false);
    }
  }, [backlogConfirmArmed, load]);

  /**
   * Create the mapping. It always lands PAUSED — enabling is the separate
   * Resume action, which the database still gates on stage completeness and
   * absence of drift.
   */
  const createMapping = useCallback(async () => {
    if (creating || !chosenJob || chosenJob.mapped || !draft.roleId) return;
    setCreateError(null);
    setCreating(true);
    try {
      // The job's own title becomes the label — trimmed, cut to the route's
      // cap, and OMITTED when Ashby gave the job no title. It is what a row
      // falls back to when the live job list cannot be read.
      const label = chosenJob.job.title?.trim().slice(0, MAX_MAPPING_LABEL).trim();
      // The return value is unused on purpose: success is the ABSENCE of a
      // throw, since `apiClient.request` raises on every non-2xx. `npm run
      // build` uses a stricter tsconfig than `test:typecheck` and refused the
      // dead binding — the gate that catches this is the build, not the
      // typecheck.
      await api.createAshbyMapping({
        external_job_id: chosenJob.job.id,
        role_id: draft.roleId,
        // NO STAGE KEYS, not even as `undefined`. The route defaults both
        // stage ids on create to the fixed screening stage; the admin has no
        // stage to choose, so the request has none to carry.
        ...(label ? { label } : {}),
      });
      // NO `!res.ok` BRANCH. `apiClient.request` throws `ApiError` on every
      // non-2xx, and this route only ever emits `ok:false` with 400/409/500 —
      // so that branch was unreachable and every admin saw the raw machine
      // code (`invalid_external_job_id`) that `mappingErrorCopy` exists to
      // translate. The test that "pinned" the copy mocked a resolved
      // `{ok:false}`, a shape the API layer cannot produce, so it was vacuous.
      setDialogOpen(false);
      setDraft({ jobKey: '', roleId: '' });
      await load();
    } catch (err) {
      // The thrown message IS the route's machine code, so translate it here
      // — this is the only path a failure actually takes. The dialog stays
      // open with both choices intact, and the reason renders inside it.
      setCreateError(
        err instanceof ApiError
          ? mappingErrorCopy(err.message)
          : 'Could not create the mapping. Try again.',
      );
    } finally {
      setCreating(false);
    }
  }, [creating, chosenJob, draft.roleId, load]);

  const openDeleteDialog = useCallback((mapping: AshbyMcMapping, trigger: HTMLElement) => {
    deleteReturnFocus.current = trigger;
    setDeleteError(null);
    setDeleteTarget(mapping);
  }, []);

  /**
   * Cancel, Close, Escape and the backdrop all land here. Focus goes back to
   * the row's Delete button when that button can take it. When it cannot —
   * the row is gone after a reload, or the reload found the mapping enabled
   * and its Delete is now disabled — `focus()` would fail SILENTLY and strand
   * the keyboard user on `<body>`, so focus goes to this section's own `Add
   * mapping` control instead: the nearest stable thing in the same list.
   */
  const closeDeleteDialog = useCallback(() => {
    const trigger = deleteReturnFocus.current;
    if (!trigger || !document.contains(trigger) || trigger.matches(':disabled')) {
      deleteReturnFocus.current = addMappingTrigger.current;
    }
    setDeleteTarget(null);
  }, []);

  /**
   * Archive the mapping ("Delete"). Success is the ABSENCE of a throw, as with
   * create: the route answers 200 `{ ok, already_archived }` and throws
   * `ApiError` — its message the route's code — on everything else. A repeat
   * (`already_archived`) is the outcome the admin asked for, so it is
   * success too.
   */
  const deleteMapping = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleteError(null);
    setDeleting(true);
    try {
      await api.archiveAshbyMapping(deleteTarget.id);
      // The row is about to leave the list, so its button cannot take focus
      // back; say where focus goes rather than let it fall to `<body>`.
      deleteReturnFocus.current = addMappingTrigger.current;
      setDeleteTarget(null);
      await load();
    } catch (err) {
      const code = err instanceof ApiError ? err.message : undefined;
      // Either code means the list on screen is WRONG about this row: it is
      // already gone, or it is enabled after all. Reload so the page tells
      // the truth — for `mapping_enabled` that is what turns this row's Pause
      // back on, since a row still showing "paused" has Pause disabled and no
      // way to follow the advice below. It reloads BEFORE the reason shows,
      // while the dialog is still busy, so the list is settled by the time
      // anything can close the dialog and pick a place to return focus.
      const stale = code === 'not_found' || code === 'mapping_enabled';
      if (stale) await load();
      setDeleteError({ message: deleteErrorCopy(code), retryable: !stale });
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, load]);

  const mappingTone = (status: string): StatusTone =>
    status === 'enabled' ? 'success' : status === 'drift' ? 'danger' : 'warning';

  const workflowRows = (
    <ul>
      {workflows.map((w) => (
        <li key={w.applicationLinkId} className={ROW}>
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-mono text-[13px] text-ink">{w.externalApplicationId}</span>
              <StatusBadge
                tone={
                  w.terminalState != null
                    ? 'danger'
                    : w.lifecycle === 'writeback_pending'
                      ? 'info'
                      : 'neutral'
                }
              >
                <span title={w.lifecycle}>{humanize(w.lifecycle)}</span>
              </StatusBadge>
              {w.terminalState && (
                <StatusBadge tone="danger">
                  <span title={w.terminalState}>{humanize(w.terminalState)}</span>
                </StatusBadge>
              )}
              {w.ingestionState && (
                <span className={PILL} title={w.ingestionState}>
                  Ingest · {humanize(w.ingestionState)}
                </span>
              )}
              {/* A completed screening whose link never reached
                  `writeback_pending` is a completion park that did not
                  land. The observer is best-effort by design (it must
                  never discard a scored assessment), so this is where that
                  case becomes visible instead of living only in a log. */}
              {w.sessionStatus === 'completed'
                && w.terminalState == null
                && w.lifecycle !== 'writeback_pending' && (
                <StatusBadge tone="warning">screened: not parked</StatusBadge>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              {w.sessionId && w.sessionStatus === 'completed' && (
                <a
                  href={`/sessions/${encodeURIComponent(w.sessionId)}`}
                  className={buttonClass('secondary', 'sm')}
                >
                  Review screening
                </a>
              )}
              <Button
                size="sm"
                disabled={busy || w.terminalState != null}
                onClick={() => void deliverInvite(w.applicationLinkId)}
              >
                {w.operations.some(
                  (op) => op.type === 'invite_delivery' && op.state === 'succeeded',
                )
                  ? 'Reissue invite link'
                  : 'Get invite link'}
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={busy || w.terminalState != null}
                onClick={() => run(() => api.cancelAshbyWorkflow(w.applicationLinkId, 'manual_stage_cancel'))}
              >
                Cancel
              </Button>
            </div>
          </div>

          {inviteError?.linkId === w.applicationLinkId && (
            <InlineNotice tone="danger" role="alert" className="mt-3">
              {inviteError.message}
            </InlineNotice>
          )}

          {invite?.linkId === w.applicationLinkId && (
            <div className="glass-sunken mt-3 p-3">
              {/*
                The one-time candidate link. It lives in component state only —
                it is not stored, not logged, and the token sits in the URL
                fragment so it never reaches a server or an access log.
              */}
              <label
                htmlFor={`invite-${w.applicationLinkId}`}
                className="block text-[13px] font-medium text-ink-secondary"
              >
                Candidate link — shown once, expires{' '}
                {new Date(invite.expiresAt).toLocaleString()}
              </label>
              <div className="mt-2 flex items-center gap-2">
                <TextField
                  id={`invite-${w.applicationLinkId}`}
                  size="sm"
                  readOnly
                  value={invite.joinUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  className="font-mono"
                />
                <Button size="sm" className="shrink-0" onClick={() => void copyInvite()}>
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <p className="mt-2 text-[13px] leading-5 text-ink-tertiary">
                Send this to the candidate yourself. It is not stored anywhere and cannot be
                shown again — reissue to get a new one, which revokes this link.
              </p>
            </div>
          )}
          {w.operations.length > 0 && (
            <ul className="mt-2 flex flex-wrap items-center gap-2">
              {w.operations.map((op) => (
                <li key={op.id} className="flex items-center gap-1.5">
                  <span className={PILL} title={`${op.type}:${op.state}`}>
                    {humanize(op.type)} · {humanize(op.state)}
                    {op.errorCode ? ` (${op.errorCode})` : ''}
                  </span>
                  {op.state === 'failed' && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => run(() => api.retryAshbyOperation(op.id))}
                    >
                      Retry
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Ashby Mission Control"
        description="Screening-workflow health and controls. Data is sanitized — no candidate PII or tokens."
        actions={
          <Link to="/mission-control" className={buttonClass('secondary', 'sm')}>
            Mission Control
          </Link>
        }
      />

      {!loaded && <LoadingPanel />}
      {error && (
        <InlineNotice tone="danger" role="alert" className="mt-6">
          {error}
        </InlineNotice>
      )}

      <RevealGroup className="mt-6 flex flex-col gap-6">
        <RevealItem>
          <GlassPanel>
            <SectionHeader
              level={2}
              title="Job mappings"
              meta={
                loaded ? (
                  <span className="text-[13px] text-ink-tertiary">{mappings.length}</span>
                ) : undefined
              }
              actions={
                // A plain button, not `<Button>`: that component does not
                // forward a ref, and the dialog returns focus HERE on close.
                <button
                  ref={addMappingTrigger}
                  type="button"
                  className={buttonClass('ghost', 'sm')}
                  onClick={openDialog}
                  aria-haspopup="dialog"
                >
                  Add mapping
                </button>
              }
            />

            {loaded && mappings.length === 0 ? (
              <EmptyPanel compact className="mt-4" title="No mappings." />
            ) : (
              <ul className="mt-2">
                {mappings.map((m, i) => (
                  <li key={m.id} className={ROW}>
                    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <MappingName mapping={m} jobTitles={jobTitles} jobsPending={jobsPending} />
                        <StatusBadge tone={mappingTone(m.status)}>{m.status}</StatusBadge>
                        {!(m.hasAiStage && m.hasTaStage) && <StatusBadge>incomplete</StatusBadge>}
                        {m.statusReason && (
                          <span className="text-[13px] text-ink-tertiary">{m.statusReason}</span>
                        )}
                      </div>
                      {/* The same wrapper on EVERY row, hint or not, so a
                          status change never remounts the buttons — the
                          Delete button the dialog returns focus to must be
                          the node that is still on the page. */}
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            disabled={busy || m.status === 'paused'}
                            onClick={() => run(() => api.pauseAshbyMapping(m.id))}
                          >
                            Pause
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy || m.status === 'enabled' || !(m.hasAiStage && m.hasTaStage)}
                            onClick={() => run(() => api.resumeAshbyMapping(m.id))}
                          >
                            Resume
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void discoverForm(m.externalJobId)}
                          >
                            Discover feedback form
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy}
                            onClick={() => void previewBinding(m.id)}
                          >
                            Preview scorecard binding
                          </Button>
                          <Button
                            size="sm"
                            disabled={busy || m.status !== 'enabled'}
                            onClick={() => void previewBacklog(m.id)}
                          >
                            Preview existing backlog
                          </Button>
                          {/*
                            HOW A DISABLED DELETE SAYS WHY. A `title` alone
                            reaches almost nobody: a `disabled` button is out
                            of the tab order, so a keyboard user never lands on
                            it and never sees the tooltip; touch has no hover;
                            and screen readers announce `title` unevenly. Text
                            on the page reaches everyone, so an ENABLED row
                            gets one short line under its actions, and
                            `aria-describedby` ties that line to the button —
                            a screen reader that browses onto the disabled
                            control hears the reason with it. The `title`
                            stays for a mouse hover.
                            Not `aria-disabled` (focusable but inert): that
                            puts a dead stop in the tab order of every enabled
                            row, where Pause and Resume beside it are plainly
                            `disabled` — one row, one convention. The line
                            shows on enabled rows ONLY, so it costs a paused
                            list nothing.
                          */}
                          <Button
                            variant="danger"
                            size="sm"
                            disabled={busy || m.status === 'enabled'}
                            title={m.status === 'enabled' ? PAUSE_BEFORE_DELETE : undefined}
                            aria-describedby={m.status === 'enabled' ? deleteHintId(i) : undefined}
                            aria-haspopup="dialog"
                            onClick={(e) => openDeleteDialog(m, e.currentTarget)}
                          >
                            Delete
                          </Button>
                        </div>
                        {m.status === 'enabled' && (
                          <p id={deleteHintId(i)} className="text-[13px] text-ink-tertiary">
                            {PAUSE_BEFORE_DELETE}
                          </p>
                        )}
                      </div>
                    </div>

                    {formError?.jobId === m.externalJobId && (
                      <InlineNotice tone="danger" role="alert" className="mt-3">
                        {formError.message}
                      </InlineNotice>
                    )}

                    {formSchema?.jobId === m.externalJobId && (
                      <FeedbackFormSchema forms={formSchema.forms} truncated={formSchema.truncated} />
                    )}

                    {bindingError?.mappingId === m.id && (
                      <InlineNotice tone="danger" role="alert" className="mt-3">
                        {bindingError.message}
                      </InlineNotice>
                    )}

                    {bindingPreview?.mappingId === m.id && (
                      <ScorecardBindingPreviewPanel
                        scoringPath={bindingPreview.scoringPath}
                        preview={bindingPreview.preview}
                      />
                    )}

                    {backlogError?.mappingId === m.id && (
                      <InlineNotice tone="danger" role="alert" className="mt-3">
                        {backlogError.message}
                      </InlineNotice>
                    )}

                    {backlogPreview?.mappingId === m.id && (() => {
                      const p = backlogPreview.preview;
                      const expired = Date.parse(p.expiresAt) <= Date.now();
                      const atCap = p.expectedCount >= p.cap;
                      return (
                        <div className="glass-sunken mt-3 p-3" role="region" aria-label="Backlog import preview">
                          <p className="text-[13px] font-medium text-ink">
                            {expired ? 'This preview has expired.' : `This snapshot contains ${p.expectedCount} existing application${p.expectedCount === 1 ? '' : 's'} from this job and stage.`}
                          </p>
                          <p className="mt-1 text-[13px] leading-5 text-ink-secondary">
                            Default behavior is future stage entries only. Confirmation schedules only this exact snapshot; completed or already-deduplicated applications may be no-ops, and existing phone engagements are not cancelled by this policy. The snapshot expires {new Date(p.expiresAt).toLocaleString()} and is capped at {p.cap} applications.
                          </p>
                          {atCap && !expired && <p className="mt-2 text-[13px] text-warning-text">This preview is at the safety cap; narrow the mapping or ask an operator to review before importing.</p>}
                          <label className="mt-3 flex items-start gap-2 text-[13px] text-ink-secondary">
                            <input type="checkbox" checked={backlogConfirmArmed} disabled={busy || expired} onChange={(e) => setBacklogConfirmArmed(e.target.checked)} />
                            <span>I understand this is an explicit provider-backed import and may create screening work.</span>
                          </label>
                          <div className="mt-3 flex items-center gap-2">
                            <Button size="sm" disabled={busy || expired || !backlogConfirmArmed} onClick={() => void confirmBacklog(m.id, p)}>
                              {busy ? 'Confirming…' : 'Confirm and import this snapshot'}
                            </Button>
                            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setBacklogPreview(null); setBacklogConfirmArmed(false); }}>
                              Cancel
                            </Button>
                          </div>
                        </div>
                      );
                    })()}
                  </li>
                ))}
              </ul>
            )}
          </GlassPanel>
        </RevealItem>

        <RevealItem>
          <GlassPanel>
            <SectionHeader
              level={2}
              title="Application workflows"
              meta={
                loaded ? (
                  <span className="text-[13px] text-ink-tertiary">{workflows.length}</span>
                ) : undefined
              }
            />
            {loaded && workflows.length === 0 ? (
              <EmptyPanel compact className="mt-4" title="No workflows." />
            ) : workflows.length > WORKFLOW_SCROLL_AFTER ? (
              <ScrollArea maxHeight="36rem" label="Application workflows" className="mt-1">
                {workflowRows}
              </ScrollArea>
            ) : (
              <div className="mt-2">{workflowRows}</div>
            )}
          </GlassPanel>
        </RevealItem>
      </RevealGroup>

      {/* OUTSIDE the RevealGroup, at the page root, on purpose: a revealed
          item can carry a transform while it animates, and a transformed
          ancestor is the containing block for a `position: fixed` overlay —
          the dialog would centre on the panel instead of the viewport. */}
      <Dialog
        open={dialogOpen}
        onClose={closeDialog}
        idPrefix="ashby-mapping"
        title="Add job mapping"
        description="Point a live Ashby job at a dashboard role. It saves paused — use Resume to turn it on."
        returnFocusRef={addMappingTrigger}
        busy={creating}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void createMapping();
          }}
        >
          {/*
            * WHY THIS DIALOG EXISTS. The endpoint shipped with the integration
            * and nothing called it, so pointing a new Ashby job at a role
            * meant a hand-rolled authenticated POST. The first form that
            * replaced that asked for a typed job id and two stage ids; this
            * asks for two choices, both made by name.
            */}
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="ashby-mapping-job" className="text-[13px] font-medium text-ink">
              Ashby job
            </label>
            <select
              id="ashby-mapping-job"
              className={SELECT}
              value={draft.jobKey}
              onChange={(e) => setDraft((d) => ({ ...d, jobKey: e.target.value }))}
              disabled={creating || jobsStatus !== 'ready' || jobOptions.length === 0}
              aria-describedby={hasJobNote ? 'ashby-mapping-job-note' : undefined}
              required
            >
              <option value="">
                {jobsStatus === 'loading' ? 'Loading jobs from Ashby…' : 'Choose a job…'}
              </option>
              {jobsStatus === 'ready' &&
                jobOptions.map((o, i) => (
                  // `value` is the POSITION, never `o.job.id` — see `draft`.
                  // The React `key` may be the id: keys never reach the DOM.
                  <option key={o.job.id} value={String(i)} disabled={o.mapped}>
                    {o.mapped ? `${o.label} — already mapped` : o.label}
                  </option>
                ))}
            </select>
            {hasJobNote && (
              <div id="ashby-mapping-job-note" className="mt-1 flex flex-col gap-2">
                {jobsStatus === 'error' && (
                  <InlineNotice
                    tone="danger"
                    role="alert"
                    action={
                      <Button size="sm" onClick={() => void loadJobs()}>
                        Try again
                      </Button>
                    }
                  >
                    {jobsError}
                  </InlineNotice>
                )}
                {noOpenJobs && (
                  <InlineNotice tone="neutral">There are no open jobs in Ashby right now.</InlineNotice>
                )}
                {jobsClipped && (
                  // Say it rather than let a short list pass for the whole
                  // of Ashby: the one job an admin came for may be past the
                  // cut, and nothing else on screen would show it.
                  <InlineNotice tone="warning">
                    Ashby returned more jobs than this list can show. If a job is missing, ask an
                    engineer.
                  </InlineNotice>
                )}
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="ashby-mapping-role" className="text-[13px] font-medium text-ink">
              Role
            </label>
            <select
              id="ashby-mapping-role"
              className={SELECT}
              value={draft.roleId}
              onChange={(e) => setDraft((d) => ({ ...d, roleId: e.target.value }))}
              disabled={creating}
              required
            >
              <option value="">Choose a role…</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.agent_name ? `${role.title} — ${role.agent_name}` : role.title}
                </option>
              ))}
            </select>
          </div>

          {createError && (
            // `text-error-text`, not `text-danger`. Tailwind here defines
            // `error`, not `danger`, so `text-danger` compiles to nothing
            // and the message rendered as ordinary body ink — it read as
            // help text rather than a failure. `Field` already uses this
            // token for exactly this.
            <p role="alert" className="text-[13px] text-error-text">
              {createError}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={closeDialog} disabled={creating}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={creating} disabled={!canSave}>
              {creating ? 'Saving…' : 'Save mapping'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Also at the page root, for the same reason as the dialog above.
          The job's NAME is the dialog's `description`: it renders straight
          under the title, and it is what a screen reader announces with the
          title when the dialog opens — "which mapping?" answered before
          anything else. The same naming rule as the row, so the dialog
          never names the job differently from the row it came from. */}
      <Dialog
        open={deleteTarget !== null}
        onClose={closeDeleteDialog}
        idPrefix="ashby-mapping-delete"
        title="Delete this mapping?"
        description={deleteTarget ? mappingName(deleteTarget, jobTitles, jobsPending) : undefined}
        returnFocusRef={deleteReturnFocus}
        busy={deleting}
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-ink-secondary">
            It stops screening for good and disappears from this list. Candidates already screened —
            their calls, scores and history — are kept. Adding this job again later brings the
            mapping back, paused.
          </p>

          {deleteError && (
            <p role="alert" className="text-[13px] text-error-text">
              {deleteError.message}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleting}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={deleting}
              disabled={deleteError?.retryable === false}
              onClick={() => void deleteMapping()}
            >
              {deleting ? 'Deleting…' : 'Delete mapping'}
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * Read-only rendering of discovered feedback-form SCHEMA.
 *
 * Every value here is form STRUCTURE that the API already sanitized — opaque
 * ids, bounded labels, input types, and scale options. There is no submitted
 * answer, score, comment, or candidate field in this data, and nothing is
 * persisted: an admin copies the ids by hand into the approved configuration
 * process. It is labelled unverified because a form the plan merely NAMES may
 * carry fields this read cannot see.
 */
function FeedbackFormSchema({ forms, truncated }: { forms: AshbyFeedbackForm[]; truncated: boolean }) {
  return (
    <div className="glass-sunken mt-3 p-4">
      <SectionHeader
        level={3}
        title="Feedback form schema — read-only, unverified"
        description="Structure only — no feedback content, scores, or comments are read. Nothing is saved or bound to write-back; copy the ids by hand into the approved configuration process."
      />
      {truncated && (
        <InlineNotice tone="warning" className="mt-3">
          Result was truncated by a safety bound — this view is partial.
        </InlineNotice>
      )}
      {forms.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-secondary">
          No feedback form is named in this job&apos;s interview plan.
        </p>
      ) : (
        <ul className="mt-3">
          {forms.map((f) => (
            <li
              key={f.formDefinitionId}
              className="border-t border-glass-ring pt-3 first:border-0 first:pt-0 [&+li]:mt-3"
            >
              <p className="text-sm font-medium text-ink">{f.title ?? 'Untitled form'}</p>
              <p className="font-mono text-[13px] text-ink-secondary">form id: {f.formDefinitionId}</p>
              {(f.stageTitle || f.stageId) && (
                <p className="text-[13px] text-ink-tertiary">
                  stage: {f.stageTitle ?? 'untitled'}
                  {f.stageId ? ` (${f.stageId})` : ''}
                </p>
              )}
              {(f.interviewTitle || f.interviewId) && (
                <p className="text-[13px] text-ink-tertiary">
                  interview: {f.interviewTitle ?? 'untitled'}
                  {f.interviewId ? ` (${f.interviewId})` : ''}
                </p>
              )}
              {!f.schemaAvailable ? (
                <p className="mt-2 text-[13px] leading-5 text-warning-text">
                  Field-level schema is not available from the interview plan for this form — only
                  its id could be read. This is not a claim that the form has no fields.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-[13px] text-ink-tertiary">{f.fieldCount} field(s)</p>
                  {f.sections.map((sec, si) => (
                    <div key={sec.id ?? `section-${si}`} className="mt-2">
                      <p className="text-[13px] font-medium text-ink-secondary">
                        {sec.title ?? 'Untitled section'}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {sec.fields.map((field) => (
                          <li key={field.id} className="text-[13px] leading-5 text-ink-secondary">
                            <span className="font-mono">{field.id}</span>
                            {' — '}
                            {field.title ?? 'untitled'}
                            {field.path ? ` [${field.path}]` : ''}
                            {field.type ? ` · ${field.type}` : ''}
                            {field.required === null
                              ? ' · required: unknown'
                              : field.required
                                ? ' · required'
                                : ' · optional'}
                            {field.options.length > 0 && (
                              <span className="text-ink-tertiary">
                                {' · scale: '}
                                {field.options
                                  .map((o) => (o.label ?? o.value ?? '').trim())
                                  .filter((t) => t.length > 0)
                                  .join(' | ')}
                                {field.optionsTruncated ? ' …' : ''}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Sanitized API error code → HR-readable copy. Never echoes provider text. */
/**
 * The route's machine codes, in words an admin can act on.
 *
 * The dialog has two pickers and nothing typed, so a code either points at
 * one of the two choices or at something the admin cannot fix from here —
 * and then the copy says who can, rather than inviting a retry that will
 * fail the same way. No stage or label field is named: there is none.
 */
function mappingErrorCopy(code: string | undefined): string {
  switch (code) {
    case 'invalid_external_job_id':
      return 'That job could not be used. Pick it again from the list.';
    case 'invalid_role_id':
      return 'Choose a role for this job.';
    case 'invalid_stage_id':
      return 'The screening stage for this job could not be set. Ask an engineer to check the Ashby setup.';
    case 'invalid_label':
      return "This job's name could not be saved with the mapping. Ask an engineer.";
    case 'invalid_delivery_mode':
      return 'That delivery mode is not one this integration supports.';
    case 'conflict':
      return 'This Ashby job is already mapped.';
    case 'mission_control_action_error':
      return 'The mapping could not be saved. Try again.';
    default:
      return 'Could not create the mapping.';
  }
}

/**
 * The archive route's machine codes, in words. `mapping_enabled` and
 * `not_found` each name something the admin can act on — pause it first, or
 * nothing left to do. Everything else (a server error, a dropped connection)
 * is worth one more try.
 */
function deleteErrorCopy(code: string | undefined): string {
  switch (code) {
    case 'mapping_enabled':
      return 'Pause this mapping first, then delete it.';
    case 'not_found':
      return 'This mapping was already removed.';
    default:
      return 'Could not delete the mapping. Try again.';
  }
}

/** The jobs read's failure, in words. `ApiError.message` IS the route's code. */
function jobsErrorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message === 'integration_disabled') {
      return "The Ashby integration is turned off, so jobs can't be listed.";
    }
    if (err.status === 403) return 'Only admins can list Ashby jobs.';
  }
  return "Couldn't load jobs from Ashby.";
}

/**
 * Picker labels for the OPEN jobs, unique WITHOUT an id.
 *
 * Ashby allows two open jobs with one title — the same role hiring in two
 * cities, or a re-opened req — and two identical options leave an admin
 * choosing blind. So duplicates first gain the date each opened, which is
 * the difference a recruiter actually knows; any still identical (no date,
 * or opened the same day) are numbered ` (2)`, ` (3)` in list order. The id
 * would be unique too, but it is the one thing this page never shows.
 */
function jobOptionLabels(jobs: AshbyJob[]): string[] {
  const titles = jobs.map((job) => job.title?.trim() || 'Untitled job');
  const perTitle = new Map<string, number>();
  for (const title of titles) perTitle.set(title, (perTitle.get(title) ?? 0) + 1);
  const dated = titles.map((title, i) => {
    if (perTitle.get(title) === 1) return title;
    const opened = openedDate(jobs[i].openedAt);
    return opened ? `${title} — opened ${opened}` : title;
  });
  const seen = new Map<string, number>();
  return dated.map((label) => {
    const n = (seen.get(label) ?? 0) + 1;
    seen.set(label, n);
    return n === 1 ? label : `${label} (${n})`;
  });
}

/** The viewer's own date format, or null when Ashby's value is missing or unparseable. */
function openedDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A mapping's job, by NAME — the ONE rule, shared by the row and the Delete
 * confirmation. The live job list first — it tracks a rename in Ashby — then
 * the label saved at creation (the job's title then), then an honest
 * placeholder. `externalJobId` is read as a lookup key and never returned.
 */
function mappingName(
  mapping: AshbyMcMapping,
  jobTitles: Map<string, string> | null,
  jobsPending: boolean,
): string {
  return (
    jobTitles?.get(mapping.externalJobId) ??
    (mapping.label?.trim() || null) ??
    (jobsPending ? 'Loading job name…' : 'Ashby job (name unavailable)')
  );
}

/**
 * A mapping row's job, by NAME (see `mappingName`). The label shows as a
 * second line only when it says something the name does not: an older
 * mapping's hand-typed tag, or the title from before a rename. Nothing here
 * renders `externalJobId` — not as text, not as a tooltip.
 */
function MappingName({
  mapping,
  jobTitles,
  jobsPending,
}: {
  mapping: AshbyMcMapping;
  jobTitles: Map<string, string> | null;
  /** The first jobs read is still in flight — "unavailable" would be a false alarm. */
  jobsPending: boolean;
}) {
  const label = mapping.label?.trim() || null;
  const name = mappingName(mapping, jobTitles, jobsPending);
  return (
    <>
      <span className="min-w-0 break-words text-sm font-medium text-ink">{name}</span>
      {label && label !== name && (
        <span className="min-w-0 break-words text-sm text-ink-secondary">{label}</span>
      )}
    </>
  );
}

function bindingErrorCopy(code: string | undefined): string {
  switch (code) {
    case 'integration_disabled':
      return 'The Ashby integration is disabled, so the form definition cannot be read.';
    case 'mapping_not_found':
      return 'This mapping no longer exists.';
    case 'binding_unverified':
      return 'The scorecard form binding is not verified; write-back is closed.';
    case 'probe_unavailable':
      return 'Ashby did not return the feedback form definition. Check the API key scopes (hiringProcessMetadataRead) and that the form still exists.';
    default:
      return 'Could not preview the scorecard binding';
  }
}

function backlogErrorCopy(code: string | undefined): string {
  switch (code) {
    case 'mapping_not_enabled': return 'Enable this mapping first. Enabling remains future-stage-only unless you explicitly confirm a snapshot.';
    case 'ashby_backlog_cap_exceeded': return 'The preview exceeds the safety cap. Narrow the mapping scope before importing.';
    case 'ashby_backlog_page_cap': return 'Ashby returned too many pages for one preview. Nothing was imported; try again later or narrow the scope.';
    case 'expired': return 'This preview expired. Run a new preview before confirming.';
    case 'count_mismatch': return 'The count changed. Run a new preview; nothing outside its snapshot can be confirmed.';
    case 'mapping_changed': return 'The mapping changed or was paused/repointed. Run a new preview.';
    case 'already_confirmed': return 'This snapshot was already confirmed; no second import was created.';
    case 'ashby_backlog_provider_unavailable': return 'The Ashby read-only provider connection is unavailable. Nothing was imported.';
    default: return 'Could not preview or confirm the existing backlog. Nothing was imported.';
  }
}

const METRIC_STATUS_COPY: Record<AshbyScorecardBindingPreview['metrics'][number]['status'], string> = {
  bound: 'will be written',
  no_field: 'no Score field with this title — add an optional Score field titled exactly like the metric',
  ambiguous_title: 'more than one field carries this title — keep exactly one',
  ambiguous_metric: 'another metric has the same name — rename one of them so each claims its own field',
  not_score_type: 'the field with this title is not a Score field — change its type to Score',
  no_path: 'the field has no submission path — recreate it in Ashby',
};

/**
 * ONE verdict, in precedence order, so the headline can never contradict the
 * rows beneath it. A form whose schema could not be read tells the operator
 * nothing about its fields — the worker retries rather than writing a card —
 * and an archived or mismatched form blocks the write entirely, so neither
 * state may be reported as "metrics would be omitted".
 */
function bindingVerdict(preview: AshbyScorecardBindingPreview): string {
  if (!preview.schemaAvailable) {
    return 'Cannot be checked — this read returned no field schema. A scorecard write would retry rather than send a partial card.';
  }
  if (!preview.formMatchesBinding) {
    return preview.archived
      ? 'Not ready — the verified form is archived, so no scorecard would be written.'
      : 'Not ready — this is not the verified form, so no scorecard would be written.';
  }
  const brokenFixed = preview.fixedFields.filter((f) => f.status !== 'present').length;
  if (brokenFixed > 0) {
    return `Not ready — ${brokenFixed} fixed field(s) no longer match the verified binding.`;
  }
  if (preview.metrics.length === 0) {
    return 'Not ready — the active scorecard has no metrics to write.';
  }
  const unbound = preview.metrics.filter((m) => m.status !== 'bound').length;
  if (unbound > 0) {
    return `${unbound} of ${preview.metrics.length} metric(s) would be omitted from the Ashby card.`;
  }
  return 'Ready — every metric and every fixed field would be written.';
}

const FIXED_FIELD_LABEL: Record<AshbyScorecardBindingPreview['fixedFields'][number]['name'], string> = {
  overall: 'Overall recommendation',
  summary: 'Summary',
  redFlags: 'Red flags',
  detailedReport: 'Detailed report',
};

/**
 * Read-only rendering of the v2 scorecard binding preview (issue #275).
 *
 * Every value here is form STRUCTURE plus dashboard metric NAMES: paths,
 * titles, types, scales. There is no submitted score, comment, or candidate
 * field, and nothing is persisted or bound by viewing it. The rule it teaches
 * is one sentence: for every metric a role scores, the form needs an optional
 * Score field whose title equals the metric's name.
 */
function ScorecardBindingPreviewPanel({
  scoringPath,
  preview,
}: {
  scoringPath: NonNullable<AshbyScorecardBindingPreviewResponse['scoringPath']>;
  preview: AshbyScorecardBindingPreview;
}) {
  return (
    <div className="glass-sunken mt-3 p-4">
      <SectionHeader
        level={3}
        title="Scorecard binding preview — read-only"
        description="What a v2 scorecard write would bind on the verified form, by metric name. Nothing is written or bound by viewing this."
      />
      <p className="mt-2 text-[13px] text-ink-secondary">
        {preview.formTitle ?? 'Untitled form'}{' '}
        <span className="font-mono text-ink-tertiary">form id: {preview.formDefinitionId}</span>
      </p>

      {scoringPath === 'no_role' && (
        <InlineNotice tone="warning" className="mt-3">
          This mapping has no dashboard role, so no metrics can be previewed.
        </InlineNotice>
      )}
      {scoringPath === 'v1_legacy' && (
        <InlineNotice tone="warning" className="mt-3">
          This role has no active dashboard scorecard. Screenings use the fixed v1 binding; no name matching applies until a scorecard is activated.
        </InlineNotice>
      )}
      {!preview.formMatchesBinding && (
        <InlineNotice tone="danger" className="mt-3">
          {preview.archived
            ? 'The verified form is archived in Ashby. Scorecard writes will fail closed until it is restored.'
            : 'The form definition read does not match the verified binding. Scorecard writes will fail closed.'}
        </InlineNotice>
      )}
      {!preview.schemaAvailable && (
        <InlineNotice tone="warning" className="mt-3">
          Field-level schema was not available from this read — only the form id could be checked. This is not a claim that the form has no fields.
        </InlineNotice>
      )}

      {scoringPath === 'v2_autobind' && (
        <p className="mt-3 text-sm font-medium text-ink" data-testid="binding-readiness">
          {bindingVerdict(preview)}
        </p>
      )}

      <p className="mt-3 text-[13px] font-medium text-ink-secondary">Fixed fields (verified binding)</p>
      <ul className="mt-1 space-y-1">
        {preview.fixedFields.map((f) => (
          <li key={f.name} className="text-[13px] leading-5 text-ink-secondary">
            {FIXED_FIELD_LABEL[f.name]}
            {' — '}
            <span className="font-mono">[{f.path}]</span>
            {f.status === 'present' && ' · present'}
            {f.status === 'missing' && (
              preview.schemaAvailable ? (
                <span className="text-error-text"> · missing on the form — writes will fail closed</span>
              ) : (
                // No field schema came back, so absence proves nothing.
                <span> · not checked by this read</span>
              )
            )}
            {f.status === 'type_mismatch' && (
              <span className="text-error-text">
                {' · type changed to '}{f.actualType ?? 'unknown'}{' (expected '}{f.expectedType}{') — writes will fail closed'}
              </span>
            )}
          </li>
        ))}
      </ul>

      {scoringPath === 'v2_autobind' && (
        <>
          <p className="mt-3 text-[13px] font-medium text-ink-secondary">Metrics (bound by name)</p>
          {preview.metrics.length === 0 ? (
            <p className="mt-1 text-[13px] text-ink-tertiary">The active scorecard has no metrics.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {preview.metrics.map((m) => (
                <li key={m.key} className="text-[13px] leading-5 text-ink-secondary">
                  <span className="text-ink">{m.name}</span>
                  {m.status === 'bound' ? (
                    <>
                      {' → '}
                      <span className="font-mono">[{m.fieldPath}]</span>
                      {m.scale ? ` · ${m.scale.min}–${m.scale.max} scale` : ''}
                      {' · '}{METRIC_STATUS_COPY.bound}
                    </>
                  ) : (
                    <span className="text-warning-text">{' · '}{METRIC_STATUS_COPY[m.status]}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {preview.unusedScoreFields.length > 0 && (
        <p className="mt-3 text-[13px] text-ink-tertiary">
          Score fields no metric claims (left empty on the card):{' '}
          {preview.unusedScoreFields.map((u) => u.title ?? u.fieldId).join(', ')}
        </p>
      )}
    </div>
  );
}

export default AshbyMissionControlPage;
