/**
 * Wording for the public Dex booking pages, `/book` and `/book/manage` (M035 S07, decision
 * D-S07-M22; the exact strings of S07-PLAN.md section 5).
 *
 * Reviewed copy, plain English, sentence case. It:
 *   - names no server data: no email address, name, Meet link, seat count, job or reason ever
 *     comes from the server into these strings, and the pages never print one (the booked card
 *     says the invite goes to "the email address on your application", never which one);
 *   - makes no promise the API cannot keep: no delivery time for the invite, no "you are
 *     guaranteed" wording;
 *   - has ONE not-found text for every cause (no application, a closed one, an R1 already done,
 *     a phone that does not match, the honeypot): the page must not tell an outsider which it was;
 *   - is the only place a candidate-facing booking string lives, so a wording review reads one file.
 */

import type { BookFieldError } from '../../lib/r1/r1-book';

/** `1 more time` / `3 more times`: how often the time can still be changed. */
export function r1MovesLeftText(n: number): string {
  return n === 1 ? '1 more time' : `${n} more times`;
}

/** The text of a status card: the small label, the heading and the body. */
export interface R1BookCardText {
  eyebrow: string;
  title: string;
  body: string;
}

const card = <T extends R1BookCardText>(text: T): Readonly<T> => Object.freeze(text);

/** Field-level messages, one per validation code of `validateBookForm` (r1-book.ts). */
const FIELD_ERRORS: Readonly<Record<BookFieldError, string>> = Object.freeze({
  name_required: 'Enter your full name.',
  name_too_long: 'Your name must be 100 characters or fewer.',
  email_required: 'Enter the email address on your application.',
  email_invalid: 'Enter an email address in the format name@example.com.',
  phone_required: 'Enter the mobile number on your application.',
  phone_invalid: 'Enter a mobile number with 10 to 15 digits, for example +91 98765 43210.',
  slot_required: 'Pick a time for your interview.',
  consents_required: 'Tick each box to agree to every purpose in the notice.',
  in_india_required: 'Confirm that you are located in India.',
});

/** `/book`: register and book a slot. */
export const R1_BOOK_COPY = Object.freeze({
  form: Object.freeze({
    eyebrow: 'Interview booking',
    title: 'Book your interview with Dex',
    intro:
      "Dex is Interview Kickstart's AI interviewer. Pick a time for your first-round interview "
      + 'on Google Meet. Dex will send a calendar invite with the Meet link to the email address '
      + 'on your application.',
    detailsLegend: 'Your details',
    detailsHint: 'Use the details from your application so we can find it.',
    nameLabel: 'Full name',
    emailLabel: 'Email address',
    emailHint: 'The email address on your application.',
    phoneLabel: 'Mobile number',
    phoneHint: 'The mobile number on your application, for example +91 98765 43210.',
    slotLegend: 'Pick a time (India Standard Time)',
    dayLegend: 'Day',
    timeLegend: 'Time',
    timeUnavailable: 'Not available',
    dayUnavailable: 'No times left',
    currentTime: 'Your current time',
    noTimesOnDay: 'There are no free times on this day. Please pick another day.',
    purposesLegend: 'Please agree to each purpose separately',
    indiaLabel: 'I confirm I am located in India.',
    submit: 'Book my interview',
    privacyLead: 'Questions?',
    privacyLink: 'Review the privacy notice',
    trapLabel: 'Leave this field empty',
  }),
  errors: Object.freeze({
    summaryTitle: 'Please check the following',
    ...FIELD_ERRORS,
    serverInvalid: 'Some details could not be accepted. Check each field and try again.',
  }),
  inline: Object.freeze({
    slotTaken: 'That time was just taken. Please pick another time.',
    noticeChanged:
      'The interview notice was updated while this page was open. Please read it again and '
      + 'tick each box.',
  }),
  live: Object.freeze({
    loading: 'Loading interview times…',
    updated: 'Interview times updated.',
    booking: 'Booking your interview…',
  }),
  states: Object.freeze({
    loading: 'Loading interview times…',
    notOpen: card({
      eyebrow: 'Interview booking',
      title: 'Booking is not open yet',
      body: 'Please try the link from the hiring team again later.',
    }),
    unavailable: card({
      eyebrow: 'Temporarily unavailable',
      title: 'Booking is temporarily unavailable',
      body: 'Please try again in a minute.',
      action: 'Try again',
    }),
    fullyBooked: card({
      eyebrow: 'Interview booking',
      title: 'All interview times are taken',
      body: 'There are no free times right now. Please check again later.',
      action: 'Check again',
    }),
    booked: card({
      eyebrow: 'Interview booked',
      title: 'Your interview is booked',
      body:
        "Dex's calendar invite is on its way to the email address on your application. It has "
        + 'the Google Meet link for your interview.',
      spam: 'If you do not see it soon, check your spam or junk folder.',
      change: 'To change or cancel your interview, use the link in the invite.',
    }),
    alreadyBooked: card({
      eyebrow: 'Already booked',
      title: 'You already have an interview booked',
      body: 'To change or cancel it, use the link in your calendar invite from Dex.',
    }),
    notFound: card({
      eyebrow: 'Interview booking',
      title: "We couldn't find your application",
      body:
        "We couldn't find an application you can book with. Check the email and phone number "
        + 'you used when you applied, or reply to the email from the hiring team.',
      action: 'Check my details',
    }),
    retry: card({
      eyebrow: 'Temporarily unavailable',
      title: 'We could not complete your booking',
      body: 'Please try again in a minute.',
      action: 'Try again',
      back: 'Back to my details',
    }),
  }),
});

