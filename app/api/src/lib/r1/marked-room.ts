/**
 * The R1 attempt's marked room (router invariant 3).
 *
 * Provision (or re-assert) the egress-free, `lane: r1`-marked room for an R1 round
 * session through `provisionRoomForCreatedSession` in `existing_session` mode. `ok` means
 * the room is there. An `adopted: true` answer (a concurrent exchange won the `created` ->
 * `waiting` CAS, or the session was already `waiting`) is success. Otherwise the caller
 * maps `provider_failed` to a retryable 503 (the attempt stays retryable) and
 * `not_joinable` to an ended attempt.
 *
 * No environment reads, no logging, no defaults: the caller passes the provisioning
 * function it resolved. Throws from provisioning (for example an unconfigured endpoint)
 * propagate unchanged.
 */

import type { provisionRoomForCreatedSession, RoomServiceClientLike } from '../room-provisioning.js';
import type { LiveKitEndpoint } from '../livekit-endpoints.js';

export type R1MarkedRoomResult =
  | { ok: true; roomName: string; adopted: boolean }
  | { ok: false; reason: 'provider_failed' | 'not_joinable' };

export interface ProvisionMarkedRoomDeps {
  provisionRoom: typeof provisionRoomForCreatedSession;
  /**
   * The router's injected room-client factory; absent in production, where provisioning
   * builds its own client.
   */
  rooms?: (endpoint: LiveKitEndpoint) => RoomServiceClientLike;
}

export async function provisionMarkedRoom(
  session: { id: string; interview_round_id: string | null },
  endpoint: LiveKitEndpoint,
  deps: ProvisionMarkedRoomDeps,
): Promise<R1MarkedRoomResult> {
  const provisioned = await deps.provisionRoom(session.id, 'existing_session', {
    endpoint,
    lane: 'r1',
    interviewRoundId: session.interview_round_id,
    ...(deps.rooms ? { rooms: deps.rooms(endpoint) } : {}),
  });
  if (provisioned.ok) return { ok: true, roomName: provisioned.roomName, adopted: provisioned.adopted };
  if (provisioned.code === 'provider_failed') return { ok: false, reason: 'provider_failed' };
  return { ok: false, reason: 'not_joinable' };
}
