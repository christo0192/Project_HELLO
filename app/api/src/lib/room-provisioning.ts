/**
 * Shared fail-closed LiveKit room + authoritative-egress provisioner.
 *
 * Single implementation used by BOTH:
 *   - POST /api/livekit/start  — recruiter starts a brand-new session
 *     (`mode: 'new_session'`), and
 *   - POST /api/livekit/exchange — a candidate joins an EXISTING `created`
 *     session that no route has provisioned yet (`mode: 'existing_session'`).
 *     Ashby materialization inserts exactly one `created` session with a NULL
 *     external_call_id; without JIT provisioning here every Ashby invite is
 *     unexchangeable.
 *
 * This module NEVER creates or rebinds a session row. It provisions the room
 * for the session id it is given, then performs the `created` → `waiting`
 * compare-and-set that publishes external_call_id.
 *
 * Invariants:
 *  1. Room metadata is minimal and carries no candidate PII (session id, room
 *     name, correlation id only) — mirrors invites.ts invariant 4.
 *  2. Authoritative egress is started BEFORE the session is published as
 *     joinable. When egress is enabled, a start failure aborts provisioning;
 *     when it is disabled (and not required) the documented browser-fallback
 *     rule applies unchanged — `startAuthoritativeRecording` owns that policy
 *     and `authoritativeRecordingEnabled()` already throws when a required
 *     egress is disabled.
 *  3. Egress is never started twice for one session:
 *     `startAuthoritativeRecording` short-circuits on a linked
 *     recording_egress_id and links its own id with an `is null` CAS.
 *  4. `existing_session` mode NEVER deletes a room and NEVER terminates the
 *     session on a provider error — the candidate's invite is still unconsumed
 *     and the join must stay retryable. Stopping a loud failure must not make
 *     it a silent one. "Nobody owns this room" is not a decidable property
 *     from outside a transaction (see reapUnownedRoom's removal below), so
 *     the mode simply never deletes; an orphan room self-reaps at
 *     ROOM_EMPTY_TIMEOUT_SEC and no token was ever minted for it.
 */

import { RoomServiceClient } from 'livekit-server-sdk';
import { env } from './env.js';
import { supabase } from './supabase.js';
import { getCorrelationId } from './correlation.js';
import { startAuthoritativeRecording } from './recording-egress.js';
import { transitionSession } from './session-lifecycle.js';

/** Room lifetime with nobody connected, in seconds. */
export const ROOM_EMPTY_TIMEOUT_SEC = 10 * 60;
/** Candidate + agent + head-room. */
export const ROOM_MAX_PARTICIPANTS = 4;

export function requireLiveKitConfigured(): void {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw new Error(
      'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in app/api/.env',
    );
  }
}

/** Deterministic room name — derived from the session id, never stored state. */
export function roomNameForSession(sessionId: string): string {
  return `screening-${sessionId}`;
}

/**
 * Minimal, PII-free room metadata. Denylisted fields (candidate name/email/
 * phone, resume facts, JD/role focus, template, transcript/scoring context,
 * provider secrets, access tokens) are structurally absent.
 */
export function buildMinimalRoomMetadata(sessionId: string, roomName: string): string {
  return JSON.stringify({
    session_id: sessionId,
    room_name: roomName,
    correlation_id: getCorrelationId() ?? undefined,
  });
}

export interface RoomServiceClientLike {
  createRoom(options: {
    name: string;
    emptyTimeout: number;
    maxParticipants: number;
    metadata: string;
  }): Promise<unknown>;
  updateRoomMetadata(room: string, metadata: string): Promise<unknown>;
  deleteRoom(room: string): Promise<unknown>;
}

export interface ProvisionRoomDeps {
  rooms?: RoomServiceClientLike;
  /**
   * Used ONLY by the `existing_session` adopt re-read. Room creation and the
   * `created` → `waiting` CAS go through `transitionSession`, which holds its
   * own module-level Supabase client, so `new_session` mode never reads this.
   * Injecting it does not redirect every database access.
   */
  db?: typeof supabase;
  startRecording?: typeof startAuthoritativeRecording;
}

export type ProvisionRoomMode = 'new_session' | 'existing_session';

export type ProvisionRoomResult =
  /** Room + egress ready and the session is `waiting` (or a concurrent
   *  provisioner won and we adopted its identical room). */
  | { ok: true; roomName: string; adopted: boolean }
  /** LiveKit room create/update or authoritative egress failed. */
  | {
      ok: false;
      code: 'provider_failed';
      roomName: string;
      error: Error;
      /** new_session only: the row was moved to `failed`. */
      terminated: boolean;
      /** new_session only: termination itself failed → reconciliation. */
      terminateFailed: boolean;
    }
  /** new_session only: another actor transitioned the row first. */
  | { ok: false; code: 'transition_conflict'; roomName: string; cleanupFailed: boolean }
  /** new_session only: the CAS errored (not a conflict). */
  | { ok: false; code: 'transition_failed'; roomName: string; cleanupFailed: boolean }
  /** existing_session only: the row is no longer joinable (terminal, or a
   *  concurrent actor moved it somewhere other than our room). */
  | { ok: false; code: 'not_joinable'; roomName: string };

