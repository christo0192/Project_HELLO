/**
 * P4 — `startPhoneAttemptRecording`, and the one property the whole phase
 * exists to make true:
 *
 *   NO EGRESS MAY BEGIN BEFORE AN AFFIRMATIVE RECORDING DISCLOSURE.
 *
 * The gate is not a comment and not the order of two statements in a worker:
 * it is `attach_phone_attempt_recording`, which 0043 refuses unless the
 * engagement is already `in_call`, a state 0042 reaches through exactly one
 * transition. So every refusal this RPC can answer with is exercised here, and
 * each one asserts the SAME two things — the egress fake was never called, and
 * the explicit `egressStarted` flag is false. Both, deliberately: an assertion
 * that only read the flag would keep passing if the flag were computed rather
 * than observed, and an assertion that only read the spy would keep passing if
 * the flag started lying to its caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  startPhoneAttemptRecording,
  type PhoneEgressClientLike,
  type StartPhoneRecordingDeps,
} from '../integrations/livekit-phone-dial/recording.js';
import {
  phoneAttemptRecordingManifestKey,
  phoneAttemptRecordingObjectKey,
  type PhoneRecordingArtifact,
  type PhoneStores,
} from '../lib/phone-screening/index.js';

const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const ROOM = `phone-${ENGAGEMENT}`;
const NOW = new Date('2026-09-01T05:30:00.000Z');

/** A shared call-order log, so ORDER is asserted rather than assumed. */
let order: string[];

beforeEach(() => {
  order = [];
});

function authoritativeArtifact(): PhoneRecordingArtifact {
  return {
    attemptId: OTHER_ATTEMPT,
    role: 'authoritative',
    objectKey: phoneAttemptRecordingObjectKey(OTHER_ATTEMPT),
    manifestKey: phoneAttemptRecordingManifestKey(OTHER_ATTEMPT),
  };
}

interface Harness {
  deps: StartPhoneRecordingDeps;
  attach: ReturnType<typeof vi.fn>;
  finalize: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  startEgress: ReturnType<typeof vi.fn>;
  buildOutput: ReturnType<typeof vi.fn>;
  stopEgress: ReturnType<typeof vi.fn>;
}

function harness(opts: {
  attach?: unknown;
  list?: unknown;
  egress?: () => Promise<{ egressId?: string }>;
} = {}): Harness {
  const list = vi.fn(async () => {
    order.push('list');
    return (opts.list ?? { status: 'ok', artifacts: [] }) as never;
  });
  const attach = vi.fn(async () => {
    order.push('attach');
    return (opts.attach ?? { status: 'ok', duplicate: false }) as never;
  });
  const finalize = vi.fn(async () => {
    order.push('finalize');
    return { status: 'ok' } as never;
  });
  const startEgress = vi.fn(async () => {
    order.push('egress');
    return opts.egress ? await opts.egress() : { egressId: 'EG_abcd1234' };
  });
  const stopEgress = vi.fn(async () => undefined);
  const buildOutput = vi.fn((objectKey: string) => ({ filepath: objectKey }));

  const stores = {
    listEngagementRecordings: list,
    attachAttemptRecording: attach,
    finalizeAttemptRecording: finalize,
  } as unknown as PhoneStores;

  const egress = { startRoomCompositeEgress: startEgress, stopEgress } as unknown as
    PhoneEgressClientLike;

  return { deps: { stores, egress, buildOutput }, attach, finalize, list, startEgress, buildOutput, stopEgress };
}

function run(h: Harness) {
  return startPhoneAttemptRecording(
    { engagementId: ENGAGEMENT, attemptId: ATTEMPT, roomName: ROOM, now: NOW },
    h.deps,
  );
}

// ═══════════════════════════════════════════════════════════════════════
// THE GATE. Every DB refusal must record NOTHING.
// ═══════════════════════════════════════════════════════════════════════