/** `/book/manage`: move, cancel or re-consent from the link in the invite. */
export const R1_BOOK_MANAGE_COPY = Object.freeze({
  loading: 'Loading your interview…',
  inactive: card({
    eyebrow: 'Manage your interview',
    title: 'This link is no longer active',
    body:
      'It may have been replaced by a newer invite, or the interview has already taken place. '
      + 'Use the link in your most recent invite from Dex, or reply to the email from the hiring '
      + 'team.',
  }),
  view: Object.freeze({
    eyebrow: 'Manage your interview',
    title: 'Your interview with Dex',
    join: 'Join from the Google Meet link in your calendar invite.',
    move: 'Change the time',
    cancel: 'Cancel my interview',
    movesLeft: (n: number): string => `You can change the time ${r1MovesLeftText(n)}.`,
    noChanges:
      'Online changes are no longer possible for this interview. Reply to the email from the '
      + 'hiring team if you need help.',
  }),
  inProgress: Object.freeze({
    title: 'Your interview is starting',
    body: 'Join from the Google Meet link in your calendar invite. Changes are no longer possible.',
  }),
  movePanel: Object.freeze({
    title: 'Pick a new time (India Standard Time)',
    confirm: 'Move my interview',
    keep: 'Keep the current time',
  }),
  moved: card({
    eyebrow: 'Interview moved',
    title: 'Your interview has moved',
    body: 'Dex will send an updated calendar invite to the email address on your application.',
    next: 'Use the link in that invite if you need to make another change.',
  }),
  cancelPanel: Object.freeze({
    title: 'Cancel your interview?',
    body: 'Your time will be released and the calendar invite cancelled.',
    withdraw: 'Also withdraw the consent I gave for this interview',
    confirm: 'Yes, cancel my interview',
    keep: 'Keep my interview',
  }),
  cancelled: card({
    eyebrow: 'Interview cancelled',
    title: 'Your interview is cancelled',
    body:
      'The calendar invite will be cancelled. If you want a new time, use the booking link from '
      + 'the hiring team.',
    withdrawn: 'We have also recorded that you withdrew your consent.',
  }),
  reconsent: Object.freeze({
    title: 'Please review the updated interview notice',
    body:
      'The notice for this interview has changed. Read it and agree again to keep your interview.',
    submit: 'Agree and keep my interview',
    done: 'Thank you. Your consent is recorded.',
  }),
  notAllowed: card({
    eyebrow: 'Manage your interview',
    title: 'This change is no longer possible',
    body:
      'It may be too close to the start of your interview, or the change limit has been reached. '
      + 'Reply to the email from the hiring team if you need help.',
  }),
  disabled: card({
    eyebrow: 'Manage your interview',
    title: 'Online changes are not available right now',
    body: 'Reply to the email from the hiring team if you need to change your interview.',
  }),
  unavailable: card({
    eyebrow: 'Temporarily unavailable',
    title: 'This page is temporarily unavailable',
    body: 'Please try again in a minute.',
    action: 'Try again',
  }),
  uncertain: card({
    eyebrow: 'Temporarily unavailable',
    title: 'We could not confirm your change',
    body: 'Check your email for an update from Dex before you try again.',
    action: 'Try again',
  }),
});
