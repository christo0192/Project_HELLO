import { useEffect, useState } from 'react';
import { clockSecondsLeft, roleplayClockText, type R1Clock } from '../../lib/r1/r1-clock';

interface R1RoleplayTimerProps {
  clock: R1Clock;
  /** The role-play is on and the clock is counting; otherwise it holds its last value. */
  running: boolean;
}

function textFor(clock: R1Clock, running: boolean): string {
  return roleplayClockText(clockSecondsLeft(clock, running, performance.now()));
}

/**
 * The role-play time left, as a quiet line under the phase label ("Role-play · 8 min left").
 *
 * It sits OUTSIDE the phase label's live region on purpose: that region is polite and atomic,
 * so anything changing inside it would make a screen reader read the whole panel again. The
 * timer is a `timer` role (not live), recomputed every second but repainted only when its text
 * changes, which is once a minute.
 */
export function R1RoleplayTimer({ clock, running }: R1RoleplayTimerProps) {
  const [text, setText] = useState(() => textFor(clock, running));

  useEffect(() => {
    const update = (): void => setText(textFor(clock, running));
    update();
    if (!running) return undefined;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [clock, running]);

  return (
    <p className="r1-timer" role="timer">
      {text}
    </p>
  );
}
