export const PREFLIGHT_POLICY_VERSION = 'voice-v1' as const;

export interface CandidatePreflightMetrics {
  stableMs: number;
  reconnects: number;
  outboundAudioPackets: number;
  medianRttMs?: number;
  meanJitterMs?: number;
  packetLossPercent?: number;
  audibleMs: number;
}

export type CandidatePreflightFailure =
  | 'stable_window'
  | 'reconnects'
  | 'outbound_audio'
  | 'latency'
  | 'jitter'
  | 'packet_loss'
  | 'microphone';

export const PREFLIGHT_LIMITS = Object.freeze({
  stableMs: 6_000,
  outboundAudioPackets: 50,
  medianRttMs: 300,
  meanJitterMs: 30,
  packetLossPercent: 3,
  audibleMs: 750,
});

/** Pure, deterministic evaluator. An explicit failing metric never falls back. */
export function evaluateCandidatePreflight(metrics: CandidatePreflightMetrics):
  | { ok: true }
  | { ok: false; reason: CandidatePreflightFailure } {
  if (metrics.stableMs < PREFLIGHT_LIMITS.stableMs) return { ok: false, reason: 'stable_window' };
  if (metrics.reconnects > 0) return { ok: false, reason: 'reconnects' };
  if (metrics.outboundAudioPackets < PREFLIGHT_LIMITS.outboundAudioPackets) return { ok: false, reason: 'outbound_audio' };
  if (metrics.audibleMs < PREFLIGHT_LIMITS.audibleMs) return { ok: false, reason: 'microphone' };
  if (metrics.medianRttMs !== undefined && metrics.medianRttMs > PREFLIGHT_LIMITS.medianRttMs) return { ok: false, reason: 'latency' };
  if (metrics.meanJitterMs !== undefined && metrics.meanJitterMs > PREFLIGHT_LIMITS.meanJitterMs) return { ok: false, reason: 'jitter' };
  if (metrics.packetLossPercent !== undefined && metrics.packetLossPercent > PREFLIGHT_LIMITS.packetLossPercent) return { ok: false, reason: 'packet_loss' };
  return { ok: true };
}
