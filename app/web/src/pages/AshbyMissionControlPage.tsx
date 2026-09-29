import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
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
  cx,
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
  SelectField,
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
 * live OPEN Ashby job, shown by name, and an active dashboard role, both read
 * afresh every time the dialog opens. There is no stage field and no free
 * -text label: the route fixes the screening stage (and the verified scorecard
 * form) on create, and the label is simply the job's display name. A new
 * mapping saves PAUSED; Resume stays the separate, database-gated switch.
 *
 * DELETING A MAPPING: `Delete` ARCHIVES it. The row leaves this list and is
 * frozen — the calls, scores and history of every candidate it screened are
 * kept. Adding the same job again later creates a NEW mapping, paused; the
 * deleted one never comes back. The database refuses to archive an ENABLED
 * mapping, so the button stays disabled until the mapping is paused and says
 * why in words, and it always asks first, in a dialog that names the job.
 *
 * JOB NAMES, NEVER JOB IDS: an Ashby job id means nothing to the person
 * reading this page, and typing one by hand is how a mapping lands on the
 * wrong job with nothing on screen to show it. ONE naming rule
 * (`jobDisplayNames`, over every job Ashby returned, any status) names the
 * picker's options, the rows and the Delete confirmation alike, telling
 * same-titled jobs apart by opening date and then by number. The picker's
 * option values are list positions, so no job id is rendered anywhere: not
 * as text, not in an option `value`, not in a `title` or ARIA attribute, not
 * in error copy. The ids stay inside handlers, where the API needs them.
 * Each row also names the ROLE it screens for, by title — never its uuid.
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
 * Extra classes for the add-mapping dialog's two `SelectField`s — the design
 * system's control, so the border clears WCAG 1.4.11 and the chevron and
 * height match every other select. `w-full min-w-0` because a native select
 * otherwise sizes itself to its LONGEST option, and one long job title would
 * push the dialog wider than a phone screen.
 */
const DIALOG_SELECT = 'w-full min-w-0';
/**
 * The note under a dialog picker. It is ALWAYS mounted, and focusable by
 * script only (`tabIndex={-1}`): when "Try again" is pressed the button that
 * had focus unmounts with the notice around it, so focus is parked here for
 * the length of the read instead of falling to `<body>`.
 */
const PICKER_NOTE =
  'flex flex-col gap-2 rounded-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-info';
/** The page-level confirmations after a save or a delete. */
const MAPPING_ADDED = "Mapping added. It's paused — use Resume to turn it on.";
const MAPPING_DELETED = 'Mapping deleted.';
/**
 * Picker-state copy, each said once on screen and once in a live region —
 * one constant per sentence so the two can never drift apart.
 */
const NO_OPEN_JOBS = 'There are no open jobs in Ashby right now.';
const CONFIDENTIAL_WITHHELD = "Confidential jobs aren't listed here.";
const ROLES_ERROR = "Couldn't load roles.";
const NO_ACTIVE_ROLES = 'There are no active roles yet.';
const NO_ACTIVE_ROLES_HINT = 'Create one on the Roles page first.';
/**
 * What Delete does, said before it is done. An archive, not a pause: it
 * cannot be undone, and adding the job again starts a NEW mapping.
 */
