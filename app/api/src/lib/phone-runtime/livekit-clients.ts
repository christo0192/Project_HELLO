/**
 * lib/phone-runtime/livekit-clients.ts — the lazy LiveKit clients the runtime
 * needs to provision a phone room and to read one.
 *
 * ── LAZY, ALWAYS ──────────────────────────────────────────────────────
 * Every SDK reference is behind `await import('livekit-server-sdk')`, mirroring
 * `integrations/livekit-phone/stores.ts`. A static import would construct SDK
 * objects at module load in every deployment — including the ones where the
 * whole lane is off — and the lane's promise is that a disabled deployment
 * performs no provider work at all.
 *
 * ── AND CREDENTIAL-GATED ──────────────────────────────────────────────
 * `createPhoneRoomClients` returns `null` when the three credentials are not
 * all present. The caller then has no room client, `provisionPhoneRoom`
 * answers `not_configured`, and `dialPhoneAttempt` refuses `room_unavailable`
 * before any carrier is reached. A missing credential is a refusal, never a
 * default.
 */

import type {
  PhoneAgentDispatchClientLike,
  PhoneRoomServiceClientLike,
} from '../../integrations/livekit-phone-dial/index.js';

export interface PhoneRoomClients {
  readonly rooms: PhoneRoomServiceClientLike;
  /** Absent when no named phone worker is configured — a legitimate state. */
  readonly dispatch?: PhoneAgentDispatchClientLike;
}

export interface PhoneLiveKitCredentials {
  readonly url: string;
  readonly apiKey: string;
  readonly apiSecret: string;
}

function provisioned(credentials: PhoneLiveKitCredentials): boolean {
  return credentials.url.trim() !== ''
    && credentials.apiKey.trim() !== ''
    && credentials.apiSecret.trim() !== '';
}

/**
 * Build the room and dispatch clients, or null when unconfigured.
 *
 * `agentName` empty means the phone room dispatches nobody. That is the P4a
 * decision, not an oversight: the browser worker stays unnamed and
 * auto-dispatching, and a phone room with no named worker simply has no agent
 * — which is safer than the browser agent answering an unclassified caller.
 */
export function createPhoneRoomClients(
  credentials: PhoneLiveKitCredentials,
  agentName: string,
): PhoneRoomClients | null {
  if (!provisioned(credentials)) return null;

  let roomService: {
    createRoom: (opts: unknown) => Promise<unknown>;
    updateRoomMetadata: (room: string, metadata: string) => Promise<unknown>;
  } | null = null;

  async function roomServiceClient(): Promise<{
    createRoom: (opts: unknown) => Promise<unknown>;
    updateRoomMetadata: (room: string, metadata: string) => Promise<unknown>;
  }> {
    if (roomService === null) {
      const { RoomServiceClient } = await import('livekit-server-sdk');
      roomService = new RoomServiceClient(
        credentials.url,
        credentials.apiKey,
        credentials.apiSecret,
      ) as unknown as typeof roomService & object;
    }
    return roomService!;
  }

  const rooms: PhoneRoomServiceClientLike = {
    async createRoom(options) {
      const client = await roomServiceClient();
      await client.createRoom(options);
    },
    async updateRoomMetadata(room, metadata) {
      const client = await roomServiceClient();
      await client.updateRoomMetadata(room, metadata);
    },
  };

  if (agentName.trim() === '') return { rooms };

  let agentDispatch: { createDispatch: (...args: unknown[]) => Promise<unknown> } | null = null;
  const dispatch: PhoneAgentDispatchClientLike = {
    async createDispatch(roomName, agentName_, options) {
      if (agentDispatch === null) {
        const { AgentDispatchClient } = await import('livekit-server-sdk');
        agentDispatch = new AgentDispatchClient(
          credentials.url,
          credentials.apiKey,
          credentials.apiSecret,
        ) as unknown as typeof agentDispatch & object;
      }
      return agentDispatch!.createDispatch(roomName, agentName_, options);
    },
  };

  return { rooms, dispatch };
}
