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
  Combobox,
  StatusBadge,
  TextField,
} from '../components/design';
import type { ComboboxOption, StatusTone } from '../components/design';
// By path, not through the design index: the menu is new in this change and
// the index is shared with work in flight elsewhere.
import { OverflowMenu } from '../components/design/OverflowMenu';
import type { OverflowMenuItem } from '../components/design/OverflowMenu';
import { humanizeEnum } from '../lib/humanize';
import { ASHBY_ERROR_CODE_LABELS } from '../lib/ashby-labels';

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
 * A ROW SHOWS ONE ACTION. Each mapping row is its job's name, the role it
 * screens with and a status in words (Live / Paused / Out of sync), plus the
 * one action that state calls for: Pause for a live or out-of-sync mapping,
 * Resume for a paused one. Everything else — the three read-only lookups and
 * Delete — waits in the row's "More" menu. Six equal buttons per row, with a
 * filled red one at the end, was the "generated admin template" look; the
 * red fill now appears only in the dialog that confirms a deletion.
 *
 * DELETING A MAPPING: `Delete` ARCHIVES it. The row leaves this list and is
 * frozen — the calls, scores and history of every candidate it screened are
 * kept. Adding the same job again later creates a NEW mapping, paused; the
 * deleted one never comes back. The database refuses to archive an ENABLED
 * mapping, so the menu item stays disabled until the mapping is paused and
 * says why in words under its label, and it always asks first, in a dialog
 * that names the job.
 *
 * CANCELLING A SCREENING is the workflow rows' destructive action, and it
 * asks first too: it cannot be undone from here, and it used to fire on one
 * click of a filled red button beside "Get invite link".
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

/** A list inside a glass panel: one surface, rows split by hairlines — never cards. */
const LIST = 'divide-y divide-glass-ring';
/** Row controls are 36px at a desk and a 44px target under a finger. */
const TOUCH = '[@media(pointer:coarse)]:h-11';

/*
 * THE WORDS FOR MACHINE STATES. Every state an admin reads on this page goes
 * through one of these maps (via `humanizeEnum`, whose sentence-case fallback
 * covers a value the API adds later), and the raw value rides along in a
 * `title`, so an operator quoting it to an engineer is one hover away from
 * the exact vocabulary. Explicit words where they matter: "drift" is not a
 * word an HR admin uses, "Out of sync" is.
 */
const MAPPING_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  enabled: { label: 'Live', tone: 'success' },
  paused: { label: 'Paused', tone: 'warning' },
  drift: { label: 'Out of sync', tone: 'danger' },
};
/** A mapping's paused / out-of-sync reason, when the API gives a code rather than a sentence. */
const STATUS_REASON_LABELS: Record<string, string> = {
  stage_id_invalid: 'A stage on this job no longer exists in Ashby',
};
const LIFECYCLE: Record<string, { label: string; tone: StatusTone }> = {
  imported: { label: 'Imported', tone: 'neutral' },
  processing: { label: 'Processing', tone: 'neutral' },
  ready: { label: 'Ready to screen', tone: 'neutral' },
  completed: { label: 'Screening complete', tone: 'success' },
  writeback_pending: { label: 'Writing back to Ashby', tone: 'info' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};
/**
 * Why a workflow stopped for good. Neutral, not red: a withdrawn applicant is
 * not an error, and red on every closed row is the alarm the review flagged.
 */
const TERMINAL_LABELS: Record<string, string> = {
  withdrawn: 'Withdrawn',
  deleted: 'Deleted in Ashby',
  manual_stage_cancel: 'Cancelled by an admin',
};
/** Resume import (the "ingestion" pipeline) — named so it cannot be read as the Resume ACTION. */
const INGESTION_LABELS: Record<string, string> = {
  queued: 'Queued',
  fetching: 'Fetching',
  scanning: 'Scanning',
  extracting: 'Extracting text',
  structuring: 'Structuring',
  ready: 'Ready',
  failed_review: 'Needs manual review',
  cancelled: 'Cancelled',
};
const OPERATION_LABELS: Record<string, string> = {
  invite_delivery: 'Invite',
  scorecard_write: 'Scorecard write-back',
  stage_move: 'Stage move',
};
const OPERATION_STATE_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'In progress',
  succeeded: 'Done',
  failed: 'Failed',
  blocked: 'Blocked',
  cancelled: 'Cancelled',
};
/** A failed operation's sanitized code; `humanizeEnum` covers the rest. */
const ERROR_CODE_LABELS = ASHBY_ERROR_CODE_LABELS;

/** Above this many rows the workflow list scrolls instead of running down the page. */
const WORKFLOW_SCROLL_AFTER = 6;
/**
 * The note under a dialog picker. It is ALWAYS mounted, and focusable by
 * script only (`tabIndex={-1}`): when "Try again" is pressed the button that
 * had focus unmounts with the notice around it, so focus is parked here for
 * the length of the read instead of falling to `<body>`.
 */
const PICKER_NOTE =
  'flex flex-col gap-2 rounded-[14px] focus:outline-none focus-visible:ring-2 focus-visible:ring-info';
/** The page-level confirmations after a save, a delete or a cancel. */
const MAPPING_ADDED = "Mapping added. It's paused — use Resume to turn it on.";
const MAPPING_DELETED = 'Mapping deleted.';
const SCREENING_CANCELLED = 'Screening cancelled.';
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
 *
 * The middle sentence is the one an admin would otherwise learn the hard way.
 * A candidate's workflow stays attached to the mapping it was imported under
 * (0109 freezes that row so its history is never re-pointed), so anyone that
 * mapping imported but had not screened yet is not picked up by a re-added
 * mapping — only new applicants are.
 */
