/**
 * M034 S04: the candidate join token mint, extracted from the R1 candidate router into
 * lib/r1/candidate-join.ts with a typed grant option.
 *
 * The default (`browser`) must be exactly the token the browser exchange minted before the
 * move; `meet_bridge` (used only by the Meet exchange, S05) is microphone-only with a fixed
 * identity and no candidate id. Tokens are checked through real, verified JWTs.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { TokenVerifier, TrackSource } from 'livekit-server-sdk';
import { cloudLiveKitEndpoint, type LiveKitEndpoint } from '../lib/livekit-endpoints.js';
import {
  CANDIDATE_TOKEN_TTL_SEC,
  MEET_BRIDGE_TOKEN_TTL_SEC,
  R1_CANDIDATE_JOIN_GRANTS,
  candidateJoinIdentity,
  mintCandidateJoin,
} from '../lib/r1/candidate-join.js';
import { CANDIDATE_TOKEN_TTL_SEC as ROUTE_CANDIDATE_TOKEN_TTL_SEC } from '../routes/r1-candidate.js';

const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const now = () => NOW;
const SESSION = {
  id: '30000000-0000-4000-8000-0000000000e1',
  candidate_id: '10000000-0000-4000-8000-0000000000b1',
};
const ROOM = `screening-${SESSION.id}`;

/** A synthetic R1 SFU endpoint. Low-entropy fixture so the history secret scanner never flags it. */
const R1_ENDPOINT: LiveKitEndpoint = {
  url: 'wss://r1.example.invalid',
  apiKey: 'r1-test-key',
  apiSecret: 'r1-test-secret-' + 's'.repeat(24),
  target: 'r1',
};

function claims(jwt: string): Record<string, any> {
  return JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8'));
}

async function verify(endpoint: LiveKitEndpoint, jwt: string) {
  return new TokenVerifier(endpoint.apiKey, endpoint.apiSecret).verify(jwt);
}

/** The exact grant the browser exchange has always minted (r1-candidate-routes.test.ts). */
const BROWSER_VIDEO = {
  room: ROOM,
  roomJoin: true,
  canPublish: true,
  canPublishSources: ['microphone', 'camera'],
  canSubscribe: true,
  canPublishData: false,
  canUpdateOwnMetadata: false,
};

describe('mintCandidateJoin: the default grant is the browser exchange token', () => {
  it('mints camera+mic, data-less, 10 minutes, identity candidate-<cand8>-<sess8>', async () => {
    const cloud = cloudLiveKitEndpoint();
    const join = await mintCandidateJoin(cloud, SESSION, ROOM, { now });
    const verified = await verify(cloud, join.jwt);
    expect(verified.video).toEqual(BROWSER_VIDEO);
    const payload = claims(join.jwt);
    expect(payload.sub).toBe('candidate-10000000-30000000');
    expect(payload.exp - payload.nbf).toBe(600);
    expect(payload.name).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
    expect(join.expiresAt).toBe(new Date(NOW + 600_000).toISOString());
    expect(join.identity).toBe(payload.sub);
    expect(Object.keys(join).sort()).toEqual(['expiresAt', 'identity', 'jwt']);
  });

  it("grant: 'browser' is the same token as the default", async () => {
    const cloud = cloudLiveKitEndpoint();
    const byDefault = await mintCandidateJoin(cloud, SESSION, ROOM, { now });
    const explicit = await mintCandidateJoin(cloud, SESSION, ROOM, { now, grant: 'browser' });
    const a = claims(byDefault.jwt);
    const b = claims(explicit.jwt);
    expect((await verify(cloud, explicit.jwt)).video).toEqual((await verify(cloud, byDefault.jwt)).video);
    expect(b.sub).toBe(a.sub);
    expect(b.exp - b.nbf).toBe(a.exp - a.nbf);
    expect(explicit.expiresAt).toBe(byDefault.expiresAt);
    expect(explicit.identity).toBe(byDefault.identity);
  });
});

