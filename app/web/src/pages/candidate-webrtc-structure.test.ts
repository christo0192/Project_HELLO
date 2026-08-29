import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(resolve(process.cwd(), 'src/pages/CandidateJoinPage.tsx'), 'utf8');
const readiness = readFileSync(resolve(process.cwd(), 'src/components/candidate-join/AudioReadinessStep.tsx'), 'utf8');
const aura = readFileSync(resolve(process.cwd(), 'src/components/candidate-join/InterviewerAura.tsx'), 'utf8');

describe('candidate WebRTC privacy and media boundaries', () => {
  it('has no camera/video capture or candidate transcript UI', () => {
    expect(readiness).not.toMatch(/createLocalVideoTrack|getUserMedia\(\{\s*video/);
    expect(page).not.toMatch(/candidate\.text|speaker === ['"]candidate|Download transcript|Edit transcript|Copy all/);
  });

  it('requires positive interviewer identification before captions or aura activity', () => {
    expect(page).toContain('AGENT_PARTICIPANT_KIND');
    expect(page).toContain("hello_speaker === 'interviewer'");
    expect(page).toContain('ActiveSpeakersChanged');
    expect(aura).toContain('--speech-level');
    expect(aura).toContain('data-speaking');
  });

  it('uses the disposable preflight contract before actual exchange', () => {
    expect(readiness).toContain('candidateLiveKitPreflight');
    expect(readiness).toContain('PREFLIGHT_LIMITS');
    expect(page).toContain('onReady={(track)');
    expect(page).toContain('join(track)');
  });
});
