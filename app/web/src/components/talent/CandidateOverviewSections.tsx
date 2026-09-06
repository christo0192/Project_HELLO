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

import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CandidateDetail, CandidateResumeFacts, Note, Session } from '../../types';
import { ScrollArea, StatusBadge } from '../design';
import { SurfaceCard, Tag } from '../design/candidate';
import {
  candidateStatusLabel,
  candidateStatusTone,
  formatDurationSec,
  sessionStatusLabel,
  sessionStatusTone,
} from './status';
import { formatDateTime } from '../../lib/datetime';
import { sessionModeLabel } from '../../lib/session-mode';

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
  return (
    <SurfaceCard as="section" labelledBy={headingId} className={className}>
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        Profile
      </h2>
      <p className="mb-4 mt-0.5 text-[13px] text-ink-tertiary">
        Identity and skills as parsed from the resume.
      </p>
      <dl className="space-y-3 text-sm">
        <Field label="Phone">
          {candidate.phone_e164 ? (
            <span className="flex items-center gap-1.5">
              {candidate.phone_e164}
              {!candidate.phone_valid && (
                <Tag tone="negative" srPrefix="Phone number:">
                  invalid
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
          <StatusBadge tone={candidateStatusTone(candidate.status)}>
            {candidateStatusLabel(candidate.status)}
          </StatusBadge>
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
        <p className="mt-4 text-[13px] leading-snug text-ink-tertiary">{footnote}</p>
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
  const hasEvidence = recentLabel || prior.length || (facts.career_highlights?.length ?? 0) ||
    (facts.education?.length ?? 0) || (facts.certifications?.length ?? 0) || facts.summary;
  if (!hasEvidence) return null;
  return (
    <div className="mt-5 border-t border-line pt-4">
      <h3 className="mb-3 text-[13px] font-medium text-ink-secondary">Resume evidence</h3>
      <dl className="space-y-3">
        {recentLabel && <Field label="Latest role"><span className="text-right">{recentLabel}</span></Field>}
        {prior.length > 0 && <div><dt className="mb-1 text-xs font-medium text-ink-secondary">Previous roles</dt><dd className="space-y-1 text-sm text-ink">{prior.map((role, i) => <div key={`${role}-${i}`}>{role}</div>)}</dd></div>}
        {listSection('Career highlights', facts.career_highlights)}
        {listSection('Education', facts.education)}
        {listSection('Certifications', facts.certifications)}
        {facts.summary && <div><dt className="mb-1 text-xs font-medium text-ink-secondary">Summary</dt><dd className="text-sm leading-relaxed text-ink">{facts.summary}</dd></div>}
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
      <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
        Screening sessions
      </h2>
      <p className="mb-3 mt-0.5 text-[13px] text-ink-tertiary">
        One row per screening session, as returned by the API.
      </p>
      {sessions.length === 0 ? (
        <p className="text-sm text-ink-secondary">{emptyLabel}</p>
      ) : (
        boundList(
          sessions.length > SESSION_ROWS_BEFORE_SCROLL,
          'Screening session list',
          '18rem',
          <ul className="divide-y divide-line">
            {sessions.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium text-ink">
                    Session {s.id.slice(0, 8)}
                    {s.mode && (
                      <span className="ml-2 text-[12px] font-normal text-ink-tertiary">
                        {sessionModeLabel(s.mode).toLowerCase()}
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] text-ink-tertiary">
                    {formatDateTime(s.created_at)}
                    {s.duration_sec ? ` · ${formatDurationSec(s.duration_sec)}` : ''}
                  </p>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <StatusBadge tone={sessionStatusTone(s.status)}>
                    {sessionStatusLabel(s.status)}
                  </StatusBadge>
                  {linkToSession && (
                    <Link
                      to={`/sessions/${s.id}`}
                      className="text-xs font-medium text-[var(--c-accent)] underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--c-accent)]"
                    >
                      View details
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
  if (error) return <p className="text-sm text-error">{error}</p>;
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
          <p className="mt-0.5 text-[12px] text-ink-tertiary">{formatDateTime(n.created_at)}</p>
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
      <p className="text-sm font-semibold text-warning">
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
