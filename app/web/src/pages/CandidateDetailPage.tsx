import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { AppealRow, CandidateDetail, Note, Session } from "../types";
import { LiveCallPanel } from "../components/LiveCallPanel";
import { LiveKitCallCard } from "../components/LiveKitCallCard";
import { Button, Card, Chip, ErrorState, LoadingState } from "../components/ui";
import { PageHeader, StatusBadge } from "../components/design";
import { Tabs, TranscriptionSyncWorkspace } from "../components/talent";
import {
  candidateStatusLabel,
  candidateStatusTone,
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
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

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!detail) return <LoadingState label="Loading candidate…" />;

  const { candidate, sessions, assessments } = detail;
  const decisionBlocked = candidate.decision_use_blocked_at != null;

  return (
    <div>
      <Link
        to="/candidates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-secondary hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        ← Back to candidates
      </Link>

      <PageHeader
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

      {decisionBlocked && (
        <div
          role="alert"
          className="mb-5 mt-4 rounded-md border border-warning/40 bg-warning-soft p-4"
        >
          <p className="text-sm font-semibold text-warning">
            Decision use is paused — open appeal
          </p>
          <p className="mt-1 text-sm text-ink-secondary">
            An appeal is under review. Automated recommendations and status
            automation are hidden until a human reviewer resolves it. The
            existing status is preserved.
          </p>
        </div>
      )}

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
    </div>
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
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Profile */}
      <Card className="p-5 lg:col-span-1">
        <h2 className="mb-4 text-sm font-semibold text-ink">Profile</h2>
        <dl className="space-y-3 text-sm">
          <Field label="Phone">
            {candidate.phone_e164 ? (
              <span className="flex items-center gap-1.5">
                {candidate.phone_e164}
                {!candidate.phone_valid && <Chip tone="red">invalid</Chip>}
              </span>
            ) : (
              <span className="text-ink-tertiary">Not provided</span>
            )}
          </Field>
          <Field label="Experience">
            {candidate.experience_years != null
              ? `${candidate.experience_years} years`
              : "—"}
          </Field>
          <Field label="Status">
            <StatusBadge tone={candidateStatusTone(candidate.status)}>
              {candidateStatusLabel(candidate.status)}
            </StatusBadge>
          </Field>
          <div>
            <dt className="mb-1.5 text-xs font-medium text-ink-secondary">
              Skills
            </dt>
            <dd className="flex flex-wrap gap-1.5">
              {candidate.skills.length === 0 ? (
                <span className="text-ink-tertiary">None parsed</span>
              ) : (
                candidate.skills.map((s) => (
                  <Chip key={s} tone="accent">
                    {s}
                  </Chip>
                ))
              )}
            </dd>
          </div>
        </dl>
        <p className="mt-5 rounded-lg bg-surface-tertiary p-3 text-xs leading-relaxed text-ink-secondary">
          Start a browser voice screening below. Transcript, playback, and
          scorecard sync back and are reviewed in the Review tab.
        </p>
      </Card>

      {/* Live actions + sessions + notes + appeals */}
      <div className="space-y-6 lg:col-span-2">
        <LiveKitCallCard
          candidateId={candidate.id}
          candidateName={candidate.name}
        />

        <LiveCallPanel
          candidateId={candidate.id}
          candidateName={candidate.name || undefined}
        />

        <SessionsSummary sessions={sessions} />

        <NotesSection candidateId={candidate.id} />
        <AppealsSection candidateId={candidate.id} sessions={sessions} />
      </div>
    </div>
  );
}

