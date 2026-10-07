/**
 * The agreements of the R1 consent notices (migration 0123), as the person is asked to tick them.
 *
 * `interview_round_consent_templates` stores the notice text and the required keys but no label per
 * key (unlike the global `consent_templates.consent_items`). Without a label the page falls back
 * to a generic "I agree to <key>." and the per-purpose disclosure, above all the separate
 * agreement to DeepSeek processing in the People's Republic of China, is lost at the point of
 * consent. The consent-template route returns these items so every required key is shown with its
 * own wording.
 *
 * Invariants, pinned by r1-consent-templates-migration.test.ts:
 *   - one entry per audience locale shipped by 0123, each with exactly its required keys, in the
 *     order of the row's `required_consents`;
 *   - the wording of each label matches the notice the same audience is shown (the staff notice
 *     never says the evaluation may update an application status);
 *   - a label is plain ASCII on one line.
 * A new release of the notices (a greater version, BOTH audience rows) needs new items here.
 */

/** Locale of the candidate notice. */
export const R1_CANDIDATE_LOCALE = 'en-IN';
/** Locale of the staff dry-run notice (BCP 47 private use). */
export const R1_STAFF_LOCALE = 'en-IN-x-staff';

export interface R1ConsentItem {
  type: string;
  label: string;
}

const DATA_PROCESSING_LABEL =
  'I agree to the providers listed in this notice, including DeepSeek in the '
  + "People's Republic of China, processing my data.";

const AI_INTERVIEW_LABEL =
  'I agree to take part in an interview led by an AI interviewer, including a sales role-play.';

const CANDIDATE_ITEMS: readonly R1ConsentItem[] = Object.freeze([
  { type: 'ai_interview', label: AI_INTERVIEW_LABEL },
  {
    type: 'video_audio_recording',
    label: 'I agree to my camera video and voice being recorded for review by the hiring team.',
  },
  {
    type: 'ai_evaluation',
    label:
      'I agree to an AI evaluation of my interview that may update my application status, '
      + 'which the hiring team can review and change and which I can contest.',
  },
  { type: 'data_processing', label: DATA_PROCESSING_LABEL },
]);

const STAFF_ITEMS: readonly R1ConsentItem[] = Object.freeze([
  { type: 'ai_interview', label: AI_INTERVIEW_LABEL },
  {
    type: 'video_audio_recording',
    label: 'I agree to my camera video and voice being recorded for the project team.',
  },
  {
    type: 'ai_evaluation',
    label:
      'I agree to an AI evaluation of my dry run for the project team to review. '
      + 'It is not used to make any decision about me.',
  },
  { type: 'data_processing', label: DATA_PROCESSING_LABEL },
]);

export const R1_CONSENT_ITEMS: Readonly<Record<string, readonly R1ConsentItem[]>> = Object.freeze({
  [R1_CANDIDATE_LOCALE]: CANDIDATE_ITEMS,
  [R1_STAFF_LOCALE]: STAFF_ITEMS,
});

/**
 * The items to show for `locale`, in the order of `required` (the template's
 * `required_consents`). Null when the locale is unknown or any required key has no label, so the
 * caller omits the items rather than showing a partial or generic presentation.
 */
export function r1ConsentItems(
  locale: string,
  required: readonly string[],
): R1ConsentItem[] | null {
  // Own keys only: a client-supplied locale such as "constructor" must not reach the prototype.
  if (!Object.prototype.hasOwnProperty.call(R1_CONSENT_ITEMS, locale)) return null;
  const items = R1_CONSENT_ITEMS[locale];
  const picked: R1ConsentItem[] = [];
  for (const type of required) {
    const item = items.find((candidate) => candidate.type === type);
    if (!item) return null;
    picked.push({ type: item.type, label: item.label });
  }
  return picked;
}
