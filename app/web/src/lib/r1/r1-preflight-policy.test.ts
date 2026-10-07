import { describe, expect, it } from 'vitest';
import {
  evaluateR1Preflight,
  R1_PREFLIGHT_LIMITS,
  R1_PREFLIGHT_POLICY,
  sumVideoFrames,
  waitForR1Preflight,
  type R1PreflightCounters,
  type R1PreflightMetrics,
  type R1PreflightWindow,
} from './r1-preflight-policy';

const PASSING: R1PreflightMetrics = {
  stableMs: R1_PREFLIGHT_LIMITS.stableMs,
  reconnects: 0,
  audioPackets: 50,
  videoFrames: 45,
  audibleMs: 750,
};

describe('r1-av-v1 preflight policy', () => {
  it('is the r1-av-v1 policy with the plan thresholds', () => {
    expect(R1_PREFLIGHT_POLICY).toBe('r1-av-v1');
    expect(R1_PREFLIGHT_LIMITS.audioPackets).toBe(50);
    expect(R1_PREFLIGHT_LIMITS.videoFrames).toBe(45);
    // The stable window and the deadline must fit inside the 10 s preflight room.
    expect(R1_PREFLIGHT_LIMITS.stableMs).toBeLessThan(R1_PREFLIGHT_LIMITS.deadlineMs);
    expect(R1_PREFLIGHT_LIMITS.deadlineMs).toBeLessThan(10_000);
    expect(R1_PREFLIGHT_LIMITS.pollMs).toBe(500);
  });

  it('passes exactly at the limits', () => {
    expect(evaluateR1Preflight(PASSING)).toEqual({ ok: true });
  });

  it.each([
    ['stable_window', { stableMs: R1_PREFLIGHT_LIMITS.stableMs - 1 }],
    ['reconnects', { reconnects: 1 }],
    ['outbound_audio', { audioPackets: 49 }],
    ['outbound_video', { videoFrames: 44 }],
    ['microphone', { audibleMs: 749 }],
  ])('fails with %s', (reason, change) => {
    expect(evaluateR1Preflight({ ...PASSING, ...change })).toEqual({ ok: false, reason });
  });

  it('never lets a good metric cover for a failing one', () => {
    const verdict = evaluateR1Preflight({ ...PASSING, audioPackets: 5_000, videoFrames: 0 });
    expect(verdict).toEqual({ ok: false, reason: 'outbound_video' });
  });
});

describe('sumVideoFrames', () => {
  it('adds every simulcast layer and tolerates missing stats', () => {
    expect(sumVideoFrames([{ framesSent: 30 }, { framesSent: 20 }])).toBe(50);
    expect(sumVideoFrames([{}, { framesSent: 7 }])).toBe(7);
    expect(sumVideoFrames(undefined)).toBe(0);
    expect(sumVideoFrames([])).toBe(0);
  });
});

/** A fake clock whose `sleep` advances time, with counters that are a function of it. */
function harness(
  counters: (elapsedMs: number) => R1PreflightCounters,
  overrides: Partial<R1PreflightWindow> = {},
) {
  let elapsed = 0;
  const reads: number[] = [];
  const check: R1PreflightWindow = {
    now: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
    readCounters: async () => {
      reads.push(elapsed);
      return counters(elapsed);
    },
    reconnects: () => 0,
    audibleMs: 1_000,
    cancelled: () => false,
    ...overrides,
  };
  return { check, reads, elapsed: () => elapsed };
}

/** Counters for a sender that emits `pps` audio packets and `fps` video frames a second. */
const rates = (pps: number, fps: number) => (elapsedMs: number) => ({
  audioPackets: Math.floor((pps * elapsedMs) / 1_000),
  videoFrames: Math.floor((fps * elapsedMs) / 1_000),
});

