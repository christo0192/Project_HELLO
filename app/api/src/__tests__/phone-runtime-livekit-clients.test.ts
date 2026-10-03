/**
 * M009 E2 — the production phone room client exposes `listParticipants`.
 *
 * The targeted-dispatch join barrier in `dial.ts` lists the room to see the
 * per-machine agent join before any SIP leg is originated, and it fails CLOSED
 * (`agent_join_unverifiable`) when the room client has no `listParticipants`.
 * The port method is optional, so nothing in the type system would notice the
 * production client lacking it — every targeted dial would simply defer once
 * PHONE_PER_MACHINE_AGENT_NAME is switched on. This pins the method onto the
 * real client, its laziness, and that SDK errors pass through untouched (the
 * dial reads only their `not_found` code).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  constructed: 0,
  listParticipants: vi.fn(),
}));

vi.mock('livekit-server-sdk', () => ({
  RoomServiceClient: class {
    constructor() {
      sdk.constructed += 1;
    }
    createRoom = vi.fn(async () => ({}));
    updateRoomMetadata = vi.fn(async () => ({}));
    listParticipants = sdk.listParticipants;
  },
  AgentDispatchClient: class {
    createDispatch = vi.fn(async () => ({}));
  },
}));

import { createPhoneRoomClients } from '../lib/phone-runtime/livekit-clients.js';

const CREDS = { url: 'wss://livekit.invalid', apiKey: 'k', apiSecret: 's' };

beforeEach(() => {
  sdk.constructed = 0;
  sdk.listParticipants.mockReset();
});

describe('createPhoneRoomClients — listParticipants (M009 E2)', () => {
  it('is present on the production rooms client, with and without a dispatch client', () => {
    expect(typeof createPhoneRoomClients(CREDS, 'phone-screener')?.rooms.listParticipants).toBe('function');
    expect(typeof createPhoneRoomClients(CREDS, '')?.rooms.listParticipants).toBe('function');
  });

  it('is lazy: no SDK client is constructed until a listing is asked for', async () => {
    const clients = createPhoneRoomClients(CREDS, 'phone-screener');
    expect(sdk.constructed).toBe(0);
    sdk.listParticipants.mockResolvedValue([
      { identity: 'agent-x', kind: 4, attributes: { 'lk.agent.name': 'phone-screener-7812736a540d58' } },
    ]);
    const listed = await clients?.rooms.listParticipants?.('phone-room-a');
    expect(sdk.constructed).toBe(1);
    expect(sdk.listParticipants).toHaveBeenCalledWith('phone-room-a');
    expect(listed).toEqual([
      { identity: 'agent-x', kind: 4, attributes: { 'lk.agent.name': 'phone-screener-7812736a540d58' } },
    ]);
  });

  it('passes the SDK error through untouched so the dial can read its not_found code', async () => {
    const clients = createPhoneRoomClients(CREDS, 'phone-screener');
    const notFound = Object.assign(new Error('room does not exist'), { code: 'not_found' });
    sdk.listParticipants.mockRejectedValue(notFound);
    await expect(clients?.rooms.listParticipants?.('phone-room-a')).rejects.toBe(notFound);
  });

  it('stays null without credentials — no client, no listing', () => {
    expect(createPhoneRoomClients({ url: '', apiKey: 'k', apiSecret: 's' }, 'phone-screener')).toBeNull();
  });
});
