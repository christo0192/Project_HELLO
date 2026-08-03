import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { AppealRow, CandidateDetail, Note, Session, TranscriptLine } from "../types";
import { Scorecard } from "../components/Scorecard";
import { LiveCallPanel } from "../components/LiveCallPanel";
import { LiveKitCallCard } from "../components/LiveKitCallCard";
import { Button, Card, Chip, ErrorState, LoadingState } from "../components/ui";
import { PageHeader, StatusBadge } from "../components/design";
import { RecordingCard, Tabs, TranscriptList } from "../components/talent";
import {
  candidateStatusLabel,
  candidateStatusTone,
  formatDurationSec,
} from "../components/talent";

/**
 * HELLO Lane 3 — CandidateDetail reorganized for daily work.
 *
 * Layout: a compact identity/status/action header (always visible) plus
 * responsive keyboard tabs (ARIA tabs pattern) that split the profile into
 * Overview / Sessions / Transcript & Scorecards / Recordings / Notes & Appeals.
 *
 * EVERY existing behavior is preserved exactly:
 *   - decision-use block banner + automated-scorecard suppression
 *   - LiveKit voice-screening invite + live call panel (realtime transcript)
 *   - append-only notes, appeals + one-time grant links (fragment-only)
 *   - ownership-scoped CSV scorecard export
 *   - on-demand short-lived recording playback (never auto-fetched)
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
  const latestAssessment = assessments[0] ?? null;
  const decisionBlocked = candidate.decision_use_blocked_at != null;

  return (
    <div>
      <Link
        to="/candidates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-secondary hover:text-ink"
      >
        ← Back to candidates
      </Link>

      {/* Compact identity / status / action header */}
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
          className="mb-5 rounded-md border border-warning/40 bg-warning-soft p-4"
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

      <Tabs
        ariaLabel="Candidate sections"
        items={[
          {
            id: "overview",
            label: "Overview",
            panel: (
              <OverviewTab
                candidate={candidate}
                sessions={sessions}
                latestAssessment={latestAssessment}
                decisionBlocked={decisionBlocked}
              />
            ),
          },
          {
            id: "sessions",
            label: "Sessions",
            panel: <SessionsTab sessions={sessions} />,
          },
          {
            id: "transcripts",
            label: "Transcript & Scorecards",
            panel: (
              <TranscriptsTab
                sessions={sessions}
                assessments={assessments}
                blocked={decisionBlocked}
              />
            ),
          },
          {
            id: "recordings",
            label: "Recordings",
            panel: <RecordingsTab sessions={sessions} />,
          },
        ]}
      />
    </div>
  );
}

/* ── Tab panels ─────────────────────────────────────────────────────── */

function OverviewTab({
  candidate,
  sessions,
  latestAssessment,
  decisionBlocked,
}: {
  candidate: CandidateDetail["candidate"];
  sessions: CandidateDetail["sessions"];
  latestAssessment: CandidateDetail["assessments"][number] | null;
  decisionBlocked: boolean;
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
            <Chip>{candidate.status || "new"}</Chip>
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
          LiveKit mode: start a browser voice screening from this dashboard.
          Transcript, playback, and scorecard sync back to Supabase.
        </p>
      </Card>

      {/* Live actions + latest assessment */}
      <div className="space-y-6 lg:col-span-2">
        <LiveKitCallCard
          candidateId={candidate.id}
          candidateName={candidate.name}
        />

        <LiveCallPanel
          candidateId={candidate.id}
          candidateName={candidate.name || undefined}
        />

        {latestAssessment && !decisionBlocked && (
          <div>
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Latest assessment
            </h2>
            <Scorecard assessment={latestAssessment} />
          </div>
        )}

        {latestAssessment && decisionBlocked && (
          <Card className="p-5">
            <h2 className="text-sm font-semibold text-ink">
              Latest assessment
            </h2>
            <p className="mt-2 text-sm text-ink-secondary">
              Hidden while an appeal is under review. A human reviewer will
              re-assess before any recommendation is used.
            </p>
          </Card>
        )}

        <NotesSection candidateId={candidate.id} />
        <AppealsSection
          candidateId={candidate.id}
          sessions={sessions}
          blocked={decisionBlocked}
        />
      </div>
    </div>
  );
}