describe("mintCandidateJoin: the 'meet_bridge' grant (Meet exchange, S05)", () => {
  it('is microphone only, subscribes, publishes no data, identity meet-<sess8>, 10 minutes', async () => {
    const cloud = cloudLiveKitEndpoint();
    const join = await mintCandidateJoin(cloud, SESSION, ROOM, { now, grant: 'meet_bridge' });
    const verified = await verify(cloud, join.jwt);
    expect(verified.video).toEqual({
      room: ROOM,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ['microphone'],
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    const payload = claims(join.jwt);
    expect(payload.sub).toBe('meet-30000000');
    expect(join.identity).toBe('meet-30000000');
    expect(payload.exp - payload.nbf).toBe(600);
    expect(join.expiresAt).toBe(new Date(NOW + 600_000).toISOString());
    expect(payload.name).toBeUndefined();
    expect(payload.metadata).toBeUndefined();
    // No candidate id prefix anywhere in the token.
    expect(JSON.stringify(payload)).not.toContain('10000000');
  });
});

describe('mintCandidateJoin: signing', () => {
  it('signs with the endpoint it is given, and only that endpoint verifies it', async () => {
    for (const grant of ['browser', 'meet_bridge'] as const) {
      const join = await mintCandidateJoin(R1_ENDPOINT, SESSION, ROOM, { now, grant });
      const verified = await verify(R1_ENDPOINT, join.jwt);
      expect(verified.video?.room).toBe(ROOM);
      expect(claims(join.jwt).iss).toBe(R1_ENDPOINT.apiKey);
      await expect(verify(cloudLiveKitEndpoint(), join.jwt)).rejects.toBeTruthy();
    }
  });
});

describe('mintCandidateJoin: unknown grants fail closed', () => {
  it('rejects an unknown grant before any token exists, and the identity rule throws the same', async () => {
    await expect(
      mintCandidateJoin(cloudLiveKitEndpoint(), SESSION, ROOM, { now, grant: 'screen' as never }),
    ).rejects.toThrow('r1_candidate_join_grant_unknown');
    expect(() => candidateJoinIdentity('screen' as never, SESSION)).toThrow('r1_candidate_join_grant_unknown');
    // A prototype key is not a preset either.
    expect(() => candidateJoinIdentity('toString' as never, SESSION)).toThrow('r1_candidate_join_grant_unknown');
    expect(candidateJoinIdentity('browser', SESSION)).toBe('candidate-10000000-30000000');
    expect(candidateJoinIdentity('meet_bridge', SESSION)).toBe('meet-30000000');
  });
});

describe('R1_CANDIDATE_JOIN_GRANTS and the TTL constants', () => {
  it('is deep-frozen: the table, each spec and each source list', () => {
    expect(Object.isFrozen(R1_CANDIDATE_JOIN_GRANTS)).toBe(true);
    expect(Object.keys(R1_CANDIDATE_JOIN_GRANTS).sort()).toEqual(['browser', 'meet_bridge']);
    for (const spec of Object.values(R1_CANDIDATE_JOIN_GRANTS)) {
      expect(Object.isFrozen(spec)).toBe(true);
      expect(Object.isFrozen(spec.sources)).toBe(true);
    }
    // ESM test files are strict mode: every mutation attempt throws and changes nothing.
    const table = R1_CANDIDATE_JOIN_GRANTS as any;
    expect(() => { table.browser = { sources: [], ttlSec: 1 }; }).toThrow(TypeError);
    expect(() => { table.screen = { sources: [], ttlSec: 1 }; }).toThrow(TypeError);
    expect(() => { table.meet_bridge.ttlSec = 3600; }).toThrow(TypeError);
    expect(() => { table.meet_bridge.sources.push(table.browser.sources[1]); }).toThrow(TypeError);
    expect(() => { table.browser.sources[0] = table.browser.sources[1]; }).toThrow(TypeError);
    expect(R1_CANDIDATE_JOIN_GRANTS.meet_bridge.ttlSec).toBe(600);
    expect(R1_CANDIDATE_JOIN_GRANTS.meet_bridge.sources).toHaveLength(1);
    expect(R1_CANDIDATE_JOIN_GRANTS.browser.sources).toHaveLength(2);
    expect(Object.keys(R1_CANDIDATE_JOIN_GRANTS)).not.toContain('screen');
  });

  it('keeps both TTLs at 600 s, and the route re-exports the lib constant', () => {
    expect(CANDIDATE_TOKEN_TTL_SEC).toBe(600);
    expect(MEET_BRIDGE_TOKEN_TTL_SEC).toBe(600);
    expect(R1_CANDIDATE_JOIN_GRANTS.browser.ttlSec).toBe(CANDIDATE_TOKEN_TTL_SEC);
    expect(R1_CANDIDATE_JOIN_GRANTS.meet_bridge.ttlSec).toBe(MEET_BRIDGE_TOKEN_TTL_SEC);
    expect(ROUTE_CANDIDATE_TOKEN_TTL_SEC).toBe(CANDIDATE_TOKEN_TTL_SEC);
  });
});

describe('R1_CANDIDATE_JOIN_GRANTS reads TrackSource on use, never at import', () => {
  it('loads under a partial SDK mock with no TrackSource, as the router did before the move', async () => {
    // Several existing route tests import the router under such a mock; the router only ever
    // touched TrackSource while serving a request, so the lib must not touch it at import.
    vi.resetModules();
    vi.doMock('livekit-server-sdk', () => ({
      AccessToken: class {},
      AgentDispatchClient: class {},
      RoomServiceClient: class {},
    }));
    try {
      const lib = await import('../lib/r1/candidate-join.js');
      expect(Object.keys(lib.R1_CANDIDATE_JOIN_GRANTS).sort()).toEqual(['browser', 'meet_bridge']);
      expect(lib.R1_CANDIDATE_JOIN_GRANTS.browser.ttlSec).toBe(600);
      expect(lib.candidateJoinIdentity('meet_bridge', SESSION)).toBe('meet-30000000');
      // The source list is the first thing that needs the enum.
      expect(() => lib.R1_CANDIDATE_JOIN_GRANTS.browser.sources).toThrow();
    } finally {
      vi.doUnmock('livekit-server-sdk');
      vi.resetModules();
    }
  });

  it('builds each source list once and returns the same frozen array on every read', () => {
    const browser = R1_CANDIDATE_JOIN_GRANTS.browser.sources;
    expect(R1_CANDIDATE_JOIN_GRANTS.browser.sources).toBe(browser);
    expect(Object.isFrozen(browser)).toBe(true);
    expect([...browser]).toEqual([TrackSource.MICROPHONE, TrackSource.CAMERA]);
    expect([...R1_CANDIDATE_JOIN_GRANTS.meet_bridge.sources]).toEqual([TrackSource.MICROPHONE]);
  });
});

describe('lib/r1/candidate-join.ts source pin', () => {
  /** Strip comments so the pin cannot be satisfied (or tripped) by prose. */
  const code = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../lib/r1/candidate-join.ts'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('has one grant literal: data-less, no metadata updates, preset sources only, no screen share', () => {
    expect(code.match(/addGrant\(/g)).toHaveLength(1);
    expect(code.match(/canPublishData:\s*false/g)).toHaveLength(1);
    expect(code).not.toMatch(/canPublishData:\s*true/);
    expect(code).not.toMatch(/canUpdateOwnMetadata:\s*true/);
    expect(code.match(/canPublishSources/g)).toHaveLength(1);
    expect(code).toContain('canPublishSources: [...spec.sources]');
    expect(code).not.toMatch(/SCREEN_SHARE/);
  });
});
