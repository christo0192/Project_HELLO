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

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CandidateDetail, Note, Session } from '../../types';
import { Card, Chip } from '../ui';
import { StatusBadge } from '../design';
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
  className = 'p-5 lg:col-span-1',
}: CandidateProfileCardProps) {
  return (
    <Card className={className}>
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
          <dt className="mb-1.5 text-xs font-medium text-ink-secondary">Skills</dt>
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
      {footnote && (
        <p className="mt-5 rounded-lg bg-surface-tertiary p-3 text-xs leading-relaxed text-ink-secondary">
          {footnote}
        </p>
      )}
    </Card>
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
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Screening sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-ink-secondary">{emptyLabel}</p>
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
                      {sessionModeLabel(s.mode).toLowerCase()}
                    </span>
                  )}
                </p>
                <p className="text-xs text-ink-tertiary">
                  {formatDateTime(s.created_at)}
                  {s.duration_sec ? ` · ${formatDurationSec(s.duration_sec)}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <StatusBadge tone={sessionStatusTone(s.status)}>
                  {sessionStatusLabel(s.status)}
                </StatusBadge>
                {linkToSession && (
                  <Link
                    to={`/sessions/${s.id}`}
                    className="text-xs font-medium text-brand-700 hover:text-brand-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 dark:text-brand-300"
                  >
                    View details
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
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
  return (
    <ul className="divide-y divide-line">
      {notes.map((n) => (
        <li key={n.id} className="py-2 text-sm">
          <p className="whitespace-pre-wrap text-ink">{n.note}</p>
          <p className="mt-0.5 text-xs text-ink-tertiary">{formatDateTime(n.created_at)}</p>
        </li>
      ))}
    </ul>
  );
}

/** Decision-use block banner — shown wherever the candidate is under appeal. */
export function DecisionBlockedBanner() {
  return (
    <div
      role="alert"
      className="mb-5 mt-4 rounded-md border border-warning/40 bg-warning-soft p-4"
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
