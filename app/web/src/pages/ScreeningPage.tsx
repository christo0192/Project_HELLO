import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Assessment, TranscriptLine } from "../types";
import { Scorecard } from "../components/Scorecard";
import {
  Button,
  ErrorState,
  LoadingState,
  Spinner,
} from "../components/ui";

export function ScreeningPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [done, setDone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const [turnError, setTurnError] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    if (!sessionId) return;
    setLoadError(null);
    setTranscript(null);
    api
      .getSession(sessionId)
      .then((data) => {
        setTranscript(data.transcript);
        setAssessment(data.assessment);
        setDone(Boolean(data.assessment) || data.session.status === "completed");
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, [sessionId]);

  useEffect(load, [load]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [transcript, thinking, assessment]);

  async function sendTurn() {
    const text = draft.trim();
    if (!text || !sessionId || thinking || done) return;
    setTurnError(null);
    setDraft("");
    setTranscript((prev) => [...(prev ?? []), { speaker: "candidate", text }]);
    setThinking(true);
    try {
      const res = await api.turn(sessionId, text);
      setTranscript((prev) => [
        ...(prev ?? []),
        { speaker: "bot", text: res.message },
      ]);
      if (res.done) {
        setDone(true);
        if (res.assessment) setAssessment(res.assessment);
      }
    } catch (err) {
      setTurnError(
        err instanceof ApiError ? err.message : "Failed to send answer.",
      );
    } finally {
      setThinking(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendTurn();
    }
  }

  if (loadError) return <ErrorState message={loadError} onRetry={load} />;
  if (transcript === null) return <LoadingState label="Loading session…" />;

  return (
    <div>
      <Link
        to="/candidates"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-900"
      >
        ← Back to candidates
      </Link>

      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-600 text-sm font-bold text-white">
          M
        </div>
        <div>
          <h1 className="text-lg font-semibold text-gray-900">
            Screening with Gopu
          </h1>
          <p className="text-xs text-gray-400">
            {done
              ? "Screening complete"
              : "Type the candidate's spoken answers and send"}
          </p>
        </div>
      </div>

      {/* Chat window */}
      <div className="flex h-[60vh] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-card">
        <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto p-5">
          {transcript.length === 0 && !thinking && (
            <p className="py-10 text-center text-sm text-gray-400">
              Waiting for the conversation to begin…
            </p>
          )}
          {transcript.map((line, i) => (
            <Bubble key={i} speaker={line.speaker} text={line.text} />
          ))}
          {thinking && <TypingIndicator />}
        </div>

        {/* Composer */}
        <div className="border-t border-gray-200 p-3">
          {done ? (
            <div className="flex items-center justify-center gap-2 py-2 text-sm font-medium text-emerald-600">
              <CheckIcon className="h-4 w-4" />
              Screening complete
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={thinking}
                placeholder="Type the candidate's answer…"
                aria-label="Candidate answer"
                className="max-h-32 flex-1 resize-none rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500 disabled:bg-gray-50"
              />
              <Button
                onClick={sendTurn}
                loading={thinking}
                disabled={!draft.trim()}
              >
                Send
              </Button>
            </div>
          )}
          {turnError && (
            <p className="mt-2 text-sm text-red-600" role="alert">
              {turnError}
            </p>
          )}
        </div>
      </div>

      {done && assessment && (
        <div className="mt-6">
          <h2 className="mb-3 text-sm font-semibold text-gray-900">
            Assessment
          </h2>
          <Scorecard assessment={assessment} />
        </div>
      )}
    </div>
  );
}

function Bubble({ speaker, text }: TranscriptLine) {
  const isBot = speaker === "bot";
  return (
    <div className={`flex ${isBot ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[78%] ${isBot ? "" : "text-right"}`}>
        <p className="mb-1 px-1 text-[11px] font-medium text-gray-400">
          {isBot ? "Gopu" : "Candidate"}
        </p>
        <div
          className={`rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            isBot
              ? "rounded-tl-sm bg-gray-100 text-gray-800"
              : "rounded-tr-sm bg-accent-600 text-white"
          }`}
        >
          {text}
        </div>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="max-w-[78%]">
        <p className="mb-1 px-1 text-[11px] font-medium text-gray-400">Gopu</p>
        <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm bg-gray-100 px-4 py-3">
          <Spinner className="h-4 w-4 text-gray-400" />
          <span className="text-sm text-gray-500">Gopu is thinking…</span>
        </div>
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
