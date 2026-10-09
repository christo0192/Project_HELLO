/**
 * Candidate-facing wording for the R1 terminal and waiting screens.
 *
 * Kept apart from the components so the copy can be reviewed (and checked for
 * promises the product does not make) without reading markup. None of it
 * states a product fact: the three course facts on the role-play card live in
 * r1-scenario.ts, where a test keeps them equal to the interviewer's and the
 * scorer's, and everything else lives only in the candidate's preparation guide.
 *
 * Two audiences read these screens: a candidate, and a member of staff on an internal
 * dry run. The staff consent notice says no decision is made about them and to tell the
 * project team, so every screen that speaks of a hiring team, a review, a contest or a
 * conversation with a person has a staff wording (`closedCopyFor`, `endedCopyFor`,
 * `reviewNoteFor`). The candidate wording is the default and the stricter of the two.
 */

import type { R1Audience } from '../../lib/r1/r1-api';

export type R1ClosedKind =
  | 'invalid'
  | 'expired'
  | 'cancelled'
  | 'completed'
  | 'paused'
  | 'unavailable'
  | 'withdrawn'
  | 'declined'
  | 'starts_exhausted'
  | 'unsupported';

export interface ClosedCopy {
  eyebrow: string;
  title: string;
  body: string;
}

export const R1_CLOSED_COPY: Readonly<Record<R1ClosedKind, ClosedCopy>> = Object.freeze({
  invalid: {
    eyebrow: 'Unable to continue',
    title: 'We could not open this link',
    body:
      'This link is missing, damaged or no longer valid. Use the link from your email '
      + 'exactly as it was sent, or contact the hiring team.',
  },
  expired: {
    eyebrow: 'Link expired',
    title: 'This interview link has expired',
    body: 'Contact the hiring team and they can send you a new link.',
  },
  cancelled: {
    eyebrow: 'Link closed',
    title: 'This interview link was cancelled',
    body: 'Contact the hiring team if you think this is a mistake.',
  },
  completed: {
    eyebrow: 'Interview complete',
    title: 'Your interview is already complete',
    body: 'Thank you. The hiring team will review it and get back to you.',
  },
  paused: {
    eyebrow: 'Temporarily unavailable',
    title: 'We cannot start interviews right now',
    body: 'Your link stays valid. Please try again later.',
  },
  unavailable: {
    eyebrow: 'Temporarily unavailable',
    title: 'The interview service is unavailable',
    body: 'Please try again in a few minutes. Your link stays valid.',
  },
  withdrawn: {
    eyebrow: 'Consent withdrawn',
    title: 'We have recorded your withdrawal',
    body:
      'No interview will be held with this link. The hiring team will be in touch about '
      + 'another way to take this interview.',
  },
  declined: {
    eyebrow: 'Consent declined',
    title: 'This interview cannot start without your consent',
    body:
      'We have recorded your choice. The hiring team will be in touch to arrange a '
      + 'conversation with a person instead.',
  },
  starts_exhausted: {
    eyebrow: 'No starts left',
    title: 'This link cannot start another interview',
    body: 'Every start this link allows has been used. Please contact the hiring team.',
  },
  unsupported: {
    eyebrow: 'Browser not supported',
    title: 'This browser cannot run the interview',
    body:
      'The interview needs camera, microphone and WebRTC support. Please open your link in '
      + 'a current version of Chrome, Edge or Safari over HTTPS.',
  },
});

/**
 * The same screens for a staff dry run. Only the screens that name a team, promise a review
 * or a follow-up differ; the rest are the candidate wording unchanged.
 */
export const R1_STAFF_CLOSED_COPY: Readonly<Record<R1ClosedKind, ClosedCopy>> = Object.freeze({
  ...R1_CLOSED_COPY,
  invalid: {
    ...R1_CLOSED_COPY.invalid,
    body:
      'This link is missing, damaged or no longer valid. Use the link from your email '
      + 'exactly as it was sent, or tell the project team.',
  },
  expired: {
    ...R1_CLOSED_COPY.expired,
    body: 'Tell the project team and they can send you a new link.',
  },
  cancelled: {
    ...R1_CLOSED_COPY.cancelled,
    body: 'Tell the project team if you think this is a mistake.',
  },
  completed: {
    ...R1_CLOSED_COPY.completed,
    body:
      'Thank you. The project team will review it. It is not used to make any decision '
      + 'about you.',
  },
  withdrawn: {
    ...R1_CLOSED_COPY.withdrawn,
    body:
      'No interview will be held with this link. Tell the project team if you would like '
      + 'to try again.',
  },
  declined: {
    ...R1_CLOSED_COPY.declined,
    body: 'We have recorded your choice. Please tell the project team.',
  },
  starts_exhausted: {
    ...R1_CLOSED_COPY.starts_exhausted,
    body: 'Every start this link allows has been used. Please tell the project team.',
  },
});