const DELETE_CONSEQUENCES =
  "It won't screen anyone again and disappears from this list. Candidates already screened — " +
  'their calls, scores and history — are kept. You can add this job again later as a new, ' +
  'paused mapping.';
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
   * EVERY dashboard role, active or not — what a row's `roleId` is resolved
   * against, since a mapping may still point at a role retired since. The
   * dialog's picker narrows it to active roles (`activeRoles`).
   *
   * A PICKER, not a uuid field. `role_id` is a uuid FK and the route rejects
   * anything else with `invalid_role_id`; asking an admin to paste one from
   * another tab is how you get a mapping pointed at the wrong role with no
   * way to notice — the id never appears on screen again.
   *
   * `null` until the first read lands, so a row can say "loading" rather
   * than "unavailable". A later failed read keeps the last good list for the
   * rows; only the dialog, which needs a CURRENT list, reports the failure.
   */
  const [allRoles, setAllRoles] = useState<Role[] | null>(null);
  const [rolesStatus, setRolesStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  /** Latest roles read only — the same race rule as `jobsRequest`. */
  const rolesRequest = useRef(0);
  /**
   * The live Ashby job list — every status, for naming mapping rows; the
   * dialog's picker narrows it to `Open`. `null` until the first read lands,
   * which is what lets a row say it is still loading rather than claim the
   * name is unavailable while Ashby is merely slow to answer.
   */
  const [jobs, setJobs] = useState<AshbyJob[] | null>(null);
  const [jobsStatus, setJobsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  /**
   * `retryable: false` when reading again cannot help — the integration is
   * off, or this account may not list jobs — so no "Try again" is offered.
   */
  const [jobsError, setJobsError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [jobsTruncated, setJobsTruncated] = useState(false);
  /** Confidential jobs the route left out — a count, never which ones. */
  const [jobsWithheld, setJobsWithheld] = useState(0);
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
   * Where focus goes after a picker's "Try again" read settles: the select
   * when it can take it, else its note (see `focusAfterRetry`). The flags are
   * set by the Try again click and nothing else, so an ordinary read — the
   * one on page load, or on open — never moves anyone's focus.
   */
  const jobSelectRef = useRef<HTMLSelectElement | null>(null);
  const jobNoteRef = useRef<HTMLDivElement | null>(null);
  const jobsRetryFocus = useRef(false);
  const roleSelectRef = useRef<HTMLSelectElement | null>(null);
  const roleNoteRef = useRef<HTMLDivElement | null>(null);
  const rolesRetryFocus = useRef(false);
  /**
   * A FAILED save or delete disables every control for the length of the
   * request, and a browser moves focus off a control the moment it is
   * disabled — to `<body>`. These say "put it back" once the request settles
   * (see `restoreFocus`); the containers are where to look.
   */
  const createFormRef = useRef<HTMLFormElement | null>(null);
  const refocusAfterCreate = useRef(false);
  const deleteBodyRef = useRef<HTMLDivElement | null>(null);
  const refocusAfterDelete = useRef(false);
  /**
   * The page-level confirmation after a save or a delete, in a `role=status`
   * region that is always mounted (a region announces reliably only if it
   * exists before it gains content). Cleared by the next action of any kind,
   * so it never outlives the thing it confirms.
   */
  const [success, setSuccess] = useState<string | null>(null);
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
    {
      mappingId: string;
      scoringPath: NonNullable<AshbyScorecardBindingPreviewResponse['scoringPath']>;
      preview: AshbyScorecardBindingPreview;
      /** Is this mapping's form the verified one? `null` = the API did not say. */
      mappingFormBound: boolean | null;
    } | null
  >(null);
  const [bindingError, setBindingError] = useState<{ mappingId: string; message: string } | null>(null);
  const [backlogPreview, setBacklogPreview] = useState<{ mappingId: string; preview: AshbyBacklogPreview } | null>(null);
  const [backlogError, setBacklogError] = useState<{ mappingId: string; message: string } | null>(null);
  const [backlogConfirmArmed, setBacklogConfirmArmed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, w] = await Promise.all([api.listAshbyMappings(), api.listAshbyWorkflows()]);
      setMappings(m.mappings);
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
   * Read every role. Best effort: a failure costs the rows their role names
   * and the dialog its picker, never the page — the mapping list and its
   * pause/resume actions are what this screen is for, and they do not need
   * roles. It runs on page load for the rows, and again every time the
   * dialog opens: a role created on the Roles page a minute ago should be
   * pickable without a reload. Not part of `load()`, which runs after every
   * row action.
   */
  const loadRoles = useCallback(async () => {
    const ticket = ++rolesRequest.current;
    setRolesStatus('loading');
    try {
      const res = await api.listRoles();
      if (ticket !== rolesRequest.current) return;
      setAllRoles(Array.isArray(res) ? res : []);
      setRolesStatus('ready');
    } catch {
      if (ticket !== rolesRequest.current) return;
      setRolesStatus('error');
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  /** The picker offers ACTIVE roles only: a retired role's script is unmaintained. */
  const activeRoles = useMemo(() => (allRoles ?? []).filter((role) => role.is_active), [allRoles]);
  /** Rows resolve against EVERY role, retired ones included. */
  const rolesById = useMemo(
    () => (allRoles === null ? null : new Map(allRoles.map((role) => [role.id, role]))),
    [allRoles],
  );
  /** The first roles read is still in flight — "unavailable" would be a false alarm. */
  const rolesPending = rolesById === null && rolesStatus === 'loading';

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
      setJobsWithheld(typeof res.withheld === 'number' && res.withheld > 0 ? res.withheld : 0);
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

  /**
   * Every job's display name, by job id — the ONE naming rule
   * (`jobDisplayNames`) applied over the WHOLE list, every status. Rows,
   * picker options and the Delete confirmation all read from this map, so
   * two same-titled jobs are told apart the same way everywhere, and an open
   * job that shares its title with a closed one is disambiguated too.
   */
  const jobNames = useMemo(() => {
    if (jobs === null) return null;
    const names = jobDisplayNames(jobs);
    return new Map(jobs.map((job, i) => [job.id, { name: names[i], title: job.title?.trim() || null }]));
  }, [jobs]);
  /** The first jobs read is still in flight — "unavailable" would be a false alarm. */
  const jobsPending = jobNames === null && jobsStatus === 'loading';

  /**
   * The picker: OPEN jobs only, in the API's title order, each named by the
   * shared rule. A job that is already mapped stays LISTED but disabled —
   * dropping it would read as "Ashby has no such job" to an admin looking
   * for it.
   */
  const jobOptions = useMemo(() => {
    const open = (jobs ?? []).filter((job) => job.status === 'Open');
    const mapped = new Set(mappings.map((m) => m.externalJobId));
    return open.map((job) => ({
      job,
      label: jobNames?.get(job.id)?.name ?? 'Untitled job',
      mapped: mapped.has(job.id),
    }));
  }, [jobs, jobNames, mappings]);

  const chosenJob = draft.jobKey === '' ? null : (jobOptions[Number(draft.jobKey)] ?? null);
  const canSave = chosenJob !== null && !chosenJob.mapped && draft.roleId !== '';
  const noOpenJobs = jobsStatus === 'ready' && jobOptions.length === 0;
  const jobsClipped = jobsStatus === 'ready' && jobsTruncated;
  const jobsHidden = jobsStatus === 'ready' && jobsWithheld > 0;
  /** Whatever sits under the job picker also DESCRIBES it, for a screen reader. */
  const hasJobNote = jobsStatus === 'error' || noOpenJobs || jobsClipped || jobsHidden;
  const noActiveRoles = rolesStatus === 'ready' && activeRoles.length === 0;
  const hasRoleNote = rolesStatus === 'error' || noActiveRoles;

  /**
   * What the dialog's two polite live regions say. Each region is mounted
   * for as long as the dialog is, so a change of state is announced — a
   * notice that mounts WITH its text is announced unreliably, which is why
   * the visible notices below carry no live role of their own.
   */
  const jobsAnnouncement =
    jobsStatus === 'loading'
      ? 'Loading jobs from Ashby…'
      : jobsStatus === 'error'
        ? (jobsError?.message ?? '')
        : noOpenJobs
          ? NO_OPEN_JOBS
          : `${jobOptions.length} open job${jobOptions.length === 1 ? '' : 's'}`;
  const rolesAnnouncement =
    rolesStatus === 'loading'
      ? 'Loading roles…'
      : rolesStatus === 'error'
        ? ROLES_ERROR
        : noActiveRoles
          ? `${NO_ACTIVE_ROLES} ${NO_ACTIVE_ROLES_HINT}`
          : `${activeRoles.length} active role${activeRoles.length === 1 ? '' : 's'}`;

  /**
   * After a "Try again" read settles, focus goes to the select if it can
   * take it, else to the note's own control (Try again again, or the Roles
   * link), else the note itself. Effects, not code in the click handler:
   * the select is only enabled once the render with the new list commits.
   */
  useEffect(() => {
    if (!jobsRetryFocus.current || jobsStatus === 'loading') return;
    jobsRetryFocus.current = false;
    focusAfterRetry(jobSelectRef.current, jobNoteRef.current);
  }, [jobsStatus]);
  useEffect(() => {
    if (!rolesRetryFocus.current || rolesStatus === 'loading') return;
    rolesRetryFocus.current = false;
    focusAfterRetry(roleSelectRef.current, roleNoteRef.current);
  }, [rolesStatus]);

  const retryJobs = useCallback(() => {
    jobsRetryFocus.current = true;
    // The Try again button is about to unmount with its notice; park focus
    // on the note, which stays, until the read settles.
    jobNoteRef.current?.focus();
    void loadJobs();
  }, [loadJobs]);
  const retryRoles = useCallback(() => {
    rolesRetryFocus.current = true;
    roleNoteRef.current?.focus();
    void loadRoles();
  }, [loadRoles]);

  /**
   * Each opening is a fresh form over a fresh read of BOTH lists: jobs are
   * live in Ashby, and a role may have been created since the page loaded.
   */
  const openDialog = useCallback(() => {
    setSuccess(null);
    setDraft({ jobKey: '', roleId: '' });
    setCreateError(null);
    jobsRetryFocus.current = false;
    rolesRetryFocus.current = false;
    refocusAfterCreate.current = false;
    setDialogOpen(true);
    void loadJobs();
    void loadRoles();
  }, [loadJobs, loadRoles]);

  const closeDialog = useCallback(() => {
    // A retry still in flight must not grab focus after the dialog is gone.
    jobsRetryFocus.current = false;
    rolesRetryFocus.current = false;
    setDialogOpen(false);
  }, []);

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string }>) => {
      setSuccess(null);
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
      setSuccess(null);
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
    setSuccess(null);
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
    setSuccess(null);
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
    setSuccess(null);
    setBusy(true);
    setBindingError(null);
    setBindingPreview(null);
    try {
      const res = await api.previewAshbyScorecardBinding(mappingId);
      if (res.ok && res.preview && res.scoringPath) {
        setBindingPreview({
          mappingId,
          scoringPath: res.scoringPath,
          preview: res.preview,
          // Only a literal boolean counts; an older API that omits it is
          // "unknown", and unknown must not raise the not-linked alarm.
          mappingFormBound: typeof res.mappingFormBound === 'boolean' ? res.mappingFormBound : null,
        });
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
    setSuccess(null);
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
    setSuccess(null);
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
      // The job's DISPLAY NAME becomes the label — the same disambiguated
      // name the picker showed ("Support Agent — opened 1 Jul 2026"), trimmed
      // and cut to the route's cap — and it is OMITTED when Ashby gave the job
      // no title: "Untitled job (2)" is a placeholder, not a name worth
      // keeping. It is what a row falls back to when the job leaves the list.
      const label = chosenJob.job.title?.trim()
        ? chosenJob.label.trim().slice(0, MAX_MAPPING_LABEL).trim()
        : undefined;
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
      // After the reload, so the row it confirms is already on the page.
      setSuccess(MAPPING_ADDED);
    } catch (err) {
      // The thrown message IS the route's machine code, so translate it here
      // — this is the only path a failure actually takes. The dialog stays
      // open and the reason renders inside it.
      const code = err instanceof ApiError ? err.message : undefined;
      // `conflict` (someone else mapped this job a moment ago) and `archived`
      // (the mapping was deleted meanwhile) both mean the lists on screen are
      // STALE, and the copy says they were refreshed — so refresh them, both
      // of them, before the reason shows. The jobs re-read clears the job
      // choice; the refreshed picker now marks that job "already mapped".
      if (code === 'conflict' || code === 'archived') {
        await Promise.all([load(), loadJobs()]);
      }
      setCreateError(code ? mappingErrorCopy(code) : 'Could not create the mapping. Try again.');
      refocusAfterCreate.current = true;
    } finally {
      setCreating(false);
    }
  }, [creating, chosenJob, draft.roleId, load, loadJobs]);

  /**
   * After a FAILED save settles, focus goes back to Save if it can take it,
   * else to the first control in the form that can (the job picker, when a
   * refresh cleared the choice) — never left on `<body>`, where the browser
   * put it when the in-flight request disabled everything.
   */
  useEffect(() => {
    if (creating || !refocusAfterCreate.current) return;
    refocusAfterCreate.current = false;
    restoreFocus(createFormRef.current);
  }, [creating]);

  const openDeleteDialog = useCallback((mapping: AshbyMcMapping, trigger: HTMLElement) => {
    setSuccess(null);
    refocusAfterDelete.current = false;
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
      setSuccess(MAPPING_DELETED);
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
      refocusAfterDelete.current = true;
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, deleting, load]);

  /**
   * After a FAILED delete settles: back to "Delete mapping" when pressing it
   * again can work, else to the first control that can take focus (Cancel)
   * — the same rule as a failed save, for the same reason.
   */
  useEffect(() => {
    if (deleting || !refocusAfterDelete.current) return;
    refocusAfterDelete.current = false;
    restoreFocus(deleteBodyRef.current);
  }, [deleting]);

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
            {/* `min-w-0`, NOT `shrink-0`: a flex item that may not shrink
                keeps its one-line width even after wrapping onto its own
                line, and on a 360px phone that line is wider than the screen
                — the page scrolled sideways. Allowed to shrink, the group
                wraps its buttons instead. Same rule on the mapping rows. */}
            <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="row-actions">
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
      {/* ALWAYS mounted, empty until a save or a delete succeeds: a status
          region that already exists announces its new text; one that mounts
          WITH its text may not. The notice inside carries no role of its own
          (`none`), or the confirmation would be announced twice. */}
      <div role="status" id="ashby-mapping-confirmation" className={success ? 'mt-6' : undefined}>
        {success && (
          <InlineNotice tone="success" role="none">
            {success}
          </InlineNotice>
        )}
      </div>

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
                      <MappingSummary
                        mapping={m}
                        jobNames={jobNames}
                        jobsPending={jobsPending}
                        rolesById={rolesById}
                        rolesPending={rolesPending}
                      >
                        <StatusBadge tone={mappingTone(m.status)}>{m.status}</StatusBadge>
                        {!(m.hasAiStage && m.hasTaStage) && <StatusBadge>incomplete</StatusBadge>}
                        {m.statusReason && (
                          <span className="text-[13px] text-ink-tertiary">{m.statusReason}</span>
                        )}
                      </MappingSummary>
                      {/* The same wrapper on EVERY row, hint or not, so a
                          status change never remounts the buttons — the
                          Delete button the dialog returns focus to must be
                          the node that is still on the page. `min-w-0`, not
                          `shrink-0`: see the workflow rows. */}
                      <div className="flex min-w-0 flex-col items-end gap-1" data-testid="row-actions">
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
                        mappingFormBound={bindingPreview.mappingFormBound}
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
          ref={createFormRef}
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
          {/* The two lists' state, for a screen reader: loading, how many,
              or why not. Visually hidden, mounted with the dialog. */}
          <p id="ashby-mapping-jobs-live" role="status" className="sr-only">
            {jobsAnnouncement}
          </p>
          <p id="ashby-mapping-roles-live" role="status" className="sr-only">
            {rolesAnnouncement}
          </p>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="ashby-mapping-job" className="text-[13px] font-medium text-ink">
              Ashby job
            </label>
            <SelectField
              id="ashby-mapping-job"
              ref={jobSelectRef}
              className={DIALOG_SELECT}
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
            </SelectField>
            <div
              id="ashby-mapping-job-note"
              ref={jobNoteRef}
              tabIndex={-1}
              className={cx(PICKER_NOTE, hasJobNote && 'mt-1')}
            >
              {jobsStatus === 'error' && jobsError && (
                <InlineNotice
                  tone="danger"
                  role="none"
                  action={
                    // Only when reading again can help. Retrying a switched
                    // -off integration or a missing permission fails the same
                    // way every time, and the button would say otherwise.
                    jobsError.retryable ? (
                      <Button size="sm" onClick={retryJobs}>
                        Try again
                      </Button>
                    ) : undefined
                  }
                >
                  {jobsError.message}
                </InlineNotice>
              )}
              {noOpenJobs && (
                <InlineNotice tone="neutral" role="none">
                  {NO_OPEN_JOBS}
                </InlineNotice>
              )}
              {jobsClipped && (
                // Say it rather than let a short list pass for the whole
                // of Ashby: the one job an admin came for may be past the
                // cut, and nothing else on screen would show it.
                <InlineNotice tone="warning" role="none">
                  Ashby returned more jobs than this list can show. If a job is missing, ask an
                  engineer.
                </InlineNotice>
              )}
              {jobsHidden && (
                // The same reason as the cut above: an admin looking for a
                // confidential job must not conclude Ashby has none.
                <p className="text-[13px] text-ink-tertiary">{CONFIDENTIAL_WITHHELD}</p>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor="ashby-mapping-role" className="text-[13px] font-medium text-ink">
              Role
            </label>
            <SelectField
              id="ashby-mapping-role"
              ref={roleSelectRef}
              className={DIALOG_SELECT}
              value={draft.roleId}
              onChange={(e) => setDraft((d) => ({ ...d, roleId: e.target.value }))}
              disabled={creating || rolesStatus !== 'ready' || activeRoles.length === 0}
              aria-describedby={hasRoleNote ? 'ashby-mapping-role-note' : undefined}
              required
            >
              <option value="">{rolesStatus === 'loading' ? 'Loading roles…' : 'Choose a role…'}</option>
              {rolesStatus === 'ready' &&
                activeRoles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.agent_name ? `${role.title} — ${role.agent_name}` : role.title}
                  </option>
                ))}
            </SelectField>
            <div
              id="ashby-mapping-role-note"
              ref={roleNoteRef}
              tabIndex={-1}
              className={cx(PICKER_NOTE, hasRoleNote && 'mt-1')}
            >
              {rolesStatus === 'error' && (
                <InlineNotice
                  tone="danger"
                  role="none"
                  action={
                    <Button size="sm" onClick={retryRoles}>
                      Try again
                    </Button>
                  }
                >
                  {ROLES_ERROR}
                </InlineNotice>
              )}
              {noActiveRoles && (
                <InlineNotice tone="neutral" role="none">
                  {NO_ACTIVE_ROLES} Create one on the{' '}
                  <Link
                    to="/roles"
                    className="rounded-sm font-medium text-ink underline underline-offset-2 hover:text-info focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
                  >
                    Roles page
                  </Link>{' '}
                  first.
                </InlineNotice>
              )}
            </div>
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
            <Button
              type="submit"
              variant="primary"
              loading={creating}
              disabled={!canSave}
              data-dialog-primary=""
            >
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
        description={deleteTarget ? mappingName(deleteTarget, jobNames, jobsPending) : undefined}
        returnFocusRef={deleteReturnFocus}
        busy={deleting}
      >
        <div ref={deleteBodyRef} className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-ink-secondary">{DELETE_CONSEQUENCES}</p>

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
              data-dialog-primary=""
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
    // Both of these mean the page was STALE, and the save handler reloads the
    // mapping list and the job list before this copy shows — which is what
    // makes "has been refreshed" true.
    case 'conflict':
      return 'This job was just mapped by someone else. The list has been refreshed.';
    case 'archived':
      return "This mapping was deleted while you were working, so it can't be changed. The list has been refreshed — add the job again to start a new, paused mapping.";
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

/**
 * The jobs read's failure, in words. `ApiError.message` IS the route's code.
 * `retryable` is false when reading again fails the same way every time — a
 * switched-off integration, a missing permission — so no "Try again" is
 * offered for those.
 */
function jobsErrorCopy(err: unknown): { message: string; retryable: boolean } {
  if (err instanceof ApiError) {
    if (err.message === 'integration_disabled') {
      return { message: "The Ashby integration is turned off, so jobs can't be listed.", retryable: false };
    }
    if (err.status === 403) return { message: 'Only admins can list Ashby jobs.', retryable: false };
  }
  return { message: "Couldn't load jobs from Ashby.", retryable: true };
}

/**
 * Focus after a picker's "Try again" read settles: the select when it is
 * enabled; else the first live control in its note (Try again once more, or
 * the Roles-page link); else the note itself, which is focusable by script.
 */
function focusAfterRetry(select: HTMLSelectElement | null, note: HTMLElement | null): void {
  if (select && !select.disabled) {
    select.focus();
    return;
  }
  const control = note?.querySelector<HTMLElement>('a[href], button:not(:disabled)');
  (control ?? note)?.focus();
}

/**
 * Focus after a FAILED dialog request settles: the dialog's primary action
 * (`data-dialog-primary`) when it can be pressed again, else the first
 * control in `container` that can take focus. Only ever called once the
 * request has settled, when Cancel at least is enabled — so focus always
 * lands on something, never on `<body>`.
 */
function restoreFocus(container: HTMLElement | null): void {
  if (!container) return;
  const primary = container.querySelector<HTMLElement>('[data-dialog-primary]');
  if (primary && !primary.matches(':disabled')) {
    primary.focus();
    return;
  }
  const first = Array.from(
    container.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ).find((el) => !el.matches(':disabled'));
  first?.focus();
}

/**
 * Display names for a list of jobs, unique WITHOUT an id — the ONE naming
 * rule, applied to the WHOLE job list (every status) so the picker, the rows
 * and the Delete confirmation all name a job identically.
 *
 * Ashby allows two jobs with one title — the same role hiring in two cities,
 * or a re-opened req — and two identical names leave an admin choosing (or
 * deleting) blind. So duplicates first gain the date each opened, which is
 * the difference a recruiter actually knows; any still identical (no date,
 * or opened the same day) are numbered ` (2)`, ` (3)` in list order. The id
 * would be unique too, but it is the one thing this page never shows.
 */
function jobDisplayNames(jobs: AshbyJob[]): string[] {
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

/** A job's display name (`jobDisplayNames`) and its bare title, by job id. */
type JobNames = Map<string, { name: string; title: string | null }>;

/**
 * A mapping's job, by NAME — shared by the row and the Delete confirmation.
 * The live job list first (the shared display name, which tracks a rename in
 * Ashby), then the label saved at creation, then an honest placeholder.
 * `externalJobId` is read as a lookup key and never returned.
 */
function mappingName(mapping: AshbyMcMapping, jobNames: JobNames | null, jobsPending: boolean): string {
  return (
    jobNames?.get(mapping.externalJobId)?.name ??
    (mapping.label?.trim() || null) ??
    (jobsPending ? 'Loading job name…' : 'Ashby job (name unavailable)')
  );
}

/**
 * The role a mapping screens for, as a row's second line. Resolved against
 * EVERY role, so a mapping on a since-retired role still names it. `none`
 * when the mapping carries no role at all; `unavailable` when it names one
 * the roles read did not return (or the read failed). The uuid itself is a
 * lookup key only — it is never rendered.
 */
function roleLine(
  mapping: AshbyMcMapping,
  rolesById: Map<string, Role> | null,
  rolesPending: boolean,
): string {
  if (mapping.roleId === null) return 'Role: none';
  if (rolesPending) return 'Role: loading…';
  const role = mapping.roleId ? rolesById?.get(mapping.roleId) : undefined;
  return role ? `Role: ${role.title}` : 'Role: unavailable';
}

/**
 * A mapping row's text, STACKED — never run together on one line: the job's
 * name (primary, with the row's badges beside it), then the role it screens
 * for, then the saved label, but only when the label says something neither
 * the name nor the job's own title already says (an older mapping's hand
 * -typed tag, or the name from before a rename). Nothing here renders
 * `externalJobId` or `roleId` — not as text, not as an attribute.
 */
function MappingSummary({
  mapping,
  jobNames,
  jobsPending,
  rolesById,
  rolesPending,
  children,
}: {
  mapping: AshbyMcMapping;
  jobNames: JobNames | null;
  /** The first jobs read is still in flight — "unavailable" would be a false alarm. */
  jobsPending: boolean;
  rolesById: Map<string, Role> | null;
  rolesPending: boolean;
  /** Badges, shown beside the name. */
  children?: ReactNode;
}) {
  const label = mapping.label?.trim() || null;
  const name = mappingName(mapping, jobNames, jobsPending);
  const title = jobNames?.get(mapping.externalJobId)?.title ?? null;
  const showLabel = label !== null && label !== name && label !== title;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-ink">{name}</span>
        {children}
      </div>
      <p className="min-w-0 break-words text-[13px] text-ink-secondary">
        {roleLine(mapping, rolesById, rolesPending)}
      </p>
      {showLabel && <p className="min-w-0 break-words text-[13px] text-ink-tertiary">{label}</p>}
    </div>
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
function bindingVerdict(preview: AshbyScorecardBindingPreview, mappingFormBound: boolean | null): string {
  // FIRST, above everything the form itself says: the scorecard writer
  // refuses every write for a mapping whose feedback form is not the
  // verified one, so a perfect form read changes nothing — never "Ready".
  if (mappingFormBound === false) {
    return "Not ready — this mapping isn't linked to the Hello Christy scorecard form, so no scorecard would be written.";
  }
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
  mappingFormBound,
}: {
  scoringPath: NonNullable<AshbyScorecardBindingPreviewResponse['scoringPath']>;
  preview: AshbyScorecardBindingPreview;
  /** Is this mapping's own feedback form the verified one? `null` = not said. */
  mappingFormBound: boolean | null;
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

      {/* The FIRST notice, above the verdict and every other notice, on every
          scoring path: everything below describes the verified FORM, and a
          mapping not linked to it gets no scorecard however good that form
          looks. Only a literal `false` — an API that did not say is not an
          alarm. */}
      {mappingFormBound === false && (
        <InlineNotice tone="danger" className="mt-3">
          This mapping isn&apos;t linked to the Hello Christy scorecard form, so no scorecard will be
          written to Ashby.
        </InlineNotice>
      )}

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
          {bindingVerdict(preview, mappingFormBound)}
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
