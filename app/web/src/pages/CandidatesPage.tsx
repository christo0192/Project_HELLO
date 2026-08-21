/**
 * Candidates — recruiter pipeline list with URL-addressable drill-down filters.
 *
 * The dashboard links here with `?status=…&role=…`; those filters are parsed
 * from the URL (via `useSearchParams`) so deep links and browser back/forward
 * work, and are shown as removable chips. Status is filtered client-side (the
 * list API only filters by role); role is passed to the API. Every row's name
 * is a real keyboard-reachable link to the candidate workspace, and a
 * "Next action" column makes the obvious next step explicit.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Candidate, Role } from "../types";
import type { CandidateFilters } from "../components/talent";
import {
  CandidateButton,
  CandidateEmptyState,
  CandidateErrorState,
  CandidateLabel,
  CandidateLoadingState,
  CandidateSelect,
  CandidateSpinner,
  SurfaceCard,
} from "../components/design";
import {
  Table,
  THead,
  TBody,
  Tr,
  Th,
  Td,
  StatusBadge,
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
} from "../components/talent";
import type { StatusTone } from "../components/design/StatusBadge";

/**
 * Filter toggle. 44px minimum target, palette tokens only, and the selected
 * state carries `aria-pressed` (set by the caller) as well as colour, so the
 * distinction is never hue-only.
 */
