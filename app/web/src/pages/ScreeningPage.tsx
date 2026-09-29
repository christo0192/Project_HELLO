import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import type { Assessment, TranscriptLine } from "../types";
import { Scorecard } from "../components/Scorecard";
import { BackIcon } from "../components/session/BackIcon";
import {
  Button,
  buttonClass,
  ErrorPanel,
  GlassPanel,
  InlineNotice,
  LoadingPanel,
  PageHeader,
  ScrollArea,
  SectionHeader,
  TextArea,
} from "../components/design";

export function ScreeningPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [transcript, setTranscript] = useState<TranscriptLine[] | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [candidateId, setCandidateId] = useState<string | null>(null);
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
        setCandidateId(data.session?.candidate_id || null);
        setDone(Boolean(data.assessment) || data.session.status === "completed");
      })
      .catch((e: ApiError) => setLoadError(e.message));
  }, [sessionId]);

  useEffect(load, [load]);

  useEffect(() => {
    // `ScrollArea` owns the scrolling element; the ref sits on its content
    // wrapper, so the scroll region is that wrapper's parent.
    const region = scrollRef.current?.parentElement;
    region?.scrollTo({ top: region.scrollHeight, behavior: "smooth" });
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
      // Roll back the optimistic turn and give the words back to the composer.
      setTranscript((prev) => {
        const next = [...(prev ?? [])];
        const last = next[next.length - 1];
        if (last && last.speaker === "candidate" && last.text === text) next.pop();
        return next;
      });
      setDraft(text);
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

  if (loadError) return <ErrorPanel message={loadError} onRetry={load} />;
  if (transcript === null) return <LoadingPanel label="Loading session…" />;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Screening console"
        title="Screening with Gopu"
        description={
          !done
            ? "Type the candidate's spoken answers and send"
            : assessment
              ? "Complete. The assessment is below."
              : "Complete. The assessment is not ready yet."
        }
        actions={
          // Back to THIS candidate when the session names one; the list otherwise.
          <Link
            to={candidateId ? `/candidates/${candidateId}` : "/candidates"}
            className={buttonClass("ghost", "md", "-ml-3 sm:-mr-3 sm:ml-0")}
          >
            <BackIcon />
            {candidateId ? "Back to candidate" : "Back to candidates"}
          </Link>
        }
      />

      {/* Conversation */}
      <GlassPanel padding="none" className="overflow-hidden">
        <ScrollArea maxHeight="60vh" label="Conversation" className="px-5">
          <div ref={scrollRef} className="space-y-4">
            {transcript.length === 0 && !thinking && (
              <p className="py-10 text-center text-sm text-ink-tertiary">
                Waiting for the conversation to begin…
              </p>
            )}
            {transcript.map((line, i) => (
              <Bubble key={i} speaker={line.speaker} text={line.text} />
            ))}
            {thinking && <TypingIndicator />}
          </div>
        </ScrollArea>

        {/* Composer */}
        <div className="border-t border-glass-ring p-3">
          {done ? (
            <div className="flex items-center justify-center gap-2 py-2 text-sm font-medium text-success-text">
              <CheckIcon className="h-4 w-4" />
              Screening complete
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <TextArea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                disabled={thinking}
                placeholder="Type the candidate's answer…"
                aria-label="Candidate answer"
                className="max-h-32 min-h-9 flex-1 resize-none py-2"
              />
              <Button
                variant="primary"
                onClick={sendTurn}
                loading={thinking}
                disabled={!draft.trim()}
              >
                Send
              </Button>
            </div>
          )}
          {turnError && (
            <InlineNotice tone="danger" role="alert" className="mt-2">
              {turnError}
            </InlineNotice>
          )}
        </div>
      </GlassPanel>

      {done && assessment && (
        <GlassPanel>
          <SectionHeader title="Assessment" />
          <div className="mt-5">
            <Scorecard assessment={assessment} layout="split" />
          </div>
        </GlassPanel>
      )}
    </div>
  );
}

function Bubble({ speaker, text }: TranscriptLine) {
  const isBot = speaker === "bot";
  return (
    <div className={`flex ${isBot ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[70%] ${isBot ? "" : "text-right"}`}>
        <p className="mb-1 px-1 text-meta font-medium text-ink-tertiary">
          {isBot ? "Gopu" : "Candidate"}
        </p>
        <div
          className={
            isBot
              ? "glass-sunken px-4 py-2.5 text-left text-sm leading-relaxed text-ink"
              : "rounded-[18px] bg-info px-4 py-2.5 text-left text-sm leading-relaxed text-white"
          }
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
      <div className="max-w-[70%]">
        <p className="mb-1 px-1 text-meta font-medium text-ink-tertiary">
          Gopu
        </p>
        {/* A soft opacity wave across the three dots (opacity only, eased
            in and out, staggered) instead of the old bounce: it says
            "working" without jumping. `motion-safe:` leaves the dots
            static under reduced motion; the sr-only text is the real
            status either way. */}
        <div
          role="status"
          className="glass-sunken flex items-center gap-1.5 px-4 py-3.5"
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-ink-muted motion-safe:animate-[pulse_1.2s_ease-in-out_infinite]"
          />
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-ink-muted motion-safe:animate-[pulse_1.2s_ease-in-out_infinite] [animation-delay:200ms]"
          />
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-ink-muted motion-safe:animate-[pulse_1.2s_ease-in-out_infinite] [animation-delay:400ms]"
          />
          <span className="sr-only">Gopu is thinking…</span>
        </div>
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
