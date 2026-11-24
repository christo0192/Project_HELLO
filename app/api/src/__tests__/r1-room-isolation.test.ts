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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * M034: the vendor modules R1-over-Meet uses. They sit outside lib/r1 but are R1 code. The booking
 * source is Ashby (D-M034-11), so there is no booking-vendor module.
 */
const meetVendorDirs = ['recall', 'google-meet'].map((name) => path.join(src, 'integrations', name));
const meetVendorSources = meetVendorDirs.flatMap((directory) => sourceFiles(directory));
/**
 * The Meet routes (routes/, outside lib/r1, but R1 code: critic C6): the Recall webhook receivers
 * (M034 S03) and the HR read of the Meet bookings (M034 S05).
 */
const meetRouteSources = ['recall-webhook.ts', 'r1-meet-bookings.ts'].map((name) => path.join(src, 'routes', name));
/** Every Meet file: the vendor modules, lib/r1/meet and the Meet routes. */
const meetSources = [...meetVendorSources, ...sourceFiles(path.join(src, 'lib', 'r1', 'meet')), ...meetRouteSources];
const MEET_CONFIG = path.join(src, 'lib', 'r1', 'meet', 'config.ts');

const r1Sources = [
  path.join(src, 'routes', 'r1.ts'),
  path.join(src, 'routes', 'r1-candidate.ts'),
  ...sourceFiles(path.join(src, 'lib', 'r1')),
  ...meetVendorSources,
  ...meetRouteSources,
  // M034 S03: the Ashby receiver routes interview schedules into r1-meet when Meet is on.
  path.join(src, 'routes', 'ashby-webhook.ts'),
];