function SessionsTab({ sessions }: { sessions: CandidateDetail["sessions"] }) {
  return (
    <div>
      <h2 className="mb-3 text-sm font-semibold text-ink">
        Screening sessions
      </h2>
      {sessions.length === 0 ? (
        <Card className="p-5 text-sm text-ink-secondary">
          No screening sessions yet. Start one from the Overview tab.
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {sessions.map((s) => (
            <div key={s.id} className="px-4 py-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-ink">
                    Session {s.id.slice(0, 8)}
                    {s.mode && (
                      <span className="ml-2 text-xs font-normal text-ink-tertiary">
                        {s.mode === "live" ? "📞 live call" : "💬 simulation"}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-ink-tertiary">
                    {new Date(s.created_at).toLocaleString()}
                    {s.duration_sec
                      ? ` · ${formatDurationSec(s.duration_sec)}`
                      : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <Chip
                    tone={
                      s.status === "completed" || s.done ? "green" : "neutral"
                    }
                  >
                    {s.status || (s.done ? "completed" : "in progress")}
                  </Chip>
                  <Link
                    to={`/screening/${s.id}`}
                    className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
                  >
                    View
                  </Link>
                </div>
              </div>
              {s.status === "completed" && (
                <RecordingDownloadButton sessionId={s.id} />
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

function TranscriptsTab({
  sessions,
  assessments,
  blocked,
}: {
  sessions: CandidateDetail["sessions"];
  assessments: CandidateDetail["assessments"];
  blocked: boolean;
}) {
  const olderAssessments = assessments.slice(1);
  return (
    <div className="space-y-6">
      <Card className="p-5">
        <h2 className="mb-1 text-sm font-semibold text-ink">
          Session transcripts
        </h2>
        <p className="mb-4 text-xs text-ink-tertiary">
          Transcripts are loaded on demand per session. The API returns speaker
          turns; timestamps are not part of the transcript contract.
        </p>
        {sessions.length === 0 ? (
          <p className="text-sm text-ink-secondary">No screening sessions yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <TranscriptCard key={s.id} session={s} />
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-ink">Scorecards</h2>
        {blocked ? (
          <p className="text-sm text-ink-secondary">
            Scorecards are suppressed while an appeal is under review. A human
            reviewer will re-assess before any recommendation is used.
          </p>
        ) : olderAssessments.length === 0 ? (
          <p className="text-sm text-ink-secondary">
            {assessments.length > 0
              ? "The latest scorecard is shown on the Overview tab. No older scorecards exist yet."
              : "No scorecards yet — complete a screening to generate one."}
          </p>
        ) : (
          <div className="space-y-6">
            {olderAssessments.map((a) => (
              <Scorecard key={a.id ?? a.overall_score} assessment={a} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function TranscriptCard({ session }: { session: Session }) {
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const detail = await api.getSession(session.id);
      setTranscript(detail.transcript);
    } catch (e) {
      setError(
        (e as { message?: string }).message || "Failed to load transcript.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <li className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">
            Session {session.id.slice(0, 8)}
          </p>
          <p className="text-xs text-ink-tertiary">
            {new Date(session.created_at).toLocaleString()}
            {session.duration_sec
              ? ` · ${formatDurationSec(session.duration_sec)}`
              : ""}
          </p>
        </div>
        {transcript === null && (
          <Button
            variant="secondary"
            onClick={() => void load()}
            loading={loading}
          >
            Load transcript
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-error">
          {error}
        </p>
      )}
      {transcript !== null && (
        <div className="mt-4">
          <TranscriptList
            transcript={transcript}
            onRetry={() => {
              setTranscript(null);
            }}
          />
        </div>
      )}
    </li>
  );
}

function RecordingsTab({
  sessions,
}: {
  sessions: CandidateDetail["sessions"];
}) {
  const completed = sessions.filter((s) => s.status === "completed");
  return (
    <Card className="p-5">
      <h2 className="mb-1 text-sm font-semibold text-ink">Recordings</h2>
      <p className="mb-4 text-xs text-ink-tertiary">
        Short-lived playback links are created only when you request them —
        never on page load — and expire automatically. Signed URLs and object
        keys are never logged or stored.
      </p>
      {completed.length === 0 ? (
        <p className="text-sm text-ink-secondary">
          No completed sessions with recordings yet.
        </p>
      ) : (
        <ul className="space-y-4">
          {completed.map((s) => (
            <li key={s.id}>
              <p className="mb-2 text-sm font-medium text-ink">
                Session {s.id.slice(0, 8)} ·{" "}
                {new Date(s.created_at).toLocaleString()}
              </p>
              <RecordingCard sessionId={s.id} title="Session recording" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ── Phase 9: append-only notes ─────────────────────────────────────── */

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
                {new Date(n.created_at).toLocaleString()}
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
        <Button variant="secondary" onClick={() => void add()} loading={saving} disabled={!noteText.trim()}>
          Add
        </Button>
      </div>
      {msg && <p className="mt-2 text-xs text-ink-secondary">{msg}</p>}
    </Card>
  );
}

/* ── Phase 9: appeals + one-time grant link ─────────────────────────── */

function AppealsSection({
  candidateId,
  sessions,
  blocked,
}: {
  candidateId: string;
  sessions: CandidateDetail["sessions"];
  blocked: boolean;
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
        `Grant issued — expires ${new Date(res.expires_at).toLocaleString()}. ` +
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
      {blocked && (
        <p className="mb-3 rounded-md bg-warning-soft p-2 text-xs text-warning">
          An appeal is open — automated decision use is paused.
        </p>
      )}
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
                {new Date(a.created_at).toLocaleString()}
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
                    {s.id.slice(0, 8)} ({s.status})
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

/* ── Phase 9: CSV export ────────────────────────────────────────────── */

function CsvExportButton({ candidateId }: { candidateId: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const csv = await api.exportCsv(candidateId);
      // Same-tab download via a transient object URL — revoked immediately.
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

/**
 * MIG-06: On-demand recording download button.
 * Fetches a short-lived signed URL only when clicked.
 * Never auto-fetches on list render.
 */
function RecordingDownloadButton({ sessionId }: { sessionId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // On-demand fetch — only ever runs from an explicit click. Repeated
  // clicks re-mint a fresh short-TTL URL (handles expiry); stale responses
  // are ignored via a generation counter.
  const handleClick = useCallback(() => {
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    api
      .getRecordingDownloadUrl(sessionId)
      .then((res) => {
        if (!mountedRef.current || reqId !== reqIdRef.current) return;
        setUrl(res.url);
        setLoading(false);
      })
      .catch((e: ApiError) => {
        if (!mountedRef.current || reqId !== reqIdRef.current) return;
        setError(e.message || "Failed to load recording");
        setLoading(false);
      });
  }, [sessionId]);

  if (url && !loading) {
    return (
      <div className="mt-2 space-y-1">
        <audio controls preload="none" src={url} className="h-9 w-full">
          <a href={url} target="_blank" rel="noreferrer">
            Download recording
          </a>
        </audio>
        <button
          type="button"
          onClick={handleClick}
          className="text-xs font-medium text-brand-700 hover:text-brand-800 dark:text-brand-300"
        >
          Refresh link
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={handleClick}
        disabled={loading}
        className="rounded bg-brand-600 px-3 py-1 text-xs font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {loading ? "Loading…" : "Play recording"}
      </button>
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
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
