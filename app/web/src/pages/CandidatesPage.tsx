/**
 * Candidates — recruiter pipeline list with URL-addressable drill-down filters.
 *
 * The dashboard links here with `?status=…&role=…`; those filters are parsed
 * from the URL (via `useSearchParams`) so deep links and browser back/forward
 * work, and are shown as removable chips. Status is filtered client-side (the
 * list API only filters by role); role is passed to the API. Every row's name
 * is a real keyboard-reachable link to the candidate workspace, and a
 * "Next action" column makes the obvious next step explicit.
 *
 * A candidate imported from Ashby exists before its resume is parsed: its
 * `name`/`email`/`phone` are null and its status is `queued`. Such a row is
 * titled with the shared neutral `CANDIDATE_SHELL_TITLE` rather than a
 * fabricated identity, and carries the sanitized `resume_review` badge that
 * says how far its resume got — and nothing more.
 *
 * Surfaces: one glass panel per logical block — the upload form (a disclosure,
 * CLOSED by default since candidates arrive from Ashby rather than by hand),
 * the per-role pipeline chart, the filter bar, the table — floating on the
 * shell ground. In the filter bar THE BAR IS THE FILTER: its legend entries
 * are the toggles, so there is one surface carrying both the figures and the
 * controls rather than a chart stacked on top of a chip row saying the same
 * numbers. The list is paginated at ten
 * rows so it never runs off the page, and the filter contract
 * (`parseCandidateFilters` / `buildCandidateSearch` / `matchesCandidateFilters`)
 * is untouched: the chips, the counts and "Clear all" drive the same URL.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Candidate, Role } from "../types";
import type { CandidateFilters } from "../components/talent";
import { CandidateButton } from "../components/design/candidate";
import {
  Button,
  buttonClass,
  EmptyPanel,
  ErrorPanel,
  Field,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  Pagination,
  SelectField,
  StatusBadge,
  Table,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  usePagination,
} from "../components/design";
import {
  CandidateHeader,
  CandidateShell,
  PipelineBar,
  RolePipelinePanel,
} from "../components/talent";
import {
  buildCandidateSearch,
  candidateNextAction,
  candidateStatusLabel,
  candidateStatusTone,
  CANDIDATE_STATUS_ORDER,
  hasActiveFilters,
  matchesCandidateFilters,
  normalizeStatus,
  parseCandidateFilters,
  recommendationLabel,
  RECOMMENDATION_ORDER,
  candidateDisplayName,
  ResumeReviewBadge,
  resumeReviewLabel,
  RESUME_REVIEW_ORDER,
} from "../components/talent";
import type { StatusTone } from "../components/design/StatusBadge";
import type { PipelineTone } from "../components/talent";
import { roleAgentName } from "../lib/role-label";

/**
 * Filter pill. Multi-select toggles, so these stay `button`s carrying
 * `aria-pressed` rather than becoming a `SegmentedControl` (which is a
 * single-choice radio group). The 44px minimum target is kept: `min-h-11`
 * is what the scope integration test reads, and it is also the reason the
 * pill is taller than the 32px chips elsewhere in the shell.
 */
const FILTER_PILL_CLASS = (selected: boolean) =>
  [
    "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-label font-medium transition-colors duration-200",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]",
    selected
      ? "bg-[var(--c-accent)] text-[var(--c-data-label-inside)] shadow-pill"
      : "bg-[var(--c-surface)] text-[var(--c-ink-secondary)] shadow-[inset_0_0_0_1px_var(--c-border)] hover:bg-[var(--c-border-light)] hover:text-[var(--c-ink)]",
  ].join(" ");

/** The live count inside a pill. Never the tone colour on the tone's fill. */
const PILL_COUNT_CLASS = (selected: boolean) =>
  selected ? "tabular-nums" : "tabular-nums text-[var(--c-ink-secondary)]";

const RECOMMENDATION_TONE: Record<string, StatusTone> = {
  advance: "success",
  hold: "warning",
  reject: "danger",
};

/**
 * Bar colour per status. Deliberately NOT the `StatusBadge` tone map: a badge
 * colours one candidate's state, while a stack has to stay legible as six
 * adjacent fills.
 *
 * Adjacent statuses must not share a tone. `new`+`queued` both neutral, and
 * `screened`+`advanced` both positive, rendered as single indistinguishable
 * runs — and since the swatch colour is the only thing linking legend to bar,
 * no sighted user could tell which part was which. Colour vision is not the
 * issue; injectivity is.
 */