export function closedCopyFor(kind: R1ClosedKind, audience: R1Audience): ClosedCopy {
  return (audience === 'staff' ? R1_STAFF_CLOSED_COPY : R1_CLOSED_COPY)[kind];
}

export type R1EndedKind = 'agent_ended' | 'aborted' | 'left' | 'disconnected';


export interface EndedCopy extends ClosedCopy {
  /**
   * Offer "Rejoin interview". Only for an ending the candidate did not choose or may
   * regret: the 90 second rejoin (plan sections 5.11 and 7.10) is taken from the same
   * tab, because the link fragment was removed from the address bar when the page opened.
   */
  rejoin: boolean;
  /** Say that an AI helps evaluate the interview and how to contest the result. */
  review: boolean;
}

export const R1_ENDED_COPY: Readonly<Record<R1EndedKind, EndedCopy>> = Object.freeze({
  agent_ended: {
    eyebrow: 'Interview complete',
    title: 'Your interview is complete.',
    body: 'Thank you for your time. The hiring team will review it and get back to you.',
    rejoin: false,
    review: true,
  },
  aborted: {
    eyebrow: 'Interview stopped',
    title: 'Your interview was stopped because of a technical problem.',
    body:
      'This will not count against you. The hiring team will send you a new link, so there '
      + 'is nothing more you need to do.',
    rejoin: false,
    review: false,
  },
  left: {
    eyebrow: 'Interview closed',
    title: 'You left the interview.',
    body: 'If this was a mistake, select Rejoin within 90 seconds and keep this tab open.',
    rejoin: true,
    review: true,
  },
  disconnected: {
    eyebrow: 'Connection lost',
    title: 'The connection to your interview ended.',
    body:
      'If this was not intended, select Rejoin within 90 seconds and keep this tab open. '
      + 'Otherwise the hiring team will be in touch.',
    rejoin: true,
    review: true,
  },
});

/** The same endings for a staff dry run (see `R1_STAFF_CLOSED_COPY`). */
export const R1_STAFF_ENDED_COPY: Readonly<Record<R1EndedKind, EndedCopy>> = Object.freeze({
  ...R1_ENDED_COPY,
  agent_ended: {
    ...R1_ENDED_COPY.agent_ended,
    body: 'Thank you for your time. The project team will review it.',
  },
  aborted: {
    ...R1_ENDED_COPY.aborted,
    body: 'Tell the project team and they can send you a new link.',
  },
  disconnected: {
    ...R1_ENDED_COPY.disconnected,
    body:
      'If this was not intended, select Rejoin within 90 seconds and keep this tab open. '
      + 'Otherwise tell the project team.',
  },
});

export function endedCopyFor(kind: R1EndedKind, audience: R1Audience): EndedCopy {
  return (audience === 'staff' ? R1_STAFF_ENDED_COPY : R1_ENDED_COPY)[kind];
}

/** The note under an ending that was reviewed: what evaluates it, and how to contest. */
export function reviewNoteFor(audience: R1Audience): string {
  return audience === 'staff'
    ? 'An AI helps evaluate this dry run and the project team reviews the result. It is not '
      + 'used to make any decision about you.'
    : 'An AI helps evaluate this interview and the hiring team reviews the result. To contest '
      + 'the result, reply to the hiring team\u2019s email and they will send you an appeal link.';
}

/**
 * The question asked before consent is taken back, by where the person is when they ask it.
 * `before` is the landing page, where the interview has not begun; `live` is mid-interview;
 * `after` is every other screen the link can show (closed or over), where no interview is
 * left to go ahead and the choice is final on this page.
 */
export const R1_WITHDRAW_QUESTIONS = Object.freeze({
  before: 'Withdraw your consent? Your interview cannot go ahead without it.',
  live: 'Withdraw your consent? This ends your interview now and it cannot be rejoined.',
  after:
    'Withdraw your consent? No interview will be held with this link, and this cannot be '
    + 'undone from this page.',
});

/** The question asked before a candidate who has not agreed says no. */
export const R1_DECLINE_QUESTION =
  'Decline the interview? No interview will be held with this link.';

/**
 * The "I'm ready" button: its label, the two outcomes, and what to do when it fails. The spoken
 * "ready" always works, so a failure sends the candidate back to it rather than blocking them.
 */
export const R1_READY_COPY = Object.freeze({
  button: "I'm ready",
  sending: 'Sending…',
  sent: 'Sent — starting the role-play',
  failed: "We couldn't send that. Just say “I'm ready”.",
});
