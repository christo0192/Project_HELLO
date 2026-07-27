import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";
import { Scorecard } from "./Scorecard";
import { Card } from "./ui";
import type { Assessment, Recommendation } from "../types";

/* ---------------- Row types (screening_v2 schema) ---------------- */

interface CallSession {
  id: string;
  candidate_id: string;
  role_id: string | null;
  mode: string | null;
  status: string; // 'in_progress' | 'completed' | ...
  started_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  recording_url?: string | null;
}

interface TranscriptTurn {
  id: string;
  session_id: string;
  turn_index: number;
  speaker: "bot" | "candidate";
  text: string;
  created_at: string;
}

interface AssessmentRow {
  session_id: string;
  candidate_id: string;
  english?: Assessment["english"];
  tone: Assessment["tone"];
  communication?: Assessment["communication"];
  motivation?: Assessment["motivation"];
  role_fit: Assessment["role_fit"];
  overall_score: number | string;
  recommendation: string;
  summary: string;
  raw: Partial<Assessment> | null;
}

/** Map an assessments row (jsonb columns) to the shape <Scorecard> expects. */
function toAssessment(row: AssessmentRow): Assessment {
  const raw = row.raw ?? {};
  return {
    english: row.english ?? raw.english,
    tone: row.tone ?? raw.tone,
    communication: row.communication ?? raw.communication,
    motivation: row.motivation ?? raw.motivation,
    role_fit: row.role_fit ?? raw.role_fit,
    overall_score: Number(row.overall_score),
    recommendation: (row.recommendation as Recommendation) ?? "hold",
    summary: row.summary ?? raw.summary ?? "",
    resume_conflicts: raw.resume_conflicts ?? [],
    raw,
  };
}

/* ---------------- Component ---------------- */

