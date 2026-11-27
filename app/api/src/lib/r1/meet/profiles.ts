/**
 * R1-over-Meet objective profiles: what a bot that joins a Google Meet call is there to do.
 *
 * A profile is CODE, not data. It names the interview kind the call runs (today the same Dex R1
 * sales round as the browser link: same scoring and review), how the candidate's consent was
 * obtained, the name the bot shows, the longest call it may sit in, how early it joins, its
 * automatic-leave timers and the disclosure it posts in the meeting chat.
 *
 * Adding a profile = a new frozen entry here and, if it needs a new interview kind or persona, a
 * migration for that too. The `objective_profile` CHECK on the booking table (M034 S02) must list
 * exactly `R1_MEET_PROFILE_IDS`; an unknown id resolves to null and callers fail closed.
 *
 * The timers are aligned with the R1 worker and pinned by `r1-meet-profiles.test.ts`, which reads
 * the worker's own files:
 *  - everyone-left 90 s = the worker's rejoin grace (R1_REJOIN_GRACE_SEC), so a candidate whose
 *    connection blips can come back before the bot leaves;
 *  - in-call-recording 2700 s = the 45-minute call cap, longer than the worker's maximum session
 *    residency plus its no-show wait;
 *  - in-call-not-recording 900 s: the bot counts as "not recording" until a human joins (recording
 *    starts on participant join), so this is the "nobody came" window after admission;
 *  - waiting room 600 s: the Google Meet maximum Recall allows;
 *  - bot detection (M035 S09), sent explicitly instead of Recall's defaults: the name heuristic
 *    keeps Recall's own word list (`notetaker`, `recorder`, `assistant`; the field is required) but
 *    activates only after 7200 s, longer than any stay the other timers allow (in-call-not-recording
 *    900 + in-call-recording 2700), so it is inert and a candidate whose Meet name contains one of
 *    those words never makes Dex leave; the no-speech heuristic keeps Recall's defaults (active
 *    after 1200 s, leave after 600 s), now explicit: a candidate who speaks is never taken for a bot.
 *
 * The disclosure is pinned in the chat when the bot joins and re-sent to everyone each time a
 * participant joins (M035 S09), so a candidate who joins after the bot still sees it even when the
 * Workspace's continuous chat hides the pin. Google Meet caps a chat message at
 * `R1_MEET_MEET_CHAT_MAX_CHARS` (500) characters.
 *
 * Consent (D-M034-9 / D-M034-11): HR takes the candidate's verbal consent when they speak to them
 * directly, and scheduling the interview in Ashby with "Dex (AI Interviewer)" as an interviewer is
 * recorded as that HR-attested consent (and the India-location attestation), naming the Ashby user
 * who scheduled it and when: consent mode `hr_attested_ashby`. A Meet round therefore skips the
 * candidate web consent page. The chat disclosure (Dex is an AI and the call is recorded) is a
 * notice to everyone in the call, never consent.
 *
 * Reads no environment, performs no I/O and does not log.
 */

/** Google Meet's limit on one chat message, in characters. Every disclosure fits in it. */
export const R1_MEET_MEET_CHAT_MAX_CHARS = 500;

/**
 * Recall's bot-detection heuristics (`automatic_leave.bot_detection`). `activateAfterSec` counts
 * from recording start; Recall requires every `timeoutSec` >= 10 and every `activateAfterSec` >= 1.
 */
export interface R1MeetBotDetection {
  /** A participant whose name contains any of `matches` (case-insensitive) is taken for a bot. */
  readonly participantNames: {
    readonly matches: readonly string[];
    readonly activateAfterSec: number;
    readonly timeoutSec: number;
  };
  /** A participant with no audio or screenshare activity for the whole call is taken for a bot. */
  readonly participantEvents: { readonly activateAfterSec: number; readonly timeoutSec: number };
}

export interface R1MeetAutomaticLeave {
  readonly waitingRoomTimeoutSec: number;
  readonly nooneJoinedTimeoutSec: number;
  readonly everyoneLeftTimeoutSec: number;
  readonly inCallNotRecordingTimeoutSec: number;
  readonly inCallRecordingTimeoutSec: number;
  readonly botDetection: R1MeetBotDetection;
}

/**
 * How a Meet round's consent was obtained. `hr_attested_ashby`: HR's act of scheduling the Dex
 * interview in Ashby attests verbal consent (and India location); the attester is the Ashby
 * scheduler. The consent `method` CHECK added in M034 S02 must accept every value here.
 */
export type R1MeetConsentMode = 'hr_attested_ashby';

/** Every consent mode this build knows. Frozen. */
export const R1_MEET_CONSENT_MODES: readonly R1MeetConsentMode[] = Object.freeze(['hr_attested_ashby'] as const);

export interface R1MeetObjectiveProfile {
  readonly id: string;
  readonly interviewKind: 'sales_r1';
  readonly consentMode: R1MeetConsentMode;
  readonly botDisplayName: string;
  readonly maxCallMinutes: number;
  /** The bot's `join_at` is this many seconds before the booked slot starts. */
  readonly botJoinLeadSec: number;
  readonly automaticLeave: R1MeetAutomaticLeave;
  /**
   * Posted (pinned) in the meeting chat to everyone when the bot joins, and re-sent to everyone each
   * time a participant joins: a notice, never consent. At most `R1_MEET_MEET_CHAT_MAX_CHARS` long.
   */
  readonly disclosureChatMessage: string;
  readonly participantMetadataRetentionHours: number;
}

export const R1_MEET_DEFAULT_PROFILE_ID = 'r1_dex_sales';

const R1_DEX_SALES: R1MeetObjectiveProfile = Object.freeze({
  id: R1_MEET_DEFAULT_PROFILE_ID,
  interviewKind: 'sales_r1',
  consentMode: 'hr_attested_ashby',
  botDisplayName: 'Dex',
  maxCallMinutes: 45,
  botJoinLeadSec: 120,
  automaticLeave: Object.freeze({
    waitingRoomTimeoutSec: 600,
    nooneJoinedTimeoutSec: 900,
    everyoneLeftTimeoutSec: 90,
    inCallNotRecordingTimeoutSec: 900,
    inCallRecordingTimeoutSec: 2700,
    botDetection: Object.freeze({
      participantNames: Object.freeze({
        matches: Object.freeze(['notetaker', 'recorder', 'assistant'] as const),
        activateAfterSec: 7200,
        timeoutSec: 600,
      }),
      participantEvents: Object.freeze({ activateAfterSec: 1200, timeoutSec: 600 }),
    }),
  }),
  disclosureChatMessage: 'Dex is an AI interviewer from Interview Kickstart. This call is recorded.',
  participantMetadataRetentionHours: 1,
});

/** Every profile this build knows, keyed by id. Deep-frozen. */
export const R1_MEET_PROFILES: Readonly<Record<string, R1MeetObjectiveProfile>> = Object.freeze({
  [R1_MEET_DEFAULT_PROFILE_ID]: R1_DEX_SALES,
});

/** The known profile ids, in registry order. The S02 CHECK constraint must equal this list. */
export const R1_MEET_PROFILE_IDS: readonly string[] = Object.freeze(Object.keys(R1_MEET_PROFILES));

const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** The profile for `id`, or null for anything this build does not know (fail closed). */
export function getR1MeetProfile(id: unknown): R1MeetObjectiveProfile | null {
  return typeof id === 'string' && own(R1_MEET_PROFILES, id) ? R1_MEET_PROFILES[id] : null;
}
