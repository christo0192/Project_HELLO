/**
 * capability-check tests.
 *
 * Verifies the pure, synchronous `checkCapabilitySupport` presence gate:
 *   - Both required APIs present            -> supported, missing []
 *   - Each API absent / not-a-function      -> unsupported with exact ids
 *   - Deterministic REQUIRED_CAPABILITIES order in `missing`
 *   - `defaultCapabilityEnvironment` never throws where the browser globals
 *     are absent, and the default-env check reports unsupported
 *   - NEGATIVE CONTROLS (no UA parsing, no enumerateDevices behaviour):
 *     (a) an "unknown browser" env carrying a userAgent string passes, the UA
 *         is never consulted (swap the UA -> result unchanged);
 *     (b) an env whose mediaDevices exposes an `enumerateDevices` spy never
 *         has that spy called during the check.
 *
 * All envs are constructed directly; no real browser is needed.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  REQUIRED_CAPABILITIES,
  checkCapabilitySupport,
  defaultCapabilityEnvironment,
} from './capability-check';
import type { CapabilityEnvironment } from './capability-check';

// ── Helpers ────────────────────────────────────────────────────────────

/** Minimal "real browser": both required APIs exposed as functions. */
function supportedEnv(): CapabilityEnvironment {
  return {
    navigator: { mediaDevices: { getUserMedia: () => Promise.resolve() } },
    RTCPeerConnection: function RTCPeerConnection() {},
  };
}

// ── Presence gate ──────────────────────────────────────────────────────

describe('checkCapabilitySupport', () => {
  it('reports supported when both required APIs are present', () => {
    expect(checkCapabilitySupport(supportedEnv())).toEqual({
      supported: true,
      missing: [],
    });
  });

  it('reports getUserMedia missing when navigator.mediaDevices.getUserMedia is absent', () => {
    const env: CapabilityEnvironment = {
      navigator: { mediaDevices: {} },
      RTCPeerConnection: function RTCPeerConnection() {},
    };
    expect(checkCapabilitySupport(env)).toEqual({
      supported: false,
      missing: ['mediaDevices.getUserMedia'],
    });
  });

  it('reports RTCPeerConnection missing when the global is absent', () => {
    const env: CapabilityEnvironment = {
      navigator: { mediaDevices: { getUserMedia: () => undefined } },
    };
    expect(checkCapabilitySupport(env)).toEqual({
      supported: false,
      missing: ['RTCPeerConnection'],
    });
  });

  it('reports both missing, in REQUIRED_CAPABILITIES order', () => {
    expect(checkCapabilitySupport({})).toEqual({
      supported: false,
      missing: [...REQUIRED_CAPABILITIES],
    });
  });

  it('treats a non-function getUserMedia as missing', () => {
    const env: CapabilityEnvironment = {
      navigator: { mediaDevices: { getUserMedia: 'not-a-function' } },
      RTCPeerConnection: function RTCPeerConnection() {},
    };
    expect(checkCapabilitySupport(env)).toEqual({
      supported: false,
      missing: ['mediaDevices.getUserMedia'],
    });
  });

  it('treats getUserMedia as missing when navigator.mediaDevices is absent entirely', () => {
    const env: CapabilityEnvironment = {
      navigator: {},
      RTCPeerConnection: function RTCPeerConnection() {},
    };
    expect(checkCapabilitySupport(env)).toEqual({
      supported: false,
      missing: ['mediaDevices.getUserMedia'],
    });
  });

  it('defaultCapabilityEnvironment is safe where navigator/RTCPeerConnection are absent, and reports unsupported', () => {
    // jsdom exposes neither mediaDevices nor RTCPeerConnection, so the
    // default environment must not throw and must report unsupported.
    expect(() => defaultCapabilityEnvironment()).not.toThrow();
    const result = checkCapabilitySupport(defaultCapabilityEnvironment());
    expect(result.supported).toBe(false);
    // `missing` is always a prefix of REQUIRED_CAPABILITIES — deterministic
    // declaration order even when both APIs are absent.
    expect(result.missing).toEqual(
      [...REQUIRED_CAPABILITIES].slice(0, result.missing.length),
    );
  });

  // ── Negative controls: no UA parsing, no enumerateDevices behaviour ──

  it('passes an unknown-browser env carrying a userAgent string, and never consults it', () => {
    const uaSpy = vi.fn(() => 'Mozilla/5.0 (Unknown-Browser/1.0)');
    const env = {
      navigator: {
        get userAgent() {
          return uaSpy();
        },
        mediaDevices: { getUserMedia: () => undefined },
      },
      RTCPeerConnection: function RTCPeerConnection() {},
    };

    const result = checkCapabilitySupport(env);
    expect(result.supported).toBe(true);
    expect(result.missing).toEqual([]);
    // The userAgent getter was never invoked: the check does no UA parsing.
    expect(uaSpy).not.toHaveBeenCalled();
  });

  it('keeps passing when the userAgent string is swapped (UA is never consulted)', () => {
    const withUa = (userAgent: string) => ({
      navigator: { userAgent, mediaDevices: { getUserMedia: () => undefined } },
      RTCPeerConnection: function RTCPeerConnection() {},
    });

    const first = checkCapabilitySupport(withUa('Mozilla/5.0 (iPhone)'));
    const second = checkCapabilitySupport(withUa('Mozilla/5.0 (Android)'));
    expect(first).toEqual(second);
    expect(first.supported).toBe(true);
    expect(second.missing).toEqual([]);
  });

  it('never calls enumerateDevices during the check', () => {
    const enumerateDevices = vi.fn();
    const env = {
      navigator: {
        mediaDevices: {
          getUserMedia: () => undefined,
          enumerateDevices,
        },
      },
      RTCPeerConnection: function RTCPeerConnection() {},
    };

    const result = checkCapabilitySupport(env);
    expect(result.supported).toBe(true);
    expect(enumerateDevices).not.toHaveBeenCalled();
  });
});
