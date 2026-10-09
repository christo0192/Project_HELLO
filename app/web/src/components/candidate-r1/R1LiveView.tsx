import { useEffect, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import type { R1Clock } from '../../lib/r1/r1-clock';
import type { R1Caption, R1Phase } from '../../lib/r1/r1-phase';
import { InterviewerAura } from '../candidate-join/InterviewerAura';
import { R1Captions } from './R1Captions';
import { R1ConsentExit } from './R1ConsentExit';
import { R1PhaseLabel } from './R1PhaseLabel';
import { R1ReadyButton } from './R1ReadyButton';
import { R1RoleplayTimer } from './R1RoleplayTimer';
import { R1ScenarioCard } from './R1ScenarioCard';
import { R1_WITHDRAW_QUESTIONS } from './r1-copy';

interface R1LiveViewProps {
  roleTitle: string;
  phase: R1Phase | null;
  /** An interviewer (AGENT-kind participant) is in the room, announced a phase or not. */
  agentPresent: boolean;
  /** The role-play scenario card is on screen (transition, role-play, aside). */
  leadVisible: boolean;
  /** The learner's name as the interviewer published it; the card says "A prospective learner" without it. */
  leadName: string | null;
  /**
   * The role-play budget left, as the interviewer last said (null when it never published one).
   * Shown with the scenario card, and counted down only while the role-play itself is running.
   */
  roleplayClock?: R1Clock | null;
  /** The interviewer is waiting for the candidate to say they are ready (`awaiting=ready`). */
  awaitingReady?: boolean;
  /**
   * Send "I'm ready" to the interviewer. Without it, or outside the transition phase while
   * the interviewer is waiting, no button is shown: saying "ready" is the main way anyway.
   */
  onReady?: () => Promise<void>;
  /** Interviewer speech level, 0 to 1. */
  level: number;
  captions: readonly R1Caption[];
  micMuted: boolean;
  cameraOn: boolean;
  video: LocalVideoTrack | null;
  error: string | null;
  onToggleMic: () => void;
  onToggleCamera: () => void;
  onLeave: () => void;
  /**
   * Take the consent back from inside the room. It ends the interview at once and cannot be
   * rejoined, which is why it is a separate control from Leave (that one can be rejoined for
   * 90 seconds). Absent, no control is shown.
   */
  onWithdraw?: () => void;
  withdrawBusy?: boolean;
  /** Why the last withdrawal did not go through; the interview is still on. */
  withdrawError?: string | null;
}

/**
 * The live interview (plan section 7.10): a small mirrored self-view, the
 * interviewer aura, captions of the interviewer only, the phase label, the
 * scenario card, the role-play clock and the "I'm ready" button while the
 * role-play is being set up or is on, and a banner whenever the camera is
 * off. The candidate's own speech is never captioned or shown back.
 */
export function R1LiveView({
  roleTitle,
  phase,
  agentPresent,
  leadVisible,
  leadName,
  roleplayClock = null,
  awaitingReady = false,
  onReady,
  level,
  captions,
  micMuted,
  cameraOn,
  video,
  error,
  onToggleMic,
  onToggleCamera,
  onLeave,
  onWithdraw,
  withdrawBusy = false,
  withdrawError = null,
}: R1LiveViewProps) {
  const [confirmingLeave, setConfirmingLeave] = useState(false);
  const videoElementRef = useRef<HTMLVideoElement>(null);
  const phaseRegionRef = useRef<HTMLDivElement>(null);
  const leaveConfirmRef = useRef<HTMLDivElement>(null);
  const leaveButtonRef = useRef<HTMLButtonElement>(null);
  const stayButtonRef = useRef<HTMLButtonElement>(null);
  // Set by the ready button as it unmounts while it holds the keyboard focus (see below).
  const readyHadFocusRef = useRef(false);
  // The button exists only while the interviewer is waiting for it, in the briefing. Leaving the
  // briefing unmounts it, so its "sent" state never leaks into a later wait.
  const readyShown = phase === 'transition' && awaitingReady && onReady !== undefined;

  // The interviewer picks up the role-play and the button goes away. If the candidate had pressed
  // it from the keyboard, focus would drop to the page; it goes to the phase panel instead, which
  // is where the change is announced from, so keyboard and screen-reader users keep their place.
  useEffect(() => {
    if (readyShown || !readyHadFocusRef.current) return;
    readyHadFocusRef.current = false;
    phaseRegionRef.current?.focus({ preventScroll: true });
  }, [readyShown]);

  // "Leave interview" opens its confirmation inside the stage card, which can scroll on a short
  // window: bring it into view and put the keyboard on the safe choice, so the destructive one
  // is never one stray Enter away. Closing it returns to the button that opened it.
  const wasConfirmingLeave = useRef(false);
  useEffect(() => {
    if (confirmingLeave) {
      leaveConfirmRef.current?.scrollIntoView?.({ block: 'nearest' });
      stayButtonRef.current?.focus({ preventScroll: true });
    } else if (wasConfirmingLeave.current) {
      leaveButtonRef.current?.focus({ preventScroll: true });
    }
    wasConfirmingLeave.current = confirmingLeave;
  }, [confirmingLeave]);

  useEffect(() => {
    const element = videoElementRef.current;
    if (!video || !element) return undefined;
    video.attach(element);
    return () => {
      video.detach(element);
    };
  }, [video]);

  return (
    <section className="r1-live" aria-label="Live video interview">
      <div className="candidate-glass-card r1-live__stage">
        <p className="candidate-eyebrow">Live interview</p>
        <h1 className="r1-live__title">{roleTitle}</h1>
        <R1PhaseLabel
          phase={phase}
          agentPresent={agentPresent}
          readyHint={readyShown}
          regionRef={phaseRegionRef}
        />
        {leadVisible && roleplayClock && (
          <R1RoleplayTimer clock={roleplayClock} running={phase === 'roleplay'} />
        )}
        {readyShown && onReady && (
          <R1ReadyButton
            onReady={onReady}
            onRemovedWithFocus={() => {
              readyHadFocusRef.current = true;
            }}
          />
        )}
        {!cameraOn && (
          <p className="r1-banner" role="status">
            Your camera is off. This interview needs your camera, so please turn it back on.
          </p>
        )}
        <div className="r1-live__media">
          <InterviewerAura level={level} speaking={level > 0.025} />
          <div className="r1-selfview r1-live__selfview">
            <video ref={videoElementRef} autoPlay muted playsInline aria-label="Your camera">
              <track kind="captions" />
            </video>
          </div>
        </div>
        <div className="candidate-interview__controls">
          <button type="button" aria-pressed={micMuted} onClick={onToggleMic}>
            {micMuted ? 'Unmute microphone' : 'Mute microphone'}
          </button>
          <button type="button" aria-pressed={!cameraOn} onClick={onToggleCamera}>
            {cameraOn ? 'Turn camera off' : 'Turn camera on'}
          </button>
          <button ref={leaveButtonRef} type="button" onClick={() => setConfirmingLeave(true)}>
            Leave interview
          </button>
        </div>
        {confirmingLeave && (
          <div
            ref={leaveConfirmRef}
            className="r1-withdraw"
            role="group"
            aria-label="Leave the interview"
          >
            <p className="candidate-muted">
              Leave the interview? You can rejoin within 90 seconds from the next screen, as
              long as you keep this tab open.
            </p>
            <div className="candidate-interview__controls">
              <button type="button" onClick={onLeave}>
                Yes, leave
              </button>
              <button
                ref={stayButtonRef}
                type="button"
                onClick={() => setConfirmingLeave(false)}
              >
                Stay in the interview
              </button>
            </div>
          </div>
        )}
        {error && (
          <p className="candidate-error" role="alert">
            {error}
          </p>
        )}
        {onWithdraw && (
          <R1ConsentExit
            kind="withdraw"
            question={R1_WITHDRAW_QUESTIONS.live}
            busy={withdrawBusy}
            error={withdrawError}
            onConfirm={onWithdraw}
            keepInView
          />
        )}
      </div>

      <div className="r1-live__side">
        {/* The full card is the briefing's; once the role-play is on it shrinks to a facts strip. */}
        {leadVisible && <R1ScenarioCard leadName={leadName} compact={phase !== 'transition'} />}
        <R1Captions captions={captions} />
      </div>
    </section>
  );
}