describe('P4 recording — a refused binding records nothing at all', () => {
  const refusals = [
    'disclosure_not_delivered',
    'engagement_terminal',
    'attempt_not_recordable',
    'not_found',
    'authoritative_exists',
    'already_bound',
    'invalid_object_key',
    'unknown_status',
  ] as const;

  for (const refusal of refusals) {
    it(`starts NO egress when attach refuses with ${refusal}`, async () => {
      const h = harness({ attach: { status: refusal } });
      const res = await run(h);

      expect(res.status).toBe('refused');
      expect(res.refusal).toBe(refusal);
      // The two independent witnesses. Both must hold.
      expect(h.startEgress).not.toHaveBeenCalled();
      expect(res.egressStarted).toBe(false);
      // And nothing was finalized either — there is no provider id to record.
      expect(h.finalize).not.toHaveBeenCalled();
      // The output descriptor is not even constructed on a refused path.
      expect(h.buildOutput).not.toHaveBeenCalled();
    });
  }

  it('refuses BEFORE the egress even for the most likely mistake — a pre-disclosure caller', async () => {
    const h = harness({ attach: { status: 'disclosure_not_delivered', engagementState: 'dialing' } });
    const res = await run(h);
    expect(res).toEqual({
      status: 'refused',
      refusal: 'disclosure_not_delivered',
      egressStarted: false,
    });
    expect(order).toEqual(['list', 'attach']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ORDER — ask, then record, then write down the id.
// ═══════════════════════════════════════════════════════════════════════

describe('P4 recording — ordering is attach, then egress, then finalize', () => {
  it('binds the keys BEFORE the egress and finalizes AFTER it', async () => {
    const h = harness();
    const res = await run(h);

    expect(res.status).toBe('started');
    expect(order).toEqual(['list', 'attach', 'egress', 'finalize']);
    // Stated as an inequality too, so a reordering that happened to keep the
    // array length still fails.
    expect(order.indexOf('attach')).toBeLessThan(order.indexOf('egress'));
    expect(order.indexOf('egress')).toBeLessThan(order.indexOf('finalize'));
    expect(res.egressStarted).toBe(true);
    expect(res.egressId).toBe('EG_abcd1234');
  });

  it('records a telephone call as audio-only, into the room it was told about', async () => {
    const h = harness();
    await run(h);
    expect(h.startEgress).toHaveBeenCalledTimes(1);
    const [room, output, options] = h.startEgress.mock.calls[0] as [string, unknown, unknown];
    expect(room).toBe(ROOM);
    expect(output).toEqual({ filepath: phoneAttemptRecordingObjectKey(ATTEMPT) });
    expect(options).toEqual({ audioOnly: true, videoOnly: false });
  });

  it('finalizes with the provider id and an active egress status', async () => {
    const h = harness();
    await run(h);
    expect(h.finalize).toHaveBeenCalledTimes(1);
    expect(h.finalize.mock.calls[0][0]).toEqual({
      attemptId: ATTEMPT,
      egressStatus: 'active',
      egressId: 'EG_abcd1234',
      now: NOW,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// KEYS — including the manifest-suffix trap.
// ═══════════════════════════════════════════════════════════════════════

describe('P4 recording — the exact derived keys, manifest suffix included', () => {
  it('binds `phone-<attemptId>-egress.ogg` and `phone-<attemptId>-egress.ogg.json`', async () => {
    const h = harness();
    const res = await run(h);

    expect(res.objectKey).toBe(`phone-${ATTEMPT}-egress.ogg`);
    expect(res.manifestKey).toBe(`phone-${ATTEMPT}-egress.ogg.json`);
    expect(h.attach.mock.calls[0][0]).toEqual({
      attemptId: ATTEMPT,
      objectKey: `phone-${ATTEMPT}-egress.ogg`,
      manifestKey: `phone-${ATTEMPT}-egress.ogg.json`,
      role: 'authoritative',
      now: NOW,
    });
  });

  it('is NOT the trap name `phone-<attemptId>-egress.json`', async () => {
    // The manifest is a SECOND object beside the audio, not a sibling with the
    // extension swapped. A purge told the wrong name deletes the audio and
    // leaves behind a file that still describes, by name and duration, a call
    // the candidate refused.
    const h = harness();
    const res = await run(h);
    expect(res.manifestKey).not.toBe(`phone-${ATTEMPT}-egress.json`);
    expect(res.manifestKey).toBe(`${res.objectKey}.json`);
    expect(res.manifestKey!.endsWith('.ogg.json')).toBe(true);
  });

  it('and the egress writes to the object key, never to the manifest key', async () => {
    const h = harness();
    const res = await run(h);
    expect(h.buildOutput).toHaveBeenCalledTimes(1);
    expect(h.buildOutput.mock.calls[0][0]).toBe(res.objectKey);
    expect(h.buildOutput.mock.calls[0][0]).not.toBe(res.manifestKey);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// ROLE — first consented attempt authoritative, reconnects supplementary.
// ═══════════════════════════════════════════════════════════════════════

describe('P4 recording — role is decided from what already exists', () => {
  it('is `authoritative` when the engagement has no artifacts yet', async () => {
    const h = harness({ list: { status: 'ok', artifacts: [] } });
    const res = await run(h);
    expect(res.role).toBe('authoritative');
    expect(h.attach.mock.calls[0][0].role).toBe('authoritative');
  });

  it('is `supplementary` once an authoritative artifact exists', async () => {
    const h = harness({ list: { status: 'ok', artifacts: [authoritativeArtifact()] } });
    const res = await run(h);
    expect(res.role).toBe('supplementary');
    expect(h.attach.mock.calls[0][0].role).toBe('supplementary');
  });

  it('is `authoritative` when only SUPPLEMENTARY rows exist — not supplementary', async () => {
    // A set with only supplementary rows means the authoritative one is
    // missing, so the next binding IS the authoritative one. Asserted so the
    // predicate cannot degrade into "any artifact means supplementary".
    const h = harness({
      list: {
        status: 'ok',
        artifacts: [{ ...authoritativeArtifact(), role: 'supplementary' }],
      },
    });
    const res = await run(h);
    expect(res.role).toBe('authoritative');
  });

  const undecidable: { label: string; list: unknown }[] = [
    { label: 'not_found', list: { status: 'not_found' } },
    { label: 'unknown_status', list: { status: 'unknown_status' } },
    { label: 'ok with no artifacts array', list: { status: 'ok' } },
    { label: 'ok with an undefined artifacts array', list: { status: 'ok', artifacts: undefined } },
  ];

  for (const c of undecidable) {
    it(`refuses with role_undecidable and records nothing when the list answers ${c.label}`, async () => {
      const h = harness({ list: c.list });
      const res = await run(h);
      expect(res).toEqual({ status: 'refused', refusal: 'role_undecidable', egressStarted: false });
      // Fail closed: an unreadable enumeration is not evidence of an empty one,
      // and it certainly is not permission to record.
      expect(h.attach).not.toHaveBeenCalled();
      expect(h.startEgress).not.toHaveBeenCalled();
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// IDEMPOTENCE AND PROVIDER FAILURE.
// ═══════════════════════════════════════════════════════════════════════

describe('P4 recording — a retry of a call that already succeeded', () => {
  it('reports already_started and starts NO second egress on the same key', async () => {
    const h = harness({ attach: { status: 'ok', duplicate: true, role: 'authoritative' } });
    const res = await run(h);

    expect(res.status).toBe('already_started');
    expect(res.objectKey).toBe(phoneAttemptRecordingObjectKey(ATTEMPT));
    expect(res.manifestKey).toBe(phoneAttemptRecordingManifestKey(ATTEMPT));
    // Two egresses writing the same key is a corrupted recording AND a second
    // billable capture of a person who consented once.
    expect(h.startEgress).not.toHaveBeenCalled();
    expect(res.egressStarted).toBe(false);
    expect(h.finalize).not.toHaveBeenCalled();
  });
});

describe('P4 recording — the provider fails after the binding exists', () => {
  it('reports egress_failed with the keys still bound and nothing started', async () => {
    const h = harness({
      egress: async () => {
        throw new Error('provider exploded');
      },
    });
    const res = await run(h);

    expect(res.status).toBe('egress_failed');
    expect(res.egressStarted).toBe(false);
    // The SAFE asymmetry: a binding with no audio. The purge enumerates by
    // binding, finds a key nothing was written to, and "nothing to purge" is a
    // distinct success. The reverse — audio with no binding — is the one that
    // loses data, and step 1 makes it unrepresentable.
    expect(res.objectKey).toBe(phoneAttemptRecordingObjectKey(ATTEMPT));
    expect(res.manifestKey).toBe(phoneAttemptRecordingManifestKey(ATTEMPT));
    expect(res.role).toBe('authoritative');
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('reports orphaned when the provider accepts and returns no egress id', async () => {
    const h = harness({ egress: async () => ({}) });
    const res = await run(h);

    expect(res.status).toBe('orphaned');
    // Audio IS being captured — we simply cannot stop it by id. Reporting this
    // as `started` would tell the caller it holds a handle it does not have.
    expect(res.egressStarted).toBe(true);
    expect(res.egressId).toBeUndefined();
    expect(res.objectKey).toBe(phoneAttemptRecordingObjectKey(ATTEMPT));
    expect(h.finalize).not.toHaveBeenCalled();
  });

  it('reports orphaned when the provider returns a non-string egress id', async () => {
    const h = harness({ egress: async () => ({ egressId: 12 as unknown as string }) });
    const res = await run(h);
    expect(res.status).toBe('orphaned');
    expect(h.finalize).not.toHaveBeenCalled();
  });
});
