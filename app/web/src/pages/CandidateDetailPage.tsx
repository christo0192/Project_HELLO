import { useCallback, useEffect, useId, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { AppealRow, CandidateDetail, Note } from "../types";
import { LiveCallPanel } from "../components/LiveCallPanel";
import { LiveKitCallCard } from "../components/LiveKitCallCard";
import {
  CandidateButton,
  CandidateErrorState,
  CandidateInput,
  CandidateLoadingState,
  CandidateSelect,
  StatusBadge,
  SurfaceCard,
  Tag,
} from "../components/design";
import {
  AshbyWorkflowCard,
  CandidateHeader,
  CandidateProfileCard,
  CandidateShell,
  DecisionBlockedBanner,
  NotesList,
  SessionsSummary,
  Tabs,
  TranscriptionSyncWorkspace,
} from "../components/talent";
import {
  candidateStatusLabel,
  candidateStatusTone,
  sessionStatusLabel,
} from "../components/talent";
import { formatDateTime } from "../lib/datetime";

/**
 * HELLO Lane 3 — CandidateDetail as one recruiter review workspace.
 *
 * Two tabs:
 *   - Overview: identity/profile, live screening actions, session summary,
 *     append-only notes, and appeals + one-time grant links.
 *   - Review: the single authoritative review workspace — session context,
 *     one recording player, synchronized transcript, and the session's
 *     scorecard (TranscriptionSyncWorkspace). This replaces the previously
 *     duplicated Sessions-tab audio, Recordings tab, and Overview scorecard.
 *
 * Preserved behavior: decision-use block banner + scorecard suppression,
 * LiveKit invite + live call panel, ownership-scoped CSV export, append-only
 * notes, appeals + fragment-only grant links, on-demand (never auto-fetched)
 * short-lived recording playback.
 */

export function CandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<CandidateDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setError(null);
    setDetail(null);
    api
      .getCandidate(id)
      .then((d) => setDetail(d))
      .catch((e: ApiError) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  if (error)
    return (
      <CandidateShell variant="inset">
        <CandidateErrorState message={error} onRetry={load} />
      </CandidateShell>
    );
  if (!detail)
    return (
      <CandidateShell variant="inset">
        <CandidateLoadingState label="Loading candidate…" />
      </CandidateShell>
    );

  const { candidate, sessions, assessments } = detail;
  const decisionBlocked = candidate.decision_use_blocked_at != null;

  return (
    <CandidateShell variant="inset">
      <Link
        to="/candidates"
        className="mb-4 inline-flex min-h-11 items-center gap-1 text-sm text-[var(--c-ink-secondary)] hover:text-[var(--c-ink)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
      >
        ← Back to candidates
      </Link>

      <CandidateHeader
        eyebrow="Candidate"
        title={candidate.name || "Unnamed candidate"}
        description={candidate.email ?? undefined}
        actions={
          <>
            <StatusBadge tone={candidateStatusTone(candidate.status)}>
              {candidateStatusLabel(candidate.status)}
            </StatusBadge>
            <CsvExportButton candidateId={candidate.id} />
          </>
        }
      />

      {decisionBlocked && <DecisionBlockedBanner />}

      <div className="mt-4">
        <Tabs
          ariaLabel="Candidate sections"
          items={[
            {
              id: "overview",
              label: "Overview",
              panel: (
                <OverviewTab candidate={candidate} sessions={sessions} />
              ),
            },
            {
              id: "review",
              label: "Review",
              panel: (
                <TranscriptionSyncWorkspace
                  sessions={sessions}
                  assessments={assessments}
                  blocked={decisionBlocked}
                />
              ),
            },
          ]}
        />
      </div>
    </CandidateShell>
  );
}

/* ── Overview tab ───────────────────────────────────────────────────── */

function OverviewTab({
  candidate,
  sessions,
}: {
  candidate: CandidateDetail["candidate"];
  sessions: CandidateDetail["sessions"];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-3">
      {/* Profile */}
      <CandidateProfileCard
        candidate={candidate}
        footnote="Start a browser voice screening below. Transcript, playback, and scorecard sync back and are reviewed in the Review tab."
      />

      {/* Live actions + sessions + notes + appeals */}
      <div className="space-y-4 sm:space-y-6 lg:col-span-2">
        <LiveKitCallCard
          candidateId={candidate.id}
          candidateName={candidate.name}
        />

        <LiveCallPanel
          candidateId={candidate.id}
          candidateName={candidate.name || undefined}
        />

        {/* Read-only Ashby pipeline status. Renders nothing for a candidate
            with no Ashby application link. */}
        <AshbyWorkflowCard source={{ kind: "candidate", candidateId: candidate.id }} />

        <SessionsSummary sessions={sessions} />

        <NotesSection candidateId={candidate.id} />
        <AppealsSection candidateId={candidate.id} sessions={sessions} />
      </div>
    </div>
  );
}

/* ── Append-only notes ──────────────────────────────────────────────── */

function NotesSection({ candidateId }: { candidateId: string }) {
  const headingId = useId();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api
      .listNotes(candidateId)
      .then((r) => setNotes(r.notes))
      .catch((e: ApiError) => setErr(e.message));
  }, [candidateId]);

  useEffect(load, [load]);

  async function add() {
    if (!noteText.trim()) return;
    setSaving(true);
    setMsg(null);
    try {
      await api.addNote(candidateId, noteText.trim());
      setNoteText("");
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Failed to add note.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="mb-3 text-sm font-semibold text-ink">
        Notes
      </h2>
      <NotesList notes={notes} error={err} />
      <div className="mt-3 flex flex-wrap gap-2">
        <label htmlFor="note-input" className="sr-only">
          Add a note
        </label>
        <CandidateInput
          id="note-input"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          maxLength={2000}
          placeholder="Add a note…"
          className="min-w-0 flex-1"
        />
        <CandidateButton
          variant="secondary"
          onClick={() => void add()}
          loading={saving}
          disabled={!noteText.trim()}
        >
          Add
        </CandidateButton>
      </div>
      {msg && <p className="mt-2 max-w-prose text-xs text-ink-secondary">{msg}</p>}
    </SurfaceCard>
  );
}

