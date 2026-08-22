/**
 * livekit-phone/stores.ts — the two production adapters behind `ports.ts`.
 *
 * Both are READ-ONLY. There is no insert, update, upsert or delete in this
 * file, and no `.rpc(` either: the only write this integration performs goes
 * through `PhoneStores.applyEvent` in the domain core, which is 0042's audited
 * RPC. A structural test asserts that.
 *
 * These exist so the reconciliation seam has a real default. A port whose only
 * implementation is a test fake is a feature that dies green — it type-checks,
 * its tests pass, and it can never run. No scheduler is armed here, though:
 * arming the sweep is P5's decision, exactly as the dial loop is.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { PHONE_LIVE_ATTEMPT_STATES } from '../../lib/phone-screening/index.js';
import type {
  DuePhoneAttempt,
  DuePhoneAttemptReader,
  LiveKitParticipantSnapshot,
  LiveKitRoomReader,
} from './ports.js';

interface AttemptRow {
  id?: unknown;
  engagement_id?: unknown;
  epoch?: unknown;
  room_name?: unknown;
  state?: unknown;
  phone_engagements?: { state?: unknown } | Array<{ state?: unknown }> | null;
}

/** PostgREST returns an embedded row as an object or a one-element array. */
function embeddedState(row: AttemptRow): string {
  const embedded = Array.isArray(row.phone_engagements)
    ? row.phone_engagements[0]
    : row.phone_engagements;
  return typeof embedded?.state === 'string' ? embedded.state : '';
}

function toDueAttempt(row: AttemptRow): DuePhoneAttempt | null {
  const attemptId = typeof row.id === 'string' ? row.id : null;
  const engagementId = typeof row.engagement_id === 'string' ? row.engagement_id : null;
  const epoch = typeof row.epoch === 'number' && Number.isSafeInteger(row.epoch) ? row.epoch : null;
  const attemptState = typeof row.state === 'string' ? row.state : '';
  const engagementState = embeddedState(row);
  // A row missing any field the sweep fences on is DROPPED, not defaulted:
  // guessing an epoch would defeat the fencing the epoch exists to provide.
  if (attemptId === null || engagementId === null || epoch === null) return null;
  if (attemptState === '' || engagementState === '') return null;
  return {
    attemptId,
    engagementId,
    epoch,
    roomName: typeof row.room_name === 'string' && row.room_name.length > 0 ? row.room_name : null,
    attemptState,
    engagementState,
  };
}

/**
 * Read the live attempts inside the sweep's wall-clock window. The bounds are
 * applied in SQL, so an oversized table cannot be pulled into memory first.
 */
export function createDuePhoneAttemptReader(client: SupabaseClient): DuePhoneAttemptReader {
  return {
    async listDueAttempts({ admittedBefore, admittedAfter, leaseHeldAt, limit }) {
      const { data, error } = await client
        .from('phone_call_attempts')
        .select('id, engagement_id, epoch, room_name, state, phone_engagements!inner(state)')
        .in('state', [...PHONE_LIVE_ATTEMPT_STATES])
        .lte('admitted_at', admittedBefore.toISOString())
        .gte('admitted_at', admittedAfter.toISOString())
        // The lease must still be HELD: see `leaseHeldAt` on the port. A NULL
        // lease is excluded too — `gt` is false against NULL — and that is
        // correct: an attempt no worker holds is not one whose webhook we can
        // conclude was merely dropped.
        .gt('lease_expires_at', leaseHeldAt.toISOString())
        .order('admitted_at', { ascending: true })
        .limit(limit);
      // A bare snake_case code — the driver message can quote a connection
      // string, so it is never propagated.
      if (error) throw new Error('phone_due_attempts_read_error');
      const rows = Array.isArray(data) ? (data as AttemptRow[]) : [];
      const out: DuePhoneAttempt[] = [];
      for (const row of rows) {
        const mapped = toDueAttempt(row);
        if (mapped !== null) out.push(mapped);
      }
      return out;
    },
  };
}

/**
 * Read room membership. Projects each participant to its IDENTITY ALONE at the
 * boundary, so the `sip.phoneNumber` / `sip.trunkPhoneNumber` attributes
 * LiveKit populates on a SIP participant are discarded here and never enter
 * this process's reachable state.
 */
export function createLiveKitRoomReader(client: {
  listParticipants(room: string): Promise<Array<{ identity?: string }>>;
}): LiveKitRoomReader {
  return {
    async listParticipants(room: string): Promise<ReadonlyArray<LiveKitParticipantSnapshot>> {
      const participants = await client.listParticipants(room);
      const out: LiveKitParticipantSnapshot[] = [];
      for (const participant of participants) {
        if (typeof participant?.identity === 'string') out.push({ identity: participant.identity });
      }
      return out;
    },
  };
}

/**
 * Build the production room reader from the EXISTING LiveKit credentials — the
 * same `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` that already
 * back `AccessToken`, `EgressClient` and room provisioning. No new credential.
 *
 * The SDK is imported lazily, on the first room read, so a deployment that
 * never runs a sweep never loads it.
 */
export function createDefaultLiveKitRoomReader(
  url: string,
  apiKey: string,
  apiSecret: string,
): LiveKitRoomReader {
  let inner: LiveKitRoomReader | undefined;
  return {
    async listParticipants(room: string): Promise<ReadonlyArray<LiveKitParticipantSnapshot>> {
      if (!inner) {
        const { RoomServiceClient } = await import('livekit-server-sdk');
        inner = createLiveKitRoomReader(new RoomServiceClient(url, apiKey, apiSecret));
      }
      return inner.listParticipants(room);
    },
  };
}
