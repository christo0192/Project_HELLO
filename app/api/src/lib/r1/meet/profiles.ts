/**
 * R1-over-Meet objective profiles: what a bot that joins a Google Meet call is there to do.
 *
 * A profile is CODE, not data. It names the interview kind the call runs (today the same Dex R1
 * sales round as the browser link: same consent, scoring and review), the name the bot shows, the
 * longest call it may sit in, how early it joins, its automatic-leave timers and the neutral
 * disclosure it posts in the meeting chat.
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
 *  - waiting room 600 s: the Google Meet maximum Recall allows.
 *
 * The disclosure text is a placeholder notice, never consent; the consent slice (S11) owns the
 * final wording.
 *
 * Reads no environment, performs no I/O and does not log.
 */

export interface R1MeetAutomaticLeave {
  readonly waitingRoomTimeoutSec: number;
  readonly nooneJoinedTimeoutSec: number;
  readonly everyoneLeftTimeoutSec: number;
  readonly inCallNotRecordingTimeoutSec: number;
  readonly inCallRecordingTimeoutSec: number;
}

export interface R1MeetObjectiveProfile {
  readonly id: string;
  readonly interviewKind: 'sales_r1';
  readonly botDisplayName: string;
  readonly maxCallMinutes: number;
  /** The bot's `join_at` is this many seconds before the booked slot starts. */
  readonly botJoinLeadSec: number;
  readonly automaticLeave: R1MeetAutomaticLeave;
  readonly disclosureChatMessage: string;
  readonly participantMetadataRetentionHours: number;
}

export const R1_MEET_DEFAULT_PROFILE_ID = 'r1_dex_sales';

const R1_DEX_SALES: R1MeetObjectiveProfile = Object.freeze({
  id: R1_MEET_DEFAULT_PROFILE_ID,
  interviewKind: 'sales_r1',
  botDisplayName: 'Dex',
  maxCallMinutes: 45,
  botJoinLeadSec: 120,
  automaticLeave: Object.freeze({
    waitingRoomTimeoutSec: 600,
    nooneJoinedTimeoutSec: 900,
    everyoneLeftTimeoutSec: 90,
    inCallNotRecordingTimeoutSec: 900,
    inCallRecordingTimeoutSec: 2700,
  }),
  disclosureChatMessage: 'Dex is an AI interviewer from Interview Kickstart.',
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