export function LiveCallPanel({
  candidateId,
  candidateName,
}: {
  candidateId: string;
  candidateName?: string;
}) {
  const [session, setSession] = useState<CallSession | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [interim, setInterim] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const sid = session?.id ?? null;
  const status = session?.status ?? null;

  // 1 + 2: adopt latest session for this candidate, and auto-activate on new ones.
  useEffect(() => {
    let cancelled = false;

    supabase
      .from("call_sessions")
      .select("*")
      .eq("candidate_id", candidateId)
      .order("started_at", { ascending: false })
      .limit(1)
      .then(({ data }) => {
        if (cancelled || !data || data.length === 0) return;
        setSession(data[0] as CallSession);
      });

    const channel = supabase
      .channel(`live-call:sessions:${candidateId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "screening_v2",
          table: "call_sessions",
          filter: `candidate_id=eq.${candidateId}`,
        },
        (payload) => setSession(payload.new as CallSession),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [candidateId]);

  // 3 + 5 + 6: for the active session, load turns and subscribe to turns,
  // session status updates, and the assessment insert.
  useEffect(() => {
    if (!sid) {
      setTurns([]);
      setAssessment(null);
      setInterim("");
      return;
    }
    let cancelled = false;
    setTurns([]);
    setAssessment(null);
    setInterim("");

    supabase
      .from("transcript_turns")
      .select("*")
      .eq("session_id", sid)
      .order("turn_index")
      .then(({ data }) => {
        if (cancelled || !data) return;
        setTurns(data as TranscriptTurn[]);
      });

    const channel = supabase
      .channel(`live-call:session:${sid}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "screening_v2",
          table: "transcript_turns",
          filter: `session_id=eq.${sid}`,
        },
        (payload) => {
          const turn = payload.new as TranscriptTurn;
          setTurns((prev) => {
            if (prev.some((t) => t.id === turn.id)) return prev;
            return [...prev, turn].sort((a, b) => a.turn_index - b.turn_index);
          });
          if (turn.speaker === "candidate") setInterim("");
        },
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "screening_v2",
          table: "call_sessions",
          filter: `id=eq.${sid}`,
        },
        (payload) =>
          setSession((prev) =>
            prev
              ? { ...prev, ...(payload.new as CallSession) }
              : (payload.new as CallSession),
          ),
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "screening_v2",
          table: "assessments",
          filter: `session_id=eq.${sid}`,
        },
        (payload) => setAssessment(toAssessment(payload.new as AssessmentRow)),
      )
      .on("broadcast", { event: "interim" }, ({ payload }) =>
        setInterim((payload as { text: string }).text ?? ""),
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [sid]);

  // 6: when the session is (or becomes) completed, fetch the assessment.
  useEffect(() => {
    if (!sid || status !== "completed") return;
    let cancelled = false;
    supabase
      .from("assessments")
      .select("*")
      .eq("session_id", sid)
      .limit(1)
      .then(({ data }) => {
        if (cancelled || !data || data.length === 0) return;
        setAssessment(toAssessment(data[0] as AssessmentRow));
      });
    return () => {
      cancelled = true;
    };
  }, [sid, status]);

  // 4: auto-scroll to newest message (including live interim bubble).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, interim]);

  const isLive = status === "in_progress";
  const isCompleted = status === "completed";

  return (
    <Card className="flex flex-col overflow-hidden">
      {/* Header + status badge */}
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 bg-gray-50/60 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-900">Live call</h2>
        {isLive ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-inset ring-red-200">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
            </span>
            Live
          </span>
        ) : isCompleted ? (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
            Call ended
          </span>
        ) : status ? (
          <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
            {status}
          </span>
        ) : null}
      </div>

      {/* Transcript / empty state */}
      {!session ? (
        <div className="flex flex-col items-center justify-center gap-1 px-4 py-12 text-center">
          <p className="text-sm font-medium text-gray-700">No active call</p>
          <p className="text-xs text-gray-500">
            Click Start Screening to begin.
          </p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex max-h-96 min-h-[12rem] flex-col gap-3 overflow-y-auto p-4"
        >
          {turns.length === 0 ? (
            <p className="m-auto text-xs text-gray-400">
              Waiting for the conversation to start…
            </p>
          ) : (
            turns.map((turn) => {
              const isBot = turn.speaker === "bot";
              return (
                <div
                  key={turn.id}
                  className={`flex flex-col ${isBot ? "items-start" : "items-end"}`}
                >
                  <span className="mb-0.5 px-1 text-[11px] font-medium text-gray-400">
                    {isBot ? "Gopu" : candidateName || "Candidate"}
                  </span>
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
                      isBot
                        ? "rounded-tl-sm bg-gray-100 text-gray-800"
                        : "rounded-tr-sm bg-accent-600 text-white"
                    }`}
                  >
                    {turn.text}
                  </div>
                </div>
              );
            })
          )}
          {interim !== "" && isLive && (
            <div className="flex flex-col items-end">
              <span className="mb-0.5 px-1 text-[11px] font-medium text-gray-400">
                {candidateName || "Candidate"}
              </span>
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-accent-600 px-3.5 py-2 text-sm italic leading-relaxed text-white opacity-70">
                {interim}
                <span className="ml-1.5 inline-flex items-end gap-0.5 align-middle">
                  <span
                    className="inline-block h-1 w-1 animate-bounce rounded-full bg-white opacity-80"
                    style={{ animationDelay: "0ms" }}
                  />
                  <span
                    className="inline-block h-1 w-1 animate-bounce rounded-full bg-white opacity-80"
                    style={{ animationDelay: "150ms" }}
                  />
                  <span
                    className="inline-block h-1 w-1 animate-bounce rounded-full bg-white opacity-80"
                    style={{ animationDelay: "300ms" }}
                  />
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Call recording, populated after the call ends */}
      {session?.recording_url && (
        <div className="border-t border-gray-200 p-4">
          <h3 className="mb-2 text-sm font-semibold text-gray-900">
            Call recording
          </h3>
          <audio
            controls
            preload="none"
            src={session.recording_url}
            className="h-9 w-full"
          >
            <a href={session.recording_url} target="_blank" rel="noreferrer">
              Download recording
            </a>
          </audio>
        </div>
      )}

      {/* Assessment: skeleton while post-call scoring runs, then the scorecard */}
      {assessment ? (
        <div className="border-t border-gray-200 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">
            Assessment
          </h3>
          <Scorecard assessment={assessment} />
        </div>
      ) : isCompleted ? (
        <div className="border-t border-gray-200 p-4">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-900">
            <svg
              className="h-4 w-4 animate-spin text-accent-600"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            Scoring the conversation…
          </h3>
          <div className="animate-pulse space-y-3" aria-hidden="true">
            <div className="h-3 w-1/3 rounded bg-gray-200" />
            <div className="grid grid-cols-2 gap-3">
              <div className="h-16 rounded-lg bg-gray-100" />
              <div className="h-16 rounded-lg bg-gray-100" />
              <div className="h-16 rounded-lg bg-gray-100" />
              <div className="h-16 rounded-lg bg-gray-100" />
            </div>
            <div className="h-3 w-full rounded bg-gray-200" />
            <div className="h-3 w-5/6 rounded bg-gray-200" />
            <div className="h-3 w-2/3 rounded bg-gray-200" />
          </div>
        </div>
      ) : null}
    </Card>
  );
}