describe('waitForR1Preflight', () => {
  it('passes as soon as both thresholds are met once the stable window has elapsed', async () => {
    const { check, elapsed } = harness(rates(50, 15));
    await expect(waitForR1Preflight(check)).resolves.toEqual({ ok: true });
    // 45 frames at 15 fps take 3 s: not the old fixed 4 s wait.
    expect(elapsed()).toBe(R1_PREFLIGHT_LIMITS.stableMs);
  });

  it('never decides before the stable window, however fast the sender is', async () => {
    const { check, elapsed } = harness(rates(500, 300));
    await expect(waitForR1Preflight(check)).resolves.toEqual({ ok: true });
    expect(elapsed()).toBe(R1_PREFLIGHT_LIMITS.stableMs);
  });

  it('reads the counters every 500 ms, first after one interval', async () => {
    const { check, reads } = harness(rates(50, 15));
    await waitForR1Preflight(check);
    expect(reads).toEqual([500, 1_000, 1_500, 2_000, 2_500, 3_000]);
  });

  it('passes a slow ramp that a single reading at 4 s would have failed', async () => {
    // A dim-room camera at 8 fps: 32 frames at 4 s, 45 only after 5.6 s.
    const ramp = rates(50, 8);
    expect(
      evaluateR1Preflight({
        stableMs: 4_000,
        reconnects: 0,
        audibleMs: 1_000,
        ...ramp(4_000),
      }),
    ).toEqual({ ok: false, reason: 'outbound_video' });

    const { check, elapsed } = harness(ramp);
    await expect(waitForR1Preflight(check)).resolves.toEqual({ ok: true });
    expect(elapsed()).toBe(6_000);
  });

  it('fails a video shortfall only at the deadline, never earlier', async () => {
    const { check, elapsed } = harness(() => ({ audioPackets: 500, videoFrames: 44 }));
    await expect(waitForR1Preflight(check)).resolves.toEqual({
      ok: false,
      reason: 'outbound_video',
    });
    expect(elapsed()).toBe(R1_PREFLIGHT_LIMITS.deadlineMs);
  });

  it('fails audio at DTX-level packet counts, which is why the check turns DTX off', async () => {
    // A quiet candidate under Opus DTX sends about 2.5 packets a second.
    const { check, elapsed } = harness(rates(2.5, 15));
    await expect(waitForR1Preflight(check)).resolves.toEqual({
      ok: false,
      reason: 'outbound_audio',
    });
    expect(elapsed()).toBe(R1_PREFLIGHT_LIMITS.deadlineMs);
    // The single 4 s reading the check used to take saw only ten packets.
    expect(rates(2.5, 15)(4_000).audioPackets).toBe(10);
  });

  it('reports a reconnect at once instead of waiting for the deadline', async () => {
    let reconnects = 0;
    const { check, elapsed } = harness(rates(50, 15), { reconnects: () => reconnects });
    const original = check.readCounters;
    check.readCounters = async () => {
      if (elapsed() >= 1_000) reconnects = 1;
      return original();
    };
    await expect(waitForR1Preflight(check)).resolves.toEqual({ ok: false, reason: 'reconnects' });
    expect(elapsed()).toBe(1_000);
  });

  it('reports an inaudible microphone at the first decision, not at the deadline', async () => {
    const { check, elapsed } = harness(rates(50, 15), { audibleMs: 0 });
    await expect(waitForR1Preflight(check)).resolves.toEqual({ ok: false, reason: 'microphone' });
    expect(elapsed()).toBe(R1_PREFLIGHT_LIMITS.stableMs);
  });

  it('stops quietly and reports nothing once cancelled', async () => {
    let calls = 0;
    const { check, reads } = harness(rates(50, 15), { cancelled: () => (calls += 1) > 3 });
    await expect(waitForR1Preflight(check)).resolves.toBeNull();
    expect(reads.length).toBeLessThanOrEqual(2);
  });

  it('does not report a verdict for a check cancelled while reading the counters', async () => {
    let cancelled = false;
    const { check } = harness(rates(50, 15), { cancelled: () => cancelled });
    check.readCounters = async () => {
      cancelled = true;
      return { audioPackets: 500, videoFrames: 500 };
    };
    await expect(waitForR1Preflight(check)).resolves.toBeNull();
  });
});
