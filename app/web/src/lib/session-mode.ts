export type SessionMode = 'browser' | 'live' | 'simulation' | string | null | undefined;

/**
 * `browser` is the web LiveKit voice path; `live` is the telephony/live path.
 * Both produce transcripts and authoritative recordings. Only `simulation`
 * is artifact-free. Unknown legacy values are labelled neutrally.
 */
export function isLiveVoiceMode(mode: SessionMode): boolean {
  return mode === 'browser' || mode === 'live';
}

export function sessionModeLabel(mode: SessionMode): string {
  if (isLiveVoiceMode(mode)) return 'Live voice';
  if (mode === 'simulation') return 'Simulation';
  return 'Screening';
}