/* ── Appeals + one-time grant link ──────────────────────────────────── */

function AppealsSection({
  candidateId,
  sessions,
}: {
  candidateId: string;
  sessions: CandidateDetail["sessions"];
}) {
  const headingId = useId();
  const [appeals, setAppeals] = useState<AppealRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [expiryHours, setExpiryHours] = useState(24);
  const [selectedSession, setSelectedSession] = useState(sessions[0]?.id ?? "");
  const [issuing, setIssuing] = useState(false);
  const [grantLink, setGrantLink] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    setErr(null);
    api
      .listAppeals(candidateId)
      .then((r) => setAppeals(r.appeals))
      .catch((e: ApiError) => setErr(e.message));
  }, [candidateId]);

  useEffect(load, [load]);

  async function issueGrant() {
    if (!selectedSession) return;
    setIssuing(true);
    setMsg(null);
    setGrantLink(null);
    try {
      const res = await api.issueAppealGrant(candidateId, selectedSession, expiryHours);
      const link = `${window.location.origin}/appeal#${res.appeal_grant_token}`;
      setGrantLink(link);
      setMsg(
        `Grant issued — expires ${formatDateTime(res.expires_at)}. ` +
          "Send this one-time link to the candidate.",
      );
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Failed to issue appeal grant.");
    } finally {
      setIssuing(false);
    }
  }

  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="mb-3 text-sm font-semibold text-ink">
        Appeals
      </h2>
      {err ? (
        <p className="text-sm text-error">{err}</p>
      ) : appeals === null ? (
        <p className="text-sm text-ink-tertiary">Loading appeals…</p>
      ) : appeals.length === 0 ? (
        <p className="text-sm text-ink-secondary">No appeals.</p>
      ) : (
        <ul className="divide-y divide-line">
          {appeals.map((a) => (
            <li key={a.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="font-medium text-ink">{a.category}</p>
                <Tag
                  tone={
                    a.status === "open" || a.status === "under_review"
                      ? "accent"
                      : "positive"
                  }
                  srPrefix="Appeal status:"
                >
                  {a.status}
                </Tag>
              </div>
              <p className="mt-0.5 max-w-prose whitespace-pre-wrap leading-relaxed text-ink-secondary">
                {a.description}
              </p>
              <p className="mt-0.5 text-xs text-ink-tertiary">
                {formatDateTime(a.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-lg border border-[var(--c-border)] p-4">
        <h3 className="text-sm font-semibold text-ink">Issue appeal grant</h3>
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-tertiary">
          A one-time fragment link the candidate opens at /appeal. Explicit
          expiry is required (1–72 hours); the plaintext is shown only once.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="appeal-session" className="block text-xs font-medium text-ink-secondary">
              Session
            </label>
            <CandidateSelect
              id="appeal-session"
              value={selectedSession}
              onChange={(e) => setSelectedSession(e.target.value)}
              className="mt-1 block w-full"
            >
              {sessions.length === 0 ? (
                <option value="">No sessions</option>
              ) : (
                sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id.slice(0, 8)} ({sessionStatusLabel(s.status)})
                  </option>
                ))
              )}
            </CandidateSelect>
          </div>
          <div>
            <label htmlFor="appeal-expiry" className="block text-xs font-medium text-ink-secondary">
              Expires in (hours, 1–72)
            </label>
            <CandidateInput
              id="appeal-expiry"
              type="number"
              min={1}
              max={72}
              value={expiryHours}
              onChange={(e) => setExpiryHours(Number(e.target.value))}
              className="mt-1 block w-full"
            />
          </div>
        </div>
        <CandidateButton
          className="mt-3"
          variant="secondary"
          onClick={() => void issueGrant()}
          loading={issuing}
          disabled={!selectedSession}
        >
          Issue one-time appeal grant
        </CandidateButton>
        {msg && <p className="mt-2 max-w-prose text-xs text-ink-secondary">{msg}</p>}
        {grantLink && (
          <div className="mt-2 rounded-lg bg-[var(--c-border-light)] p-3">
            <p className="text-xs font-semibold text-ink-secondary">One-time link (shown once)</p>
            <code className="block break-all text-xs text-ink-secondary">{grantLink}</code>
            <p className="mt-1 max-w-prose text-[11px] leading-relaxed text-ink-tertiary">
              Contains a secret token in the fragment — share it only with the
              candidate. It is never stored by the app.
            </p>
          </div>
        )}
      </div>
    </SurfaceCard>
  );
}

/* ── CSV export ─────────────────────────────────────────────────────── */

function CsvExportButton({ candidateId }: { candidateId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const csv = await api.exportCsv(candidateId);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `screening-export-${candidateId}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Failed to export CSV.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <CandidateButton
        variant="secondary"
        onClick={() => void download()}
        loading={busy}
      >
        Export screening data (scorecard + transcript)
      </CandidateButton>
      {err && (
        <p className="mt-1 rounded bg-[var(--c-surface)] px-2 py-1 text-xs text-error">
          {err}
        </p>
      )}
    </div>
  );
}