const STATUS_BAR_TONE: Record<string, PipelineTone> = {
  new: "neutral",
  queued: "caution",
  screening: "accent",
  screened: "positive",
  advanced: "positive",
  rejected: "negative",
  consent_declined: "negative",
};

const RECOMMENDATION_BAR_TONE: Record<string, PipelineTone> = {
  advance: "positive",
  hold: "caution",
  reject: "negative",
};

/**
 * The agent screening this candidate's role — the operator-facing name, never
 * spoken to the candidate. Sits immediately left of the Role column.
 *
 * ONE neutral marker for every "no agent to show" case: the candidate has no
 * role, the role has no agent name, the roles request has not landed, or the
 * role is not in the viewer's list. The Role column beside it already tells
 * those states apart; repeating "No role" / "Unknown role" here would say the
 * same thing twice in one row.
 */
function AgentCell({ role }: { role: Role | undefined }) {
  const name = role ? roleAgentName(role) : null;
  if (name) {
    return <span className="text-label text-[var(--c-ink)]">{name}</span>;
  }
  return <span className="text-[var(--c-ink-secondary)]">—</span>;
}

/**
 * The role a candidate's row belongs to.
 *
 * ONE role per row, because that is what the row IS: `candidates.role_id` is a
 * single FK and a row is one Ashby APPLICATION, so a person who applied to two
 * roles is two rows carrying one role each. Rendering a list here would imply
 * a many-to-many the data cannot express, and would make the row's
 * "Review & decide" ambiguous about which application it decides.
 *
 * Three distinct states, deliberately not collapsed into one:
 *   - no role on the candidate          → "No role"
 *   - roles not fetched yet, or failed  → "—"   (we do not know)
 *   - fetched, and the id is absent     → "Unknown role" (deleted/out of scope)
 * The middle case used to render as "Unknown role" for EVERY row whenever the
 * candidates request won its race with the roles request — a confident claim
 * that every candidate's role had been deleted.
 */
function RoleCell({
  roleId,
  title,
  rolesLoaded,
}: {
  roleId: string | null;
  title: string | undefined;
  rolesLoaded: boolean;
}) {
  if (!roleId) {
    return <span className="text-[var(--c-ink-secondary)]">No role</span>;
  }
  if (title) {
    // No `data-` attribute carrying the raw uuid: it would confirm the id of a
    // role the viewer may have no scope to see.
    return <span className="text-label text-[var(--c-ink)]">{title}</span>;
  }
  return (
    <span className="text-[var(--c-ink-secondary)]">{rolesLoaded ? "Unknown role" : "—"}</span>
  );
}

/**
 * Skills as ONE quiet line of text, not a wrap of outlined chips.
 *
 * Four chips per row broke onto two lines on most rows and made the skills
 * the loudest thing in a table whose job is status and next step. The first
 * two read as a list; the rest are a count; the whole list is the `title`
 * and, in full, on the candidate's profile, so the ellipsis hides nothing.
 */
function SkillsCell({ skills }: { skills: string[] }) {
  if (skills.length === 0) {
    return <span className="text-[var(--c-ink-secondary)]">—</span>;
  }
  const shown = skills.slice(0, 2);
  const more = skills.length - shown.length;
  return (
    <span
      className="flex w-[8.5rem] items-baseline gap-1.5 text-label"
      title={skills.join(", ")}
    >
      <span className="min-w-0 truncate text-[var(--c-ink)]">{shown.join(", ")}</span>
      {more > 0 && (
        <span className="shrink-0 tabular-nums text-[var(--c-ink-secondary)]">+{more}</span>
      )}
    </span>
  );
}

/**
 * Twelve-pixel cell padding instead of the table's default sixteen, with the
 * outer edges kept at sixteen so the first column still lines up with the
 * filter panel above. Eight columns at sixteen a side spent 256px on gutters,
 * which is exactly what pushed the next-action column off a 1440px screen.
 * A descendant selector, so it wins over the cell's own padding without
 * touching the shared `Table`.
 */