const DELETE_CONSEQUENCES =
  "It won't screen anyone again and disappears from this list. Candidates already screened — " +
  'their calls, scores and history — are kept. Candidates it imported but has not screened ' +
  "yet won't be screened. You can add this job again later as a new, paused mapping for new " +
  'applicants.';
/**
 * The route's cap on a mapping `label` (its `MAX_LABEL_LEN`, counted in UTF-16
 * units like `String.length`). A longer job title would be refused whole as
 * `invalid_label`, so it is cut here instead.
 */
const MAX_MAPPING_LABEL = 120;
/**
 * Why an item in a row's More menu cannot be chosen. Shown under the item's
 * label and read as its description, never only as a hover tooltip: a menu
 * item is reached by the arrow keys, so the reason reaches everyone.
 */
const PAUSE_BEFORE_DELETE = 'Pause this mapping before deleting it';
const BACKLOG_NEEDS_LIVE = 'Available once this mapping is live';
/** What Cancel screening does, said before it is done. */
const CANCEL_CONSEQUENCES =
  "Screening stops for this application. Any invite, scorecard write-back or stage move still " +
  "waiting is cancelled, and it can't be restarted from here.";
/**
 * The `id` of a row's missing-stage line, which also describes its disabled
 * Resume — by list POSITION, like the picker's option values, so no id of any
 * kind is written into the markup.
 */
