/**
 * P5 — `purgePhoneEngagementRecordings`, and the two failure shapes it exists
 * to make impossible:
 *
 *   1. A TERMINAL STATE COMMITTED OVER AUDIO WE FAILED TO DELETE. The
 *      engagement would look correctly opted out while the recording sat in
 *      the bucket, and nothing afterwards would ever look again. So every path
 *      that did not verifiably delete everything answers
 *      `safeToAcknowledge: false`, and the caller does not post the terminal
 *      event.
 *   2. A PURGE THAT MISSES THE RECONNECT'S AUDIO. The session-scoped key names
 *      ONE object; a reconnect is a second attempt with its own recording and
 *      its own manifest. The negative control below is built entirely around
 *      that: FOUR keys — two objects and two manifests — or the test fails.
 *
 * There is a third property here that is about what the module does NOT do:
 * it writes no suppression. 0042 writes that inside `apply_phone_event`'s
 * transaction, atomically with the terminal state, and a second writer could
 * only ever disagree with the first. `applyEvent` is therefore asserted never
 * to be called — on the happy path and on every failure path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  purgePhoneEngagementRecordings,
  type PhonePurgeDeps,
  type PhoneRecordingStorage,
} from '../integrations/livekit-phone-dial/recording-purge.js';
import {
  phoneAttemptRecordingManifestKey,
  phoneAttemptRecordingObjectKey,
  type ListPhoneEngagementRecordingsResult,
  type PhoneRecordingArtifact,
  type PhoneStores,
} from '../lib/phone-screening/index.js';

const ENGAGEMENT = '11111111-2222-4333-8444-555555555555';
const ACTOR = '99999999-9999-4999-8999-999999999999';
const FIRST_ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RECONNECT_ATTEMPT = 'aaaaaaaa-bbbb-4ccc-8ddd-ffffffffffff';
const NOW = new Date('2026-09-01T05:30:00.000Z');

const AUTH_OBJECT = phoneAttemptRecordingObjectKey(FIRST_ATTEMPT);
const AUTH_MANIFEST = phoneAttemptRecordingManifestKey(FIRST_ATTEMPT);
const SUPP_OBJECT = phoneAttemptRecordingObjectKey(RECONNECT_ATTEMPT);
const SUPP_MANIFEST = phoneAttemptRecordingManifestKey(RECONNECT_ATTEMPT);

function authoritative(): PhoneRecordingArtifact {
  return {
    attemptId: FIRST_ATTEMPT,
    role: 'authoritative',
    objectKey: AUTH_OBJECT,
    manifestKey: AUTH_MANIFEST,
  };
}

/** The reconnect's own audio. The whole reason enumeration is by ENGAGEMENT. */
function supplementary(): PhoneRecordingArtifact {
  return {
    attemptId: RECONNECT_ATTEMPT,
    role: 'supplementary',
    objectKey: SUPP_OBJECT,
    manifestKey: SUPP_MANIFEST,
  };
}

/** A shared call-order log, so ORDER is asserted rather than assumed. */
let order: string[];

beforeEach(() => {
  order = [];
});

interface Harness {
  deps: PhonePurgeDeps;
  list: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  applyEvent: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  exists?: ReturnType<typeof vi.fn>;
  removed(): string[];
}

function harness(opts: {
  list?: unknown;
  clear?: unknown;
  /** Keys the probe should still report present after a remove. */
  stillPresent?: readonly string[];
  removeThrowsOn?: string;
  existsThrowsOn?: string;
  /** Omit the probe entirely — the production seam MUST supply one. */
  noExists?: boolean;
} = {}): Harness {
  const removedKeys: string[] = [];

  const list = vi.fn(async () => {
    order.push('list');
    return (opts.list ?? {
      status: 'ok',
      artifacts: [authoritative(), supplementary()],
    }) as never;
  });
  const clear = vi.fn(async () => {
    order.push('clear');
    return (opts.clear ?? { status: 'ok', cleared: 2 }) as never;
  });
  const applyEvent = vi.fn(async () => {
    order.push('applyEvent');
    return { status: 'applied' } as never;
  });

  const unreachable = async (): Promise<never> => {
    throw new Error('phone_store_method_not_expected');
  };
  const stores = {
    listEngagementRecordings: list,
    clearAttemptRecordings: clear,
    applyEvent,
    admitAttempt: unreachable,
    heartbeatAttempt: unreachable,
    reclaimAttemptLeases: unreachable,
    scheduleAppointment: unreachable,
    cancelAppointment: unreachable,
    expireAppointments: unreachable,
    setHalt: unreachable,
    clearHalt: unreachable,
    backlog: unreachable,
    attachAttemptRecording: unreachable,
    finalizeAttemptRecording: unreachable,
  } as unknown as PhoneStores;

  const remove = vi.fn(async (key: string) => {
    order.push(`remove:${key}`);
    if (opts.removeThrowsOn === key) throw new Error('bucket refused the delete');
    removedKeys.push(key);
  });
  const exists = vi.fn(async (key: string) => {
    order.push(`exists:${key}`);
    if (opts.existsThrowsOn === key) throw new Error('bucket refused the probe');
    return (opts.stillPresent ?? []).includes(key);
  });

  const storage: PhoneRecordingStorage = opts.noExists
    ? { remove }
    : { remove, exists };

  return {
    deps: { stores, storage },
    list,
    clear,
    applyEvent,
    remove,
    exists: opts.noExists ? undefined : exists,
    removed: () => removedKeys,
  };
}