const FILTER_TOGGLE_CLASS = (selected: boolean) =>
  [
    "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
    "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]",
    selected
      ? "border-[var(--c-accent)] bg-[var(--c-accent-light)] text-[var(--c-accent)]"
      : "border-[var(--c-control-border)] bg-[var(--c-surface)] text-[var(--c-ink-secondary)] hover:bg-[var(--c-border-light)] hover:text-[var(--c-ink)]",
  ].join(" ");

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

  const loadCandidates = useCallback((role: string | null) => {
    setError(null);
    setCandidates(null);
    api
      .listCandidates(role || undefined)
      .then(setCandidates)
      .catch((e: ApiError) => setError(e.message));
  }, []);

  useEffect(() => {
    api.listRoles().then(setRoles).catch(() => setRoles([]));
  }, []);

  useEffect(() => {
    loadCandidates(roleId);
  }, [roleId, loadCandidates]);

  // Every mutation rebuilds the full filter set from the current URL so no
  // dimension (status / recommendation / assessed / role) is dropped.
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

  return (
    <CandidateShell variant="inset">
      <CandidateHeader
        eyebrow="Talent workspace"
        title="Candidates"
        description="Upload resumes, review parsed profiles, and move candidates through screening."
      />

      <div className="mt-6">
        <UploadCard roles={roles} onUploaded={() => loadCandidates(roleId)} />
      </div>

      {/* Filter bar */}
      <section aria-label="Filters" className="mt-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-ink">
            All candidates
            {candidates && (
              <span className="ml-2 font-normal text-ink-tertiary">
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
              <CandidateSelect
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
              </CandidateSelect>
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
                className={FILTER_TOGGLE_CLASS(selected)}
              >
                {candidateStatusLabel(status)}
                {candidates && (
                  <span className="tabular-nums text-ink-tertiary">{count}</span>
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
          <span className="text-xs font-medium text-ink-tertiary">Recommendation:</span>
          {RECOMMENDATION_ORDER.map((rec) => {
            const selected = filters.recommendations.includes(rec);
            const count = recommendationCounts.get(rec) ?? 0;
            return (
              <button
                key={rec}
                type="button"
                onClick={() => toggleRecommendation(rec)}
                aria-pressed={selected}
                className={FILTER_TOGGLE_CLASS(selected)}
              >
                {recommendationLabel(rec)}
                {candidates && (
                  <span className="tabular-nums text-ink-tertiary">{count}</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Active-filter summary */}
        {active && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
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
      </section>

      {/* Body states */}
      <div className="mt-4">
        {error && (
          <CandidateErrorState
            message={error}
            onRetry={() => loadCandidates(roleId)}
          />
        )}
        {!error && candidates === null && (
          <CandidateLoadingState label="Loading candidates…" />
        )}
        {!error && candidates !== null && candidates.length === 0 && (
          <CandidateEmptyState
            title="No candidates yet"
            hint="Upload a resume above to parse a candidate and add them here."
          />
        )}
        {!error &&
          candidates !== null &&
          candidates.length > 0 &&
          visible.length === 0 && (
            <div className="rounded-xl border border-dashed border-[var(--c-control-border)] bg-[var(--c-surface)] p-8 text-center">
              <p className="text-sm font-medium text-[var(--c-ink-secondary)]">
                No candidates match these filters
              </p>
              <button
                type="button"
                onClick={clearFilters}
                className="mt-2 inline-flex min-h-11 items-center text-xs font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
              >
                Clear filters
              </button>
            </div>
          )}

        {!error && visible.length > 0 && (
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
              <TBody>
                {visible.map((c) => {
                  const next = candidateNextAction(c.status);
                  return (
                    <Tr key={c.id}>
                      <Td>
                        <Link
                          to={`/candidates/${c.id}`}
                          className="font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
                        >
                          {c.name || "Unnamed"}
                        </Link>
                        {c.email && (
                          <p className="text-xs text-ink-tertiary">{c.email}</p>
                        )}
                      </Td>
                      <Td>
                        <div className="flex max-w-xs flex-wrap gap-1">
                          {c.skills.slice(0, 4).map((s) => (
                            <span
                              key={s}
                              className="inline-flex items-center rounded-md bg-surface-tertiary px-2 py-0.5 text-xs font-medium text-ink-secondary"
                            >
                              {s}
                            </span>
                          ))}
                          {c.skills.length > 4 && (
                            <span className="text-xs text-ink-tertiary">
                              +{c.skills.length - 4}
                            </span>
                          )}
                          {c.skills.length === 0 && (
                            <span className="text-ink-tertiary">—</span>
                          )}
                        </div>
                      </Td>
                      <Td className="tabular-nums text-ink-secondary">
                        {c.experience_years != null
                          ? `${c.experience_years} yr`
                          : "—"}
                      </Td>
                      <Td>
                        <StatusBadge tone={candidateStatusTone(c.status)}>
                          {candidateStatusLabel(c.status)}
                        </StatusBadge>
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
                              <span className="text-xs tabular-nums text-ink-tertiary">
                                {c.latest_score}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="text-ink-tertiary">—</span>
                        )}
                      </Td>
                      <Td>
                        <span
                          className={
                            next.emphasis
                              ? "text-sm font-medium text-[var(--c-accent)]"
                              : "text-sm text-ink-secondary"
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
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-tertiary px-2 py-0.5 text-xs text-ink">
      {label}
      <button
        type="button"
        onClick={onRemove}
        aria-label={`Remove filter ${label}`}
        className="rounded-full px-1 text-ink-tertiary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        ×
      </button>
    </span>
  );
}

function UploadCard({
  roles,
  onUploaded,
}: {
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
      setSuccess(`Parsed ${result.candidate.name || "candidate"}.`);
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
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="mb-1 text-sm font-semibold text-ink">
        Upload a resume
      </h2>
      <p className="mb-4 max-w-prose text-sm text-ink-secondary">
        PDF or DOCX. Parsing runs an LLM and can take 10–20 seconds.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <CandidateLabel htmlFor="resume-file">Resume file</CandidateLabel>
          <input
            id="resume-file"
            ref={inputRef}
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setSuccess(null);
              setError(null);
            }}
            disabled={uploading}
            className="block w-full text-sm text-ink-secondary file:mr-3 file:rounded-lg file:border-0 file:bg-[var(--c-accent-light)] file:px-3 file:py-2 file:text-sm file:font-medium file:text-[var(--c-accent)] disabled:opacity-60"
          />
        </div>
        <div>
          <CandidateLabel htmlFor="resume-role">Role (optional)</CandidateLabel>
          <CandidateSelect
            id="resume-role"
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
          </CandidateSelect>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <CandidateButton onClick={handleUpload} disabled={!file} loading={uploading}>
          {uploading ? "Parsing…" : "Upload & Parse"}
        </CandidateButton>
        {uploading && (
          <span className="flex items-center gap-2 text-sm text-ink-secondary">
            <CandidateSpinner className="h-4 w-4 text-[var(--c-accent)]" />
            Extracting and parsing with the LLM…
          </span>
        )}
        {success && !uploading && (
          <span className="text-sm text-success">{success}</span>
        )}
        {error && !uploading && (
          <span className="text-sm text-error">{error}</span>
        )}
      </div>
    </SurfaceCard>
  );
}
