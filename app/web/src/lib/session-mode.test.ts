import { describe, expect, it } from 'vitest';
import { isLiveVoiceMode, sessionModeLabel } from './session-mode';

describe('session mode presentation', () => {
  it.each(['browser', 'live'])('treats %s as artifact-producing live voice', (mode) => {
    expect(isLiveVoiceMode(mode)).toBe(true);
    expect(sessionModeLabel(mode)).toBe('Live voice');
  });

  it('labels only simulation as Simulation', () => {
    expect(isLiveVoiceMode('simulation')).toBe(false);
    expect(sessionModeLabel('simulation')).toBe('Simulation');
  });

  it('labels unknown legacy modes neutrally', () => {
    expect(sessionModeLabel(null)).toBe('Screening');
    expect(sessionModeLabel('legacy')).toBe('Screening');
  });
});
