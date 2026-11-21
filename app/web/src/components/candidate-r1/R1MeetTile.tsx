import type { R1Clock } from '../../lib/r1/r1-clock';
import type { R1MeetFailure } from '../../lib/r1/r1-meet';
import type { R1MeetEndReason } from '../../lib/r1/r1-meet-room';
import { R1_NO_PHASE_LABELS, R1_PHASE_LABELS, type R1Phase } from '../../lib/r1/r1-phase';
import { R1RoleplayTimer } from './R1RoleplayTimer';
import { R1ScenarioCard } from './R1ScenarioCard';
import { R1_MEET_TILE_COPY } from './r1-meet-copy';

/** Why the tile idles: no ticket in the address, or the server's Meet switch is off. */
export type R1MeetIdleReason = 'no_ticket' | 'disabled';

/**
 * Why the bridge gave up: an exchange refusal (`R1MeetFailure`), or a failure before any call
 * (an unsupported browser, no meeting audio) or after the exchange (the room would not connect).
 */
export type R1MeetUnavailableReason = R1MeetFailure | 'unsupported' | 'no_audio' | 'connect_failed';

/** Where the bridge is. The page owns it; the tile only draws it. */
export type MeetStage =
  | { name: 'idle'; reason: R1MeetIdleReason }
  | { name: 'connecting'; preparing: boolean }
  | { name: 'live' }
  | { name: 'ended'; reason: R1MeetEndReason }
  | { name: 'unavailable'; reason: R1MeetUnavailableReason };

interface R1MeetTileProps {
  stage: MeetStage;
  /** The interviewer's current phase, or null before it has announced one. */
  phase: R1Phase | null;
  /** An interviewer (AGENT-kind participant) is in the room, announced a phase or not. */
  agentPresent: boolean;
  /** The learner's name as the interviewer published it; the card says "A prospective learner" without it. */
  leadName: string | null;
  /** The role-play scenario card is on the tile (transition, role-play, aside). */
  leadVisible: boolean;
  /** The role-play budget left, as the interviewer last said, or null when it never published one. */
  roleplayClock: R1Clock | null;
}

/** The machine reason a test reads from `data-reason`; never shown. */
function reasonOf(stage: MeetStage): string | undefined {
  switch (stage.name) {
    case 'idle':
    case 'ended':
    case 'unavailable':
      return stage.reason;
    case 'connecting':
      return stage.preparing ? 'preparing' : undefined;
    default:
      return undefined;
  }
}

function textOf(stage: MeetStage): { title: string; body: string | null } {
  switch (stage.name) {
    case 'idle':
      return R1_MEET_TILE_COPY.idle;
    case 'connecting':
      return R1_MEET_TILE_COPY.connecting;
    case 'live':
      return { title: R1_MEET_TILE_COPY.live.title, body: null };
    case 'ended':
      return R1_MEET_TILE_COPY.ended[stage.reason];
    case 'unavailable':
      return R1_MEET_TILE_COPY.unavailable;
  }
}

/**
 * The Meet bridge tile: what the Recall bot shows as the AI interviewer's camera in a Google
 * Meet call (M034 S07, decision D-S07-12).
 *
 * Everyone in the meeting sees it, so it shows only the interview's state: in the room, the
 * phase LABEL (never the detail line, which speaks browser wording to the candidate), the
 * role-play clock and the scenario card (the learner's name as the interviewer published it, and
 * the three static course facts). There is no source for the candidate's name here, and there
 * must never be one. It has no controls at all: nobody can press anything on a camera tile.
 */
export function R1MeetTile({
  stage,
  phase,
  agentPresent,
  leadName,
  leadVisible,
  roleplayClock,
}: R1MeetTileProps) {
  const { title, body } = textOf(stage);
  const live = stage.name === 'live';
  const label = phase
    ? R1_PHASE_LABELS[phase].label
    : R1_NO_PHASE_LABELS[agentPresent ? 'inProgress' : 'waiting'].label;
  const showLead = live && leadVisible;

  return (
    <section
      className="r1-meet-tile"
      aria-labelledby="r1-meet-title"
      data-state={stage.name}
      data-reason={reasonOf(stage)}
    >
      <div className="candidate-glass-card r1-meet-tile__stage">
        <p className="candidate-eyebrow">{R1_MEET_TILE_COPY.eyebrow}</p>
        <h1 id="r1-meet-title" className="r1-meet-tile__title">
          {title}
        </h1>
        {body !== null && <p className="candidate-muted r1-meet-tile__body">{body}</p>}
        {live && (
          <div
            className="r1-phase"
            data-phase={phase ?? (agentPresent ? 'unannounced' : 'none')}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <p className="r1-phase__label">{label}</p>
          </div>
        )}
        {showLead && roleplayClock && (
          <R1RoleplayTimer clock={roleplayClock} running={phase === 'roleplay'} />
        )}
      </div>
      {showLead && <R1ScenarioCard leadName={leadName} compact={phase !== 'transition'} />}
    </section>
  );
}
