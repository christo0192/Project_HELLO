/**
 * The transport under the video. It owns no media: it asks the host, and the host asks the player.
 *
 * The clock is written by the host through the two refs, a whole second at a time, so a player that
 * reports every frame renders nothing here.
 */
import type { Ref } from 'react';
import { Button, SelectField, Slider, cx } from '../design';
import { clockText } from '../../lib/r1-recording';
import { R1_PLAYBACK_RATES } from '../../lib/r1-review';

const ICON = 'h-4 w-4';

function PlayIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="currentColor">
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="currentColor">
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className={ICON} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 6v4h2.5l3.5 3V3L5 6z" fill="currentColor" />
      {muted ? <path d="M11 6l3.5 4M14.5 6L11 10" /> : <path d="M11 5.5a3.5 3.5 0 0 1 0 5" />}
    </svg>
  );
}

function SkipIcon({ forward }: { forward: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d={forward ? 'M16.5 10a6.5 6.5 0 1 1-2.2-4.9' : 'M3.5 10a6.5 6.5 0 1 0 2.2-4.9'} />
      <path d={forward ? 'M14.5 2.5v3h-3' : 'M5.5 2.5v3h3'} />
    </svg>
  );
}

const quiet =
  'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-ink-secondary transition-colors duration-hover ease-out hover:bg-surface-secondary hover:text-ink focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ink)]';

export interface PlayerControlsProps {
  playing: boolean;
  muted: boolean;
  volume: number;
  rate: number;
  lengthSec: number;
  initialSec: number;
  positionRef: Ref<HTMLSpanElement>;
  onToggle: () => void;
  onSkip: (deltaSec: number) => void;
  onMuted: (muted: boolean) => void;
  onVolume: (volume: number) => void;
  onRate: (rate: number) => void;
  /** The ref to the Play button, for a host that moves focus to it. */
  playRef?: Ref<HTMLButtonElement>;
}

export function PlayerControls({
  playing,
  muted,
  volume,
  rate,
  lengthSec,
  initialSec,
  positionRef,
  onToggle,
  onSkip,
  onMuted,
  onVolume,
  onRate,
  playRef,
}: PlayerControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Button
        ref={playRef}
        variant="primary"
        onClick={onToggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="h-9 w-9 shrink-0 !px-0"
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </Button>
      <button type="button" onClick={() => onSkip(-15)} aria-label="Back 15 seconds" title="Back 15 seconds" className={quiet}>
        <SkipIcon forward={false} />
      </button>
      <p className="whitespace-nowrap px-1 font-mono text-label tabular-nums text-ink">
        <span ref={positionRef} data-testid="position">
          {clockText(initialSec)}
        </span>
        <span className="text-ink-tertiary"> / </span>
        <span data-testid="length" className="text-ink-tertiary">
          {clockText(lengthSec)}
        </span>
      </p>
      <button type="button" onClick={() => onSkip(15)} aria-label="Forward 15 seconds" title="Forward 15 seconds" className={quiet}>
        <SkipIcon forward />
      </button>

      <span className={cx('ml-auto flex items-center gap-2')}>
        <button type="button" onClick={() => onMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'} className={quiet}>
          <SpeakerIcon muted={muted} />
        </button>
        <Slider
          aria-label="Volume"
          value={Math.round(volume * 100)}
          min={0}
          max={100}
          step={5}
          onValueChange={(value) => onVolume(value / 100)}
          className="w-20"
        />
        <SelectField size="sm" aria-label="Speed" value={String(rate)} onChange={(event) => onRate(Number(event.target.value))} className="w-20">
          {R1_PLAYBACK_RATES.map((option) => (
            <option key={option} value={String(option)}>
              {option}x
            </option>
          ))}
        </SelectField>
      </span>
    </div>
  );
}
