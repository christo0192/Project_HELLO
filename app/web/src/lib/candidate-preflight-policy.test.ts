import { describe, expect, it } from 'vitest';
import { evaluateCandidatePreflight, PREFLIGHT_LIMITS } from './candidate-preflight-policy';

const passing = {
  stableMs: PREFLIGHT_LIMITS.stableMs,
  reconnects: 0,
  outboundAudioPackets: PREFLIGHT_LIMITS.outboundAudioPackets,
  audibleMs: PREFLIGHT_LIMITS.audibleMs,
};

describe('candidate voice preflight policy', () => {
  it('passes when hard requirements meet their inclusive boundaries', () => {
    expect(evaluateCandidatePreflight(passing)).toEqual({ ok: true });
  });

  it.each([
    ['stable_window', { stableMs: PREFLIGHT_LIMITS.stableMs - 1 }],
    ['reconnects', { reconnects: 1 }],
    ['outbound_audio', { outboundAudioPackets: PREFLIGHT_LIMITS.outboundAudioPackets - 1 }],
    ['microphone', { audibleMs: PREFLIGHT_LIMITS.audibleMs - 1 }],
    ['latency', { medianRttMs: PREFLIGHT_LIMITS.medianRttMs + 1 }],
    ['jitter', { meanJitterMs: PREFLIGHT_LIMITS.meanJitterMs + 1 }],
    ['packet_loss', { packetLossPercent: PREFLIGHT_LIMITS.packetLossPercent + 0.01 }],
  ] as const)('rejects %s without a bypass', (reason, mutation) => {
    expect(evaluateCandidatePreflight({ ...passing, ...mutation })).toEqual({ ok: false, reason });
  });

  it('allows genuinely unavailable numeric metrics but not explicit failures', () => {
    expect(evaluateCandidatePreflight(passing)).toEqual({ ok: true });
    expect(evaluateCandidatePreflight({ ...passing, medianRttMs: undefined, meanJitterMs: undefined, packetLossPercent: undefined })).toEqual({ ok: true });
  });
});
