/**
 * R1 isolation fences for room provisioning and the candidate surface.
 *
 *  - Room metadata: Cloud stays byte-identical; an R1 room carries exactly the
 *    server-authored marker the worker's routing contract reads
 *    (`lane` = `r1`, mirrored from origin/r1/pr4a-worker-core).
 *  - Egress: an R1 room NEVER starts LiveKit egress, on the R1 SFU or on the
 *    Cloud fallback (spy); every other caller still does.
 *  - Source fences (plan section 9, fence 7): R1 code never touches the legacy
 *    consent tables, invites/grants or the egress client, and no phone-only
 *    module or the shared room module reaches into R1.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  transition: vi.fn(),
  egress: vi.fn(),
}));

vi.mock('../lib/session-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/session-lifecycle.js')>()),
  transitionSession: mocks.transition,
}));
vi.mock('../lib/recording-egress.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/recording-egress.js')>()),
  startAuthoritativeRecording: mocks.egress,
}));

import {
  R1_ROOM_DEPARTURE_TIMEOUT_SEC,
  R1_ROOM_EMPTY_TIMEOUT_SEC,
  R1_ROOM_MAX_PARTICIPANTS,
  R1_ROOM_METADATA_LANE_KEY,
  R1_ROOM_METADATA_LANE_VALUE,
  ROOM_EMPTY_TIMEOUT_SEC,
  ROOM_MAX_PARTICIPANTS,
  buildMinimalRoomMetadata,
  provisionRoomForCreatedSession,
  roomNameForSession,
  type ProvisionRoomDeps,
} from '../lib/room-provisioning.js';
import type { LiveKitEndpoint } from '../lib/livekit-endpoints.js';

const SESSION = '30000000-0000-4000-8000-0000000000e1';
/** The session's interview round: the R1 exchange only provisions R1 round sessions. */
const ROUND = '30000000-0000-4000-8000-0000000000f1';
const ROOM = roomNameForSession(SESSION);
const CLOUD: LiveKitEndpoint = {
  url: 'wss://cloud.example.test',
  apiKey: 'cloud-key',
  apiSecret: 'cloud-secret',
  target: 'cloud',
};
const R1_SFU: LiveKitEndpoint = {
  url: 'wss://r1.example.test',
  apiKey: 'r1-key',
  apiSecret: 'r1-secret',
  target: 'r1',
};

function fakeRooms() {
  return {
    createRoom: vi.fn(async () => ({})),
    updateRoomMetadata: vi.fn(async (_room: string, _metadata: string) => ({})),
    deleteRoom: vi.fn(async () => ({})),
  };
}

async function provision(endpoint: LiveKitEndpoint, extra: Partial<ProvisionRoomDeps> = {}) {
  const rooms = fakeRooms();
  const startRecording = vi.fn(async () => ({ status: 'started' as const, egressId: 'egress-1' }));
  const result = await provisionRoomForCreatedSession(SESSION, 'existing_session', {
    endpoint,
    rooms,
    startRecording,
    ...extra,
  });
  return { rooms, startRecording, result };
}

beforeEach(() => {
  mocks.transition.mockReset();
  mocks.transition.mockResolvedValue({ ok: true });
  mocks.egress.mockReset();
  mocks.egress.mockResolvedValue({ status: 'started', egressId: 'must-not-be-used' });
});

/** The worker's routing predicate (r1_routing.room_is_r1), restated for the fence. */
function roomIsR1(metadata: unknown): boolean {
  if (typeof metadata !== 'string') return false;
  try {
    const parsed = JSON.parse(metadata);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      && parsed[R1_ROOM_METADATA_LANE_KEY] === R1_ROOM_METADATA_LANE_VALUE;
  } catch {
    return false;
  }
}

describe('R1 room metadata marker', () => {
  it('uses exactly the key and value the worker routing contract reads', () => {
    expect(R1_ROOM_METADATA_LANE_KEY).toBe('lane');
    expect(R1_ROOM_METADATA_LANE_VALUE).toBe('r1');
  });

  it('leaves Cloud metadata byte-identical to the pre-R1 shape', () => {
    const expected = JSON.stringify({ session_id: SESSION, room_name: ROOM });
    expect(buildMinimalRoomMetadata(SESSION, ROOM)).toBe(expected);
    expect(buildMinimalRoomMetadata(SESSION, ROOM, 'cloud')).toBe(expected);
    expect(roomIsR1(expected)).toBe(false);
  });

  it('adds only the marker for an R1 room, and stays PII-free', () => {
    const metadata = buildMinimalRoomMetadata(SESSION, ROOM, 'r1');
    expect(JSON.parse(metadata)).toEqual({ session_id: SESSION, room_name: ROOM, lane: 'r1' });
    expect(roomIsR1(metadata)).toBe(true);
    expect(roomIsR1('{"lane":"R1"}')).toBe(false);
    expect(roomIsR1('{"lane":["r1"]}')).toBe(false);
    expect(roomIsR1('not json')).toBe(false);
    expect(roomIsR1(undefined)).toBe(false);
  });
});

