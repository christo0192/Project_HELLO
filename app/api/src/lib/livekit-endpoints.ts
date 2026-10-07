/**
 * Per-lane LiveKit endpoint selection.
 *
 * Cloud credentials remain the permanent default. R1 is selected only by the
 * exact `BROWSER_LIVEKIT_TARGET=r1` opt-in, and is intentionally read when a
 * browser operation starts rather than while this module is imported.
 *
 * `BROWSER_LIVEKIT_TARGET=r1` must only be set as part of the R1 cutover
 * (plan v2 §8.2; runbook docs/runbooks/r1-operations.md, "Fallback flip
 * procedure"): drain R1 sessions, flip THIS target FIRST (the readiness host
 * check, PR-LK-liveness, then runs and fails closed for any worker not yet on
 * the R1 SFU), and only then point project-hello-voice LIVEKIT_* at the R1 SFU
 * with R1_READINESS_HOST=on. Never leave this on Cloud while a browser worker is
 * on the R1 SFU: the Cloud path skips the host check. Roll back in reverse:
 * workers first, then this target.
 */

import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { env } from './env.js';

export type LiveKitEndpointTarget = 'cloud' | 'r1';

export interface LiveKitEndpoint {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly target: LiveKitEndpointTarget;
}

/** The existing LIVEKIT_* configuration, which always means LiveKit Cloud. */
export function cloudLiveKitEndpoint(): LiveKitEndpoint {
  return {
    url: env.livekitUrl,
    apiKey: env.livekitApiKey,
    apiSecret: env.livekitApiSecret,
    target: 'cloud',
  };
}

/**
 * The R1 variables are intentionally not parsed by env.ts: malformed or
 * missing optional R1 configuration must never make API boot fail. Only the
 * exact target value selects them; every other value preserves Cloud behavior.
 */
export function browserLiveKitEndpoint(): LiveKitEndpoint {
  if (process.env.BROWSER_LIVEKIT_TARGET === 'r1') {
    return {
      url: process.env.R1_LIVEKIT_URL ?? '',
      apiKey: process.env.R1_LIVEKIT_API_KEY ?? '',
      apiSecret: process.env.R1_LIVEKIT_API_SECRET ?? '',
      target: 'r1',
    };
  }
  return cloudLiveKitEndpoint();
}

/** The error a lane mismatch fails provisioning with (and the exchange route's reason). */
export const R1_LANE_MISMATCH_ERROR = 'r1_lane_mismatch';

/**
 * True when a session and the selected LiveKit endpoint disagree about the lane: an R1
 * round (`interview_round_id` set) on a non-R1 endpoint, or a legacy session while the
 * R1 endpoint is selected. ONE predicate for room provisioning and for the exchange
 * route's already-provisioned branch, so the two can never drift apart. It lives with
 * the endpoint seam, not in `room-provisioning`, which the phone lane imports.
 */
export function r1LaneMismatch(
  interviewRoundId: string | null | undefined,
  endpoint: Pick<LiveKitEndpoint, 'target'>,
): boolean {
  const r1Round = typeof interviewRoundId === 'string' && interviewRoundId.length > 0;
  return r1Round !== (endpoint.target === 'r1');
}

/**
 * Reject a selected endpoint before a provider client or token is created.
 * The Cloud message deliberately remains byte-for-byte compatible with the
 * long-standing room-provisioning guard used by the phone lane.
 */
export function requireLiveKitEndpointConfigured(endpoint: LiveKitEndpoint): void {
  if (endpoint.url && endpoint.apiKey && endpoint.apiSecret) return;
  if (endpoint.target === 'r1') {
    throw new Error(
      'R1_LIVEKIT_URL, R1_LIVEKIT_API_KEY, and R1_LIVEKIT_API_SECRET must be set when BROWSER_LIVEKIT_TARGET is r1',
    );
  }
  throw new Error(
    'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in app/api/.env',
  );
}

/** Select and fail closed for the browser lane; never downgrade selected R1 to Cloud. */
export function requireBrowserLiveKitConfigured(): LiveKitEndpoint {
  const endpoint = browserLiveKitEndpoint();
  requireLiveKitEndpointConfigured(endpoint);
  return endpoint;
}

/** Build SDK clients from an explicit lane endpoint. */
export function roomServiceClientFor(endpoint: LiveKitEndpoint): RoomServiceClient {
  return new RoomServiceClient(endpoint.url, endpoint.apiKey, endpoint.apiSecret);
}

export function agentDispatchClientFor(endpoint: LiveKitEndpoint): AgentDispatchClient {
  return new AgentDispatchClient(endpoint.url, endpoint.apiKey, endpoint.apiSecret);
}

export function accessTokenFor(
  endpoint: LiveKitEndpoint,
  options: ConstructorParameters<typeof AccessToken>[2],
): AccessToken {
  return new AccessToken(endpoint.apiKey, endpoint.apiSecret, options);
}