const TABLE_DENSITY =
  "[&_td]:px-3 [&_th]:px-3 [&_td:first-child]:pl-4 [&_th:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:last-child]:pr-4";

/**
 * The next step as something to CLICK when there is one, and a dash when
 * there is not.
 *
 * An actionable step ("Start screening", "Review & decide") is a link styled
 * as a secondary button, to the page where the step happens: the Review tab
 * for a decision, the candidate's Overview (where the call and invite live)
 * for a screening. Every other state is waiting on the system ("Queued for
 * screening") or settled ("Rejected"), which the Status column beside it
 * already says; repeating it here made this a column of grey sentences
 * around the few buttons that matter. The words stay for screen readers and
 * on hover.
 *
 * The link's accessible name carries the candidate ("Review & decide, Meera
 * Iyer"): a column of identical "Review & decide" links is ambiguous out of
 * the row's context, which is how a screen reader's links list presents it.
 */
function NextActionCell({
  candidateId,
  candidateName,
  status,
  next,
}: {
  candidateId: string;
  candidateName: string;
  status: string | null | undefined;
  next: { label: string; emphasis: boolean };
}) {
  if (next.emphasis) {
    const isReview = normalizeStatus(status) === "screened";
    return (
      <Link
        to={`/candidates/${candidateId}${isReview ? "?tab=review" : ""}`}
        // The compact size with a 36px floor (`min-h-9`, the design
        // system's control minimum): the md size's wider padding alone would
        // push this column, and so the table, past a 1440px layout.
        className={buttonClass("secondary", "sm", "min-h-9")}
      >
        <span>{next.label}</span>
        <span className="sr-only">, {candidateName}</span>
      </Link>
    );
  }
  return (
    <span className="text-[var(--c-ink-secondary)]" title={next.label}>
      <span aria-hidden="true">—</span>
      <span className="sr-only">{next.label}</span>
    </span>
  );
}

