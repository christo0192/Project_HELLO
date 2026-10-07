/**
 * Candidate-facing wording for the R1 terminal and waiting screens.
 *
 * Kept apart from the components so the copy can be reviewed (and checked for
 * promises the product does not make) without reading markup. None of it
 * states a product fact: the product facts live only in the candidate's
 * preparation guide.
 */

export type R1ClosedKind =
  | 'invalid'
  | 'expired'
  | 'cancelled'
  | 'completed'
  | 'paused'
  | 'unavailable'
  | 'withdrawn'
  | 'declined'
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
  unsupported: {
    eyebrow: 'Browser not supported',
    title: 'This browser cannot run the interview',
    body:
      'The interview needs camera, microphone and WebRTC support. Please open your link in '
      + 'a current version of Chrome, Edge or Safari over HTTPS.',
  },
});

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
