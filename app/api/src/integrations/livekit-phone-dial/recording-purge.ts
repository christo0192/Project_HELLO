/**
 * livekit-phone-dial/recording-purge.ts — deleting a refusing candidate's audio,
 * in the only order that is honest about what can and cannot be atomic.
 *
 * ── THIS IS NOT ATOMIC, AND SAYING SO IS THE POINT ────────────────────
 * The obligation has two halves that live in two systems:
 *
 *   * the SUPPRESSION — a Postgres write, and since the PR #91 repair it
 *     already happens INSIDE `apply_phone_event`'s transaction for
 *     `opted_out`/`wrong_number`. This module must therefore NOT write a
 *     second suppression. A second writer could only ever disagree with the
 *     first, and the transaction that owns the terminal state is the one that
 *     must own the obligation attached to it.
 *   * the DELETION — object-store calls. No transaction spans both systems.
 *
 * So "atomic" is not available and is not claimed. What IS available is a
 * DURABLE, IDEMPOTENT, VERIFIED ORDERING, and that is what this implements:
 *
 *   1. ENUMERATE   every artifact of the ENGAGEMENT — authoritative AND
 *                  supplementary, object AND manifest.
 *   2. DELETE      each one, then VERIFY its absence.
 *   3. RECORD      the verified deletion (`clear_phone_attempt_recordings`).
 *   4. ACKNOWLEDGE by posting the terminal event, whose transaction writes the
 *                  suppression atomically with the terminal state.
 *
 * If any step before 4 fails, steps 3 and 4 DO NOT RUN. The request stays
 * unacknowledged and is retried. A terminal state committed over audio we
 * failed to delete is exactly the split this substrate exists to prevent, and
 * it would be invisible afterwards — the engagement would look correctly
 * opted out while the recording sat in the bucket.
 *
 * ── WHY IT ENUMERATES BY ENGAGEMENT, NOT BY SESSION ───────────────────
 * The session-scoped key names ONE object. A reconnect is a second attempt
 * with its own audio, and a purge written against the session key alone would
 * delete the first recording, report success, and leave the reconnect's audio
 * behind. That is the failure the negative control in the test suite is built
 * around, and it is why 0043 put the keys on the ATTEMPT.
 *
 * ── "NOTHING TO PURGE" IS A DISTINCT SUCCESS ──────────────────────────
 * An engagement that never reached disclosure has no artifacts, and that is a
 * clean success — not a failure, and not an unknown. But it is reported as its
 * own status, because a delete that silently succeeds on an absent key is,
 * as `retention.ts` puts it, "a second, quieter false success". An UNREADABLE
 * enumeration is the opposite: it is never treated as empty.
 */

import type { PhoneRecordingArtifact, PhoneStores } from '../../lib/phone-screening/index.js';

/** Deletion + verification seam. Mirrors `retention.ts`'s `RecordingStorage`. */
export interface PhoneRecordingStorage {
  remove(objectKey: string): Promise<void>;
  /**
   * Absence probe. OPTIONAL in the type only so a test can prove what happens
   * without one — production MUST supply it, and a purge without it never
   * claims a verified deletion.
   */
  exists?(objectKey: string): Promise<boolean>;
}

export const PHONE_PURGE_STATUSES = [
  'purged',
  'nothing_to_purge',
  'enumeration_failed',
  'delete_failed',
  'verification_unavailable',
  'still_present',
  'clear_failed',
] as const;

export type PhonePurgeStatus = (typeof PHONE_PURGE_STATUSES)[number];

export interface PhonePurgeResult {
  readonly status: PhonePurgeStatus;
  /** Keys confirmed ABSENT after deletion. */
  readonly deleted: number;
  /** Artifacts the enumeration reported. */
  readonly enumerated: number;
  /**
   * Whether the caller may now post the terminal event. The single question
   * the caller actually needs answered, stated once rather than re-derived
   * from the status at each call site.
   */
  readonly safeToAcknowledge: boolean;
}

export interface PhonePurgeDeps {
  readonly stores: PhoneStores;
  readonly storage: PhoneRecordingStorage;
}

