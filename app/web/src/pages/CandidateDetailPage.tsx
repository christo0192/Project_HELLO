import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { CandidateDetail } from "../types";
import { Scorecard } from "../components/Scorecard";
import { LiveCallPanel } from "../components/LiveCallPanel";
import { LiveKitCallCard } from "../components/LiveKitCallCard";
import {
  Card,
  Chip,
  ErrorState,
  LoadingState,
  PageHeader,
} from "../components/ui";

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

  return (
    <div>
      <Link
        to="/candidates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← Back to candidates
      </Link>

      <PageHeader
        title={candidate.name || "Unnamed candidate"}
        description={candidate.email ?? undefined}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Profile */}
        <Card className="p-5 lg:col-span-1">
          <h2 className="mb-4 text-sm font-semibold text-gray-900">Profile</h2>
          <dl className="space-y-3 text-sm">
            <Field label="Phone">
              {candidate.phone_e164 ? (
                <span className="flex items-center gap-1.5">
                  {candidate.phone_e164}
                  {!candidate.phone_valid && <Chip tone="red">invalid</Chip>}
                </span>
              ) : (
                <span className="text-gray-400">Not provided</span>
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
              <dt className="mb-1.5 text-xs font-medium text-gray-500">
                Skills
              </dt>
              <dd className="flex flex-wrap gap-1.5">
                {candidate.skills.length === 0 ? (
                  <span className="text-gray-400">None parsed</span>
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
          <p className="mt-5 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-500">
            LiveKit mode: start a browser voice screening from this dashboard.
            Transcript, playback, and scorecard sync back to Supabase.
          </p>
        </Card>

        {/* Sessions + latest assessment */}
        <div className="space-y-6 lg:col-span-2">
          <LiveKitCallCard
            candidateId={candidate.id}
            candidateName={candidate.name}
          />

          <LiveCallPanel
            candidateId={candidate.id}
            candidateName={candidate.name || undefined}
          />

          {latestAssessment && (
            <div>
              <h2 className="mb-3 text-sm font-semibold text-gray-900">
                Latest assessment
              </h2>
              <Scorecard assessment={latestAssessment} />
            </div>
          )}

          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-900">
              Screening sessions
            </h2>
            {sessions.length === 0 ? (
              <Card className="p-5 text-sm text-gray-500">
                No screening sessions yet. Start one above.
              </Card>
            ) : (
              <Card className="divide-y divide-gray-100">
                {sessions.map((s) => (
                  <div key={s.id} className="px-4 py-3 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-gray-800">
                          Session {s.id.slice(0, 8)}
                          {s.mode && (
                            <span className="ml-2 text-xs font-normal text-gray-400">
                              {s.mode === "live" ? "📞 live call" : "💬 simulation"}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-400">
                          {new Date(s.created_at).toLocaleString()}
                          {s.duration_sec ? ` · ${s.duration_sec}s` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <Chip
                          tone={
                            s.status === "completed" || s.done
                              ? "green"
                              : "neutral"
                          }
                        >
                          {s.status || (s.done ? "completed" : "in progress")}
                        </Chip>
                        <Link
                          to={`/screening/${s.id}`}
                          className="text-xs font-medium text-accent-600 hover:text-accent-700"
                        >
                          View
                        </Link>
                      </div>
                    </div>
                    {s.recording_url && (
                      <audio
                        controls
                        preload="none"
                        src={s.recording_url}
                        className="mt-2 h-9 w-full"
                      >
                        <a href={s.recording_url} target="_blank" rel="noreferrer">
                          Download recording
                        </a>
                      </audio>
                    )}
                  </div>
                ))}
              </Card>
            )}
          </div>
        </div>
      </div>
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
      <dt className="text-xs font-medium text-gray-500">{label}</dt>
      <dd className="text-gray-800">{children}</dd>
    </div>
  );
}
