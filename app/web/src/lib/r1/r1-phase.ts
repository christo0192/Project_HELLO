/**
 * The R1 phase vocabulary the candidate page understands. WHO may announce a
 * phase is decided in r1-agent.ts; this module is pure data and has no SDK
 * dependency.
 *
 * The worker publishes the current phase as the participant attribute
 * `phase` (a plain lowercase key, so the SDK never rewrites it). The values
 * are the phase machine's states (plan section 5.1) plus the terminal
 * `ended`, which the worker sets just before it closes the room.
 *
 * CROSS-PR PREREQUISITE (Stage A0). The vocabulary below mirrors PR-4a's
 * `R1Phase` enum (`app/voice-livekit/r1_phases.py`) plus `ended`, and it is only
 * useful if the worker PUBLISHES it: `set_attributes({"phase": <R1Phase.value>})`
 * on EVERY phase transition. PR-4a's first cut published only `ended`, which
 * leaves the label on its fallback and the role-play lead card hidden for the
 * whole interview. Until the worker does, the page degrades to a presence-only
 * label (see R1_NO_PHASE_LABELS), and `r1-phase.test.ts` compares this list with
 * the worker's enum as soon as that file is on the branch.
 *
 * Invariants:
 *   - A value outside the vocabulary is ignored, never rendered: the page
 *     shows only the fixed labels below, so a malformed or hostile attribute
 *     can neither inject text nor blank the previous label.
 *   - The lead card is visible only while the role-play is on the candidate's
 *     screen, so the persona is not shown before the interviewer announces it.
 */

export const R1_PHASE_ATTRIBUTE = 'phase';

export const R1_PHASES = [
  'pre_join',
  'opening',
  'icebreaker',
  'transition',
  'roleplay',
  'aside',
  'roleplay_exit',
  'wrapup',
  'closing',
  'finishing',
  'paused_disconnected',
  'aborted',
  'ended',
] as const;

export type R1Phase = (typeof R1_PHASES)[number];

export function parseR1Phase(value: unknown): R1Phase | null {
  return typeof value === 'string' && (R1_PHASES as readonly string[]).includes(value)
    ? (value as R1Phase)
    : null;
}

export interface R1PhaseLabel {
  /** Short text for the on-screen label. */
  label: string;
  /** One line of task context under the label. */
  detail: string;
}

export const R1_PHASE_LABELS: Readonly<Record<R1Phase, R1PhaseLabel>> = Object.freeze({
  pre_join: { label: 'Getting ready', detail: 'Your interviewer is about to join.' },
  opening: { label: 'Welcome', detail: 'Your interviewer is introducing the interview.' },
  icebreaker: { label: 'Getting to know you', detail: 'Talk through your background.' },
  transition: {
    label: 'Role-play briefing',
    detail: 'Your interviewer is setting up the role-play.',
  },
  roleplay: {
    label: 'Role-play',
    detail: 'You are the Program Advisor. The interviewer plays a prospective learner.',
  },
  aside: {
    label: 'Note from your interviewer',
    detail: 'The role-play is paused for a moment.',
  },
  roleplay_exit: {
    label: 'Role-play finished',
    detail: 'The interviewer is speaking as themselves again.',
  },
  wrapup: { label: 'Your questions', detail: 'Ask anything about the role or the next steps.' },
  closing: { label: 'Wrapping up', detail: 'The interview is ending.' },
  finishing: { label: 'Saving your interview', detail: 'Please keep this tab open.' },
  paused_disconnected: {
    label: 'Waiting for you',
    detail: 'The interview is paused until you reconnect.',
  },
  aborted: {
    label: 'Stopping early',
    detail: 'A technical problem on our side ended the interview.',
  },
  ended: { label: 'Interview complete', detail: 'Thank you for your time.' },
});

/**
 * What the label says while the interviewer has announced no phase: waiting for
 * the interviewer to join, or, once an AGENT-kind participant is in the room,
 * a neutral line that does not claim a phase the page has not been told.
 */
export const R1_NO_PHASE_LABELS = Object.freeze({
  waiting: { label: 'Connecting', detail: 'Waiting for your interviewer to join.' },
  inProgress: { label: 'Interview in progress', detail: 'Your interviewer is with you.' },
}) satisfies Readonly<Record<string, R1PhaseLabel>>;

/** Phases during which the role-play lead card is shown. */
const LEAD_CARD_PHASES: ReadonlySet<R1Phase> = new Set<R1Phase>([
  'transition',
  'roleplay',
  'aside',
]);

/**
 * Whether the lead card should be on screen. While the interview is paused for
 * a disconnect the card follows the phase the interview will resume in.
 */
export function isLeadCardVisible(phase: R1Phase | null, lastActive: R1Phase | null): boolean {
  const effective = phase === 'paused_disconnected' ? lastActive : phase;
  return effective !== null && LEAD_CARD_PHASES.has(effective);
}

/** Who a caption line belongs to. In the role-play the bot speaks as the learner. */
export type R1CaptionSpeaker = 'interviewer' | 'learner';

export function captionSpeakerFor(phase: R1Phase | null): R1CaptionSpeaker {
  return phase === 'roleplay' ? 'learner' : 'interviewer';
}

export const R1_CAPTION_SPEAKER_LABELS: Readonly<Record<R1CaptionSpeaker, string>> = Object.freeze({
  interviewer: 'Interviewer',
  learner: 'Learner (simulated by the AI)',
});

export interface R1Caption {
  id: string;
  text: string;
  final: boolean;
  speaker: R1CaptionSpeaker;
}

export const R1_MAX_CAPTIONS = 100;

export interface CaptionSegment {
  id: string;
  text: string;
  final: boolean;
}

/**
 * Merge incoming transcription segments into the caption list. A segment keeps
 * the speaker it was first seen under, so a line that is finalised after the
 * phase has moved on is not relabelled retroactively.
 */
export function mergeCaptions(
  previous: readonly R1Caption[],
  segments: readonly CaptionSegment[],
  speaker: R1CaptionSpeaker,
): R1Caption[] {
  const next = [...previous];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    const index = next.findIndex((caption) => caption.id === segment.id);
    if (index >= 0) {
      next[index] = { ...next[index], text, final: segment.final };
    } else {
      next.push({ id: segment.id, text, final: segment.final, speaker });
    }
  }
  return next.slice(-R1_MAX_CAPTIONS);
}