function roomClient(): RoomServiceClientLike {
  return new RoomServiceClient(
    env.livekitUrl,
    env.livekitApiKey,
    env.livekitApiSecret,
  ) as unknown as RoomServiceClientLike;
}

/**
 * REMOVED — `reapUnownedRoom`. It read (status, recording_egress_id) and then
 * deleted the room in a SECOND await. Between those two awaits a concurrent
 * request could start its egress, win the `recording_egress_id is null` link
 * CAS, win the `created → waiting` CAS and return a grant + LiveKit JWT — and
 * the reap would then delete the winner's room. With LiveKit's default
 * `room.auto_create`, that candidate would join a fresh, EGRESS-FREE room:
 * an unrecorded screening that the "joinable with no egress linked" detection
 * query cannot see, because the row still carries the (now-orphaned) egress
 * id. A read-then-delete pair cannot prove ownership, so `existing_session`
 * mode does not delete at all. The cost is at most one empty room living out
 * its ROOM_EMPTY_TIMEOUT_SEC; the benefit is that "never deletes a live
 * room" is true by construction rather than by timing.
 */

/**
 * Provision the LiveKit room and authoritative egress for a session that is
 * currently in the `created` state, then CAS it to `waiting` with
 * external_call_id set.
 *
 * Callers map the failure codes to their own transport semantics; this
 * function never writes an HTTP response and never throws for an expected
 * provider/CAS failure.
 */
export async function provisionRoomForCreatedSession(
  sessionId: string,
  mode: ProvisionRoomMode,
  deps: ProvisionRoomDeps = {},
): Promise<ProvisionRoomResult> {
  requireLiveKitConfigured();

  const roomName = roomNameForSession(sessionId);
  const metadata = buildMinimalRoomMetadata(sessionId, roomName);
  const rooms = deps.rooms ?? roomClient();
  const db = deps.db ?? supabase;
  const startRecording = deps.startRecording ?? startAuthoritativeRecording;

  try {
    try {
      await rooms.createRoom({
        name: roomName,
        emptyTimeout: ROOM_EMPTY_TIMEOUT_SEC,
        maxParticipants: ROOM_MAX_PARTICIPANTS,
        metadata,
      });
    } catch {
      // Room already exists (retry, or a concurrent provisioner) — converge
      // its metadata instead of failing.
      await rooms.updateRoomMetadata(roomName, metadata);
    }

    // Server-authoritative capture starts before anyone can join. In required
    // mode a storage/egress failure aborts rather than silently producing an
    // unrecorded room.
    const recording = await startRecording(roomName, sessionId);
    if (recording.status === 'started' && !recording.egressId) {
      throw new Error('authoritative recording returned no identifier');
    }
  } catch (raw) {
    const error = raw instanceof Error ? raw : new Error('LiveKit room provisioning failed');
    if (mode === 'new_session') {
      await rooms.deleteRoom(roomName).catch(() => undefined);
      const term = await transitionSession(sessionId, 'created', 'failed', 'room_create_error');
      return {
        ok: false,
        code: 'provider_failed',
        roomName,
        error,
        terminated: term.ok,
        terminateFailed: !term.ok && !term.conflict,
      };
    }
    // existing_session: leave the row in `created` so the unconsumed invite
    // stays retryable, and leave any room we may have created alone — see the
    // reapUnownedRoom removal note above. It is empty (no token was minted)
    // and expires on its own; a retry converges on the same room.
    return {
      ok: false,
      code: 'provider_failed',
      roomName,
      error,
      terminated: false,
      terminateFailed: false,
    };
  }

  const tr = await transitionSession(sessionId, 'created', 'waiting', undefined, {
    external_call_id: roomName,
  });
  if (tr.ok) return { ok: true, roomName, adopted: false };

  if (mode === 'existing_session') {
    // A concurrent exchange may have won the CAS with the SAME deterministic
    // room. Adopt it — never delete the winner's room, and let the invite CAS
    // downstream decide which request actually joins.
    const { data: current } = await db
      .from('call_sessions')
      .select('status, external_call_id')
      .eq('id', sessionId)
      .single();
    if (
      current
      && (current.status === 'waiting' || current.status === 'in_progress')
      && current.external_call_id === roomName
    ) {
      return { ok: true, roomName, adopted: true };
    }
    return { ok: false, code: 'not_joinable', roomName };
  }

  let cleanupFailed = false;
  try {
    await rooms.deleteRoom(roomName);
  } catch {
    cleanupFailed = true;
  }
  return {
    ok: false,
    code: tr.conflict ? 'transition_conflict' : 'transition_failed',
    roomName,
    cleanupFailed,
  };
}
