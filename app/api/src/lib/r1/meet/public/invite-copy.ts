/**
 * The words of Lexy's calendar invite for a public R1 booking (M035 S05, dark): the event summary
 * S06 creates the event with, and the plain-text description the `calendar_sync` job writes on
 * every invite or move send.
 *
 * What the description says: how to join (the Meet button of the invite, a laptop or a phone with
 * Chrome, no Google account needed), that the interviewer is an AI and the call is recorded, the
 * candidate's personal manage link (move, cancel or withdraw; it works until the interview ends),
 * and where to ask for help (a reply to the hiring team's email, not to the invite).
 *
 * What it never holds: the candidate's name or email, the Meet link (Google shows the Meet button
 * from the event's conference; in space mode the event's `location` holds the link) or any other
 * value of the booking. The only variable parts are the interviewer's display name (the booking's
 * objective profile) and the manage link (`./manage-token.ts`), both checked against a strict
 * pattern first. The text is ASCII only, so it never contains a character the Google client
 * refuses in a description, and it stays far under that client's 4096-character cap.
 *
 * Pure: no environment, no I/O, nothing logged.
 */

/** The event title S06 inserts the event with (at most the Google client's 200 characters). */
export const R1_MEET_PUBLIC_EVENT_SUMMARY = 'Interview Kickstart R1 with Lexy (AI interviewer)';
/** The Google client's description cap (`integrations/google/calendar.ts`). */
export const R1_MEET_PUBLIC_INVITE_MAX_CHARS = 4096;

/** A display name such as the profile's `botDisplayName`: a letter, then up to 39 name characters. */
const INTERVIEWER_NAME_RE = /^[A-Za-z][A-Za-z .'-]{0,39}$/;
/** Exactly what `r1MeetPublicManageLink` answers: an https origin, the manage page, the token. */
const MANAGE_LINK_RE = /^https:\/\/[a-z0-9.-]+(?::[0-9]+)?\/book\/manage#m=[A-Za-z0-9_-]{43}$/;

export interface R1MeetPublicInviteCopyInput {
  /** The interviewer's display name (`getR1MeetProfile(...).botDisplayName`). */
  readonly interviewerName: string;
  /** The candidate's manage link for this send (`r1MeetPublicManageLink`). Never logged. */
  readonly manageLink: string;
}

/**
 * The invite description for one send, or null when the name or the link is not exactly what the
 * patterns above accept (the caller then sends nothing).
 */
export function buildR1MeetPublicInviteDescription(input: R1MeetPublicInviteCopyInput): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const { interviewerName: name, manageLink } = input;
  if (typeof name !== 'string' || !INTERVIEWER_NAME_RE.test(name)) return null;
  if (typeof manageLink !== 'string' || !MANAGE_LINK_RE.test(manageLink)) return null;
  const text = [
    `Your R1 interview with ${name}, Interview Kickstart's AI interviewer.`,
    '',
    'How to join',
    '- At the interview time, open the Google Meet link in this invite ("Join with Google Meet").',
    '- Use a laptop, or a phone with the Chrome browser. You do not need a Google account.',
    '- Allow microphone access when your browser asks, and join from a quiet place.',
    '',
    'What to expect',
    `- ${name} is an AI interviewer, not a person. She runs the interview over Google Meet.`,
    '- The call is recorded so that the hiring team can review your interview.',
    '',
    'Move, cancel or withdraw',
    '- Use your personal link. It works until the interview ends:',
    `  ${manageLink}`,
    '- Please do not share or forward this link: anyone who has it can change your booking.',
    '',
    "Questions? Reply to the hiring team's email that sent you the booking link. Replies to this calendar invite are not read.",
  ].join('\n');
  return text.length <= R1_MEET_PUBLIC_INVITE_MAX_CHARS ? text : null;
}