/**
 * Delete and verify every recording artifact of an engagement, then record
 * that it happened.
 *
 * DOES NOT post the terminal event and DOES NOT write a suppression. The
 * caller posts the event only when `safeToAcknowledge` is true, and 0042
 * writes the suppression inside that same transaction.
 */
export async function purgePhoneEngagementRecordings(
  input: { engagementId: string; actorId?: string | null; now: Date },
  deps: PhonePurgeDeps,
): Promise<PhonePurgeResult> {
  // ── 1. ENUMERATE ────────────────────────────────────────────────────
  const listed = await deps.stores.listEngagementRecordings({
    engagementId: input.engagementId,
  });
  if (listed.status !== 'ok' || listed.artifacts === undefined) {
    // We do not know what exists. Treating that as "nothing exists" is the
    // precise shape of the "we believe none was created" failure.
    return {
      status: 'enumeration_failed',
      deleted: 0,
      enumerated: 0,
      safeToAcknowledge: false,
    };
  }

  const keys = artifactKeys(listed.artifacts);
  if (keys.length === 0) {
    // A clean, distinct success: there is genuinely nothing to delete, so the
    // terminal event may be posted immediately.
    return {
      status: 'nothing_to_purge',
      deleted: 0,
      enumerated: 0,
      safeToAcknowledge: true,
    };
  }

  // ── 2. DELETE, THEN VERIFY ──────────────────────────────────────────
  if (deps.storage.exists === undefined) {
    // Without a probe we can delete but cannot VERIFY, and an unverified
    // deletion must not be reported as one. Refuse rather than claim.
    return {
      status: 'verification_unavailable',
      deleted: 0,
      enumerated: keys.length,
      safeToAcknowledge: false,
    };
  }

  let deleted = 0;
  for (const key of keys) {
    try {
      await deps.storage.remove(key);
    } catch {
      return {
        status: 'delete_failed',
        deleted,
        enumerated: keys.length,
        safeToAcknowledge: false,
      };
    }
    let present: boolean;
    try {
      present = await deps.storage.exists(key);
    } catch {
      // A probe that THREW proves nothing either way.
      return {
        status: 'verification_unavailable',
        deleted,
        enumerated: keys.length,
        safeToAcknowledge: false,
      };
    }
    if (present) {
      // The remove call returned without error and the object is still there.
      // This is exactly why the probe exists: an idempotent `remove` that
      // succeeds on a key it did not remove is indistinguishable from one that
      // did, unless somebody looks.
      return {
        status: 'still_present',
        deleted,
        enumerated: keys.length,
        safeToAcknowledge: false,
      };
    }
    deleted += 1;
  }

  // ── 3. RECORD the verified deletion ─────────────────────────────────
  const cleared = await deps.stores.clearAttemptRecordings({
    engagementId: input.engagementId,
    actorId: input.actorId ?? null,
    now: input.now,
  });
  if (cleared.status !== 'ok') {
    // The objects are gone but the rows still name them. Retrying is safe and
    // converges: the enumeration will return the same keys, the deletes are
    // idempotent, and the probes will confirm absence immediately. Until the
    // rows are cleared we do NOT acknowledge, because a caller reading those
    // rows afterwards would believe audio still exists.
    return {
      status: 'clear_failed',
      deleted,
      enumerated: keys.length,
      safeToAcknowledge: false,
    };
  }

  // ── 4. is the CALLER's, and only now ────────────────────────────────
  return {
    status: 'purged',
    deleted,
    enumerated: keys.length,
    safeToAcknowledge: true,
  };
}

/**
 * Every key that must die: the object AND the manifest, for EVERY attempt.
 *
 * The manifest is listed separately and deliberately. Deleting the recording
 * and forgetting its manifest is a documented trap this lane has already hit
 * once — `<key>.json`, not `<session>-egress.json` — and a manifest left
 * behind still describes, by name and duration, a call the candidate refused.
 */
function artifactKeys(artifacts: readonly PhoneRecordingArtifact[]): string[] {
  const keys: string[] = [];
  for (const artifact of artifacts) {
    keys.push(artifact.objectKey);
    if (artifact.manifestKey !== null) keys.push(artifact.manifestKey);
  }
  return keys;
}
