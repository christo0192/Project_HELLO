/**
 * Wording for the Meet bridge tile (M034 S07, decision D-S07-12; plan section 5).
 *
 * The tile is the AI interviewer's camera tile in a Google Meet call, so EVERYONE in the
 * meeting reads it: the candidate, and anyone from the hiring side who joined. It therefore:
 *   - never names the candidate (the page has no source for the name, and must never get one);
 *   - never claims anything about recording (the interviewer says that aloud);
 *   - never addresses the candidate with browser wording ("keep this tab open"): the live tile
 *     shows only the phase LABEL, never its detail line;
 *   - names the interviewer only as "AI interviewer", because the persona is pluggable.
 *
 * One title per state; a failure keeps its machine reason out of the copy (the tile carries it
 * in a `data-reason` attribute for tests only).
 */

import type { R1MeetEndReason } from '../../lib/r1/r1-meet-room';

export interface R1MeetTileText {
  title: string;
  body: string;
}

export const R1_MEET_TILE_COPY = Object.freeze({
  /** Above the heading in every state. */
  eyebrow: 'AI interviewer',
  /** No ticket, or the server's Meet switch is off. */
  idle: Object.freeze({
    title: 'The AI interviewer is not available for this call',
    body: 'The hiring team will be in touch.',
  }),
  /** The ticket is being exchanged, or the interviewer is being prepared. */
  connecting: Object.freeze({
    title: 'Preparing the interview…',
    body: 'The AI interviewer will join in a moment.',
  }),
  /** In the room: the phase label, the role-play clock and the scenario card follow. */
  live: Object.freeze({ title: 'Live interview' }),
  /** Every terminal failure reads the same. */
  unavailable: Object.freeze({
    title: 'The AI interviewer cannot join this call',
    body: 'The hiring team will be in touch.',
  }),
  /** How the room ended. */
  ended: Object.freeze({
    agent_ended: Object.freeze({
      title: 'Interview complete',
      body: 'Thank you for your time.',
    }),
    aborted: Object.freeze({
      title: 'The interview stopped because of a technical problem',
      body: 'This will not count against you. The hiring team will be in touch.',
    }),
    /**
     * Blames nobody: the drop may be the bridge's own (the Recall bot's network), the interviewer
     * may never have joined, and everyone in the Meet, the hiring side included, reads this.
     */
    disconnected: Object.freeze({
      title: 'The interview connection ended',
      body: 'The hiring team will be in touch.',
    }),
  }) satisfies Readonly<Record<R1MeetEndReason, R1MeetTileText>>,
});
