/**
 * CandidateOverviewSections — the presentational pieces of the candidate
 * Overview tab, extracted so the full recruiter workspace
 * (`CandidateDetailPage`) and the candidate-scoped Ashby review experience
 * (`AshbyScopedReviewPage`) render the SAME content instead of two drifting
 * copies.
 *
 * Every piece here is read-only and prop-driven. Anything that acts — starting
 * a call, adding a note, issuing an appeal grant, exporting CSV — deliberately
 * stays on the full workspace page: the scoped experience is a reading surface
 * and must not grow actions or cross-links out of its candidate.
 *
 * `SessionsSummary` takes `linkToSession` because the scoped shell has no
 * global navigation: a "View details" link there would be a backlink into the
 * unscoped app, which the scoped route must not offer.
 */

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CandidateDetail, CandidatePhoneAttempt, CandidateResumeFacts, MembershipRole, Note, Session } from '../../types';
import { api } from '../../api';
import { ScrollArea, StatusBadge } from '../design';
import { SurfaceCard, Tag } from '../design/candidate';
import { usePhoneAttemptHistory } from './usePhoneAttemptHistory';
import type { PhoneAttemptHistorySource } from './usePhoneAttemptHistory';
import {
  attemptOutcomeLabel,
  attemptRawStatus,
  candidateDisplayStatus,
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
} from './status';
import { formatDateTime } from '../../lib/datetime';
import { formatPhone } from '../../lib/humanize';
import { sessionModeLabel } from '../../lib/session-mode';

/** The quiet inline action style shared by every row link/button here. */
const ROW_ACTION =
  'rounded-sm text-xs font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)] disabled:cursor-wait disabled:opacity-60';

/** One label/value row inside the profile definition list. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-xs font-medium text-ink-secondary">{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

/**
 * Rows past these counts scroll inside the card instead of growing it. The
 * left rail of the Overview is sticky, so an unbounded list would push its
 * own card past the viewport and take the rail's scroll with it.
 *
 * The region is named differently from the card that contains it: both are
 * `region` landmarks, and two landmarks sharing a role AND an accessible
 * name is an axe `landmark-unique` violation.
 */
const SESSION_ROWS_BEFORE_SCROLL = 5;
const NOTE_ROWS_BEFORE_SCROLL = 4;

/** One attempt's inline audio: what the open row is showing. */
type AttemptAudio =
  | { attemptId: string; status: 'loading' }
  | { attemptId: string; status: 'ready'; url: string }
  | { attemptId: string; status: 'error'; message: string; retryable: boolean };

/**
 * A refused mint, in a recruiter's words. The download route answers 409 for
 * a recording still processing or quarantined, 403 for a deleted attempt or a
 * revoked parent, 404 for a missing or purged one, and 429 past the strict
 * per-user recordings bucket.
 */
function attemptAudioError(cause: unknown): { message: string; retryable: boolean } {
  const status = typeof (cause as { status?: unknown } | null)?.status === 'number'
    ? (cause as { status: number }).status
    : 0;
  const text = cause instanceof Error ? cause.message : '';
  if (status === 409) {
    return /process/i.test(text)
      ? { message: 'Recording is still processing. Try again shortly.', retryable: true }
      : { message: 'Recording withheld: it failed an integrity check.', retryable: false };
  }
  if (status === 403) {
    return { message: 'Recording unavailable: it was deleted or access was withdrawn.', retryable: false };
  }
  if (status === 404) return { message: 'Recording no longer available.', retryable: false };
  if (status === 429) {
    return { message: 'Too many recording requests. Wait a moment, then try again.', retryable: true };
  }
  return { message: "Couldn't load the recording.", retryable: true };
}

/** Why a listed recording cannot be played. */
function unavailableRecordingLabel(reason: CandidatePhoneAttempt['recording']['reason']): string {
  switch (reason) {
    case 'access_unavailable':
      return 'Recording access unavailable';
    case 'recording_failed':
      return 'Recording unavailable (capture failed)';
    case 'quarantined':
      return 'Recording withheld (failed integrity check)';
    case 'deleted':
      return 'Recording deleted';
    case 'revoked':
      return 'Recording withdrawn';
    default:
      return 'No recording available';
  }
}