describe('R1 room provisioning never runs egress', () => {
  it('Cloud default (no lane): egress starts once and the room is byte-compatible', async () => {
    const { rooms, startRecording, result } = await provision(CLOUD);
    expect(result).toMatchObject({ ok: true, roomName: ROOM });
    expect(startRecording).toHaveBeenCalledTimes(1);
    expect(rooms.createRoom).toHaveBeenCalledWith({
      name: ROOM,
      emptyTimeout: ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: ROOM_MAX_PARTICIPANTS,
      metadata: JSON.stringify({ session_id: SESSION, room_name: ROOM }),
    });
    expect(ROOM_EMPTY_TIMEOUT_SEC).toBe(600);
    expect(ROOM_MAX_PARTICIPANTS).toBe(4);
  });

  it.each([
    ['Cloud fallback', CLOUD],
    ['R1 SFU', R1_SFU],
  ])('lane r1 on the %s: no egress, marked room, R1 limits', async (_name, endpoint) => {
    const { rooms, startRecording, result } = await provision(endpoint, { lane: 'r1', interviewRoundId: ROUND });
    expect(result).toMatchObject({ ok: true, roomName: ROOM, adopted: false });
    expect(startRecording).not.toHaveBeenCalled();
    expect(mocks.egress).not.toHaveBeenCalled();
    expect(rooms.createRoom).toHaveBeenCalledTimes(1);
    const options = (rooms.createRoom.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(options).toMatchObject({
      name: ROOM,
      emptyTimeout: R1_ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: R1_ROOM_MAX_PARTICIPANTS,
      departureTimeout: R1_ROOM_DEPARTURE_TIMEOUT_SEC,
    });
    expect(roomIsR1(options.metadata)).toBe(true);
    expect(R1_ROOM_EMPTY_TIMEOUT_SEC).toBe(180);
    expect(R1_ROOM_MAX_PARTICIPANTS).toBe(3);
    expect(mocks.transition).toHaveBeenCalledWith(
      SESSION,
      'created',
      'waiting',
      undefined,
      { external_call_id: ROOM },
    );
  });

  it('keeps the marker when the room already exists and its metadata is converged', async () => {
    const rooms = fakeRooms();
    rooms.createRoom.mockRejectedValueOnce(new Error('already exists'));
    const result = await provisionRoomForCreatedSession(SESSION, 'existing_session', {
      endpoint: CLOUD,
      rooms,
      lane: 'r1',
      interviewRoundId: ROUND,
      startRecording: vi.fn(),
    });
    expect(result.ok).toBe(true);
    expect(rooms.updateRoomMetadata).toHaveBeenCalledTimes(1);
    expect(roomIsR1(rooms.updateRoomMetadata.mock.calls[0]![1])).toBe(true);
    expect(mocks.egress).not.toHaveBeenCalled();
  });

  it('R1 SFU without the flag: an R1 round session (invite path) gets a marked R1 room, no egress', async () => {
    const { rooms, startRecording, result } = await provision(R1_SFU, { interviewRoundId: ROUND });
    expect(result).toMatchObject({ ok: true, roomName: ROOM });
    expect(startRecording).not.toHaveBeenCalled();
    expect(mocks.egress).not.toHaveBeenCalled();
    const options = (rooms.createRoom.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(roomIsR1(options.metadata)).toBe(true);
    expect(options).toMatchObject({
      emptyTimeout: R1_ROOM_EMPTY_TIMEOUT_SEC,
      maxParticipants: R1_ROOM_MAX_PARTICIPANTS,
      departureTimeout: R1_ROOM_DEPARTURE_TIMEOUT_SEC,
    });
  });

  it('R1 SFU without the flag: a legacy session is refused before any provider call (lane fence)', async () => {
    const { rooms, startRecording, result } = await provision(R1_SFU);
    expect(result).toMatchObject({ ok: false, code: 'provider_failed', terminated: false });
    expect(rooms.createRoom).not.toHaveBeenCalled();
    expect(rooms.updateRoomMetadata).not.toHaveBeenCalled();
    expect(rooms.deleteRoom).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('Cloud without the flag: an R1 round session is refused (no unmarked or marked room off-lane)', async () => {
    const { rooms, startRecording, result } = await provision(CLOUD, { interviewRoundId: ROUND });
    expect(result).toMatchObject({ ok: false, code: 'provider_failed', terminated: false });
    expect(rooms.createRoom).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
    expect(mocks.egress).not.toHaveBeenCalled();
  });

  it.each([
    ['Cloud fallback', CLOUD, undefined],
    ['R1 SFU', R1_SFU, undefined],
    ['Cloud fallback (empty round id)', CLOUD, ''],
    ['R1 SFU (null round id)', R1_SFU, null],
  ])('lane r1 on the %s WITHOUT an R1 round is refused before any provider call', async (_name, endpoint, round) => {
    const { rooms, startRecording, result } = await provision(endpoint, { lane: 'r1', interviewRoundId: round });
    expect(result).toMatchObject({ ok: false, code: 'provider_failed', terminated: false });
    expect(rooms.createRoom).not.toHaveBeenCalled();
    expect(rooms.updateRoomMetadata).not.toHaveBeenCalled();
    expect(startRecording).not.toHaveBeenCalled();
    expect(mocks.egress).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('fails an R1 room without egress involvement when the room cannot be made', async () => {
    const rooms = fakeRooms();
    rooms.createRoom.mockRejectedValue(new Error('down'));
    rooms.updateRoomMetadata.mockRejectedValue(new Error('down'));
    const result = await provisionRoomForCreatedSession(SESSION, 'existing_session', {
      endpoint: CLOUD,
      rooms,
      lane: 'r1',
      interviewRoundId: ROUND,
      startRecording: vi.fn(),
    });
    expect(result).toMatchObject({ ok: false, code: 'provider_failed', terminated: false });
    expect(mocks.egress).not.toHaveBeenCalled();
    expect(rooms.deleteRoom).not.toHaveBeenCalled();
  });
});

// ── Source fences ─────────────────────────────────────────────────────

const src = fileURLToPath(new URL('../', import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const item = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(item);
    return entry.name.endsWith('.ts') ? [item] : [];
  });
}

const r1Sources = [
  path.join(src, 'routes', 'r1.ts'),
  path.join(src, 'routes', 'r1-candidate.ts'),
  ...sourceFiles(path.join(src, 'lib', 'r1')),
];

/** Strip comments so a fence cannot be satisfied (or tripped) by prose. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('R1 source fences', () => {
  it('finds the R1 sources', () => {
    expect(r1Sources.length).toBeGreaterThanOrEqual(8);
  });

  it('never reads or writes the legacy consent tables (fence 7)', () => {
    for (const file of r1Sources) {
      expect(code(file), file).not.toMatch(/['"`]consent_(records|templates)['"`]/);
      expect(code(file), file).not.toMatch(/\.from\(\s*['"`]consent_/);
    }
  });

  it('never creates invites or grants, and never validates a legacy invite', () => {
    for (const file of r1Sources) {
      expect(code(file), file).not.toMatch(
        new RegExp(
          'candidate_invites|candidate_access_grants|createGrant|validateInvite'
          + '|invite-validation|candidate-access',
        ),
      );
    }
  });

  it('never imports the egress client or starts egress', () => {
    for (const file of r1Sources) {
      expect(code(file), file).not.toMatch(
        /recording-egress|startAuthoritativeRecording|EgressClient|startRoomCompositeEgress/,
      );
    }
  });

  it('keeps the shared room module and phone-only code free of R1 imports', () => {
    expect(code(path.join(src, 'lib', 'room-provisioning.ts'))).not.toMatch(/from ['"]\.\/r1\//);
    const phoneFiles = [
      ...sourceFiles(path.join(src, 'lib', 'phone-runtime')),
      ...sourceFiles(path.join(src, 'lib', 'phone-canary1')),
      ...readdirSync(path.join(src, 'routes'))
        .filter((name) => /^phone.*\.ts$/.test(name))
        .map((name) => path.join(src, 'routes', name)),
    ];
    expect(phoneFiles.length).toBeGreaterThan(0);
    for (const file of phoneFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/lib\/r1\/|routes\/r1|r1-candidate/);
    }
  });

  it('reads no environment variable that API configuration does not already declare', () => {
    const declared = new Set([
      'R1_ENABLED',
      'WORKER_CONTEXT_SECRET',
      'DEEPSEEK_API_KEY',
      'WEB_ORIGIN',
      'BROWSER_LIVEKIT_TARGET',
      'R1_LIVEKIT_URL',
      'R1_LIVEKIT_API_KEY',
      'R1_LIVEKIT_API_SECRET',
    ]);
    for (const file of r1Sources) {
      const reads = code(file)
        .matchAll(/process\.env\.([A-Z0-9_]+)|source\.([A-Z0-9_]{4,})\b/g);
      for (const match of reads) {
        const name = (match[1] ?? match[2])!;
        if (name === 'WORKER_CONTEXT_SECRET' || declared.has(name)) continue;
        expect.fail(`${path.basename(file)} reads undeclared ${name}`);
      }
    }
  });
});