function run(h: Harness) {
  return purgePhoneEngagementRecordings(
    { engagementId: ENGAGEMENT, actorId: ACTOR, now: NOW },
    h.deps,
  );
}

/** The keys `remove` was actually asked for, in call order. */
function removeCalls(h: Harness): string[] {
  return h.remove.mock.calls.map((c) => c[0] as string);
}

// ═══════════════════════════════════════════════════════════════════════
// THE NEGATIVE CONTROL — the reconnect's audio and every manifest.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 purge — the reconnect negative control', () => {
  it('deletes ALL FOUR keys: two objects and two manifests', async () => {
    const h = harness();
    const res = await run(h);

    // The EXACT set, asserted as a set and by membership. A purge written
    // against the session key alone would delete the first recording, report
    // success, and leave the reconnect's audio — and its manifest, which still
    // describes by name and duration a call the candidate refused.
    expect(removeCalls(h)).toEqual([AUTH_OBJECT, AUTH_MANIFEST, SUPP_OBJECT, SUPP_MANIFEST]);
    expect(res.status).toBe('purged');
    expect(res.enumerated).toBe(4);
    expect(res.deleted).toBe(4);
    expect(res.safeToAcknowledge).toBe(true);
  });

  it('fails if SUPPLEMENTARY rows stop being enumerated', async () => {
    // The control for the control. If the module ever narrowed itself to the
    // authoritative artifact, the assertion above would still see two keys and
    // a `purged` status; this pins which two it must NOT be.
    const h = harness();
    await run(h);
    const keys = removeCalls(h);

    expect(keys).toContain(SUPP_OBJECT);
    expect(keys.filter((k) => k.includes(RECONNECT_ATTEMPT))).toHaveLength(2);
    // And the authoritative-only key set is explicitly NOT what happened.
    expect(keys).not.toEqual([AUTH_OBJECT, AUTH_MANIFEST]);
  });

  it('fails if MANIFEST keys stop being enumerated', async () => {
    const h = harness();
    await run(h);
    const keys = removeCalls(h);

    expect(keys).toContain(AUTH_MANIFEST);
    expect(keys).toContain(SUPP_MANIFEST);
    expect(keys.filter((k) => k.endsWith('.json'))).toHaveLength(2);
    // The object-only key set is explicitly NOT what happened.
    expect(keys).not.toEqual([AUTH_OBJECT, SUPP_OBJECT]);
  });

  it('verifies the absence of every key it removed, not just the last one', async () => {
    const h = harness();
    await run(h);
    expect(h.exists!.mock.calls.map((c) => c[0])).toEqual([
      AUTH_OBJECT,
      AUTH_MANIFEST,
      SUPP_OBJECT,
      SUPP_MANIFEST,
    ]);
  });

  it('skips only the manifest that genuinely does not exist', async () => {
    // A binding whose egress never produced a manifest carries `null`. That is
    // the ONLY reason a manifest key may be absent from the delete set — which
    // is what makes the four-key assertion above meaningful rather than a
    // coincidence of the fixture.
    const h = harness({
      list: {
        status: 'ok',
        artifacts: [{ ...authoritative(), manifestKey: null }, supplementary()],
      },
    });
    const res = await run(h);

    expect(removeCalls(h)).toEqual([AUTH_OBJECT, SUPP_OBJECT, SUPP_MANIFEST]);
    expect(res.enumerated).toBe(3);
    expect(res.deleted).toBe(3);
    expect(res.status).toBe('purged');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// EMPTY IS A SUCCESS. UNREADABLE IS NOT.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 purge — nothing to purge is a distinct success', () => {
  it('answers nothing_to_purge and removes nothing when the list is genuinely empty', async () => {
    const h = harness({ list: { status: 'ok', artifacts: [] } });
    const res = await run(h);

    expect(res).toEqual({
      status: 'nothing_to_purge',
      deleted: 0,
      enumerated: 0,
      safeToAcknowledge: true,
    });
    expect(h.remove).not.toHaveBeenCalled();
    // Nothing was deleted, so there is nothing to record either.
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe('P5 purge — an unreadable enumeration is never read as an empty one', () => {
  const unreadable: { label: string; list: ListPhoneEngagementRecordingsResult }[] = [
    { label: 'not_found', list: { status: 'not_found' } },
    { label: 'unknown_status', list: { status: 'unknown_status' } },
    { label: 'ok with NO artifacts field', list: { status: 'ok' } },
    { label: 'ok with an explicitly undefined artifacts field', list: { status: 'ok', artifacts: undefined } },
  ];

  for (const c of unreadable) {
    it(`answers enumeration_failed when the list answers ${c.label}`, async () => {
      const h = harness({ list: c.list });
      const res = await run(h);

      expect(res.status).toBe('enumeration_failed');
      expect(res.safeToAcknowledge).toBe(false);
      expect(res.enumerated).toBe(0);
      expect(res.deleted).toBe(0);
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.clear).not.toHaveBeenCalled();
    });
  }

  it('distinguishes ABSENT from EMPTY — the same counts, opposite verdicts', async () => {
    // Both answers carry zero artifacts and zero deletions. The ONLY thing
    // that separates them is whether we know, and `safeToAcknowledge` is where
    // that difference has to show up.
    const absent = await run(harness({ list: { status: 'ok' } }));
    const empty = await run(harness({ list: { status: 'ok', artifacts: [] } }));

    expect(absent.enumerated).toBe(empty.enumerated);
    expect(absent.deleted).toBe(empty.deleted);
    expect(absent.safeToAcknowledge).toBe(false);
    expect(empty.safeToAcknowledge).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// VERIFICATION — an unverified deletion is not a deletion.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 purge — without a probe, nothing is claimed and nothing is removed', () => {
  it('answers verification_unavailable and removes NOTHING when the seam has no exists', async () => {
    const h = harness({ noExists: true });
    const res = await run(h);

    expect(res.status).toBe('verification_unavailable');
    expect(res.safeToAcknowledge).toBe(false);
    expect(res.enumerated).toBe(4);
    expect(res.deleted).toBe(0);
    // It refuses BEFORE deleting anything: a delete it could not verify is
    // worse than no delete, because it looks done.
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.clear).not.toHaveBeenCalled();
  });

  it('answers verification_unavailable when the probe THROWS — that proves nothing either way', async () => {
    const h = harness({ existsThrowsOn: AUTH_MANIFEST });
    const res = await run(h);

    expect(res.status).toBe('verification_unavailable');
    expect(res.safeToAcknowledge).toBe(false);
    // The first key WAS confirmed absent before the probe failed; the count is
    // the honest partial, not a rounded-up success.
    expect(res.deleted).toBe(1);
    expect(res.enumerated).toBe(4);
    expect(removeCalls(h)).toEqual([AUTH_OBJECT, AUTH_MANIFEST]);
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe('P5 purge — a remove that succeeds on an object that is still there', () => {
  it('answers still_present — the second, quieter false success', async () => {
    // An idempotent `remove` that succeeds on a key it did not remove is
    // indistinguishable from one that did, unless somebody looks.
    const h = harness({ stillPresent: [SUPP_OBJECT] });
    const res = await run(h);

    expect(res.status).toBe('still_present');
    expect(res.safeToAcknowledge).toBe(false);
    expect(res.deleted).toBe(2);
    expect(res.enumerated).toBe(4);
    // It stops at the offending key rather than pressing on.
    expect(removeCalls(h)).toEqual([AUTH_OBJECT, AUTH_MANIFEST, SUPP_OBJECT]);
    expect(h.clear).not.toHaveBeenCalled();
  });
});

describe('P5 purge — a delete that fails stops everything downstream', () => {
  it('answers delete_failed and NEVER records the clear', async () => {
    const h = harness({ removeThrowsOn: AUTH_MANIFEST });
    const res = await run(h);

    expect(res.status).toBe('delete_failed');
    expect(res.safeToAcknowledge).toBe(false);
    expect(res.deleted).toBe(1);
    expect(res.enumerated).toBe(4);
    // The rows must keep naming the keys, or a later reader would believe the
    // audio is gone. This is the assertion that keeps step 3 behind step 2.
    expect(h.clear).not.toHaveBeenCalled();
    // And it does not carry on deleting the rest.
    expect(removeCalls(h)).toEqual([AUTH_OBJECT, AUTH_MANIFEST]);
  });
});

describe('P5 purge — the objects are gone but the rows still name them', () => {
  const clearFailures = [{ status: 'not_found' }, { status: 'unknown_status' }];

  for (const clear of clearFailures) {
    it(`answers clear_failed when the clear RPC returns ${clear.status}`, async () => {
      const h = harness({ clear });
      const res = await run(h);

      expect(res.status).toBe('clear_failed');
      expect(res.safeToAcknowledge).toBe(false);
      // The deletion DID happen and is reported honestly; retrying converges.
      expect(res.deleted).toBe(4);
      expect(res.enumerated).toBe(4);
      expect(h.clear).toHaveBeenCalledTimes(1);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════
// ORDER, AND THE WRITE THIS MODULE MUST NOT PERFORM.
// ═══════════════════════════════════════════════════════════════════════

describe('P5 purge — the happy path, in the only honest order', () => {
  it('records the clear exactly once, after every verified deletion', async () => {
    const h = harness();
    const res = await run(h);

    expect(res.status).toBe('purged');
    expect(res.deleted).toBe(res.enumerated);
    expect(res.deleted).toBe(removeCalls(h).length);
    expect(res.safeToAcknowledge).toBe(true);
    expect(h.clear).toHaveBeenCalledTimes(1);
    expect(h.clear.mock.calls[0][0]).toEqual({
      engagementId: ENGAGEMENT,
      actorId: ACTOR,
      now: NOW,
    });
  });

  it('deletes BEFORE it clears — stated on the shared call-order log', async () => {
    const h = harness();
    await run(h);

    expect(order[0]).toBe('list');
    expect(order[order.length - 1]).toBe('clear');
    // As an inequality too, so a reordering that kept the array length fails.
    for (const key of [AUTH_OBJECT, AUTH_MANIFEST, SUPP_OBJECT, SUPP_MANIFEST]) {
      expect(order.indexOf(`remove:${key}`)).toBeGreaterThanOrEqual(0);
      expect(order.indexOf(`remove:${key}`)).toBeLessThan(order.indexOf('clear'));
      expect(order.indexOf(`exists:${key}`)).toBeLessThan(order.indexOf('clear'));
      // Each key is PROBED after it is removed, not before.
      expect(order.indexOf(`remove:${key}`)).toBeLessThan(order.indexOf(`exists:${key}`));
    }
  });

  it('defaults a missing actor to null rather than inventing one', async () => {
    const h = harness();
    await purgePhoneEngagementRecordings({ engagementId: ENGAGEMENT, now: NOW }, h.deps);
    expect(h.clear.mock.calls[0][0]).toEqual({
      engagementId: ENGAGEMENT,
      actorId: null,
      now: NOW,
    });
  });
});

describe('P5 purge — this module writes NO suppression, on any path', () => {
  const paths: { label: string; opts: Parameters<typeof harness>[0] }[] = [
    { label: 'the happy path', opts: {} },
    { label: 'nothing_to_purge', opts: { list: { status: 'ok', artifacts: [] } } },
    { label: 'enumeration_failed', opts: { list: { status: 'not_found' } } },
    { label: 'verification_unavailable (no probe)', opts: { noExists: true } },
    { label: 'verification_unavailable (probe throws)', opts: { existsThrowsOn: AUTH_OBJECT } },
    { label: 'still_present', opts: { stillPresent: [AUTH_OBJECT] } },
    { label: 'delete_failed', opts: { removeThrowsOn: AUTH_OBJECT } },
    { label: 'clear_failed', opts: { clear: { status: 'not_found' } } },
  ];

  for (const p of paths) {
    it(`never calls applyEvent on ${p.label}`, async () => {
      // 0042 writes the suppression INSIDE `apply_phone_event`'s transaction,
      // atomically with the terminal state. A second writer here could only
      // ever disagree with the first, and the terminal event is the CALLER's
      // to post — only once `safeToAcknowledge` is true.
      const h = harness(p.opts);
      await run(h);
      expect(h.applyEvent).not.toHaveBeenCalled();
      expect(order).not.toContain('applyEvent');
    });
  }
});
