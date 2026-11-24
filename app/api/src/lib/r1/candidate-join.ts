/**
 * The R1 candidate's LiveKit join token (router invariant 4).
 *
 * One mint for every R1 candidate join, so the grant cannot drift between callers:
 *
 *  - the token publishes ONLY the preset's track sources, never a data channel
 *    (`canPublishData: false`) and never its own metadata (`canUpdateOwnMetadata: false`);
 *  - it may join and subscribe in exactly the one room it names;
 *  - it is signed with the secret of the endpoint the caller selected, so the R1 SFU
 *    and the Cloud fallback each verify only their own tokens;
 *  - its TTL bounds the initial connection only (plan 7.10).
 *
 * The presets are a closed, frozen table. `browser` is the browser exchange's token,
 * byte-compatible with the router's earlier inline mint: camera and microphone,
 * 10 minutes, identity `candidate-<cand8>-<sess8>`. `meet_bridge` is for the Meet
 * exchange (S05): microphone only, 10 minutes, identity `meet-<sess8>`, and no
 * candidate id in the token. The browser path never asks for it. An unknown preset
 * fails closed before any token object exists, and no caller can switch on data
 * publishing, metadata updates or screen sharing.
 *
 * No environment reads, no logging, no defaults beyond `grant = 'browser'`.
 */

import { TrackSource } from 'livekit-server-sdk';
import { accessTokenFor, type LiveKitEndpoint } from '../livekit-endpoints.js';

/** Plan 7.10: LiveKit token expiry only bounds the initial connection. */
export const CANDIDATE_TOKEN_TTL_SEC = 10 * 60;
/** The Meet bridge's join token, like the browser one, only has to connect once. */
export const MEET_BRIDGE_TOKEN_TTL_SEC = 10 * 60;

/** The closed set of candidate join presets. */
export type R1CandidateJoinGrant = 'browser' | 'meet_bridge';

/** What a preset fixes: the publishable track sources and the TTL. Every other flag is fixed for all presets. */
export interface R1CandidateJoinGrantSpec {
  readonly sources: readonly TrackSource[];
  readonly ttlSec: number;
}

/**
 * A frozen preset whose source list is built on its first read, never at import. The router
 * only ever touched `TrackSource` while serving a request, and existing tests import the
 * router under a partial SDK mock that has no `TrackSource`, so reading it at import would
 * break them. The list is built once, frozen, and the same array is returned on every read.
 */
function preset(sources: () => TrackSource[], ttlSec: number): R1CandidateJoinGrantSpec {
  let built: readonly TrackSource[] | undefined;
  return Object.freeze({
    get sources(): readonly TrackSource[] {
      if (built === undefined) built = Object.freeze(sources());
      return built;
    },
    ttlSec,
  });
}

/** Deep-frozen: the table, each spec and each source list. */
export const R1_CANDIDATE_JOIN_GRANTS: Readonly<Record<R1CandidateJoinGrant, R1CandidateJoinGrantSpec>> =
  Object.freeze({
    browser: preset(() => [TrackSource.MICROPHONE, TrackSource.CAMERA], CANDIDATE_TOKEN_TTL_SEC),
    meet_bridge: preset(() => [TrackSource.MICROPHONE], MEET_BRIDGE_TOKEN_TTL_SEC),
  });

/**
 * The participant identity a preset's token carries. Exported so the Meet exchange (S05)
 * binds the interviewer to the same identity the token names. Throws
 * `r1_candidate_join_grant_unknown` for anything outside the table.
 */
export function candidateJoinIdentity(
  grant: R1CandidateJoinGrant,
  session: { id: string; candidate_id: string },
): string {
  if (!Object.prototype.hasOwnProperty.call(R1_CANDIDATE_JOIN_GRANTS, grant)) {
    throw new Error('r1_candidate_join_grant_unknown');
  }
  if (grant === 'meet_bridge') return `meet-${session.id.slice(0, 8)}`;
  return `candidate-${session.candidate_id.slice(0, 8)}-${session.id.slice(0, 8)}`;
}

export interface R1CandidateJoin {
  jwt: string;
  expiresAt: string;
  identity: string;
}

/**
 * Mint the candidate's join token for `roomName` on `endpoint`. The default `browser`
 * preset is exactly the browser exchange's token. `expiresAt` is read from `options.now`
 * after signing.
 */
export async function mintCandidateJoin(
  endpoint: LiveKitEndpoint,
  session: { id: string; candidate_id: string },
  roomName: string,
  options: { now: () => number; grant?: R1CandidateJoinGrant },
): Promise<R1CandidateJoin> {
  const grant = options.grant ?? 'browser';
  // Fails closed on an unknown preset before any token object exists.
  const identity = candidateJoinIdentity(grant, session);
  const spec = R1_CANDIDATE_JOIN_GRANTS[grant];
  const token = accessTokenFor(endpoint, { identity, ttl: spec.ttlSec });
  // The preset's sources only. SCREEN_SHARE is reserved for future rounds.
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canPublishSources: [...spec.sources],
    canSubscribe: true,
    canPublishData: false,
    canUpdateOwnMetadata: false,
  });
  const jwt = await token.toJwt();
  return {
    jwt,
    expiresAt: new Date(options.now() + spec.ttlSec * 1000).toISOString(),
    identity,
  };
}