/** The M034 Meet variables, declared in config/environment.schema.json (api): non-secrets, then credentials. */
const MEET_ENV_NAMES = [
  'R1_MEET_ENABLED',
  'R1_MEET_BOT_NAME',
  'R1_MEET_DAILY_BOT_CAP',
  'R1_MEET_GOOGLE_LOGIN_GROUP_ID',
  'R1_MEET_SERVICE_USER_ID',
  'RECALL_BASE_URL',
  'R1_MEET_ARM_AT_CREATE',
  'R1_MEET_MULTI_HUMAN_POLICY',
  'R1_MEET_ASHBY_DEX_USER_ID',
  'R1_MEET_ASHBY_FEEDBACK_FORM_ID',
  'RECALL_API_KEY',
  'RECALL_WEBHOOK_SECRET',
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

  it('covers the M034 Meet files: lib/r1/meet and the Recall and Google Meet modules', () => {
    // D-M034-11: Meet rounds are booked in Ashby; the booking-vendor module of the first plan is gone.
    expect(existsSync(path.join(src, 'integrations', 'calen' + 'dly'))).toBe(false);
    for (const directory of meetVendorDirs) {
      expect(meetVendorSources.some((file) => file.startsWith(directory + path.sep)), directory).toBe(true);
    }
    for (const name of ['config.ts', 'profiles.ts']) {
      expect(r1Sources, name).toContain(path.join(src, 'lib', 'r1', 'meet', name));
    }
    // M034 S03: the Recall receivers are fenced like lib/r1 (no egress, no legacy consent, no
    // quoted livekit literal).
    const recallRoute = path.join(src, 'routes', 'recall-webhook.ts');
    expect(existsSync(recallRoute)).toBe(true);
    expect(meetSources).toContain(recallRoute);
    expect(r1Sources).toContain(recallRoute);
    // M034 S05: so is the HR read of the Meet bookings.
    const bookingsRoute = path.join(src, 'routes', 'r1-meet-bookings.ts');
    expect(existsSync(bookingsRoute)).toBe(true);
    expect(meetSources).toContain(bookingsRoute);
    for (const file of meetSources) expect(r1Sources, file).toContain(file);
    // M034 S03 T4: the Ashby receiver's Meet branch is fenced like the rest of R1.
    const ashbyRoute = path.join(src, 'routes', 'ashby-webhook.ts');
    expect(existsSync(ashbyRoute)).toBe(true);
    expect(r1Sources).toContain(ashbyRoute);
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
      // M034: nor the R1-over-Meet vendor modules.
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /lib\/r1\/|routes\/r1|r1-candidate|integrations\/(?:recall|google-meet)/,
      );
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
      // R1-REC adds the recording storage surface on purpose, all declared in
      // config/environment.schema.json (api) and read ONLY by lib/r1/recording/config.ts.
      'R1_RECORDING_S3_ENDPOINT',
      'R1_RECORDING_S3_REGION',
      'R1_RECORDING_S3_BUCKET',
      'R1_RECORDING_S3_ACCESS_KEY_ID',
      'R1_RECORDING_S3_SECRET_ACCESS_KEY',
      'R1_RECORDING_MAX_BYTES',
      'R1_RECORDING_DOWNLOAD_TTL_SEC',
      'R1_RECORDING_RETENTION_DAYS',
      // Owner decision 2026-11-20 (India sales playbook for the post-session scorer): declared
      // in config/environment.schema.json (api) and read ONLY by lib/r1/config.ts.
      'R1_INDIA_PLAYBOOK',
      // Owner decision 2026-11-24 (referrals, partners and a paid interview-prep add-on are real
      // IK offers): declared in config/environment.schema.json (api) and read ONLY by
      // lib/r1/config.ts, like R1_INDIA_PLAYBOOK.
      'R1_IK_OFFERS',
      // M034 Meet surface, declared in config/environment.schema.json (api) and read ONLY by
      // lib/r1/meet/config.ts (pinned by the next test).
      ...MEET_ENV_NAMES,
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

  it('reads the Meet variables only in lib/r1/meet/config.ts, and the Meet vendor modules read no environment at all', () => {
    const runtimeFiles = sourceFiles(src).filter((file) => !path.relative(src, file).split(path.sep).includes('__tests__'));
    expect(runtimeFiles).toContain(MEET_CONFIG);
    // A Meet-prefixed name read through process.env (dotted, bracketed or destructured) or through an
    // env-source object named `source` or `env`.
    const meetName = '((?:R1_MEET|RECALL)_[A-Z0-9_]+)';
    const meetReads = [
      new RegExp(`\\b(?:process\\.env|source|env)\\s*\\.\\s*${meetName}`, 'g'),
      new RegExp(`\\b(?:process\\.env|source|env)\\s*\\[\\s*['"\`]${meetName}['"\`]\\s*\\]`, 'g'),
      new RegExp(`\\{[^}]*\\b${meetName}\\b[^}]*\\}\\s*=\\s*(?:process\\.env|source|env)\\b`, 'g'),
    ];
    for (const file of runtimeFiles) {
      if (file === MEET_CONFIG) continue;
      const text = code(file);
      for (const pattern of meetReads) {
        expect([...text.matchAll(pattern)].map((match) => match[1]), path.relative(src, file)).toEqual([]);
      }
    }
    // The one reader names every variable as a literal process.env read (env-contract visibility).
    const configText = code(MEET_CONFIG);
    for (const name of MEET_ENV_NAMES) expect(configText, name).toContain(`process.env.${name}`);
    expect(configText).toContain('process.env.WEB_ORIGIN');

    // The vendor modules take explicit settings: no process.env, no import.meta.env, no env-source map.
    expect(meetVendorSources.length).toBeGreaterThanOrEqual(3);
    for (const file of meetVendorSources) {
      expect(code(file), path.relative(src, file)).not.toMatch(
        /\bprocess\s*(?:\.\s*env\b|\[)|\bimport\s*\.\s*meta\s*\.\s*env\b|\b(?:source|env)\s*(?:\.\s*[A-Z]|\[\s*['"`][A-Z])/,
      );
    }
  });

  it('never hands Recall our LiveKit: no quoted livekit literal or agent_name in any Meet file (R8)', () => {
    expect(meetSources.length).toBeGreaterThanOrEqual(5);
    for (const file of meetSources) {
      const text = code(file);
      expect(text, path.relative(src, file)).not.toMatch(/['"`]livekit['"`]/i);
      expect(text, path.relative(src, file)).not.toMatch(/agent_name/i);
    }
  });
});
