/**
 * HELLO Session Detail — the read-only record of one screening (Lane 3).
 *
 * Uses the existing `GET /api/screening/:id` contract
 * (`SessionDetail = { session, transcript, assessment }`):
 *
 *   - Scorecard: rendered from the returned `assessment` via <Scorecard>,
 *     which handles both generations (legacy dimensions and role-scorecard
 *     v2). It comes first: the verdict is what a recruiter opened this for.
 *   - Transcript: speaker turns only — the API contract has no timestamps,
 *     so none are fabricated.
 *   - Recording: authorized short-lived player/download via
 *     `GET /api/recordings/:id/download` — fetched ONLY on an explicit click,
 *     refreshed on expiry, errors handled inline. The signed URL appears in
 *     the DOM only as the media href while active and is never logged.
 *
 * NAMING. The page is named by what it is (whose screening, for which role),
 * never by its id. The session payload carries only `candidate_id` and
 * `role_id`, so the page also reads the candidate (for the name) and the
 * role (for the title). Both reads are enrichment: if either fails, the page
 * still renders, named from what it does know. The session id stays one
 * hover away in the details list, shortened, for support.
 *
 * There is deliberately NO composer here: this is a review view, not a
 * live-screening console.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import type { Session, SessionDetail } from '../types';
import {
  buttonClass,
  EmptyPanel,
  ErrorPanel,
  GlassPanel,
  LoadingPanel,
  PageHeader,
  ScrollArea,
  SectionHeader,
  StatusBadge,
} from '../components/design';
import { RecordingCard, TranscriptList } from '../components/talent';
import {
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
} from '../components/talent';
import { unknownLengthWords } from '../components/talent/sessionLegs';
import { Scorecard } from '../components/Scorecard';
import { BackIcon } from '../components/session/BackIcon';
import { formatSessionWhen } from '../components/session/format';
import { shortId } from '../lib/humanize';
import { sessionModeLabel } from '../lib/session-mode';

/** What the page knows about the session beyond its own payload. */
interface SessionContext {
  candidateName: string | null;
  roleTitle: string | null;
  /**
   * M013 S02: this session's recorded roll-up, from the candidate read (the
   * session payload does not carry it). null = unknown.
   */
  recordedSeconds: number | null;
  recordedCalls: number | null;
  /** Calls with audio of unknown length, left out of `recordedSeconds`. */
  recordedUnknownCalls: number | null;
}