export function CandidatesPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = parseCandidateFilters(searchParams);
  const filterKey = buildCandidateSearch(filters).toString();
  const { roleId } = filters;

  const [roles, setRoles] = useState<Role[]>([]);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const uploadPanelId = useId();
  /**
   * CLOSED by default (owner request 2026-09-22). Uploading a resume by hand
   * is the rare path — candidates arrive from Ashby — and an always-open form
   * pushed the pipeline itself below the fold, which is the thing a recruiter
   * opens this page to read.
   *
   * It stays a real disclosure: the header button owns `aria-expanded`, and
   * the empty state's "Upload a resume" is a button that OPENS the panel
   * rather than prose pointing at a form that is not on screen.
   */
  const [uploadOpen, setUploadOpen] = useState(false);
  const uploadPanelRef = useRef<HTMLElement | null>(null);
  /**
   * Focus is moved ONLY for the far-away trigger.
   *
   * The empty state's button sits below the whole filter bar while the panel
   * is mounted near the top, so opening from there without moving focus leaves
   * a keyboard user shift-tabbing backwards past a dozen controls. The HEADER
   * button sits directly above the panel, where APG is explicit that a
   * disclosure should NOT move focus — doing so makes collapsing it again
   * require tabbing back.
   */
  const [focusPanelOnOpen, setFocusPanelOnOpen] = useState(false);
  const openUpload = useCallback((moveFocus: boolean) => {
    setFocusPanelOnOpen(moveFocus);
    setUploadOpen((open) => !open);
  }, []);
  /**
   * An EFFECT, not a `requestAnimationFrame` inside the state updater.
   *
   * Updaters must be pure: React invokes them during render, replays them on
   * rebase, and double-invokes them under StrictMode — each pass scheduling
   * another frame that yanks focus back. rAF also fires BEFORE paint, so if
   * the commit landed a frame later it focused a still-`hidden` element and
   * silently did nothing. Effects run after commit, so the panel is visible
   * and focusable by definition.
   */
  useEffect(() => {
    if (uploadOpen && focusPanelOnOpen) uploadPanelRef.current?.focus();
  }, [uploadOpen, focusPanelOnOpen]);

  // Generation counter: a slower earlier request must never overwrite the
  // rows of the filter the user is now looking at.
  const loadGen = useRef(0);
  const loadCandidates = useCallback((role: string | null) => {
    const gen = ++loadGen.current;
    setError(null);
    setCandidates(null);
    api
      .listCandidates(role || undefined)
      .then((rows) => { if (gen === loadGen.current) setCandidates(rows); })
      .catch((e: ApiError) => { if (gen === loadGen.current) setError(e.message); });
  }, []);

  /**
   * `null` until the roles request settles, so the Role column can tell
   * "not loaded yet" from "role not in the list".
   *
   * Previously this was `[]` in both cases and the two fetches race: whenever
   * candidates arrived first (or `listRoles` failed), `roleById` was
   * empty and EVERY row rendered "Unknown role" — a positive claim that each
   * candidate's role had been deleted. Harmless while roles only fed a
   * dropdown; load-bearing now that a column asserts from it.
   */
  const [rolesLoaded, setRolesLoaded] = useState(false);
  useEffect(() => {
    api
      .listRoles()
      .then((rows) => {
        setRoles(rows);
        // ONLY on success. `.finally` here marked a FAILED fetch as loaded,
        // which left `roles` empty with `rolesLoaded` true and put every row
        // back to "Unknown role" — the precise claim ("every candidate's role
        // was deleted") this state was added to prevent. A failure means we do
        // not know, and "—" is what not knowing looks like.
        setRolesLoaded(true);
      })
      .catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    loadCandidates(roleId);
  }, [roleId, loadCandidates]);

  // Every mutation rebuilds the full filter set from the current URL so no
  // dimension (status / recommendation / resume review / assessed / role) is
  // dropped.
  const applyFilters = useCallback(
    (next: Partial<CandidateFilters>) => {
      setSearchParams(buildCandidateSearch({ ...filters, ...next }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, setSearchParams],
  );

  const toggleFromList = (list: string[], value: string) =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const toggleStatus = useCallback(
    (status: string) => applyFilters({ statuses: toggleFromList(filters.statuses, status) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, applyFilters],
  );

  const toggleRecommendation = useCallback(
    (rec: string) =>
      applyFilters({ recommendations: toggleFromList(filters.recommendations, rec) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, applyFilters],
  );

  const toggleResumeReview = useCallback(
    (value: string) =>
      applyFilters({ resumeReview: toggleFromList(filters.resumeReview, value) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filterKey, applyFilters],
  );

  const setRole = useCallback(
    (nextRole: string) => applyFilters({ roleId: nextRole || null }),
    [applyFilters],
  );

  const clearFilters = useCallback(() => {
    setSearchParams(new URLSearchParams());
  }, [setSearchParams]);

  const visible = useMemo(
    () => (candidates ?? []).filter((c) => matchesCandidateFilters(c, filters)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [candidates, filterKey],
  );

  const page = usePagination(visible, 10, filterKey);

  const active = hasActiveFilters(filters);
  const roleTitle = roles.find((r) => r.id === roleId)?.title;

  // Live count per status from the currently loaded (role-scoped) set.
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of candidates ?? []) {
      const key = normalizeStatus(c.status);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [candidates]);

  // Live count per recommendation from the currently loaded set.
  const recommendationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of candidates ?? []) {
      if (c.latest_recommendation) {
        counts.set(
          c.latest_recommendation,
          (counts.get(c.latest_recommendation) ?? 0) + 1,
        );
      }
    }
    return counts;
  }, [candidates]);

  // Live count per resume-review state from the currently loaded set. Derived
  // from the same one response the list already has — no extra request.
  const resumeReviewCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of candidates ?? []) {
      if (c.resume_review) {
        counts.set(c.resume_review, (counts.get(c.resume_review) ?? 0) + 1);
      }
    }
    return counts;
  }, [candidates]);

  /**
   * How many loaded candidates carry a recommendation at all.
   *
   * The recommendation bar is measured against THIS, not the full list: an
   * unscreened candidate has no recommendation, and counting them into the
   * denominator would draw a mostly-empty bar that reads as "most candidates
   * were not recommended" when it means "most have not been screened yet".
   */
  const assessedTotal = useMemo(
    () => (candidates ?? []).filter((c) => Boolean(c.latest_recommendation)).length,
    [candidates],
  );

  /** Role by id, for the table's Agent and Role columns. */
  const roleById = useMemo(() => {
    const byId = new Map<string, Role>();
    for (const r of roles) byId.set(r.id, r);
    return byId;
  }, [roles]);

  // The facet is only meaningful where the signal exists. A deep link keeps
  // it visible so its own toggles stay reachable and removable.
  const showResumeFacet =
    resumeReviewCounts.size > 0 || filters.resumeReview.length > 0;

  return (
    <CandidateShell variant="inset">
      <CandidateHeader
        eyebrow="Talent workspace"
        title="Candidates"
        description="Upload resumes, review parsed profiles, and move candidates through screening."
        actions={
          <Button
            size="lg"
            variant="primary"
            aria-expanded={uploadOpen}
            aria-controls={uploadPanelId}
            // No focus move: the panel is directly below this button.
            onClick={() => openUpload(false)}
          >
            Upload resume
          </Button>
        }
      />

      <UploadPanel
        id={uploadPanelId}
        panelRef={uploadPanelRef}
        open={uploadOpen}
        roles={roles}
        onUploaded={() => loadCandidates(roleId)}
      />

      {/* Pipeline by role. Placed ABOVE the filter bar because it answers the
          question the page is opened with ("how is each role doing"), and it
          follows the page's role filter so drilling into one role narrows the
          chart with it. */}
      <RolePipelinePanel roles={roles} roleId={roleId} />

      {/* Filter bar — one panel, so the whole filter contract reads as a
          single control surface rather than four stacked rows. */}
      <GlassPanel as="section" aria-label="Filters" padding="sm" className="mt-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--c-ink)]">
            All candidates
            {candidates && (
              <span className="ml-2 font-normal text-[var(--c-ink-secondary)]">
                {active
                  ? `${visible.length} of ${candidates.length}`
                  : candidates.length}
              </span>
            )}
          </h2>
          {roles.length > 0 && (
            <div className="w-full sm:w-56">
              <label htmlFor="role-filter" className="sr-only">
                Filter by role
              </label>
              <SelectField
                id="role-filter"
                value={roleId ?? ""}
                onChange={(e) => setRole(e.target.value)}
                aria-label="Filter by role"
                className="w-full"
              >
                <option value="">All roles</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title}
                  </option>
                ))}
              </SelectField>
            </div>
          )}
        </div>

        {/* THE BAR IS THE FILTER. It was briefly a chart ABOVE the chips,
            which meant four rows of label+number where there had been two —
            a legend is itself a row of chips. Now the legend entries are the
            toggles: same `role="group"`, same `aria-pressed`, same 44px
            targets, same URL contract, one surface.

            Segments come from the FULL CANDIDATE_STATUS_ORDER. The old pill
            row justifiably omitted `consent_declined` (terminal, URL-only)
            because pills are affordances; a bar that claims to partition the
            whole list cannot, or those candidates silently become an unnamed
            "Unaccounted" block — and for this product a consent refusal is
            the outcome people most need to see. */}
        {/* Rendered whenever candidates have loaded, empty list or not — the
            same rule as the recommendation control below. Gating this one on
            `length > 0` meant selecting a role with no candidates removed the
            very toggle that had set the filter, leaving it un-pressable except
            via the Active-filters chips. The pill row it replaced was
            unconditional. */}
        {candidates && (
          <PipelineBar
            className="mt-3"
            label="Filter by status"
            total={candidates.length}
            onToggle={toggleStatus}
            selectedKeys={filters.statuses}
            segments={CANDIDATE_STATUS_ORDER.map((status) => ({
              key: status,
              label: candidateStatusLabel(status),
              value: statusCounts.get(status) ?? 0,
              tone: STATUS_BAR_TONE[status] ?? 'neutral',
            }))}
            footnote={
              // The cohort is the LOADED set, which the role filter narrows
              // server-side but the status filter does not. Said plainly,
              // because the heading a few pixels above can read "1 of 3" and a
              // picture under it is taken to be a picture of the 1.
              active
                ? `Across all ${candidates.length.toLocaleString()} loaded candidates${
                    roleTitle ? ` in ${roleTitle}` : ''
                  }, not the current filter.`
                : undefined
            }
          />
        )}

        {/* Recommendation is a SEPARATE cohort: only assessed candidates
            carry one, so it is measured against the assessed subtotal. Against
            the whole list it would draw a mostly-empty bar implying the rest
            were "not recommended" rather than "not yet screened". */}
        {/* Rendered whenever candidates are loaded, NOT only when some carry a
            recommendation. Gating on `assessedTotal > 0` made the
            recommendation filter unreachable in a workspace with no
            assessments yet — the pill row it replaced was always present. With
            a zero total `PipelineBar` draws no track, so this degrades to
            exactly that pill row and grows a bar once there is something to
            chart. */}
        {candidates && (
          <PipelineBar
            className="mt-3"
            label="Filter by recommendation"
            total={assessedTotal}
            onToggle={toggleRecommendation}
            selectedKeys={filters.recommendations}
            segments={RECOMMENDATION_ORDER.map((rec) => ({
              key: rec,
              label: recommendationLabel(rec),
              value: recommendationCounts.get(rec) ?? 0,
              tone: RECOMMENDATION_BAR_TONE[rec] ?? 'neutral',
            }))}
            footnote={
              assessedTotal > 0
                ? `Of ${assessedTotal.toLocaleString()} with a recommendation.`
                : undefined
            }
          />
        )}

        {/* Resume-review toggles — additive facet over the sanitized enum the
            list already returns. Never mutates candidate status.

            Shown only when the loaded set actually carries the signal (or a
            deep link selected it), so a workspace with no ATS-imported
            candidates keeps the filter bar it had. Three permanently-zero
            toggles would be noise, and would imply a dimension that does not
            exist for that recruiter. */}
        {showResumeFacet && (
        <div
          className="mt-2 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter by resume review"
        >
          <span className="text-label font-medium text-[var(--c-ink-secondary)]">
            Resume:
          </span>
          {RESUME_REVIEW_ORDER.map((value) => {
            const selected = filters.resumeReview.includes(value);
            const count = resumeReviewCounts.get(value) ?? 0;
            return (
              <button
                key={value}
                type="button"
                onClick={() => toggleResumeReview(value)}
                aria-pressed={selected}
                className={FILTER_PILL_CLASS(selected)}
              >
                {resumeReviewLabel(value)}
                {candidates && (
                  <span className={PILL_COUNT_CLASS(selected)}>{count}</span>
                )}
              </button>
            );
          })}
        </div>
        )}

        {/* Active-filter summary */}
        {active && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-label text-[var(--c-ink-secondary)]">
            <span className="font-medium">Active filters:</span>
            {roleTitle && (
              <FilterChip
                label={`Role: ${roleTitle}`}
                onRemove={() => setRole("")}
              />
            )}
            {filters.statuses.map((s) => (
              <FilterChip
                key={s}
                label={candidateStatusLabel(s)}
                onRemove={() => toggleStatus(s)}
              />
            ))}
            {filters.recommendations.map((r) => (
              <FilterChip
                key={r}
                label={`Rec: ${recommendationLabel(r)}`}
                onRemove={() => toggleRecommendation(r)}
              />
            ))}
            {filters.resumeReview.map((r) => (
              <FilterChip
                key={r}
                label={resumeReviewLabel(r) ?? r}
                onRemove={() => toggleResumeReview(r)}
              />
            ))}
            {filters.assessed && (
              <FilterChip
                label="Assessed"
                onRemove={() => applyFilters({ assessed: false })}
              />
            )}
            <button
              type="button"
              onClick={clearFilters}
              className="rounded px-1.5 py-0.5 font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
            >
              Clear all
            </button>
          </div>
        )}
      </GlassPanel>

      {/* Body states */}
      <div className="mt-4">
        {error && (
          <ErrorPanel
            message={error}
            onRetry={() => loadCandidates(roleId)}
          />
        )}
        {!error && candidates === null && (
          <LoadingPanel label="Loading candidates…" />
        )}
        {!error && candidates !== null && candidates.length === 0 && (
          <EmptyPanel
            title="No candidates yet"
            // The upload form is collapsed by default now, so prose telling a
            // recruiter to "upload above" would point at something that is not
            // on screen.
            hint="Upload a resume to parse a candidate and add them here."
            action={
              <Button
                variant="secondary"
                size="sm"
                aria-expanded={uploadOpen}
                aria-controls={uploadPanelId}
                // A real TOGGLE. One-way `setUploadOpen(true)` under a
                // two-way `aria-expanded` is a control advertising a state it
                // cannot change: once open it announced "expanded" and then
                // did nothing when pressed (WCAG 4.1.2).
                // Focus moves: this button is far below the panel.
                onClick={() => openUpload(true)}
              >
                Upload a resume
              </Button>
            }
          />
        )}
        {!error &&
          candidates !== null &&
          candidates.length > 0 &&
          visible.length === 0 && (
            <EmptyPanel
              title="No candidates match these filters"
              action={
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              }
            />
          )}

        {!error && visible.length > 0 && (
          <>
            {/* COLUMN WIDTHS. Every cell states the width it needs, so the
                table's own min-content width is a real layout rather than
                whatever the browser squeezes out of eight auto columns: at
                1440px it fits the column exactly, and below that (a 390px
                phone) it keeps these widths and scrolls sideways INSIDE the
                table's own container, never the page.
                  - Exp., Status, Recommendation and Next action never wrap
                    ("7 / yr" and a badge broken over two lines were the
                    review's complaint).
                  - Agent and Role may wrap, to two lines at most, at a
                    minimum width that fits a two-word title per line.
                  - Email and Skills truncate with the full value in
                    `title`: both are shown in full on the profile, so the
                    ellipsis never hides anything unreachable. */}
            <Table caption="Candidates in your pipeline" className={TABLE_DENSITY}>
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Agent</Th>
                  <Th>Role</Th>
                  <Th>Skills</Th>
                  <Th className="whitespace-nowrap text-right">Exp.</Th>
                  <Th>Status</Th>
                  <Th>Recommendation</Th>
                  <Th className="whitespace-nowrap">Next action</Th>
                </Tr>
              </THead>
              {/* Rows reveal in sequence; the class collapses under
                  prefers-reduced-motion with the rest of the shell. */}
              <TBody className="fade-up-stagger">
                {page.items.map((c) => {
                  const next = candidateNextAction(c.status);
                  const role = c.role_id ? roleById.get(c.role_id) : undefined;
                  const displayName = candidateDisplayName(c.name);
                  return (
                    <Tr key={c.id}>
                      <Td className="py-2">
                        <Link
                          to={`/candidates/${c.id}`}
                          className="font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
                        >
                          {displayName}
                        </Link>
                        {c.email && (
                          <p
                            className="w-[10rem] truncate text-label text-[var(--c-ink-secondary)]"
                            title={c.email}
                          >
                            {c.email}
                          </p>
                        )}
                      </Td>
                      {/* The role's AGENT, left of the role itself. Looked up
                          from the same roles list — no extra request — and
                          "—" whenever there is no agent name to show. */}
                      <Td className="min-w-[8rem]">
                        <AgentCell role={role} />
                      </Td>
                      {/* ONE role per row, because that is what the row IS.

                          `candidates.role_id` is a single FK and a row is one
                          Ashby APPLICATION, so a person who applied to two
                          roles is two rows carrying one role each — not one
                          row carrying two. Rendering a list here would imply
                          a many-to-many the data cannot express, and would
                          make the row's "Review & decide" ambiguous about
                          which application it decides.

                          A role the roles list does not carry (filtered by
                          scope, or deleted) falls back to a neutral marker
                          rather than a blank cell or a raw uuid. */}
                      <Td className="min-w-[8.5rem]">
                        <RoleCell
                          roleId={c.role_id}
                          title={role?.title}
                          rolesLoaded={rolesLoaded}
                        />
                      </Td>
                      <Td>
                        <SkillsCell skills={c.skills} />
                      </Td>
                      <Td className="whitespace-nowrap text-right tabular-nums text-[var(--c-ink-secondary)]">
                        {c.experience_years != null
                          ? `${c.experience_years} yr`
                          : "—"}
                      </Td>
                      <Td className="whitespace-nowrap">
                        {/* Stacked, not wrapped: a status and a resume badge
                            side by side would force the column wide, and a
                            flex-wrap broke them at arbitrary points. */}
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge tone={candidateStatusTone(c.status)}>
                            <span title={`Status: ${c.status}`}>
                              {candidateStatusLabel(c.status)}
                            </span>
                          </StatusBadge>
                          {/* Additive only: the candidate's own status is
                              unchanged and still first. */}
                          <ResumeReviewBadge value={c.resume_review} />
                        </div>
                      </Td>
                      <Td className="whitespace-nowrap">
                        {c.latest_recommendation ? (
                          <span className="inline-flex items-center gap-1.5">
                            <StatusBadge
                              tone={RECOMMENDATION_TONE[c.latest_recommendation] ?? "neutral"}
                            >
                              {recommendationLabel(c.latest_recommendation)}
                            </StatusBadge>
                            {c.latest_score != null && (
                              <span className="text-xs tabular-nums text-[var(--c-ink-secondary)]">
                                {c.latest_score}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-[var(--c-ink-secondary)]">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap">
                        <NextActionCell
                          candidateId={c.id}
                          candidateName={displayName}
                          status={c.status}
                          next={next}
                        />
                      </Td>
                    </Tr>
                  );
                })}
              </TBody>
            </Table>
            <Pagination state={page} noun="candidates" />
          </>
        )}
      </div>
    </CandidateShell>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--c-border-light)] px-2 py-0.5 text-xs text-[var(--c-ink-secondary)]">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="rounded-full px-1 text-[var(--c-ink-secondary)] hover:text-[var(--c-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        ×
      </button>
    </span>
  );
}

/**
 * The upload disclosure.
 *
 * Kept mounted and toggled with `hidden` rather than unmounted, so the
 * header button's `aria-controls` always resolves to a real element and an
 * in-progress upload is never destroyed by a stray click on the toggle.
 */
function UploadPanel({
  id,
  panelRef,
  open,
  roles,
  onUploaded,
}: {
  id: string;
  /** Focus target: the empty state opens this panel from far below it. */
  panelRef?: RefObject<HTMLElement | null>;
  open: boolean;
  roles: Role[];
  onUploaded: () => void;
}) {
  const headingId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [roleId, setRoleId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload() {
    if (!file) return;
    setError(null);
    setSuccess(null);
    setUploading(true);
    try {
      const result = await api.uploadResume(file, roleId || undefined);
      setSuccess(`Parsed ${result.candidate.name?.trim() || "candidate"}.`);
      setFile(null);
      if (inputRef.current) inputRef.current.value = "";
      onUploaded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <GlassPanel
      as="section"
      id={id}
      ref={panelRef}
      // -1: a programmatic focus target, never a tab stop of its own.
      tabIndex={-1}
      hidden={!open}
      aria-labelledby={headingId}
      className="mt-6 focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--c-accent)]"
    >
      <h2
        id={headingId}
        className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--c-ink)]"
      >
        Upload a resume
      </h2>
      <p className="mt-0.5 text-label text-[var(--c-ink-secondary)]">
        PDF or DOCX. Parsing runs an LLM and can take 10–20 seconds.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label="Resume file" id="resume-file" className="sm:col-span-2">
          {({ id: fileId }) => (
            <input
              id={fileId}
              ref={inputRef}
              type="file"
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setSuccess(null);
                setError(null);
              }}
              disabled={uploading}
              className="block w-full text-sm text-[var(--c-ink-secondary)] file:mr-3 file:rounded-control file:border-0 file:bg-[var(--c-accent-light)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--c-accent)] disabled:opacity-60"
            />
          )}
        </Field>
        <Field label="Role (optional)" id="resume-role">
          {({ id: selectId }) => (
            <SelectField
              id={selectId}
              value={roleId}
              onChange={(e) => setRoleId(e.target.value)}
              disabled={uploading}
              className="w-full"
            >
              <option value="">No role</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                </option>
              ))}
            </SelectField>
          )}
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <CandidateButton onClick={handleUpload} disabled={!file} loading={uploading}>
          {uploading ? "Parsing…" : "Upload & Parse"}
        </CandidateButton>
        {uploading && (
          <span className="text-sm text-[var(--c-ink-secondary)]">
            Extracting and parsing with the LLM…
          </span>
        )}
        {/* Tone is a dot plus a tint, never coloured small text. */}
        {success && !uploading && (
          <InlineNotice tone="success" role="status">
            {success}
          </InlineNotice>
        )}
        {error && !uploading && (
          <InlineNotice tone="danger" role="alert">
            {error}
          </InlineNotice>
        )}
      </div>
    </GlassPanel>
  );
}
