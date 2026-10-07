import { useEffect, useRef, useState } from 'react';
import type { LocalVideoTrack } from 'livekit-client';
import type { R1LeadCard } from '../../lib/r1/r1-api';
import {
  R1_CAPTION_SPEAKER_LABELS,
  type R1Caption,
  type R1Phase,
} from '../../lib/r1/r1-phase';
import { InterviewerAura } from '../candidate-join/InterviewerAura';
import { R1ConsentExit } from './R1ConsentExit';
import { R1LeadCardView } from './R1LeadCard';
import { R1PhaseLabel } from './R1PhaseLabel';
import { R1_WITHDRAW_QUESTIONS } from './r1-copy';

interface R1LiveViewProps {
  roleTitle: string;
  phase: R1Phase | null;
  /** An interviewer (AGENT-kind participant) is in the room, announced a phase or not. */
  agentPresent: boolean;
  leadVisible: boolean;
  lead: R1LeadCard | null;
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
 * lead card while the role-play is on, and a banner whenever the camera is
 * off. The candidate's own speech is never captioned or shown back.
 */
export function R1LiveView({
  roleTitle,
  phase,
  agentPresent,
  leadVisible,
  lead,
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
        <R1PhaseLabel phase={phase} agentPresent={agentPresent} />
        {!cameraOn && (
          <p className="r1-banner" role="status">
            Your camera is off. This interview needs your camera, so please turn it back on.
          </p>
        )}
        <InterviewerAura level={level} speaking={level > 0.025} />
        <div className="r1-selfview r1-live__selfview">
          <video ref={videoElementRef} autoPlay muted playsInline aria-label="Your camera">
            <track kind="captions" />
          </video>
        </div>
        <div className="candidate-interview__controls">
          <button type="button" aria-pressed={micMuted} onClick={onToggleMic}>
            {micMuted ? 'Unmute microphone' : 'Mute microphone'}
          </button>
          <button type="button" aria-pressed={!cameraOn} onClick={onToggleCamera}>
            {cameraOn ? 'Turn camera off' : 'Turn camera on'}
          </button>
          <button type="button" onClick={() => setConfirmingLeave(true)}>
            Leave interview
          </button>
        </div>
        {confirmingLeave && (
          <div className="r1-withdraw" role="group" aria-label="Leave the interview">
            <p className="candidate-muted">
              Leave the interview? You can rejoin within 90 seconds from the next screen, as
              long as you keep this tab open.
            </p>
            <div className="candidate-interview__controls">
              <button type="button" onClick={onLeave}>
                Yes, leave
              </button>
              <button type="button" onClick={() => setConfirmingLeave(false)}>
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
          />
        )}
      </div>

      <div className="r1-live__side">
        {leadVisible && <R1LeadCardView lead={lead} />}
        <section
          className="candidate-glass-card candidate-interview__captions"
          aria-label="Live captions"
        >
          <h2>Captions</h2>
          <div className="candidate-caption-list" aria-live="polite">
            {captions.length === 0 ? (
              <p className="candidate-muted">Listening for the interviewer…</p>
            ) : (
              captions.map((caption) => (
                <p className="candidate-caption" key={caption.id}>
                  <small data-speaker={caption.speaker}>
                    {R1_CAPTION_SPEAKER_LABELS[caption.speaker]}
                  </small>
                  {caption.text}
                </p>
              ))
            )}
          </div>
        </section>
      </div>
    </section>
  );
}