function nonBlank(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Read the candidate's name and the role's title. Never rejects: each read
 * is settled on its own, and a failure only means the page names itself
 * from less. (`Promise.resolve().then` so a synchronous throw is caught too.)
 */
async function readContext(session: Session): Promise<SessionContext> {
  const [candidate, role] = await Promise.allSettled([
    session.candidate_id
      ? Promise.resolve().then(() => api.getCandidate(session.candidate_id))
      : Promise.resolve(null),
    session.role_id
      ? Promise.resolve().then(() => api.getRole(session.role_id as string))
      : Promise.resolve(null),
  ]);
  const rolled = candidate.status === 'fulfilled'
    ? candidate.value?.sessions?.find((s) => s?.id === session.id) ?? null
    : null;
  const recordedSeconds = positiveOrNull(rolled?.recorded_total_sec);
  return {
    candidateName: candidate.status === 'fulfilled' ? nonBlank(candidate.value?.candidate?.name) : null,
    roleTitle: role.status === 'fulfilled' ? nonBlank(role.value?.title) : null,
    recordedSeconds,
    recordedCalls: recordedSeconds !== null ? positiveOrNull(rolled?.recorded_legs) : null,
    recordedUnknownCalls: recordedSeconds !== null ? positiveOrNull(rolled?.recorded_unknown_legs) : null,
  };
}

function positiveOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Answered legs left out of `duration_sec` because nobody saw them end (0125). */
function unobservedLegs(session: Session): number {
  const n = session.duration_unobserved_legs;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/** "(1 call's end not observed)" / "(2 calls' ends not observed)". */
function unobservedNote(count: number): string {
  return count === 1 ? "(1 call's end not observed)" : `(${count} calls' ends not observed)`;
}

/** "Meera Iyer’s screening", else the role, else the mode. Never an id. */
function pageTitle(session: Session, context: SessionContext): string {
  if (context.candidateName) return `${context.candidateName}’s screening`;
  if (context.roleTitle) return `${context.roleTitle} screening`;
  const mode = sessionModeLabel(session.mode);
  return mode === 'Screening' ? 'Screening' : `${mode} screening`;
}

/** Role · mode · when, leaving out whatever the title already says or is unknown. */
function pageMeta(session: Session, context: SessionContext): string {
  const mode = sessionModeLabel(session.mode);
  return [
    context.candidateName ? context.roleTitle : null,
    mode === 'Screening' ? null : mode,
    formatSessionWhen(session.started_at ?? session.created_at),
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [context, setContext] = useState<SessionContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A retry (or a new id) supersedes any read still in flight.
  const generation = useRef(0);

  const load = useCallback(() => {
    if (!sessionId) return;
    const current = ++generation.current;
    setError(null);
    setDetail(null);
    setContext(null);
    api
      .getSession(sessionId)
      .then(async (data) => {
        const ctx = await readContext(data.session);
        if (current !== generation.current) return;
        // One commit: the heading renders once, already named, instead of
        // flashing a fallback title and then swapping it.
        setDetail(data);
        setContext(ctx);
      })
      .catch((e: ApiError) => {
        if (current !== generation.current) return;
        setError(e?.message || 'Failed to load the session.');
      });
  }, [sessionId]);

  useEffect(load, [load]);

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!detail || !context) return <LoadingPanel label="Loading session…" />;

  const { session, transcript, assessment } = detail;
  const completed = session.status === 'completed';
  const gateOnlyTranscript = transcript.length > 0 && transcript.every((line) => line.is_gate === true);
  const meta = pageMeta(session, context);
  const words = typeof session.candidate_words === 'number' ? session.candidate_words : null;
  const phone = session.mode === 'live';
  const unobserved = unobservedLegs(session);

  return (
    <div className="space-y-6">
      <PageHeader
        title={pageTitle(session, context)}
        description={meta || undefined}
        actions={
          <Link to={`/candidates/${session.candidate_id}`} className={buttonClass('ghost', 'md', '-ml-3 sm:-mr-3 sm:ml-0')}>
            <BackIcon />
            Back to candidate
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-start">
        {/* Scorecard: the verdict first, then the evidence it rests on. */}
        <GlassPanel className="lg:col-span-7">
          <SectionHeader title="Scorecard" />
          <div className="mt-5">
            {assessment ? (
              <Scorecard assessment={assessment} />
            ) : (
              <EmptyPanel
                compact
                title="No scorecard yet"
                hint={
                  completed
                    ? 'Scoring may still be running. Check back in a minute.'
                    : 'This session has not completed, so it has not been scored.'
                }
              />
            )}
          </div>
        </GlassPanel>

        <div className="space-y-6 lg:col-span-5">
          {/* Details + recording: one surface, one logical group (the call).
              The recording section brings its own hairline above it. */}
          <GlassPanel>
            <SectionHeader title="Details" />
            <dl className="mt-2 divide-y divide-glass-ring">
              <DetailRow label="Status">
                <StatusBadge tone={sessionStatusTone(session.status)}>
                  {sessionStatusLabel(session.status)}
                </StatusBadge>
              </DetailRow>
              {phone ? (
                <>
                  {/* A phone session's `duration_sec` is CONNECTED time
                      summed over the calls whose end was seen (0125). A call
                      only the timeout closed is left out and said so, never
                      counted as minutes nobody was on the line for. */}
                  {(session.duration_sec != null || unobserved > 0) && (
                    <DetailRow label="Connected time">
                      <span data-session-connected="">
                        {session.duration_sec != null ? formatDurationSec(session.duration_sec) : 'Not known'}
                        {unobserved > 0 && (
                          <span className="text-ink-secondary"> {unobservedNote(unobserved)}</span>
                        )}
                      </span>
                    </DetailRow>
                  )}
                  {context.recordedSeconds !== null && (
                    <DetailRow label="Recorded">
                      <span data-session-recorded="">
                        {context.recordedUnknownCalls !== null ? 'At least ' : ''}
                        {formatDurationSec(context.recordedSeconds)}
                        {context.recordedCalls !== null && context.recordedCalls > 1
                          ? ` across ${context.recordedCalls} calls`
                          : ''}
                        {unknownLengthWords(context.recordedUnknownCalls)}
                      </span>
                    </DetailRow>
                  )}
                </>
              ) : (
                session.duration_sec != null && (
                  <DetailRow label="Duration">{formatDurationSec(session.duration_sec)}</DetailRow>
                )
              )}
              {words != null && (
                <DetailRow label="Candidate words">{words.toLocaleString('en-IN')}</DetailRow>
              )}
              <DetailRow label="Reference">
                <span title={session.id} className="font-mono text-label text-ink-secondary">
                  {shortId(session.id)}
                </span>
              </DetailRow>
            </dl>
            <div className="mt-4">
              {completed ? (
                <RecordingCard sessionId={session.id} title="Recording" />
              ) : (
                <p className="text-sm text-ink-tertiary">
                  Recording access is available once the session completes.
                </p>
              )}
            </div>
          </GlassPanel>

          <GlassPanel>
            <SectionHeader
              title={gateOnlyTranscript ? 'Pre-interview gate transcript' : 'Transcript'}
              description={`${transcript.length} speaker turn${transcript.length === 1 ? '' : 's'}`}
            />
            {gateOnlyTranscript && (
              <p className="glass-sunken mt-3 px-3.5 py-2.5 text-label text-ink-secondary">
                This is the identity and recording-consent exchange before the interview. No screening
                interview was recorded in this session.
              </p>
            )}
            {/* `TranscriptList` already exposes a region named "Transcript";
                this scroll region needs a distinct name (axe landmark-unique). */}
            <ScrollArea maxHeight="32rem" label="Session transcript" className="mt-2">
              <TranscriptList transcript={transcript} />
            </ScrollArea>
          </GlassPanel>
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-4 py-2">
      <dt className="text-label text-ink-tertiary">{label}</dt>
      <dd className="text-right text-sm tabular-nums text-ink">{children}</dd>
    </div>
  );
}
