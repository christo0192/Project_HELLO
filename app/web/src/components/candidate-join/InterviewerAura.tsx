import { useEffect, useRef } from 'react';

interface InterviewerAuraProps {
  level: number;
  speaking: boolean;
}

/** Central identity plate driven by measured LiveKit remote-speaker energy. */
export function InterviewerAura({ level, speaking }: InterviewerAuraProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const value = Math.max(0, Math.min(1, level));

  useEffect(() => {
    rootRef.current?.style.setProperty('--speech-level', String(value));
  }, [value]);

  return (
    <div
      ref={rootRef}
      className="candidate-aura"
      data-speaking={speaking ? 'true' : 'false'}
      role="img"
      aria-label={speaking ? 'Interviewer is speaking' : 'Listening to the interviewer'}
    >
      <span className="candidate-aura__halo candidate-aura__halo--outer" aria-hidden="true" />
      <span className="candidate-aura__halo candidate-aura__halo--middle" aria-hidden="true" />
      <span className="candidate-aura__halo candidate-aura__halo--inner" aria-hidden="true" />
      <span className="candidate-aura__logo-plate">
        <img src="/ik-logo.png" alt="Interview Kickstart" draggable={false} />
      </span>
      <span className="candidate-aura__status" aria-live="polite">
        {speaking ? 'Interviewer speaking' : 'Listening'}
      </span>
    </div>
  );
}
