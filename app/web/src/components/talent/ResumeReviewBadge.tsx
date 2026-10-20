/**
 * Resume-review presentation — the ONE place the candidate surfaces turn the
 * server's sanitized `resume_review` enum, and a nullable candidate name, into
 * something a recruiter can read.
 *
 * Two problems, one module, because they are the same problem: an Ashby import
 * creates a PII-minimal candidate shell whose `name`/`email`/`phone` are all
 * null and whose status is `queued`. Before this, such a row rendered as a
 * blank-ish "Unnamed" link with nothing anywhere saying why. It now renders
 * with one neutral, non-identifying title and one badge that says exactly how
 * far its resume got — and nothing else.
 *
 * What deliberately does NOT appear here:
 *   - the nine parse failure codes, scan verdicts and guard rejections
 *     (`failed_review` is projected to `needs_review` server-side already),
 *   - any Ashby/application-link/external id, file handle or operation state,
 *   - any resume content or candidate PII.
 * All of that is operator information and lives in admin-gated Mission
 * Control. Recovery is admin-only too, so there is no retry affordance here.
 *
 * Colour: `StatusBadge`'s tones resolve to the approved candidate palette
 * inside `.candidate-scope` (src/styles/candidate-palette.css), so this file
 * declares no colour of its own. Distinction is never hue-only — each state
 * spells out its own meaning in words, and `needs_review` additionally
 * carries more weight than its siblings.
 *
 * M017 adds the intake type ("Resume parsing" / "Phone parsing") beside it,
 * and the words for the Ashby profile check's outcome, for the same reason:
 * one module owns how a candidate's path in is said.
 */

import { StatusBadge } from '../design';
import type { StatusTone } from '../design/StatusBadge';
import type { AshbyProfileOutcome, IntakeType, ResumeReview } from '../../types';

/**
 * The neutral title of a candidate whose identity has not been parsed yet.
 *
 * Exact, shared copy: the list link, the Candidate Detail header and the
 * Ashby-scoped header all say this and nothing else. It states the situation
 * without fabricating a person ("Unnamed" implied a parsed candidate who had
 * no name; this one has not been parsed at all).
 */
export const CANDIDATE_SHELL_TITLE = 'Awaiting resume details';

/**
 * Safe display name for a possibly-null candidate name. Blank strings are
 * treated as absent — a whitespace-only name is not an identity either.
 */
export function candidateDisplayName(name: string | null | undefined): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || CANDIDATE_SHELL_TITLE;
}

/** Canonical order for resume-review facets (matches the ingestion journey). */
export const RESUME_REVIEW_ORDER = [
  'processing',
  'needs_review',
  'cancelled',
] as const;

export type ResumeReviewKey = (typeof RESUME_REVIEW_ORDER)[number];

/**
 * The three states that get a visible badge.
 *
 * `ready` and `null` are deliberately quiet: "the resume parsed" and "this
 * candidate has no Ashby resume at all" are the unremarkable majority of the
 * list, and a badge on every row would be noise, not information.
 */
const LABELS: Record<ResumeReviewKey, string> = {
  processing: 'Resume processing',
  needs_review: 'Resume needs review',
  cancelled: 'Resume cancelled',
};

const TONES: Record<ResumeReviewKey, StatusTone> = {
  processing: 'info',
  needs_review: 'warning',
  cancelled: 'neutral',
};

/** True when the value is one of the three states that render a badge. */
export function isBadgedResumeReview(
  value: string | null | undefined,
): value is ResumeReviewKey {
  return value === 'processing' || value === 'needs_review' || value === 'cancelled';
}

/**
 * Human label for a resume-review value, or null when the state is one of the
 * intentionally quiet ones (`ready`, `null`, or anything unrecognized).
 */
export function resumeReviewLabel(value: string | null | undefined): string | null {
  return isBadgedResumeReview(value) ? LABELS[value] : null;
}

export interface ResumeReviewBadgeProps {
  value: ResumeReview | null | undefined;
  className?: string;
}

/** The resume-review badge. Renders nothing for `ready`/`null`. */
export function ResumeReviewBadge({ value, className }: ResumeReviewBadgeProps) {
  if (!isBadgedResumeReview(value)) return null;
  return (
    <StatusBadge
      tone={TONES[value]}
      className={
        value === 'needs_review'
          ? className
            ? `font-semibold ${className}`
            : 'font-semibold'
          : className
      }
    >
      {LABELS[value]}
    </StatusBadge>
  );
}

/** Canonical order for the intake facet: the resume path first. */
export const INTAKE_TYPE_ORDER = ['resume_parsing', 'phone_parsing'] as const;

/**
 * Both values get a badge. Unlike resume review there is no quiet majority:
 * the badge exists to say which way the candidate came in.
 */
const INTAKE_LABELS: Record<IntakeType, string> = {
  resume_parsing: 'Resume parsing',
  phone_parsing: 'Phone parsing',
};

/** True when the value is one of the two intake types. */
export function isIntakeType(value: string | null | undefined): value is IntakeType {
  return value === 'resume_parsing' || value === 'phone_parsing';
}

/** Human label for an intake type, or null for null/absent/unrecognized. */
export function intakeTypeLabel(value: string | null | undefined): string | null {
  return isIntakeType(value) ? INTAKE_LABELS[value] : null;
}

export interface IntakeBadgeProps {
  value: IntakeType | null | undefined;
  className?: string;
}

/**
 * The intake badge. One neutral tone for both values, so they are told apart
 * by their words alone, and no dot: an intake path is a fact about the
 * candidate, not a status. Renders nothing for null — an older API, or a
 * candidate with neither an Ashby link nor an upload — or an unknown value.
 */
export function IntakeBadge({ value, className }: IntakeBadgeProps) {
  if (!isIntakeType(value)) return null;
  return (
    <StatusBadge tone="neutral" dot={false} className={className}>
      {INTAKE_LABELS[value]}
    </StatusBadge>
  );
}

/**
 * What the last Ashby profile check did, in a recruiter's words, for every
 * value of the closed `profile_outcome` vocabulary. Rendered beside the raw
 * code (one hover away) on the Ashby card and in Ashby Live Jobs; an unknown
 * future value falls back to its own words through `humanizeEnum`.
 */
export const PROFILE_OUTCOME_LABELS: Readonly<Record<AshbyProfileOutcome, string>> = {
  applied: 'Ashby number applied',
  number_invalid: 'No valid Indian mobile in Ashby',
  number_placeholder: 'Placeholder number in Ashby',
  number_shared: 'Number belongs to another candidate',
  name_missing: 'No usable name in Ashby',
  resume_found: 'Resume found — resume parsing',
  resume_shape_unknown: 'Could not read resume status from Ashby',
  stage_moved: 'Left the AI screening stage',
  application_inactive: 'Application not active in Ashby',
  mapping_inactive: 'Job not enabled for phone screening',
  subject_request_hold: 'On hold: data request',
  engagement_active: 'Call already in progress',
  not_applicable: 'No change needed',
  ashby_unavailable: 'Ashby unavailable — will retry',
  identity_unconfirmed: 'Wrong person answered the Ashby number',
  application_terminal: 'Application closed',
  candidate_missing: 'Candidate record missing',
};