function SessionsSummary({ sessions }: { sessions: Session[] }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Screening sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          No screening sessions yet. Start one above.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {sessions.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">
                  Session {s.id.slice(0, 8)}
                  {s.mode && (
                    <span className="ml-2 text-xs font-normal text-ink-tertiary">
                      {s.mode === "live" ? "live call" : "simulation"}
                    </span>
                  )}
                </p>
                <p className="text-xs text-ink-tertiary">
                  {formatDateTime(s.created_at)}
                  {s.duration_sec
                    ? ` · ${formatDurationSec(s.duration_sec)}`
                    : ""}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge tone={sessionStatusTone(s.status)}>
                  {sessionStatusLabel(s.status)}
                </StatusBadge>
                <Link
                  to={`/sessions/${s.id}`}
                  className="text-xs font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
                >
                  View details
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── Append-only notes ──────────────────────────────────────────────── */

function NotesSection({ candidateId }: { candidateId: string }) {
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
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Notes</h2>
      {err ? (
        <p className="text-sm text-error">{err}</p>
      ) : notes === null ? (
        <p className="text-sm text-ink-tertiary">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-sm text-ink-secondary">No notes yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {notes.map((n) => (
            <li key={n.id} className="py-2 text-sm">
              <p className="whitespace-pre-wrap text-ink">{n.note}</p>
              <p className="mt-0.5 text-xs text-ink-tertiary">
                {formatDateTime(n.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex gap-2">
        <label htmlFor="note-input" className="sr-only">
          Add a note
        </label>
        <input
          id="note-input"
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          maxLength={2000}
          placeholder="Add a note…"
          className="flex-1 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-tertiary focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
        />
        <Button
          variant="secondary"
          onClick={() => void add()}
          loading={saving}
          disabled={!noteText.trim()}
        >
          Add
        </Button>
      </div>
      {msg && <p className="mt-2 text-xs text-ink-secondary">{msg}</p>}
    </Card>
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
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Appeals</h2>
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
                <Chip tone={a.status === "open" || a.status === "under_review" ? "accent" : "green"}>
                  {a.status}
                </Chip>
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-ink-secondary">{a.description}</p>
              <p className="mt-0.5 text-xs text-ink-tertiary">
                {formatDateTime(a.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 rounded-md border border-line p-4">
        <h3 className="text-sm font-semibold text-ink">Issue appeal grant</h3>
        <p className="mt-1 text-xs text-ink-tertiary">
          A one-time fragment link the candidate opens at /appeal. Explicit
          expiry is required (1–72 hours); the plaintext is shown only once.
        </p>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div>
            <label htmlFor="appeal-session" className="block text-xs font-medium text-ink-secondary">
              Session
            </label>
            <select
              id="appeal-session"
              value={selectedSession}
              onChange={(e) => setSelectedSession(e.target.value)}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
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
            </select>
          </div>
          <div>
            <label htmlFor="appeal-expiry" className="block text-xs font-medium text-ink-secondary">
              Expires in (hours, 1–72)
            </label>
            <input
              id="appeal-expiry"
              type="number"
              min={1}
              max={72}
              value={expiryHours}
              onChange={(e) => setExpiryHours(Number(e.target.value))}
              className="mt-1 block w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>
        <Button
          className="mt-3"
          variant="secondary"
          onClick={() => void issueGrant()}
          loading={issuing}
          disabled={!selectedSession}
        >
          Issue one-time appeal grant
        </Button>
        {msg && <p className="mt-2 text-xs text-ink-secondary">{msg}</p>}
        {grantLink && (
          <div className="mt-2 rounded-md bg-surface-tertiary p-3">
            <p className="text-xs font-semibold text-ink-secondary">One-time link (shown once)</p>
            <code className="block break-all text-xs text-ink-secondary">{grantLink}</code>
            <p className="mt-1 text-[11px] text-ink-tertiary">
              Contains a secret token in the fragment — share it only with the
              candidate. It is never stored by the app.
            </p>
          </div>
        )}
      </div>
    </Card>
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
      <Button variant="secondary" onClick={() => void download()} loading={busy}>
        Export screening data (scorecard + transcript)
      </Button>
      {err && <p className="mt-1 text-xs text-error">{err}</p>}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-xs font-medium text-ink-secondary">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}