const missingStageId = (row: number): string => `ashby-mapping-missing-${row}`;

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
  const jobSelectRef = useRef<HTMLButtonElement | null>(null);
  const jobNoteRef = useRef<HTMLDivElement | null>(null);
  const jobsRetryFocus = useRef(false);
  const roleSelectRef = useRef<HTMLButtonElement | null>(null);
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
   * Where focus goes when the Delete confirmation closes: the More button of
   * the row it came from.
   *
   * ONE ref, pointed at that button by the menu itself (`onSelect` hands
   * over its trigger) — not a ref per row: choosing the item is the one
   * moment that knows exactly which row's menu opened the dialog, and the
   * menu item itself is gone by then. `useModal` reads the ref at CLOSE, so
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
  /**
   * The workflow the Cancel confirmation is about. A SNAPSHOT, like
   * `deleteTarget`, so the open dialog keeps naming the application after a
   * reload changes the list under it.
   */
  const [cancelTarget, setCancelTarget] = useState<AshbyMcWorkflow | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<{ message: string; retryable: boolean } | null>(
    null,
  );
  /** The row's More button — re-pointed at close when it can no longer take focus. */
  const cancelReturnFocus = useRef<HTMLElement | null>(null);
  const cancelBodyRef = useRef<HTMLDivElement | null>(null);
  const refocusAfterCancel = useRef(false);
  /**
   * Each workflow row's application id, focusable by script only. A
   * cancelled application's row turns terminal and loses its More button,
   * so focus after the confirmation lands HERE, on the row it was about,
   * instead of on `<body>`.
   */
  const workflowAnchors = useRef(new Map<string, HTMLElement>());
  /** The Pause / Resume button whose request is running (see `rowAction`). */
  const rowActionFocus = useRef<HTMLButtonElement | null>(null);

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

  /**
   * The picker's rows. `value` is the POSITION (see `draft`) — the combobox
   * never renders it, and the job id never becomes one. A job that is
   * already mapped is grouped last and tagged rather than hidden: dropping it
   * would read as "Ashby has no such job" to an admin looking for it.
   */
  const jobPickerOptions = useMemo<ComboboxOption[]>(() => {
    // ONE row format in the picker: the title, then "Opened <date>" on the
    // second line — for every job, duplicate or not. Two jobs with the same
    // title AND the same opening day are told apart by "· listing N" on that
    // same line. (The saved label and the rows keep the one-line
    // `jobDisplayNames` form; this is only how the list reads.)
    const seen = new Map<string, number>();
    return jobOptions.map((o, i) => {
      const title = o.job.title?.trim() || 'Untitled job';
      const opened = openedDate(o.job.openedAt);
      const key = `${title}\u0000${opened ?? ''}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      const parts = [opened ? `Opened ${opened}` : null, n > 1 ? `listing ${n}` : null].filter(Boolean);
      const line = parts.join(' · ');
      return {
        value: String(i),
        label: title,
        description: line ? line.charAt(0).toUpperCase() + line.slice(1) : undefined,
        disabled: o.mapped,
        tag: o.mapped ? 'Mapped' : undefined,
        group: o.mapped ? 'Already mapped' : undefined,
      };
    });
  }, [jobOptions]);
  const rolePickerOptions = useMemo<ComboboxOption[]>(
    () =>
      activeRoles.map((role) => ({
        value: role.id,
        label: role.title,
        description: role.agent_name ? `Agent · ${role.agent_name}` : undefined,
      })),
    [activeRoles],
  );

  const chosenJob = draft.jobKey === '' ? null : (jobOptions[Number(draft.jobKey)] ?? null);
  const chosenRole = activeRoles.find((role) => role.id === draft.roleId) ?? null;
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
   * After a "Try again" read settles, focus goes to the picker if it can
   * take it, else to the note's own control (Try again again, or the Roles
   * link), else the note itself. Effects, not code in the click handler:
   * the picker is only enabled once the render with the new list commits.
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
        // `archived`: the mapping was deleted in another tab or by another
        // admin, so this row is stale. Say so in words and refresh — leaving
        // the row on screen would invite the same click again.
        if (e instanceof ApiError && e.message === 'archived') {
          // Refresh FIRST: a successful `load()` clears the page error, so
          // setting the message before it would erase it.
          await load();
          setError('This mapping was deleted elsewhere. The list has been refreshed.');
        } else {
          setError(e instanceof ApiError ? e.message : 'Action failed');
        }
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
   * the row's More button when that button can take it. When it cannot —
   * the row is gone after a reload — `focus()` would fail SILENTLY and strand
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

  /**
   * A row's Pause / Resume. `busy` disables the button for the length of the
   * request, and a real browser drops focus to `<body>` the moment it does;
   * the button itself survives the reload (only its label may change), so
   * the effect below puts focus back on it once the request settles.
   */
  const rowAction = useCallback(
    (button: HTMLButtonElement, action: () => Promise<{ ok: boolean; error?: string }>) => {
      rowActionFocus.current = button;
      void run(action);
    },
    [run],
  );

  useEffect(() => {
    if (busy) return;
    const button = rowActionFocus.current;
    rowActionFocus.current = null;
    if (!button || !button.isConnected || button.disabled) return;
    const active = document.activeElement;
    if (active === null || active === document.body) button.focus();
  }, [busy]);

  const openCancelDialog = useCallback((workflow: AshbyMcWorkflow, trigger: HTMLElement) => {
    setSuccess(null);
    refocusAfterCancel.current = false;
    cancelReturnFocus.current = trigger;
    setCancelError(null);
    setCancelTarget(workflow);
  }, []);

  /**
   * Keep screening, Close, Escape and the backdrop all land here. Focus goes
   * back to the row's More button when it can take it; when it cannot (the
   * reload found the application closed, so the row has no menu any more),
   * to the row's application id; failing that, `useModal` falls back to
   * `main` rather than `<body>`.
   */
  const closeCancelDialog = useCallback(() => {
    const trigger = cancelReturnFocus.current;
    if (!trigger || !document.contains(trigger) || trigger.matches(':disabled')) {
      const anchor = cancelTarget ? workflowAnchors.current.get(cancelTarget.applicationLinkId) : undefined;
      cancelReturnFocus.current = anchor && document.contains(anchor) ? anchor : null;
    }
    setCancelTarget(null);
  }, [cancelTarget]);

  /**
   * Cancel one application's screening. Success is the absence of a throw
   * AND of `ok: false`. On success the list is reloaded BEFORE the dialog
   * closes: the row turns terminal and its More button leaves, so focus is
   * pointed at the row itself first. `already_terminal` and `not_found`
   * mean the row on screen is stale; reload so the page tells the truth, and
   * turn the confirm button off, since pressing it again cannot succeed.
   */
  const cancelWorkflow = useCallback(async () => {
    if (!cancelTarget || cancelling) return;
    const linkId = cancelTarget.applicationLinkId;
    setCancelError(null);
    setCancelling(true);
    try {
      let code: string | null = null;
      try {
        const res = await api.cancelAshbyWorkflow(linkId, 'manual_stage_cancel');
        if (!res.ok) code = res.error ?? 'unknown';
      } catch (err) {
        code = err instanceof ApiError ? err.message : 'unknown';
      }
      if (code === null) {
        await load();
        cancelReturnFocus.current = workflowAnchors.current.get(linkId) ?? null;
        setCancelTarget(null);
        setSuccess(SCREENING_CANCELLED);
        return;
      }
      const stale = code === 'already_terminal' || code === 'not_found';
      if (stale) await load();
      setCancelError({ message: cancelErrorCopy(code), retryable: !stale });
      refocusAfterCancel.current = true;
    } finally {
      setCancelling(false);
    }
  }, [cancelTarget, cancelling, load]);

  /** After a FAILED cancel settles: the same focus rule as a failed delete. */
  useEffect(() => {
    if (cancelling || !refocusAfterCancel.current) return;
    refocusAfterCancel.current = false;
    restoreFocus(cancelBodyRef.current);
  }, [cancelling]);

  /* What needs a look, said once above each list instead of left for the
     reader to count down the rows. */
  const mappingSummary = loaded
    ? sentence([
        [mappings.filter((m) => m.status === 'enabled').length, 'live'],
        [mappings.filter((m) => m.status === 'paused').length, 'paused'],
        [mappings.filter((m) => m.status === 'drift').length, 'out of sync'],
      ])
    : null;
  const workflowSummary = loaded
    ? sentence([
        [workflows.filter((w) => w.operations.some((op) => op.state === 'failed')).length, 'with a failed operation'],
        [workflows.filter(notQueuedForWriteback).length, 'not queued for write-back'],
        [workflows.filter((w) => w.ingestionState === 'failed_review').length, 'with a resume to review'],
      ])
    : null;

  const workflowRows = (
    <ul className={LIST}>
      {workflows.map((w) => {
        const terminal = w.terminalState != null;
        // A finished screening's row offers its review first; reissuing an
        // invite after a completed call is the rare case, so it waits in More.
        const reviewable = Boolean(w.sessionId) && w.sessionStatus === 'completed';
        const inviteLabel = w.operations.some(
          (op) => op.type === 'invite_delivery' && op.state === 'succeeded',
        )
          ? 'Reissue invite link'
          : 'Get invite link';
        const lifecycle = LIFECYCLE[w.lifecycle] ?? { label: humanizeEnum(w.lifecycle), tone: 'neutral' };
        // A closed application has nothing left to do except, perhaps, be
        // reviewed: no invite, no cancel, and so no menu at all.
        const menuItems: OverflowMenuItem[] = terminal
          ? []
          : [
              ...(reviewable
                ? [
                    {
                      key: 'invite',
                      label: inviteLabel,
                      disabled: busy,
                      onSelect: () => void deliverInvite(w.applicationLinkId),
                    },
                  ]
                : []),
              {
                key: 'cancel',
                label: 'Cancel screening',
                tone: 'danger',
                haspopup: 'dialog',
                disabled: busy,
                onSelect: (trigger) => openCancelDialog(w, trigger),
              },
            ];
        const hasActions = reviewable || !terminal;
        return (
          <li
            key={w.applicationLinkId}
            className="grid grid-cols-1 gap-x-6 gap-y-3 py-4 first:pt-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
          >
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                {/* The application's only name on this page. Focusable by
                    script only: where focus goes once a cancel closes the
                    row's menu for good. */}
                <span
                  ref={(node) => {
                    if (node) workflowAnchors.current.set(w.applicationLinkId, node);
                    else workflowAnchors.current.delete(w.applicationLinkId);
                  }}
                  tabIndex={-1}
                  className="rounded-sm font-mono text-label font-medium text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-info"
                >
                  {w.externalApplicationId}
                </span>
                <StatusBadge tone={lifecycle.tone}>
                  <span title={w.lifecycle}>{lifecycle.label}</span>
                </StatusBadge>
                {w.terminalState && (
                  <StatusBadge tone="neutral">
                    <span title={w.terminalState}>{humanizeEnum(w.terminalState, TERMINAL_LABELS)}</span>
                  </StatusBadge>
                )}
                {/* A completed screening whose link never reached
                    `writeback_pending` is a completion park that did not
                    land. The observer is best-effort by design (it must
                    never discard a scored assessment), so this is where that
                    case becomes visible instead of living only in a log. */}
                {notQueuedForWriteback(w) && (
                  <StatusBadge tone="warning">
                    <span title="The screening finished, but the workflow never reached writeback_pending, so its scorecard will not be written to Ashby.">
                      Not queued for write-back
                    </span>
                  </StatusBadge>
                )}
              </div>
              {(w.ingestionState || w.operations.length > 0) && (
                <ul className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-label text-ink-secondary">
                  {w.ingestionState && (
                    <li
                      title={w.ingestionState}
                      className={w.ingestionState === 'failed_review' ? 'text-warning-text' : undefined}
                    >
                      Resume import: {humanizeEnum(w.ingestionState, INGESTION_LABELS)}
                    </li>
                  )}
                  {w.operations.map((op) => {
                    const type = humanizeEnum(op.type, OPERATION_LABELS);
                    const failed = op.state === 'failed';
                    return (
                      <li key={op.id} className="flex items-center gap-2">
                        <span
                          title={`${op.type}: ${op.state}${op.errorCode ? ` (${op.errorCode})` : ''}`}
                          className={failed ? 'text-error-text' : undefined}
                        >
                          {type}: {humanizeEnum(op.state, OPERATION_STATE_LABELS)}
                          {op.errorCode ? ` (${humanizeEnum(op.errorCode, ERROR_CODE_LABELS)})` : ''}
                        </span>
                        {failed && (
                          <Button
                            className={TOUCH}
                            disabled={busy}
                            // Starts with the visible word; says WHICH retry.
                            aria-label={`Retry ${type.toLowerCase()}`}
                            onClick={() => run(() => api.retryAshbyOperation(op.id))}
                          >
                            Retry
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            {hasActions && (
              // `min-w-0`, NOT `shrink-0`: a flex item that may not shrink
              // keeps its one-line width even after wrapping onto its own
              // line, and on a 360px phone that line is wider than the
              // screen. Same rule on the mapping rows.
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:justify-end" data-testid="row-actions">
                {reviewable ? (
                  <Link
                    to={`/sessions/${encodeURIComponent(w.sessionId ?? '')}`}
                    className={buttonClass('secondary', 'md', TOUCH)}
                  >
                    Review screening
                  </Link>
                ) : (
                  <Button
                    className={TOUCH}
                    disabled={busy}
                    onClick={() => void deliverInvite(w.applicationLinkId)}
                  >
                    {inviteLabel}
                  </Button>
                )}
                {menuItems.length > 0 && (
                  <OverflowMenu label={`More actions for ${w.externalApplicationId}`} items={menuItems} />
                )}
              </div>
            )}

            {inviteError?.linkId === w.applicationLinkId && (
              <InlineNotice tone="danger" role="alert" className="sm:col-span-2">
                {inviteError.message}
              </InlineNotice>
            )}

            {invite?.linkId === w.applicationLinkId && (
              <div className="glass-sunken p-3 sm:col-span-2 sm:p-4">
                {/*
                  The one-time candidate link. It lives in component state only —
                  it is not stored, not logged, and the token sits in the URL
                  fragment so it never reaches a server or an access log.
                */}
                <label
                  htmlFor={`invite-${w.applicationLinkId}`}
                  className="block text-label font-medium text-ink-secondary"
                >
                  Candidate link, shown once. Expires {formatWhen(invite.expiresAt)}
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <TextField
                    id={`invite-${w.applicationLinkId}`}
                    readOnly
                    value={invite.joinUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="font-mono"
                  />
                  <Button className={cx('shrink-0', TOUCH)} onClick={() => void copyInvite()}>
                    {copied ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p className="mt-2 text-label text-ink-tertiary">
                  Send it to the candidate yourself. It isn&apos;t stored and can&apos;t be shown
                  again; reissuing revokes it and makes a new one.
                </p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      {/* No eyebrow and no header buttons: the sidebar already says where
          this page sits, and the page's one primary action — Add mapping —
          belongs to the list it adds to. */}
      <PageHeader
        title="Ashby Mission Control"
        description="The Ashby jobs HELLO screens, and each application's progress. Candidate details never appear here."
      />

      {!loaded && <LoadingPanel />}
      {error && (
        <InlineNotice tone="danger" role="alert" className="mt-6">
          {error}
        </InlineNotice>
      )}
      {/* ALWAYS mounted, empty until a save, a delete or a cancel succeeds:
          a status region that already exists announces its new text; one
          that mounts WITH its text may not. The notice inside carries no
          role of its own (`none`), or the confirmation would be announced
          twice. */}
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
                  <span className="text-label tabular-nums text-ink-tertiary">{mappings.length}</span>
                ) : undefined
              }
              description={mappingSummary ?? undefined}
              actions={
                // THE page's one primary action. `Button` passes `ref`
                // through to the `<button>`; the dialog returns focus here.
                <Button
                  ref={addMappingTrigger}
                  variant="primary"
                  className={TOUCH}
                  icon={<PlusIcon />}
                  onClick={openDialog}
                  aria-haspopup="dialog"
                >
                  Add mapping
                </Button>
              }
            />

            {loaded && mappings.length === 0 ? (
              <EmptyPanel
                compact
                className="mt-4"
                title="No jobs are mapped yet."
                hint="Add a mapping to screen an Ashby job's applicants with one of your roles."
              />
            ) : (
              <ul className={cx('mt-2', LIST)}>
                {mappings.map((m, i) => {
                  const status = MAPPING_STATUS[m.status] ?? {
                    label: humanizeEnum(m.status),
                    tone: 'neutral' as StatusTone,
                  };
                  const name = mappingName(m, jobNames, jobsPending);
                  const live = m.status === 'enabled';
                  const missing = missingStages(m);
                  // ONE visible action for the row's state. A live mapping,
                  // or an out-of-sync one, can only be PAUSED — the database
                  // refuses to resume an out-of-sync mapping outright
                  // (`drifted_cannot_enable`), so offering Resume there
                  // would only invite an error. A paused one can be resumed
                  // once both of its Ashby stages exist; until then Resume
                  // stays visible, off, and described by the line that says
                  // which stage is missing.
                  const pausing = m.status !== 'paused';
                  const resumeBlocked = !pausing && missing !== null;
                  const menuItems: OverflowMenuItem[] = [
                    {
                      key: 'form',
                      label: 'Discover feedback form',
                      disabled: busy,
                      onSelect: () => void discoverForm(m.externalJobId),
                    },
                    {
                      key: 'binding',
                      label: 'Preview scorecard binding',
                      disabled: busy,
                      onSelect: () => void previewBinding(m.id),
                    },
                    {
                      key: 'backlog',
                      label: 'Preview existing backlog',
                      disabled: busy || !live,
                      disabledReason: live ? undefined : BACKLOG_NEEDS_LIVE,
                      onSelect: () => void previewBacklog(m.id),
                    },
                    {
                      // Quiet until it matters: error ink in a menu, the
                      // filled red only on the dialog's confirm button.
                      key: 'delete',
                      label: 'Delete',
                      tone: 'danger',
                      haspopup: 'dialog',
                      disabled: busy || live,
                      disabledReason: live ? PAUSE_BEFORE_DELETE : undefined,
                      onSelect: (trigger) => openDeleteDialog(m, trigger),
                    },
                  ];
                  return (
                    <li
                      key={m.id}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-3 py-4 sm:grid-cols-[minmax(0,1fr)_7.5rem_auto] sm:items-center"
                    >
                      <MappingSummary
                        mapping={m}
                        name={name}
                        jobNames={jobNames}
                        rolesById={rolesById}
                        rolesPending={rolesPending}
                        missing={missing}
                        missingId={missingStageId(i)}
                      />
                      {/* A column of its own at desk width, so the states
                          line up down the list and can be scanned. */}
                      <div className="col-start-2 row-start-1 justify-self-end sm:justify-self-start">
                        <StatusBadge tone={status.tone}>
                          <span title={m.status}>{status.label}</span>
                        </StatusBadge>
                      </div>
                      {/* The same wrapper on EVERY row, so a status change
                          never remounts the controls — the More button the
                          Delete dialog returns focus to must be the node that
                          is still on the page. `min-w-0`, not `shrink-0`: see
                          the workflow rows. */}
                      <div
                        className="col-span-2 flex min-w-0 flex-wrap items-center gap-2 sm:col-span-1 sm:col-start-3 sm:row-start-1 sm:justify-end"
                        data-testid="row-actions"
                      >
                        <Button
                          className={cx('min-w-[5.5rem]', TOUCH)}
                          disabled={busy || resumeBlocked}
                          aria-describedby={resumeBlocked ? missingStageId(i) : undefined}
                          onClick={(e) =>
                            rowAction(e.currentTarget, () =>
                              pausing ? api.pauseAshbyMapping(m.id) : api.resumeAshbyMapping(m.id),
                            )
                          }
                        >
                          {pausing ? 'Pause' : 'Resume'}
                        </Button>
                        <OverflowMenu label={`More actions for ${name}`} items={menuItems} />
                      </div>

                      {(formError?.jobId === m.externalJobId ||
                        formSchema?.jobId === m.externalJobId ||
                        bindingError?.mappingId === m.id ||
                        bindingPreview?.mappingId === m.id ||
                        backlogError?.mappingId === m.id ||
                        backlogPreview?.mappingId === m.id) && (
                        <div className="col-span-full flex min-w-0 flex-col gap-3">
                          {formError?.jobId === m.externalJobId && (
                            <InlineNotice tone="danger" role="alert">
                              {formError.message}
                            </InlineNotice>
                          )}

                          {formSchema?.jobId === m.externalJobId && (
                            <FeedbackFormSchema forms={formSchema.forms} truncated={formSchema.truncated} />
                          )}

                          {bindingError?.mappingId === m.id && (
                            <InlineNotice tone="danger" role="alert">
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
                            <InlineNotice tone="danger" role="alert">
                              {backlogError.message}
                            </InlineNotice>
                          )}

                          {backlogPreview?.mappingId === m.id && (() => {
                            const p = backlogPreview.preview;
                            const expired = Date.parse(p.expiresAt) <= Date.now();
                            const atCap = p.expectedCount >= p.cap;
                            return (
                              <div className="glass-sunken p-4" role="region" aria-label="Backlog import preview">
                                <p className="text-label font-medium text-ink">
                                  {expired ? 'This preview has expired.' : `This snapshot contains ${p.expectedCount} existing application${p.expectedCount === 1 ? '' : 's'} from this job and stage.`}
                                </p>
                                <p className="mt-1 text-label text-ink-secondary">
                                  Default behavior is future stage entries only. Confirmation schedules only this exact snapshot; completed or already-deduplicated applications may be no-ops, and existing phone engagements are not cancelled by this policy. The snapshot expires {formatWhen(p.expiresAt)} and is capped at {p.cap} applications.
                                </p>
                                {atCap && !expired && <p className="mt-2 text-label text-warning-text">This preview is at the safety cap; narrow the mapping or ask an operator to review before importing.</p>}
                                <label className="mt-3 flex items-start gap-2 text-label text-ink-secondary">
                                  <input type="checkbox" checked={backlogConfirmArmed} disabled={busy || expired} onChange={(e) => setBacklogConfirmArmed(e.target.checked)} />
                                  <span>I understand this is an explicit provider-backed import and may create screening work.</span>
                                </label>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                  <Button className={TOUCH} disabled={busy || expired || !backlogConfirmArmed} onClick={() => void confirmBacklog(m.id, p)}>
                                    {busy ? 'Confirming…' : 'Confirm and import this snapshot'}
                                  </Button>
                                  <Button variant="ghost" className={TOUCH} disabled={busy} onClick={() => { setBacklogPreview(null); setBacklogConfirmArmed(false); }}>
                                    Cancel
                                  </Button>
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </li>
                  );
                })}
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
                  <span className="text-label tabular-nums text-ink-tertiary">{workflows.length}</span>
                ) : undefined
              }
              description={workflowSummary ?? undefined}
            />
            {loaded && workflows.length === 0 ? (
              <EmptyPanel
                compact
                className="mt-4"
                title="No applications yet."
                hint="Applicants for a live mapping appear here once Ashby sends them."
              />
            ) : workflows.length > WORKFLOW_SCROLL_AFTER ? (
              <ScrollArea maxHeight="36rem" label="Application workflows" className="mt-1">
                {workflowRows}
              </ScrollArea>
            ) : (
              <div className="mt-1">{workflowRows}</div>
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
        description="Screen applicants for a live Ashby job with one of your roles. New mappings start paused."
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
          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              id="ashby-mapping-job-label"
              htmlFor="ashby-mapping-job"
              className="text-label font-medium text-ink"
            >
              Ashby job
            </label>
            <Combobox
              id="ashby-mapping-job"
              labelId="ashby-mapping-job-label"
              ref={jobSelectRef}
              value={draft.jobKey}
              onChange={(next) => setDraft((d) => ({ ...d, jobKey: next }))}
              options={jobPickerOptions}
              placeholder={jobsStatus === 'loading' ? 'Loading jobs from Ashby…' : jobsStatus === 'error' ? 'Jobs unavailable' : 'Choose a job'}
              searchLabel="Search open jobs"
              listLabel="Open Ashby jobs"
              noun={['job', 'jobs']}
              noMatchText={(q) => `No open job matches “${q}”.`}
              loading={jobsStatus === 'loading'}
              disabled={creating || jobsStatus !== 'ready' || jobOptions.length === 0}
              aria-describedby={hasJobNote ? 'ashby-mapping-job-note' : undefined}
            />
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
                  This list may be incomplete — Ashby was slow or has more jobs than it can
                  show. If a job is missing, close this and try again in a minute.
                </InlineNotice>
              )}
              {jobsHidden && (
                // The same reason as the cut above: an admin looking for a
                // confidential job must not conclude Ashby has none.
                <p className="text-label text-ink-tertiary">{CONFIDENTIAL_WITHHELD}</p>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <label
              id="ashby-mapping-role-label"
              htmlFor="ashby-mapping-role"
              className="text-label font-medium text-ink"
            >
              Role
            </label>
            <Combobox
              id="ashby-mapping-role"
              labelId="ashby-mapping-role-label"
              ref={roleSelectRef}
              value={draft.roleId}
              onChange={(next) => setDraft((d) => ({ ...d, roleId: next }))}
              options={rolePickerOptions}
              placeholder={rolesStatus === 'loading' ? 'Loading roles…' : rolesStatus === 'error' ? 'Roles unavailable' : 'Choose a role'}
              searchLabel="Search roles"
              listLabel="Active roles"
              noun={['role', 'roles']}
              noMatchText={(q) => `No active role matches “${q}”.`}
              loading={rolesStatus === 'loading'}
              disabled={creating || rolesStatus !== 'ready' || activeRoles.length === 0}
              aria-describedby={hasRoleNote ? 'ashby-mapping-role-note' : undefined}
            />
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

          <MappingPreview jobName={chosenJob?.label ?? null} roleName={chosenRole?.title ?? null} />

          {createError && (
            // `text-error-text`, not `text-danger`. Tailwind here defines
            // `error`, not `danger`, so `text-danger` compiles to nothing
            // and the message rendered as ordinary body ink — it read as
            // help text rather than a failure. `Field` already uses this
            // token for exactly this.
            <p role="alert" className="text-label text-error-text">
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
            <p role="alert" className="text-label text-error-text">
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

      {/* Also at the page root. The application id is the only name this
          page has for an application (the list carries no candidate
          details), so it is the dialog's description, as the job's name is
          Delete's: "which one?" answered with the title. */}
      <Dialog
        open={cancelTarget !== null}
        onClose={closeCancelDialog}
        idPrefix="ashby-workflow-cancel"
        title="Cancel this screening?"
        description={cancelTarget?.externalApplicationId}
        returnFocusRef={cancelReturnFocus}
        busy={cancelling}
      >
        <div ref={cancelBodyRef} className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-ink-secondary">{CANCEL_CONSEQUENCES}</p>

          {cancelError && (
            <p role="alert" className="text-label text-error-text">
              {cancelError.message}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button variant="ghost" onClick={closeCancelDialog} disabled={cancelling}>
              Keep screening
            </Button>
            <Button
              variant="danger"
              loading={cancelling}
              disabled={cancelError?.retryable === false}
              onClick={() => void cancelWorkflow()}
              data-dialog-primary=""
            >
              {cancelling ? 'Cancelling…' : 'Cancel screening'}
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
        <p className="mt-3 text-label text-ink-secondary">
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
              <p className="font-mono text-label text-ink-secondary">form id: {f.formDefinitionId}</p>
              {(f.stageTitle || f.stageId) && (
                <p className="text-label text-ink-tertiary">
                  stage: {f.stageTitle ?? 'untitled'}
                  {f.stageId ? ` (${f.stageId})` : ''}
                </p>
              )}
              {(f.interviewTitle || f.interviewId) && (
                <p className="text-label text-ink-tertiary">
                  interview: {f.interviewTitle ?? 'untitled'}
                  {f.interviewId ? ` (${f.interviewId})` : ''}
                </p>
              )}
              {!f.schemaAvailable ? (
                <p className="mt-2 text-label text-warning-text">
                  Field-level schema is not available from the interview plan for this form — only
                  its id could be read. This is not a claim that the form has no fields.
                </p>
              ) : (
                <>
                  <p className="mt-2 text-label text-ink-tertiary">{f.fieldCount} field(s)</p>
                  {f.sections.map((sec, si) => (
                    <div key={sec.id ?? `section-${si}`} className="mt-2">
                      <p className="text-label font-medium text-ink-secondary">
                        {sec.title ?? 'Untitled section'}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {sec.fields.map((field) => (
                          <li key={field.id} className="text-label text-ink-secondary">
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
 * What Save will create, said once — and only once both halves are chosen.
 * An always-present preview of dashed "Job → Role" placeholders restated the
 * pickers above it (and truncated to "R…" on a phone); a single sentence
 * that names both choices in full is the useful part, and it wraps.
 */
function MappingPreview({ jobName, roleName }: { jobName: string | null; roleName: string | null }) {
  if (!jobName || !roleName) return null;
  return (
    <p className="rounded-[12px] bg-ink/[0.035] px-3.5 py-2.5 text-label text-ink-secondary">
      Applicants for <span className="font-medium text-ink">{jobName}</span> will be screened with
      the <span className="font-medium text-ink">{roleName}</span> role&apos;s questions and
      scorecard.
    </p>
  );
}

/**
 * Focus after a picker's "Try again" read settles: the picker's trigger when
 * it is enabled; else the first live control in its note (Try again once
 * more, or the Roles-page link); else the note itself, which is focusable by
 * script.
 */
function focusAfterRetry(select: HTMLButtonElement | null, note: HTMLElement | null): void {
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

/**
 * The opening date as "2 Jul 2026", or null when Ashby's value is missing or
 * unparseable. FIXED locale and UTC, not the viewer's: this string becomes
 * part of a duplicate job's name, and that name is SAVED as the mapping's
 * label — a viewer-local format would store "2 Jul" for an admin in India and
 * render "Jul 1" for one in the US, and the row would then show two dates.
 *
 * Built by hand, not with `toLocaleDateString`: ICU versions disagree on the
 * short month (current ones print "Sept"), and a saved label must not depend
 * on which browser saved it.
 */
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function openedDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCDate()} ${SHORT_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
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
 * The role a mapping screens for, on the row's second line. Resolved against
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
 * Which of the mapping's two Ashby stages is missing, in words, or null when
 * both exist. A mapping without both cannot be resumed; this is the line
 * that says why.
 */
function missingStages(mapping: AshbyMcMapping): string | null {
  if (mapping.hasAiStage && mapping.hasTaStage) return null;
  if (!mapping.hasAiStage && !mapping.hasTaStage) return 'Both Ashby stages are missing';
  return mapping.hasAiStage ? 'The TA stage is missing in Ashby' : 'The AI screening stage is missing in Ashby';
}

/**
 * A mapping's paused / out-of-sync reason for display. The column holds a
 * sanitized reason that is sometimes a sentence and sometimes a code; a code
 * becomes words, a sentence is shown as written.
 */
function reasonText(reason: string): string {
  const trimmed = reason.trim();
  return /^[a-z0-9_.:-]+$/.test(trimmed) ? humanizeEnum(trimmed, STATUS_REASON_LABELS) : trimmed;
}

/**
 * A mapping row's text, STACKED — never run together on one line: the job's
 * name (primary), then a quiet line with the role it screens for and, when
 * there is one, why it is paused or out of sync and which stage is missing;
 * then the saved label, but only when it says something neither the name
 * nor the job's own title already says (an older mapping's hand-typed tag,
 * or the name from before a rename). Nothing here renders `externalJobId` or
 * `roleId` — not as text, not as an attribute.
 */
function MappingSummary({
  mapping,
  name,
  jobNames,
  rolesById,
  rolesPending,
  missing,
  missingId,
}: {
  mapping: AshbyMcMapping;
  /** The shared display name (`mappingName`). */
  name: string;
  jobNames: JobNames | null;
  rolesById: Map<string, Role> | null;
  rolesPending: boolean;
  /** `missingStages(mapping)`. */
  missing: string | null;
  /** The missing-stage line's id: it also describes a disabled Resume. */
  missingId: string;
}) {
  const label = mapping.label?.trim() || null;
  const title = jobNames?.get(mapping.externalJobId)?.title ?? null;
  // A label saved before dates were hand-formatted may say "Sept" where the
  // name now says "Sep" — the same date, so it is not a second line's worth.
  const sameDate = (a: string | null) => (a ?? '').replace(/\bSept\b/g, 'Sep');
  const showLabel =
    label !== null && sameDate(label) !== sameDate(name) && sameDate(label) !== sameDate(title);
  const reason = mapping.statusReason?.trim() ? mapping.statusReason.trim() : null;
  // Separators only where the facts share a line (desk width). On a phone
  // each fact takes its own line, where a dot would be left dangling.
  const dot = (
    <span aria-hidden="true" className="hidden text-ink-muted sm:inline">
      ·
    </span>
  );
  return (
    <div className="col-start-1 row-start-1 flex min-w-0 flex-col gap-0.5">
      <span className="min-w-0 break-words text-sm font-medium leading-5 text-ink">{name}</span>
      <div className="flex min-w-0 flex-col text-label sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2">
        <p className="min-w-0 break-words text-ink-secondary">{roleLine(mapping, rolesById, rolesPending)}</p>
        {reason && (
          <>
            {dot}
            <p className="min-w-0 break-words text-ink-tertiary" title={reason}>
              {reasonText(reason)}
            </p>
          </>
        )}
        {missing && (
          <>
            {dot}
            <p id={missingId} className="min-w-0 break-words text-warning-text">
              {missing}
            </p>
          </>
        )}
      </div>
      {showLabel && <p className="min-w-0 break-words text-label text-ink-tertiary">{label}</p>}
    </div>
  );
}

/**
 * A completed screening whose workflow never reached `writeback_pending`:
 * the completion park did not land, so no scorecard will reach Ashby.
 */
function notQueuedForWriteback(w: AshbyMcWorkflow): boolean {
  return w.sessionStatus === 'completed' && w.terminalState == null && w.lifecycle !== 'writeback_pending';
}

/**
 * Counts as one sentence — "1 live, 1 paused and 1 out of sync." — leaving
 * out whatever is zero; null when everything is.
 */
function sentence(parts: Array<[number, string]>): string | null {
  const said = parts.filter(([n]) => n > 0).map(([n, words]) => `${n} ${words}`);
  if (said.length === 0) return null;
  const last = said.pop()!;
  return `${said.length > 0 ? `${said.join(', ')} and ` : ''}${last}.`;
}

/**
 * The page's one date-and-time format: "18 Aug, 14:05" this year, "18 Aug
 * 2027, 14:05" otherwise, in the viewer's time zone. Built by hand for the
 * same reason as `openedDate`: ICU versions disagree on "Sep" and "Sept".
 */
function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'at an unknown time';
  const year = date.getFullYear() === new Date().getFullYear() ? '' : ` ${date.getFullYear()}`;
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()} ${SHORT_MONTHS[date.getMonth()]}${year}, ${hh}:${mm}`;
}

/**
 * The cancel route's machine codes, in words. The two stale-row codes say
 * the list was refreshed (the handler reloads before this shows); anything
 * else is worth one more try.
 */
function cancelErrorCopy(code: string): string {
  switch (code) {
    case 'already_terminal':
      return 'This application was already closed. The list has been refreshed.';
    case 'not_found':
      return 'This application is no longer listed. The list has been refreshed.';
    default:
      return 'Could not cancel this screening. Try again.';
  }
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" aria-hidden="true" className="h-4 w-4">
      <path d="M12 5v14M5 12h14" />
    </svg>
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
      <p className="mt-2 text-label text-ink-secondary">
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

      <p className="mt-3 text-label font-medium text-ink-secondary">Fixed fields (verified binding)</p>
      <ul className="mt-1 space-y-1">
        {preview.fixedFields.map((f) => (
          <li key={f.name} className="text-label text-ink-secondary">
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
          <p className="mt-3 text-label font-medium text-ink-secondary">Metrics (bound by name)</p>
          {preview.metrics.length === 0 ? (
            <p className="mt-1 text-label text-ink-tertiary">The active scorecard has no metrics.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {preview.metrics.map((m) => (
                <li key={m.key} className="text-label text-ink-secondary">
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
        <p className="mt-3 text-label text-ink-tertiary">
          Score fields no metric claims (left empty on the card):{' '}
          {preview.unusedScoreFields.map((u) => u.title ?? u.fieldId).join(', ')}
        </p>
      )}
    </div>
  );
}

export default AshbyMissionControlPage;