/**
 * Per-dial evidence, with an inline player for every recorded leg —
 * including calls that ended at or before the consent step, whose audio the
 * worker keeps from the start of the call (0105, 2026-09-26 decision).
 *
 * The signed URL is minted ONLY from an explicit "Play recording" click,
 * through the existing attempt download route (role/ownership, lifecycle,
 * integrity re-verification and a `recording.download` audit with
 * `pre_consent`). It lives only in this component's state for the open row:
 * the history payload never carries one, nothing logs or stores it, and
 * closing the row (or opening another) discards it. `preload="none"`.
 */
export function PhoneAttemptHistory({
  candidateId,
  role,
  source,
  title = 'Call attempts',
  description = 'Every phone leg and its recording, including calls that ended at the consent step.',
}: {
  candidateId: string;
  role: MembershipRole;
  /** A shared list from `usePhoneAttemptHistory`; omit to load one here. */
  source?: PhoneAttemptHistorySource;
  title?: string;
  description?: string;
}) {
  const headingId = useId();
  const playerBaseId = useId();
  const own = usePhoneAttemptHistory(candidateId, !source);
  const { attempts, nextCursor, error, reload, loadOlder } = source ?? own;

  const [audio, setAudio] = useState<AttemptAudio | null>(null);
  const audioGeneration = useRef(0);
  const mountedRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  // Position and play state carried across a "Refresh link" re-mint.
  const resumeRef = useRef<{ time: number; playing: boolean } | null>(null);
  // The player's progress for a screen reader. ALWAYS mounted (a live region
  // inserted together with its text is often not announced) and written on
  // each step. Focus stays on the toggle, which controls the player: moving
  // it to the <audio> once the asynchronous mint lands would pull it away
  // from wherever the user had gone meanwhile. Errors use the row's alert.
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A different candidate never inherits an open player or a late response.
  useEffect(() => {
    audioGeneration.current += 1;
    resumeRef.current = null;
    setAudio(null);
    setAnnouncement('');
  }, [candidateId]);

  const canPlay = typeof api.getAttemptRecordingDownloadUrl === 'function';

  const mint = useCallback((attemptId: string) => {
    const gen = ++audioGeneration.current;
    setAudio({ attemptId, status: 'loading' });
    setAnnouncement('Loading recording');
    Promise.resolve()
      .then(() => api.getAttemptRecordingDownloadUrl(attemptId))
      .then((result) => {
        if (!mountedRef.current || gen !== audioGeneration.current) return;
        setAudio({ attemptId, status: 'ready', url: result.url });
        setAnnouncement('Recording ready. The player follows this button.');
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current || gen !== audioGeneration.current) return;
        resumeRef.current = null;
        setAudio({ attemptId, status: 'error', ...attemptAudioError(cause) });
        setAnnouncement('');
      });
  }, []);

  function toggle(attemptId: string) {
    if (audio?.attemptId === attemptId) {
      // Closing discards the URL and ignores any mint still in flight.
      audioGeneration.current += 1;
      resumeRef.current = null;
      setAudio(null);
      setAnnouncement('');
      return;
    }
    resumeRef.current = null;
    mint(attemptId);
  }

  function refresh(attemptId: string) {
    const el = audioRef.current;
    resumeRef.current = el ? { time: el.currentTime, playing: !el.paused } : null;
    mint(attemptId);
  }

  const readyUrl = audio?.status === 'ready' ? audio.url : null;
  // Once a freshly minted URL is on the <audio> after a refresh, restore its
  // position and play state. Never autoplays on open: the gesture is gone
  // after the async mint.
  useEffect(() => {
    const el = audioRef.current;
    if (!readyUrl || !el) return;
    const resume = resumeRef.current;
    if (!resume) return;
    resumeRef.current = null;
    const restore = () => {
      try {
        if (resume.time > 0.1) el.currentTime = resume.time;
      } catch {
        /* not seekable yet */
      }
      if (resume.playing) el.play().catch(() => {});
    };
    if (el.readyState >= 1) restore();
    else {
      el.addEventListener('loadedmetadata', restore, { once: true });
      try {
        el.load();
      } catch {
        /* preload="none" kick; ignore where unsupported */
      }
    }
  }, [readyUrl]);

  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        {title}
      </h2>
      <p className="mb-3 mt-0.5 text-label text-ink-tertiary">{description}</p>
      {/* aria-live rather than role="status": the page already has status
          regions of its own, and this one only narrates the player. */}
      <p aria-live="polite" aria-atomic="true" data-player-announcer="" className="sr-only">
        {announcement}
      </p>
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-ink-secondary">Attempt history unavailable.</p>
          <button type="button" className={ROW_ACTION} onClick={reload}>Retry</button>
        </div>
      ) : attempts === null ? (
        <p className="text-sm text-ink-tertiary">Loading attempt history…</p>
      ) : attempts.length === 0 ? (
        <p className="text-sm text-ink-secondary">No phone call attempts yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {attempts.map((attempt) => {
            const open = audio?.attemptId === attempt.id ? audio : null;
            const playerId = `${playerBaseId}-player-${attempt.id}`;
            const recorded = attempt.recording.state !== 'unavailable';
            const preConsent = recorded && attempt.consent_stage === 'before_consent';
            const recordingName = `Attempt ${attempt.attempt_seq} recording`;
            return (
              <li key={attempt.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
                  <div className="min-w-0">
                    {/* The OUTCOME in a recruiter's words, beside the attempt
                        number, because it is what they act on ("No answer",
                        "Hung up before the recording notice"). The machine
                        pair stays one hover away for an operator to quote. */}
                    <p className="text-ink">
                      <span className="font-medium">Attempt {attempt.attempt_seq}</span>
                      <span aria-hidden="true" className="text-ink-tertiary"> · </span>
                      <span
                        className="text-ink-secondary"
                        title={attemptRawStatus(attempt.outcome_class, attempt.state, attempt.abandon_reason)}
                      >
                        {attemptOutcomeLabel(attempt.outcome_class, attempt.state, attempt.abandon_reason)}
                      </span>
                    </p>
                    <p className="text-meta tabular-nums text-ink-tertiary">
                      {formatDateTime(attempt.admitted_at)}
                      {attempt.duration_sec != null && attempt.duration_sec > 0
                        ? ` · ${formatDurationSec(attempt.duration_sec)}`
                        : ''}
                    </p>
                    {preConsent && (
                      <p className="mt-1">
                        <Tag tone="caution">Recorded before consent</Tag>
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                    {attempt.recording.state === 'processing' && (
                      <span className="text-xs text-ink-tertiary">Recording processing</span>
                    )}
                    {/* A processing clip gets the click too: for a worker gate
                        clip whose finalize never completed, an explicit mint
                        is the route's bounded recovery path (it re-runs the
                        verifier and answers a retryable 409 while still not
                        ready). */}
                    {(attempt.recording.state === 'ready' || attempt.recording.state === 'processing') && canPlay ? (
                      <button
                        type="button"
                        className={ROW_ACTION}
                        aria-expanded={open !== null}
                        aria-controls={open ? playerId : undefined}
                        onClick={() => toggle(attempt.id)}
                      >
                        {open
                          ? 'Hide player'
                          : attempt.recording.state === 'processing' ? 'Try to load recording' : 'Play recording'}
                      </button>
                    ) : attempt.recording.state !== 'unavailable' ? null : (
                      <span className="text-xs text-ink-tertiary">
                        {unavailableRecordingLabel(attempt.recording.reason)}
                      </span>
                    )}
                    {attempt.transcript && (
                      <Link
                        to={attempt.transcript.href}
                        className={ROW_ACTION}
                      >
                        {attempt.transcript.kind === 'gate_only' ? 'Pre-interview gate transcript' : 'Session transcript'}
                      </Link>
                    )}
                  </div>
                </div>
                {open && (
                  <div
                    id={playerId}
                    role="group"
                    aria-label={recordingName}
                    className="mt-2 space-y-1.5"
                  >
                    {open.status === 'loading' ? (
                      <p className="text-meta text-ink-tertiary">Loading recording…</p>
                    ) : open.status === 'error' ? (
                      <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <p className="text-meta text-ink-secondary">{open.message}</p>
                        {open.retryable && (
                          <button type="button" className={ROW_ACTION} onClick={() => mint(attempt.id)}>
                            Try again
                          </button>
                        )}
                      </div>
                    ) : (
                      <>
                        <audio
                          ref={audioRef}
                          controls
                          preload="none"
                          src={open.url}
                          className="h-9 w-full"
                          aria-label={recordingName}
                        />
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          <a href={open.url} download className={ROW_ACTION}>
                            Download file
                          </a>
                          <button type="button" className={ROW_ACTION} onClick={() => refresh(attempt.id)}>
                            Refresh link
                          </button>
                        </div>
                      </>
                    )}
                    {preConsent && (
                      <p className="text-meta text-ink-tertiary">
                        Recorded before the candidate consented and kept under the
                        2026-09-26 retention decision. Every playback is logged.
                      </p>
                    )}
                  </div>
                )}
                {attempt.transcript?.kind === 'gate_only' && (
                  <p className="mt-1 text-meta text-ink-secondary">
                    Gate-only evidence: identity and recording-consent exchange before the interview.
                  </p>
                )}
                {attempt.transcript?.shared_session && (
                  <p className="mt-1 text-meta text-ink-tertiary">
                    This session transcript may include multiple call legs; it is not an attempt-only transcript.
                  </p>
                )}
                {role === 'interviewer' && attempt.recording.reason === 'access_unavailable' && (
                  <p className="mt-1 text-meta text-ink-tertiary">
                    Audio access is available only when the associated session has an owner you own.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {attempts && nextCursor && !error && (
        <button
          type="button"
          className={`mt-3 ${ROW_ACTION}`}
          onClick={loadOlder}
        >
          Load older attempts
        </button>
      )}
    </SurfaceCard>
  );
}

function boundList(bounded: boolean, label: string, maxHeight: string, list: ReactNode): ReactNode {
  if (!bounded) return list;
  return (
    <ScrollArea maxHeight={maxHeight} label={label} className="-my-1">
      {list}
    </ScrollArea>
  );
}

export interface CandidateProfileCardProps {
  candidate: CandidateDetail['candidate'];
  /** Optional trailing note (the full workspace explains its live actions). */
  footnote?: ReactNode;
  className?: string;
}

/** Identity/profile card — phone, experience, status and parsed skills. */
export function CandidateProfileCard({
  candidate,
  footnote,
  className = 'p-4 sm:p-5 lg:col-span-1',
}: CandidateProfileCardProps) {
  const headingId = useId();
  const displayStatus = candidateDisplayStatus(candidate);
  return (
    <SurfaceCard as="section" labelledBy={headingId} className={className}>
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        Profile
      </h2>
      <p className="mb-4 mt-0.5 text-label text-ink-tertiary">
        Identity and skills as parsed from the resume.
      </p>
      {/* SUMMARY FIRST, ABOVE THE NUMBERS. The ask was to put it "above the
          numbers and experience, because summary is the thing the manager
          cares to see often". An earlier pass moved it only to the top of the
          Resume-evidence list further down, which left it below Phone,
          Experience, Status and Skills — i.e. below exactly the numbers it was
          asked to clear. It sits above the whole field list now, and
          `ResumeEvidence` no longer repeats it. */}
      {candidate.parsed?.summary && (
        <div data-candidate-summary="" className="mb-4">
          <h3 className="mb-1 text-xs font-medium text-ink-secondary">Summary</h3>
          <p className="text-sm leading-relaxed text-ink">{candidate.parsed.summary}</p>
        </div>
      )}

      <dl className="space-y-3 text-sm">
        <Field label="Phone">
          {candidate.phone_e164 ? (
            <span className="flex items-center gap-1.5">
              {/* Grouped the way people read a number aloud; the stored E.164
                  value stays one hover away for an operator to paste. */}
              <span className="whitespace-nowrap tabular-nums" title={candidate.phone_e164}>
                {formatPhone(candidate.phone_e164)}
              </span>
              {!candidate.phone_valid && (
                <Tag tone="negative" srPrefix="Phone number:">
                  Invalid
                </Tag>
              )}
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
          {/* The same derivation as the header and the list row. */}
          <span className="flex flex-col items-end gap-0.5 text-right">
            <StatusBadge tone={displayStatus.tone}>
              <span title={displayStatus.title}>{displayStatus.label}</span>
            </StatusBadge>
            {/* Visible, not hover-only: the reason, count and last dial. */}
            {displayStatus.detail && (
              <span className="text-meta text-ink-tertiary">{displayStatus.detail}</span>
            )}
          </span>
        </Field>
        <div>
          <dt className="mb-1.5 text-xs font-medium text-ink-secondary">Skills</dt>
          <dd className="flex flex-wrap gap-1.5">
            {candidate.skills.length === 0 ? (
              <span className="text-ink-tertiary">None parsed</span>
            ) : (
              candidate.skills.map((s) => (
                <Tag key={s} tone="accent" srPrefix="Skill:">
                  {s}
                </Tag>
              ))
            )}
          </dd>
        </div>
      </dl>
      <ResumeEvidence facts={candidate.parsed} />
      {footnote && (
        <p className="mt-4 text-label leading-snug text-ink-tertiary">{footnote}</p>
      )}
    </SurfaceCard>
  );
}

function ResumeEvidence({ facts }: { facts?: CandidateResumeFacts | null }) {
  if (!facts) return null;
  const recent = facts.recent_role;
  const recentLabel = recent
    ? [recent.title, recent.employer, recent.period].filter(Boolean).join(' · ')
    : facts.current_role;
  const prior = (facts.prior_roles ?? []).map((role) =>
    [role.title, role.employer, role.period].filter(Boolean).join(' · '),
  ).filter(Boolean);
  const listSection = (label: string, values?: string[]) => values && values.length > 0 ? (
    <div>
      <dt className="mb-1 text-xs font-medium text-ink-secondary">{label}</dt>
      <dd className="text-sm leading-relaxed text-ink">{values.join(' · ')}</dd>
    </div>
  ) : null;
  // `facts.summary` is NOT counted: it renders above the field list at the top
  // of the card now, not in this section. Leaving it in the predicate gave a
  // candidate whose parse yielded only a summary a "Resume evidence" heading
  // and a rule above an empty list.
  const hasEvidence = recentLabel || prior.length || (facts.career_highlights?.length ?? 0) ||
    (facts.education?.length ?? 0) || (facts.certifications?.length ?? 0);
  if (!hasEvidence) return null;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="mb-3 text-label font-medium text-ink-secondary">Resume evidence</h3>
      <dl className="space-y-3 text-sm">
        {/* Summary is NOT repeated here — it renders above the field list at
            the top of this card, which is what "above the numbers and
            experience" asked for. */}
        {recentLabel && <Field label="Latest role"><span className="text-right">{recentLabel}</span></Field>}
        {prior.length > 0 && <div><dt className="mb-1 text-xs font-medium text-ink-secondary">Previous roles</dt><dd className="space-y-1 text-sm text-ink">{prior.map((role, i) => <div key={`${role}-${i}`}>{role}</div>)}</dd></div>}
        {listSection('Career highlights', facts.career_highlights)}
        {listSection('Education', facts.education)}
        {listSection('Certifications', facts.certifications)}
      </dl>
    </div>
  );
}

export interface SessionsSummaryProps {
  sessions: Session[];
  /**
   * Render the per-session "View details" link. False in the scoped shell,
   * which offers no navigation out of the linked candidate.
   */
  linkToSession?: boolean;
  /** Copy shown when the candidate has no sessions yet. */
  emptyLabel?: string;
}

/** Compact screening-session list (newest first, as loaded). */
export function SessionsSummary({
  sessions,
  linkToSession = true,
  emptyLabel = 'No screening sessions yet. Start one above.',
}: SessionsSummaryProps) {
  const headingId = useId();
  return (
    <SurfaceCard as="section" labelledBy={headingId} className="p-4 sm:p-5">
      <h2 id={headingId} className="mb-3 text-[15px] font-semibold tracking-tight text-ink">
        Screening sessions
      </h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-ink-secondary">{emptyLabel}</p>
      ) : (
        boundList(
          sessions.length > SESSION_ROWS_BEFORE_SCROLL,
          'Screening session list',
          '18rem',
          <ul className="divide-y divide-line">
            {sessions.map((s, index) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
              >
                <div className="min-w-0">
                  {/* Numbered in the order they happened (the list arrives
                      newest first), never by id: a uuid prefix as the row's
                      name is a database leaking onto the page. The id stays
                      in `title` for support. */}
                  <p className="truncate font-medium text-ink" title={`Session id ${s.id}`}>
                    Session {sessions.length - index}
                    {s.mode && (
                      <span className="ml-2 text-meta font-normal text-ink-tertiary">
                        {sessionModeLabel(s.mode).toLowerCase()}
                      </span>
                    )}
                  </p>
                  <p className="text-meta text-ink-tertiary">
                    {formatDateTime(s.created_at)}
                    {s.duration_sec ? ` · ${formatDurationSec(s.duration_sec)}` : ''}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <StatusBadge tone={sessionStatusTone(s.status)}>
                    {sessionStatusLabel(s.status)}
                  </StatusBadge>
                  {linkToSession && (
                    <Link to={`/sessions/${s.id}`} className={ROW_ACTION}>
                      View details
                      <span className="sr-only"> for session {sessions.length - index}</span>
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>,
        )
      )}
    </SurfaceCard>
  );
}

export interface NotesListProps {
  /** null = still loading. */
  notes: Note[] | null;
  error?: string | null;
}

/** Append-only recruiter notes, read-only. */
export function NotesList({ notes, error = null }: NotesListProps) {
  if (error) return <p className="text-sm text-error-text">{error}</p>;
  if (notes === null) return <p className="text-sm text-ink-tertiary">Loading notes…</p>;
  if (notes.length === 0) return <p className="text-sm text-ink-secondary">No notes yet.</p>;
  return boundList(
    notes.length > NOTE_ROWS_BEFORE_SCROLL,
    'Note history',
    '16rem',
    <ul className="divide-y divide-line">
      {notes.map((n) => (
        <li key={n.id} className="py-2 text-sm">
          <p className="whitespace-pre-wrap text-ink">{n.note}</p>
          <p className="mt-0.5 text-meta text-ink-tertiary">{formatDateTime(n.created_at)}</p>
        </li>
      ))}
    </ul>,
  );
}

/** Decision-use block banner — shown wherever the candidate is under appeal. */
export function DecisionBlockedBanner() {
  return (
    <div
      role="alert"
      className="mb-5 mt-4 rounded-card border border-warning bg-warning-soft p-4"
    >
      <p className="text-sm font-semibold text-warning-text">
        Decision use is paused — open appeal
      </p>
      <p className="mt-1 text-sm text-ink-secondary">
        An appeal is under review. Automated recommendations and status
        automation are hidden until a human reviewer resolves it. The existing
        status is preserved.
      </p>
    </div>
  );
}
