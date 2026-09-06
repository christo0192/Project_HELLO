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
 * Surfaces: one glass panel per logical block — the upload form, the filter
 * bar, the table — floating on the shell ground. The list is paginated at ten
 * rows so it never runs off the page, and the filter contract
 * (`parseCandidateFilters` / `buildCandidateSearch` / `matchesCandidateFilters`)
 * is untouched: the chips, the counts and "Clear all" drive the same URL.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Candidate, Role } from "../types";
import type { CandidateFilters } from "../components/talent";
import { CandidateButton, Tag } from "../components/design/candidate";
import {
  Button,
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
import { CandidateHeader, CandidateShell } from "../components/talent";
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

/**
 * Filter pill. Multi-select toggles, so these stay `button`s carrying
 * `aria-pressed` rather than becoming a `SegmentedControl` (which is a
 * single-choice radio group). The 44px minimum target is kept: `min-h-11`
 * is what the scope integration test reads, and it is also the reason the
 * pill is taller than the 32px chips elsewhere in the shell.
 */
const FILTER_PILL_CLASS = (selected: boolean) =>
  [
    "inline-flex min-h-11 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors duration-200",
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

// Statuses offered as quick toggles (consent_declined stays URL-only/terminal).
const FILTERABLE_STATUSES = CANDIDATE_STATUS_ORDER.filter(
  (s) => s !== "consent_declined",
);

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
   * Open by default. The panel is a disclosure — the header button owns its
   * `aria-expanded` — but the upload form is the way a recruiter puts a
   * candidate into an empty workspace, and the empty state points at it
   * ("Upload a resume above"), so it may not start hidden.
   */
  const [uploadOpen, setUploadOpen] = useState(true);

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

  useEffect(() => {
    api.listRoles().then(setRoles).catch(() => setRoles([]));
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
            onClick={() => setUploadOpen((open) => !open)}
          >
            Upload resume
          </Button>
        }
      />

      <UploadPanel
        id={uploadPanelId}
        open={uploadOpen}
        roles={roles}
        onUploaded={() => loadCandidates(roleId)}
      />

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

        {/* Status toggles */}
        <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {FILTERABLE_STATUSES.map((status) => {
            const selected = filters.statuses.includes(status);
            const count = statusCounts.get(status) ?? 0;
            return (
              <button
                key={status}
                type="button"
                onClick={() => toggleStatus(status)}
                aria-pressed={selected}
                className={FILTER_PILL_CLASS(selected)}
              >
                {candidateStatusLabel(status)}
                {candidates && (
                  <span className={PILL_COUNT_CLASS(selected)}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Recommendation toggles */}
        <div
          className="mt-2 flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter by recommendation"
        >
          <span className="text-[13px] font-medium text-[var(--c-ink-secondary)]">
            Recommendation:
          </span>
          {RECOMMENDATION_ORDER.map((rec) => {
            const selected = filters.recommendations.includes(rec);
            const count = recommendationCounts.get(rec) ?? 0;
            return (
              <button
                key={rec}
                type="button"
                onClick={() => toggleRecommendation(rec)}
                aria-pressed={selected}
                className={FILTER_PILL_CLASS(selected)}
              >
                {recommendationLabel(rec)}
                {candidates && (
                  <span className={PILL_COUNT_CLASS(selected)}>{count}</span>
                )}
              </button>
            );
          })}
        </div>

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
          <span className="text-[13px] font-medium text-[var(--c-ink-secondary)]">
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
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-[var(--c-ink-secondary)]">
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
            hint="Upload a resume above to parse a candidate and add them here."
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
            <Table caption="Candidates in your pipeline">
              <THead>
                <Tr>
                  <Th>Name</Th>
                  <Th>Skills</Th>
                  <Th>Exp.</Th>
                  <Th>Status</Th>
                  <Th>Recommendation</Th>
                  <Th>Next action</Th>
                </Tr>
              </THead>
              {/* Rows reveal in sequence; the class collapses under
                  prefers-reduced-motion with the rest of the shell. */}
              <TBody className="fade-up-stagger">
                {page.items.map((c) => {
                  const next = candidateNextAction(c.status);
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          to={`/candidates/${c.id}`}
                          className="font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
                        >
                          {candidateDisplayName(c.name)}
                        </Link>
                        {c.email && (
                          <p className="text-[13px] text-[var(--c-ink-secondary)]">{c.email}</p>
                        )}
                      </Td>
                      <Td>
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {c.skills.slice(0, 4).map((s) => (
                            <Tag key={s}>{s}</Tag>
                          ))}
                          {c.skills.length > 4 && (
                            <span className="text-xs text-[var(--c-ink-secondary)]">
                              +{c.skills.length - 4}
                            </span>
                          )}
                          {c.skills.length === 0 && (
                            <span className="text-[var(--c-ink-secondary)]">—</span>
                          )}
                        </div>
                      </Td>
                      <Td className="tabular-nums text-[var(--c-ink-secondary)]">
                        {c.experience_years != null
                          ? `${c.experience_years} yr`
                          : "—"}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <StatusBadge tone={candidateStatusTone(c.status)}>
                            {candidateStatusLabel(c.status)}
                          </StatusBadge>
                          {/* Additive only: the candidate's own status is
                              unchanged and still first. */}
                          <ResumeReviewBadge value={c.resume_review} />
                        </div>
                      </Td>
                      <Td>
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
                      <Td>
                        <span
                          className={
                            next.emphasis
                              ? "text-sm font-medium text-[var(--c-accent)]"
                              : "text-sm text-[var(--c-ink-secondary)]"
                          }
                        >
                          {next.label}
                        </span>
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
  open,
  roles,
  onUploaded,
}: {
  id: string;
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
      hidden={!open}
      aria-labelledby={headingId}
      className="mt-6"
    >
      <h2
        id={headingId}
        className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--c-ink)]"
      >
        Upload a resume
      </h2>
      <p className="mt-0.5 text-[13px] leading-5 text-[var(--c-ink-secondary)]">
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
