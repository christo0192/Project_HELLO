/**
 * Browser capability detection for the candidate voice-screening join flow.
 *
 * The join flow needs two WebRTC capabilities before a candidate can enter a
 * live voice screening: microphone capture via
 * `navigator.mediaDevices.getUserMedia` and peer-to-peer audio via the
 * `RTCPeerConnection` global.
 *
 * Detection strategy — HARD INVARIANTS:
 *   1. Gate ONLY on API *presence* (`typeof x === 'function'`). No user-agent
 *      parsing, no `enumerateDevices`, no `getUserMedia` invocation (calling
 *      `getUserMedia` would prompt for microphone permission during detection).
 *   2. Unknown browsers that expose both required APIs PASS.
 *   3. The check is fully synchronous and deterministic: `missing` is always
 *      reported in REQUIRED_CAPABILITIES order.
 *
 * `useCapabilitySupport()` runs this check once on mount. Because the check is
 * synchronous, it completes before the Join button can ever be enabled.
 */

import { useEffect, useState } from 'react';

/** The exact APIs the voice-screening join flow requires, in check order. */
export const REQUIRED_CAPABILITIES = [
  'mediaDevices.getUserMedia',
  'RTCPeerConnection',
] as const;

export type CapabilityId = (typeof REQUIRED_CAPABILITIES)[number];

export type CapabilityStatus = 'checking' | 'supported' | 'unsupported';

export interface CapabilityCheckResult {
  supported: boolean;
  missing: CapabilityId[];
}

/**
 * Loose structural view of the browser globals the check reads.
 *
 * Only the two required API slots are modelled — anything else the real
 * `navigator`/`RTCPeerConnection` expose is irrelevant to detection.
 */
export interface CapabilityEnvironment {
  navigator?: { mediaDevices?: { getUserMedia?: unknown } };
  RTCPeerConnection?: unknown;
}

/**
 * Returns the real runtime environment (browser globals), or an empty
 * environment when they are absent (e.g. Node/jsdom). Uses `typeof` guards so
 * it never throws where `navigator`/`RTCPeerConnection` are undefined.
 */
export function defaultCapabilityEnvironment(): CapabilityEnvironment {
  const env: CapabilityEnvironment = {};
  if (typeof navigator !== 'undefined') {
    env.navigator = navigator as CapabilityEnvironment['navigator'];
  }
  if (typeof RTCPeerConnection !== 'undefined') {
    env.RTCPeerConnection = RTCPeerConnection;
  }
  return env;
}

/**
 * Pure, synchronous presence check: supported iff every required API is
 * present as a function. `missing` lists absent ids in REQUIRED_CAPABILITIES
 * order (getUserMedia first). Never reads the user agent, never calls
 * `enumerateDevices`, never invokes `getUserMedia`.
 */
export function checkCapabilitySupport(
  env: CapabilityEnvironment = defaultCapabilityEnvironment(),
): CapabilityCheckResult {
  const missing: CapabilityId[] = [];

  if (typeof env.navigator?.mediaDevices?.getUserMedia !== 'function') {
    missing.push('mediaDevices.getUserMedia');
  }
  if (typeof env.RTCPeerConnection !== 'function') {
    missing.push('RTCPeerConnection');
  }

  return { supported: missing.length === 0, missing };
}

/**
 * React hook: starts at `'checking'`, then a mount-only effect runs the
 * synchronous presence check (default environment) once and settles on
 * `'supported'` or `'unsupported'`. No async work, no timers, no permission
 * requests — the result is available before any Join button can be enabled.
 */
export function useCapabilitySupport(): CapabilityStatus {
  const [status, setStatus] = useState<CapabilityStatus>('checking');

  useEffect(() => {
    const result = checkCapabilitySupport();
    setStatus(result.supported ? 'supported' : 'unsupported');
  }, []);

  return status;
}
