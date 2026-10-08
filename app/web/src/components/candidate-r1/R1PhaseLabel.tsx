import {
  R1_NO_PHASE_LABELS,
  R1_PHASE_LABELS,
  R1_READY_DETAIL,
  type R1Phase,
} from '../../lib/r1/r1-phase';

interface R1PhaseLabelProps {
  /** The agent's current phase, or null before the interviewer has announced one. */
  phase: R1Phase | null;
  /**
   * Whether an interviewer (an AGENT-kind participant) is in the room. With no phase
   * announced, this separates "waiting for your interviewer" from "in progress".
   */
  agentPresent: boolean;
  /**
   * The interviewer is waiting for the candidate to say they are ready and the "I'm ready"
   * button is showing: the transition line then says so, which a screen reader announces.
   */
  readyHint?: boolean;
}

/**
 * The on-screen phase label (plan decision D8). It is a polite live region so a
 * screen reader hears the interview change mode, which the single voice does
 * not otherwise mark. Only fixed vocabulary is rendered, never the raw
 * attribute value. A worker that has not published its phase must not leave the
 * candidate reading "Waiting for your interviewer to join" while the interviewer
 * is talking, so presence alone moves the label to a neutral "in progress".
 */
export function R1PhaseLabel({ phase, agentPresent, readyHint = false }: R1PhaseLabelProps) {
  const unannounced = agentPresent ? 'inProgress' : 'waiting';
  const copy = phase ? R1_PHASE_LABELS[phase] : R1_NO_PHASE_LABELS[unannounced];
  const detail = phase === 'transition' && readyHint ? R1_READY_DETAIL : copy.detail;
  return (
    <div
      className="r1-phase"
      data-phase={phase ?? (agentPresent ? 'unannounced' : 'none')}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <p className="r1-phase__label">{copy.label}</p>
      <p className="r1-phase__detail">{detail}</p>
    </div>
  );
}
