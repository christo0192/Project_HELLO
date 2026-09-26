import { createHash } from 'node:crypto';
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  type EgressInfo,
} from 'livekit-server-sdk';
import { env } from './env.js';
import { supabase } from './supabase.js';
import { phoneAttemptRecordingObjectKey } from './phone-screening/index.js';

export type RecordingFinalizeStatus = 'ready' | 'fallback_required' | 'pending';
export type AttemptRecordingFinalizeStatus = RecordingFinalizeStatus;

interface EgressClientLike {
  startRoomCompositeEgress: EgressClient['startRoomCompositeEgress'];
  stopEgress: EgressClient['stopEgress'];
  listEgress: EgressClient['listEgress'];
}

interface RecordingEgressDeps {
  client?: EgressClientLike;
  db?: typeof supabase;
  sleep?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function egressClient(): EgressClient {
  return new EgressClient(env.livekitUrl, env.livekitApiKey, env.livekitApiSecret);
}

function requireEgressConfig(): void {
  if (!env.recordingEgressEnabled) {
    if (env.recordingEgressRequired) {
      throw new Error('authoritative recording is required but egress is disabled');
    }
    return;
  }
  if (
    !env.recordingEgressS3Endpoint
    || !env.recordingEgressS3AccessKeyId
    || !env.recordingEgressS3SecretAccessKey
  ) {
    throw new Error('authoritative recording storage is not configured');
  }
}

export function authoritativeRecordingEnabled(): boolean {
  requireEgressConfig();
  return env.recordingEgressEnabled;
}

export function egressObjectKey(sessionId: string): string {
  return `${sessionId}-egress.ogg`;
}

/**
 * The canonical manifest object written by the application finalizer alongside
 * each authoritative egress file. Provider generation is disabled for phone
 * egress; the finalizer writes this key after hashing verified bytes.
 *
 * The name is `<filepath>.json`, i.e. `<session-id>-egress.ogg.json` — NOT
 * `<session-id>-egress.json`. That distinction matters: deleting the wrong key
 * against an idempotent `remove()` succeeds silently and would produce a
 * second, quieter false-success compliance record, which is precisely the
 * failure class the erasure repair exists to end.
 *
 * Pinned against `livekit-server-sdk@2.16.0` / `@livekit/protocol`: the SDK
 * does not construct the name (the egress service does), and the AUTHORITATIVE
 * value is reported back by the provider as `EgressInfo.manifestLocation`
 * (`@generated from field: string manifest_location = 23`), sitting beside
 * `FileInfo.filename` (field 1). This helper is therefore the derivation used
 * when no live `EgressInfo` is in hand (erasure runs long after the egress is
 * gone); `scripts/repair/inspect-egress.ts` prints the provider's own
 * `manifestLocation` so the derivation is OBSERVABLE rather than assumed.
 */
export function egressManifestObjectKey(sessionId: string): string {
  return `${egressObjectKey(sessionId)}.json`;
}

/**
 * Bounded reason codes for a finalization DEFERRAL.
 *
 * This list is the code-side mirror of the 0038 CHECK
 * `chk_call_sessions_recording_finalize_defer_reason`, which is the
 * AUTHORITATIVE gate. The queue's own `defer_job` reason gate is a looser
 * shape regex, so a code added here but not to the migration would defer the
 * JOB normally while failing the SESSION write — and because that write is
 * best-effort, it would fail silently and the health surface would
 * under-report. The two must always move together.
 */
export const RECORDING_FINALIZE_DEFER_REASONS = [
  'poll_timeout',
  'object_unreadable',
  'object_absent',
  'manifest_unwritable',
  'provider_error',
  'egress_identity_mismatch',
  'provenance_conflict',
  'terminal_state',
  'rpc_unknown',
  'egress_disabled',
] as const;

export type RecordingFinalizeDeferReason = typeof RECORDING_FINALIZE_DEFER_REASONS[number];

/** Outcome of the best-effort deferral bookkeeping write. */
export interface RecordingFinalizeDeferralRecord {
  /** Post-increment deferral count for this session, or null when unknown. */
  attempts: number | null;
  /** True once the session has stamped `recording_finalize_exhausted_at`. */
  exhausted: boolean;
}

/**
 * Persist ONE finalization deferral: why, when, how many times, and whether
 * the row has now given up.
 *
 * BEST-EFFORT BY CONTRACT. Before this existed, every `'pending'` return wrote
 * nothing and logged nothing while collapsing five distinct causes into one
 * silence. Recording the cause must not be able to CHANGE the cause: a failure
 * to write the marker never alters the returned `RecordingFinalizeStatus`, so
 * an observability write can never turn a converging session into a stuck one.
 *
 * The increment happens inside the RPC in a single statement, so two machines
 * racing the same session cannot lose one to a read-modify-write.
 */
async function recordFinalizeDeferral(
  db: typeof supabase,
  sessionId: string,
  reason: RecordingFinalizeDeferReason,
  maxAttempts: number,
): Promise<RecordingFinalizeDeferralRecord> {
  try {
    const { data, error } = await db.rpc('record_recording_finalize_deferral', {
      p_session_id: sessionId,
      p_reason: reason,
      p_max_attempts: maxAttempts,
    });
    if (error) return { attempts: null, exhausted: false };
    const row = (data ?? {}) as { attempts?: unknown; exhausted?: unknown };
    return {
      attempts: typeof row.attempts === 'number' && Number.isFinite(row.attempts)
        ? row.attempts
        : null,
      exhausted: row.exhausted === true,
    };
  } catch {
    return { attempts: null, exhausted: false };
  }
}

/**
 * Public seam so the queue handler can record a deferral for a cause it
 * observed OUTSIDE this module — a `listEgress` throw that the route swallows,
 * or an egress build that is not configured at all. Same best-effort contract.
 */
export async function recordRecordingFinalizeDeferral(
  sessionId: string,
  reason: RecordingFinalizeDeferReason,
  maxAttempts: number = env.recordingFinalizeMaxAttempts,
  deps: { db?: typeof supabase } = {},
): Promise<RecordingFinalizeDeferralRecord> {
  return recordFinalizeDeferral(deps.db ?? supabase, sessionId, reason, maxAttempts);
}

/**
 * Whether an egress finalize can even be ATTEMPTED on this build.
 *
 * `finalizeAuthoritativeRecording` never consulted the enable flag: with
 * `RECORDING_EGRESS_ENABLED=false` but legacy rows still carrying an egress
 * id, `egressClient()` constructs against a possibly-empty `LIVEKIT_URL` and
 * throws — which, from a queue handler, is a FAILURE, and five of those
 * dead-letter a job whose only problem is that the feature is off. The handler
 * checks this first and DEFERS instead.
 */
export function egressFinalizeConfigured(): boolean {
  if (!env.recordingEgressEnabled) return false;
  return Boolean(
    env.livekitUrl
    && env.livekitApiKey
    && env.livekitApiSecret
    && env.recordingEgressS3Endpoint
    && env.recordingEgressS3AccessKeyId
    && env.recordingEgressS3SecretAccessKey,
  );
}

// ── 0026: pure timing-anchor helpers ────────────────────────────────

/** Maximum valid epoch-ms value (year 2100, matches DB CHECK constraint). */
export const MAX_EPOCH_MS_ANCHOR = 4_102_444_800_000;

/**
 * Safely convert an EgressInfo.startedAt bigint (nanoseconds since epoch
 * on the LiveKit server clock) to epoch milliseconds.
 *
 * BigInt division happens BEFORE Number conversion: the nanosecond value
 * does NOT need to fit in Number.MAX_SAFE_INTEGER because integer division
 * by 1_000_000n yields a millisecond value (~1.7e12 for the current epoch)
 * which fits comfortably in Number safely. The result is validated against
 * MAX_EPOCH_MS_ANCHOR (year 2100 boundary).
 *
 * Returns null when startedAt is null, undefined, 0n, or produces an
 * out-of-range ms value. Never throws.
 */
export function safeEgressStartedAtMs(
  startedAt: bigint | null | undefined,
): number | null {
  if (startedAt == null) return null;
  if (typeof startedAt !== 'bigint') return null;
  if (startedAt <= 0n) return null;
  // Integer division: nanos → ms. For current epoch values (~1.7e18 ns),
  // this yields ~1.7e12 ms which is safely below MAX_SAFE_INTEGER (~9e15).
  const ms = Number(startedAt / 1_000_000n);
  if (!Number.isFinite(ms) || ms <= 0 || ms >= MAX_EPOCH_MS_ANCHOR) return null;
  return ms;
}

/**
 * Validate a possibly-unsafe epoch-ms value arriving from the database
 * (Supabase returns int8/bigint as `number` for safe values, but a
 * misconfigured parser or a manual insert could produce a `string`).
 *
 * Accepts: positive finite integer numbers (or numeric strings that parse
 * to the same) within (0, MAX_EPOCH_MS_ANCHOR). Rejects: NaN, Infinity,
 * negative, zero, boolean, non-numeric strings, floats, out-of-range.
 *
 * Returns a clean integer `number` or null. Never throws.
 */
export function validateEpochMsAnchor(
  v: unknown,
): number | null {
  if (v == null) return null;
  if (typeof v === 'boolean') return null;
  if (typeof v === 'bigint') {
    if (v <= 0n || v >= BigInt(MAX_EPOCH_MS_ANCHOR)) return null;
    return Number(v);
  }
  let n: number;
  if (typeof v === 'string') {
    // Accept only strings that unambiguously represent a positive integer
    // (no leading sign, no decimals, no whitespace, no hex).
    if (!/^[1-9]\d{0,15}$/.test(v)) return null;
    n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n >= MAX_EPOCH_MS_ANCHOR) return null;
    // Round-trip check: Number→string must match the original
    if (String(n) !== v) return null;
    return n;
  }
  if (typeof v !== 'number') return null;
  if (!Number.isFinite(v)) return null;
  if (v <= 0 || v >= MAX_EPOCH_MS_ANCHOR) return null;
  if (!Number.isInteger(v)) return null;
  return v;
}

export async function startAuthoritativeRecording(
  roomName: string,
  sessionId: string,
  deps: RecordingEgressDeps = {},
): Promise<{ status: 'disabled' | 'started'; egressId?: string }> {
  if (!authoritativeRecordingEnabled()) return { status: 'disabled' };

  const client = deps.client ?? egressClient();
  const db = deps.db ?? supabase;
  const { data: existing, error: existingError } = await db
    .from('call_sessions')
    .select('recording_egress_id')
    .eq('id', sessionId)
    .single();
  if (existingError || !existing) throw new Error('recording session not found');
  if (existing.recording_egress_id) {
    return { status: 'started', egressId: String(existing.recording_egress_id) };
  }

  const objectKey = egressObjectKey(sessionId);
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.OGG,
    filepath: objectKey,
    disableManifest: false,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: env.recordingEgressS3AccessKeyId,
        secret: env.recordingEgressS3SecretAccessKey,
        region: env.recordingEgressS3Region,
        endpoint: env.recordingEgressS3Endpoint,
        bucket: env.recordingsBucket,
        forcePathStyle: true,
      }),
    },
  });

  const info = await client.startRoomCompositeEgress(
    roomName,
    output,
    { audioOnly: true, videoOnly: false },
  );
  if (!info.egressId) throw new Error('recording egress returned no identifier');

  const { data, error } = await db
    .from('call_sessions')
    .update({
      recording_egress_id: info.egressId,
      recording_egress_status: 'active',
    })
    .eq('id', sessionId)
    .is('recording_egress_id', null)
    .select('id');

  if (error || !data || data.length !== 1) {
    await client.stopEgress(info.egressId).catch(() => undefined);
    throw new Error('recording egress could not be linked to session');
  }
  return { status: 'started', egressId: info.egressId };
}

/**
 * The terminal egress statuses, read LAZILY.
 *
 * Deliberately a function rather than a module-level constant: several suites
 * `vi.mock('livekit-server-sdk')` with a partial module, and a top-level
 * `EgressStatus.EGRESS_COMPLETE` would evaluate at import time and throw
 * before a single test ran. The original code happened to be lazy because the
 * array sat inside a function body; keeping it lazy is a requirement, not a
 * style preference.
 */
function terminalEgressStatuses(): readonly EgressStatus[] {
  return [
    EgressStatus.EGRESS_COMPLETE,
    EgressStatus.EGRESS_FAILED,
    EgressStatus.EGRESS_ABORTED,
    EgressStatus.EGRESS_LIMIT_REACHED,
  ];
}

/**
 * What ONE `listEgress` response says about OUR egress.
 *
 * There are THREE answers here, not two, and collapsing any pair of them is a
 * defect:
 *
 *  1. `terminal`          — an item matching our `egressId` reached a terminal
 *                           status. The only case that may act.
 *  2. `identity_mismatch` — the response carried items but NONE of them is
 *                           ours. That is the provider ignoring the
 *                           `egressId` filter, a shape already observed on
 *                           this provider with `limit`. Before this check,
 *                           ANOTHER session's `EGRESS_FAILED` would satisfy
 *                           the old unfiltered `find` and latch OUR row to
 *                           `'failed'` permanently.
 *  3. `not_terminal`      — either an empty response (filter honoured, not
 *                           terminal yet) or our item in a live state. This
 *                           is the ordinary healthy path and must stay
 *                           `poll_timeout`; recording it as a mismatch would
 *                           burn the attempt budget of every in-flight
 *                           session.
 */
export type EgressIdentityProbe =
  | { outcome: 'terminal'; info: EgressInfo }
  | { outcome: 'identity_mismatch' }
  | { outcome: 'not_terminal' };

export function probeEgressIdentity(
  items: readonly EgressInfo[] | null | undefined,
  egressId: string,
): EgressIdentityProbe {
  if (!items || items.length === 0) return { outcome: 'not_terminal' };
  const mine = items.find((item) => item.egressId === egressId);
  // Case 2: a non-empty answer that is not about us.
  if (!mine) return { outcome: 'identity_mismatch' };
  return terminalEgressStatuses().includes(mine.status)
    ? { outcome: 'terminal', info: mine }
    : { outcome: 'not_terminal' };
}

/** Result of polling for OUR egress to reach a terminal state. */
type TerminalEgressWait =
  | { kind: 'terminal'; info: EgressInfo }
  | { kind: 'timeout'; sawIdentityMismatch: boolean };

async function waitForTerminalEgress(
  client: EgressClientLike,
  egressId: string,
  wait: (ms: number) => Promise<void>,
): Promise<TerminalEgressWait> {
  const deadline = Date.now() + env.recordingEgressFinalizeTimeoutMs;
  let sawIdentityMismatch = false;
  while (Date.now() < deadline) {
    const items = await client.listEgress({ egressId });
    const probe = probeEgressIdentity(items, egressId);
    if (probe.outcome === 'terminal') return { kind: 'terminal', info: probe.info };
    // A mismatch is NOT a reason to stop polling — the next response may be
    // correctly filtered — but it must not be forgotten either, because it is
    // the difference between "still flushing" and "the filter is being
    // ignored and we are reading someone else's egress".
    if (probe.outcome === 'identity_mismatch') sawIdentityMismatch = true;
    await wait(500);
  }
  return { kind: 'timeout', sawIdentityMismatch };
}

/**
 * The synthetic-egress-id prefix the in-worker recorder mints (see
 * `worker-recording.ts` / `workerRecordingEgressId`). A session carrying one of
 * these has a worker-uploaded object, not a LiveKit egress, and finalizes
 * through `finalizeWorkerInbandRecording` rather than the egress poll.
 */
const WORKER_INBAND_EGRESS_ID_PREFIX = 'EG_worker_';

export function isWorkerInbandEgressId(egressId: string): boolean {
  return egressId.startsWith(WORKER_INBAND_EGRESS_ID_PREFIX);
}

/**
 * Link the same verified bytes to the attempt row for the legacy LiveKit
 * egress provider. The session finalizer remains the authority for the
 * reusable session slot, but candidate history is attempt-scoped and must not
 * infer readiness from that slot. This is deliberately a CAS with a reread:
 * a concurrent worker/session finalizer may have completed the attempt first,
 * and a parent lifecycle change must never be resurrected by this write.
 */
async function persistPhoneAttemptEvidence(
  db: typeof supabase,
  attemptId: string,
  sessionId: string,
  objectKey: string,
  manifestKey: string,
  sha256: string,
  sizeBytes: number,
  contentType: 'audio/ogg' | 'audio/mpeg',
): Promise<void> {
  const { data: parent, error: parentError } = await db
    .from('call_sessions')
    .select('recording_revoked_at,recording_quarantined,recording_deleted_at')
    .eq('id', sessionId)
    .maybeSingle();
  if (parentError || !parent || parent.recording_revoked_at || parent.recording_deleted_at || parent.recording_quarantined === true) {
    throw new Error('phone_attempt_parent_lifecycle_blocked');
  }
  const { data: linked, error: linkError } = await db
    .from('phone_call_attempts')
    .update({
      recording_session_id: sessionId,
      recording_sha256: sha256,
      recording_size_bytes: sizeBytes,
      recording_content_type: contentType,
      recording_ready: true,
      egress_status: 'complete',
    })
    .eq('id', attemptId)
    .is('recording_ready', false)
    .is('recording_quarantined', false)
    .is('recording_deleted_at', null)
    .select('id');
  if (linkError) throw new Error('phone_attempt_evidence_link_failed');
  if (linked && linked.length > 0) return;

  const { data: reread, error: rereadError } = await db
    .from('phone_call_attempts')
    .select('recording_session_id,recording_object_key,recording_manifest_key,recording_sha256,recording_size_bytes,recording_content_type,recording_ready,recording_quarantined,recording_deleted_at')
    .eq('id', attemptId)
    .maybeSingle();
  if (rereadError || !reread
      || reread.recording_session_id !== sessionId
      || reread.recording_object_key !== objectKey
      || reread.recording_manifest_key !== manifestKey
      || reread.recording_sha256 !== sha256
      || reread.recording_size_bytes !== sizeBytes
      || reread.recording_content_type !== contentType
      || reread.recording_ready !== true
      || reread.recording_quarantined === true
      || reread.recording_deleted_at) {
    throw new Error('phone_attempt_evidence_link_not_converged');
  }
}

/**
 * Sniff the AUDIO container of a worker-uploaded object from its leading magic
 * bytes, so the finalizer records the recording's REAL content type instead of
 * assuming MP3.
 *
 * WHY (live v114, 2026-09-04): the in-worker recorder normally uploads an MP3,
 * but when the OGG→MP3 transcode dies on a sample/channel desync it now falls
 * back to uploading the RAW OGG rather than losing the audio. The object key is
 * the same `.mp3` key either way (the presigned URL is minted for one key), so
 * the key is NOT a reliable type signal — the bytes are. An OGG file starts
 * with the ASCII capture pattern `OggS`; anything else finalizes as `audio/mpeg`
 * (MP3 has no single universal magic — `ID3` tags, or a `0xFF 0xEx/Fx` frame
 * sync — so MP3 is the correct default, and an `audio/ogg` result is the
 * QA-visible "this was the fallback, the transcode failed" marker). This reads
 * the object's own bytes and trusts no client-declared header.
 */
export function sniffRecordingContentType(bytes: Buffer): 'audio/ogg' | 'audio/mpeg' {
  // "OggS" — the Ogg page capture pattern at byte 0 of every Ogg stream.
  if (
    bytes.length >= 4
    && bytes[0] === 0x4f && bytes[1] === 0x67
    && bytes[2] === 0x67 && bytes[3] === 0x53
  ) {
    return 'audio/ogg';
  }
  return 'audio/mpeg';
}

/**
 * Attempt evidence has a stricter gate than the historical session finalizer.
 * A non-empty object is not necessarily audio: require a known Ogg capture
 * pattern, an ID3-tagged MP3, or an MPEG frame sync before marking it ready.
 * The worker's reported digest, size and manifest are advisory; this function
 * is deliberately based only on bytes read back from storage.
 */
export function verifiedPhoneContentType(bytes: Buffer): 'audio/ogg' | 'audio/mpeg' | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from('OggS'))) {
    return 'audio/ogg';
  }
  if (bytes.length >= 4 && bytes.subarray(0, 3).equals(Buffer.from('ID3'))) {
    return 'audio/mpeg';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }
  return null;
}

export interface RecordingManifestExpectation {
  objectKey: string;
  contentType: 'audio/ogg' | 'audio/mpeg';
  sha256: string;
  sizeBytes: number;
  egressId: string | null;
}

/**
 * The manifest's durable identity is the object, container, digest, size and
 * egress. Duration/finalized_at are optional enrichment written by the
 * provider-aware finalizer, so two finalizers cannot reject the same verified
 * bytes merely because one ran before provider timing was available.
 */
export function recordingManifestMatches(
  bytes: Buffer,
  expected: RecordingManifestExpectation,
): boolean {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    return value.schema_version === 1
      && value.object_key === expected.objectKey
      && value.content_type === expected.contentType
      && value.sha256 === expected.sha256
      && value.size_bytes === expected.sizeBytes
      && (value.egress_id ?? null) === expected.egressId
      && (value.provider_duration_ms === undefined
        || value.provider_duration_ms === null
        || (typeof value.provider_duration_ms === 'number' && Number.isSafeInteger(value.provider_duration_ms)))
      && (value.finalized_at === undefined
        || value.finalized_at === null
        || typeof value.finalized_at === 'string');
  } catch {
    return false;
  }
}

function canonicalRecordingManifest(expected: RecordingManifestExpectation, enrichment: {
  providerDurationMs?: number | null;
  finalizedAt?: string | null;
} = {}): Buffer {
  return Buffer.from(JSON.stringify({
    schema_version: 1,
    object_key: expected.objectKey,
    content_type: expected.contentType,
    sha256: expected.sha256,
    size_bytes: expected.sizeBytes,
    provider_duration_ms: enrichment.providerDurationMs ?? null,
    egress_id: expected.egressId,
    finalized_at: enrichment.finalizedAt ?? null,
  }));
}

/**
 * Finalize one worker-uploaded attempt without requiring the reusable session
 * recording slot to have been stamped. This is the gate-death path: the
 * attempt key is authoritative, while the session remains reusable across
 * legs and is intentionally not claimed by a pre-consent attempt.
 */
export async function finalizeWorkerInbandAttemptRecording(
  attemptId: string,
  deps: RecordingEgressDeps = {},
  expectedSessionId?: string,
): Promise<AttemptRecordingFinalizeStatus> {
  const db = deps.db ?? supabase;
  const { data: attempt, error } = await db
    .from('phone_call_attempts')
    .select('session_id,recording_session_id,recording_object_key, recording_manifest_key, recording_ready, recording_quarantined, recording_deleted_at, egress_id, egress_status')
    .eq('id', attemptId)
    .maybeSingle();
  if (error || !attempt) throw new Error('phone recording attempt not found');
  if (expectedSessionId !== undefined && attempt.recording_session_id !== expectedSessionId) return 'fallback_required';
  if (attempt.recording_ready === true) {
    if (attempt.recording_quarantined === true || attempt.recording_deleted_at || !attempt.recording_session_id) {
      return 'fallback_required';
    }
    const { data: readyParent, error: readyParentError } = await db
      .from('call_sessions')
      .select('recording_revoked_at,recording_quarantined,recording_deleted_at')
      .eq('id', attempt.recording_session_id)
      .maybeSingle();
    if (readyParentError || !readyParent || readyParent.recording_revoked_at
      || readyParent.recording_deleted_at || readyParent.recording_quarantined === true) {
      return 'fallback_required';
    }
    return 'ready';
  }
  if (attempt.recording_quarantined === true || attempt.recording_deleted_at) return 'fallback_required';
  if (!attempt.recording_object_key || attempt.egress_status === 'failed') return 'fallback_required';
  if (!attempt.recording_session_id) return 'fallback_required';

  const { data: parentSession, error: parentError } = await db
    .from('call_sessions')
    .select('recording_revoked_at,recording_quarantined,recording_deleted_at')
    .eq('id', attempt.recording_session_id)
    .maybeSingle();
  if (parentError || !parentSession) return 'fallback_required';
  if (parentSession.recording_revoked_at || parentSession.recording_deleted_at || parentSession.recording_quarantined === true) {
    return 'fallback_required';
  }

  const objectKey = String(attempt.recording_object_key);
  const manifestKey = typeof attempt.recording_manifest_key === 'string'
    ? attempt.recording_manifest_key
    : null;
  if (objectKey !== phoneAttemptRecordingObjectKey(attemptId)
      || manifestKey !== `${objectKey}.json`) {
    return 'fallback_required';
  }

  let downloaded: { data?: Blob | ArrayBuffer | Buffer | null; error?: { message?: string } | null };
  try {
    downloaded = await db.storage.from(env.recordingsBucket).download(objectKey);
  } catch {
    return 'pending';
  }
  if (downloaded.error || downloaded.data == null) return 'pending';

  let bytes: Buffer;
  try {
    const data = downloaded.data;
    bytes = Buffer.isBuffer(data)
      ? data
      : data instanceof ArrayBuffer
        ? Buffer.from(data)
        : Buffer.from(await data.arrayBuffer());
  } catch {
    return 'pending';
  }
  if (bytes.length === 0 || bytes.length > env.recordingMaxBytes) return 'fallback_required';
  const contentType = verifiedPhoneContentType(bytes);
  if (!contentType) return 'fallback_required';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const manifestExpectation: RecordingManifestExpectation = {
    objectKey,
    contentType,
    sha256,
    sizeBytes: bytes.length,
    egressId: typeof attempt.egress_id === 'string' ? attempt.egress_id : null,
  };
  const manifest = canonicalRecordingManifest(manifestExpectation);
  const bucket = db.storage.from(env.recordingsBucket);
  const uploaded = await bucket.upload(manifestKey, manifest, {
    contentType: 'application/json',
    upsert: false,
  });
  if (uploaded.error) {
    let existing: { data?: Blob | ArrayBuffer | Buffer | null; error?: { message?: string } | null };
    try {
      existing = await bucket.download(manifestKey);
    } catch {
      return 'pending';
    }
    if (existing.error || existing.data == null) return 'pending';
    try {
      const existingBytes = Buffer.isBuffer(existing.data)
        ? existing.data
        : existing.data instanceof ArrayBuffer
          ? Buffer.from(existing.data)
          : Buffer.from(await existing.data.arrayBuffer());
      if (!recordingManifestMatches(existingBytes, manifestExpectation)) return 'fallback_required';
    } catch {
      return 'pending';
    }
  }

  const { data: linked, error: linkError } = await db
    .from('phone_call_attempts')
    .update({
      recording_sha256: sha256,
      recording_size_bytes: bytes.length,
      recording_content_type: contentType,
      recording_ready: true,
      egress_status: 'complete',
    })
    .eq('id', attemptId)
    .is('recording_ready', false)
    .is('recording_quarantined', false)
    .is('recording_deleted_at', null)
    .select('id');
  if (linkError) return 'pending';
  if (linked && linked.length > 0) return 'ready';
  const { data: reread, error: rereadError } = await db
    .from('phone_call_attempts')
    .select('recording_ready,recording_quarantined,recording_deleted_at,recording_session_id')
    .eq('id', attemptId)
    .maybeSingle();
  if (rereadError || !reread) return 'fallback_required';
  if (reread.recording_ready === true && reread.recording_quarantined !== true && !reread.recording_deleted_at) {
    const { data: parentAfter, error: parentAfterError } = await db
      .from('call_sessions')
      .select('recording_revoked_at,recording_quarantined,recording_deleted_at')
      .eq('id', reread.recording_session_id)
      .maybeSingle();
    if (!parentAfterError && parentAfter
      && !parentAfter.recording_revoked_at
      && !parentAfter.recording_deleted_at
      && parentAfter.recording_quarantined !== true) return 'ready';
  }
  return 'fallback_required';
}

/**
 * PR A — finalize a WORKER-INBAND recording.
 *
 * The worker already recorded the call, transcoded it to MP3, and PUT it to the
 * attempt-scoped object key. There is therefore NO egress to stop or poll: this
 * does exactly the tail of the egress branch — download the object, enforce the
 * size cap, SHA-256 it, write the canonical `<object>.json` manifest, and link
 * the integrity columns — but sets `recording_provenance = 'worker_inband'`
 * (0078) and writes the session columns directly, because
 * `finalize_authoritative_recording` (0054) hard-codes `livekit_egress` and
 * would answer `provenance_conflict` for this origin.
 *
 * Deferral/latch semantics MIRROR the egress branch: a zero-byte or unreadable
 * download is a bounded DEFERRAL (transient storage), an oversize object is a
 * deterministic latch to `failed` (`fallback_required`), a bad manifest is a
 * deferral, and a converged session clears the deferral markers on the way out.
 * Idempotent: a second finalize of an already-linked worker recording returns
 * `ready` from the caller before this function is reached.
 */
export async function finalizeWorkerInbandRecording(
  sessionId: string,
  deps: RecordingEgressDeps = {},
): Promise<RecordingFinalizeStatus> {
  const db = deps.db ?? supabase;
  const maxAttempts = env.recordingFinalizeMaxAttempts;
  const defer = async (reason: RecordingFinalizeDeferReason): Promise<'pending'> => {
    const record = await recordFinalizeDeferral(db, sessionId, reason, maxAttempts);
    // A worker-inband recording that exhausted its deferrals has no other
    // recovery path (the worker deleted its local audio at finish()) — leaving
    // the status `active` forever showed "Recording is still processing" for a
    // recording that will never arrive (live 2026-09-03, EG_worker_a6cc612d).
    // Latch to `failed` so the surface is truthful; the audited
    // `reopen_recording_finalize` RPC remains the reset lifecycle.
    if (record.exhausted) {
      await db.from('call_sessions')
        .update({ recording_egress_status: 'failed' })
        .eq('id', sessionId)
        .is('recording_object_key', null);
    }
    return 'pending';
  };

  // Re-read the egress id so the attempt binding lookup uses the SAME id the
  // 0051 stamp wrote. A worker recording is always a `live` (phone) session and
  // its object key is owned by the bound attempt, never guessed.
  const { data: session, error } = await db
    .from('call_sessions')
    .select('recording_egress_id, recording_object_key, recording_provenance, recording_egress_status, recording_revoked_at, recording_quarantined, recording_deleted_at')
    .eq('id', sessionId)
    .single();
  if (error || !session) throw new Error('recording session not found');
  if (session.recording_revoked_at || session.recording_deleted_at || session.recording_quarantined === true) {
    return 'fallback_required';
  }
  if (session.recording_object_key) return 'ready';
  if (!session.recording_egress_id) return 'fallback_required';
  // Latched failed — the worker reported the upload permanently lost (or the
  // deferrals exhausted). There is nothing to download; do not spend another
  // retry cycle misreading the absence as `object_unreadable`.
  if (session.recording_egress_status === 'failed') return 'fallback_required';
  const egressId = String(session.recording_egress_id);

  const { data: attempt, error: attemptError } = await db
    .from('phone_call_attempts')
    .select('id,recording_object_key, recording_manifest_key')
    .or(`session_id.eq.${sessionId},recording_session_id.eq.${sessionId}`)
    .eq('egress_id', egressId)
    .not('recording_object_key', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (attemptError) throw new Error('phone recording binding read failed');
  if (!attempt?.recording_object_key) return defer('object_absent');
  const objectKey = String(attempt.recording_object_key);
  const manifestKey = typeof attempt.recording_manifest_key === 'string'
    ? attempt.recording_manifest_key
    : null;

  const { data: object, error: downloadError } = await db.storage
    .from(env.recordingsBucket)
    .download(objectKey);
  if (downloadError) return defer('object_unreadable');
  if (!object) return defer('object_absent');
  const bytes = Buffer.from(await object.arrayBuffer());
  // Same latch split as the egress branch: a zero-byte read is STORAGE
  // evidence (transient) → bounded deferral; an oversize object is a
  // DETERMINISTIC property of the bytes → latch to `failed`.
  if (bytes.length === 0) return defer('object_unreadable');
  // v114 (2026-09-04): record the object's REAL container type. A clean upload
  // is an MP3 (`audio/mpeg`); the worker's raw-OGG transcode-failure fallback
  // is an `audio/ogg` object at the SAME `.mp3` key, so we sniff the bytes
  // rather than assume. An `audio/ogg` worker_inband recording is the QA signal
  // that the MP3 transcode failed but the audio was retained.
  const contentType = sniffRecordingContentType(bytes);
  if (bytes.length > env.recordingMaxBytes) {
    await db.from('call_sessions')
      .update({ recording_egress_status: 'failed' })
      .eq('id', sessionId);
    return 'fallback_required';
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // The manifest has exactly one writer: this finalizer. Verify an existing
  // object by exact canonical bytes so retries are idempotent.
  if (manifestKey !== `${objectKey}.json`) return defer('manifest_unwritable');
  const manifest = Buffer.from(JSON.stringify({
    schema_version: 1,
    object_key: objectKey,
    content_type: contentType,
    sha256,
    size_bytes: bytes.length,
    provider_duration_ms: null,
    egress_id: egressId,
    finalized_at: null,
  }));
  const bucket = db.storage.from(env.recordingsBucket);
  const uploaded = await bucket.upload(manifestKey, manifest, {
    contentType: 'application/json',
    upsert: false,
  });
  if (uploaded.error) {
    const existing = await bucket.download(manifestKey);
    if (existing.error || !existing.data) return defer('manifest_unwritable');
    const existingBytes = Buffer.from(await existing.data.arrayBuffer());
    if (!existingBytes.equals(manifest)) return defer('manifest_unwritable');
  }

  // Link the integrity columns directly. `finalize_authoritative_recording`
  // cannot be used: it forces `livekit_egress` provenance and rejects any other
  // non-null origin. The write is conditioned on a still-null object key so two
  // finalizers racing the same session cannot both link (the loser's update
  // matches zero rows and it falls through to the idempotent `ready`).
  const { data: linked, error: linkError } = await db
    .from('call_sessions')
    .update({
      recording_object_key: objectKey,
      recording_sha256: sha256,
      recording_size_bytes: bytes.length,
      recording_content_type: contentType,
      recording_provenance: 'worker_inband',
      recording_egress_status: 'complete',
      recording_finalize_defer_reason: null,
      recording_finalize_exhausted_at: null,
    })
    .eq('id', sessionId)
    .is('recording_object_key', null)
    .select('id');
  if (linkError) return defer('rpc_unknown');
  // Whether THIS update linked the row (one row) or a concurrent finalizer
  // linked it first (zero rows), the outcome is the same: the object is linked.
  // `linked` is referenced so the CAS result is not silently discarded — a
  // future reader can distinguish the winner from the loser here if needed.
  void linked;
  return 'ready';
}

/**
 * Latch a WORKER-INBAND recording as permanently failed on the worker's own
 * report.
 *
 * The worker deletes its local OGG/MP3 inside `finish()`'s cleanup, so a failed
 * close/transcode/upload can never be retried from the worker side — yet before
 * this existed the failure was reported to NOBODY: the finalizer kept
 * re-downloading an object that was never PUT, misread every 404 as
 * `object_unreadable`, exhausted its deferrals, and the session sat at
 * `recording_egress_status='active'` ("Recording is still processing") forever
 * (live 2026-09-03, `EG_worker_a6cc612d`). Guarded: only a worker-inband
 * egress id may be latched, and never over a linked object. The audited
 * `reopen_recording_finalize` RPC remains the only path back to `active`.
 */
export async function markWorkerRecordingFailed(
  sessionId: string,
  attemptId: string,
  deps: RecordingEgressDeps = {},
): Promise<
  | 'failed_latched'
  | 'already_linked'
  | 'not_worker_inband'
  | 'attempt_mismatch'
  | 'session_not_found'
  | 'latch_failed'
> {
  const db = deps.db ?? supabase;
  const { data: session, error } = await db
    .from('call_sessions')
    .select('recording_egress_id, recording_object_key, recording_revoked_at, recording_quarantined, recording_deleted_at, recording_egress_status')
    .eq('id', sessionId)
    .single();
  if (error || !session) return 'session_not_found';
  // A parent lifecycle terminal state is inherited by every attempt. Do this
  // before either CAS so a late worker report cannot resurrect evidence.
  if (session.recording_revoked_at || session.recording_quarantined === true || session.recording_deleted_at) {
    return 'already_linked';
  }

  // The attempt is the authority for this report. `recording_session_id` is
  // the 0107 evidence-only binding; `session_id` is accepted only for legacy
  // consenting attempts that predate that column. Never use the worker's
  // supplied session id to create this binding.
  const { data: attempt, error: attemptError } = await db
    .from('phone_call_attempts')
    .select('session_id,recording_session_id,egress_id,egress_status,recording_ready,recording_quarantined,recording_deleted_at')
    .eq('id', attemptId)
    .maybeSingle();
  if (attemptError || !attempt) return 'not_worker_inband';
  const boundSessionId = attempt.recording_session_id ?? attempt.session_id;
  if (boundSessionId !== sessionId) return 'attempt_mismatch';
  const attemptEgressId = typeof attempt.egress_id === 'string' ? attempt.egress_id : '';
  if (attemptEgressId !== `${WORKER_INBAND_EGRESS_ID_PREFIX}${attemptId}`) return 'not_worker_inband';
  if (attempt.recording_ready === true || attempt.recording_quarantined === true || attempt.recording_deleted_at) {
    return 'already_linked';
  }

  // Latch the requested attempt independently. In particular, a supplementary
  // attempt must not be hidden by a verified primary already on the parent.
  const { data: latchedAttempt, error: latchAttemptError } = await db.from('phone_call_attempts')
    .update({ egress_status: 'failed', recording_ready: false })
    .eq('id', attemptId)
    .eq('egress_id', attemptEgressId)
    .is('recording_ready', false)
    .is('recording_quarantined', false)
    .is('recording_deleted_at', null)
    .not('egress_status', 'in', '(complete,failed)')
    .select('id');
  if (latchAttemptError) return 'latch_failed';
  if (!latchedAttempt || latchedAttempt.length === 0) {
    // CAS=0 is not proof of success. Only report an already-latched/terminal
    // state after a readback; an unknown race stays a hard failure.
    const { data: current, error: currentError } = await db
      .from('phone_call_attempts')
      .select('egress_status,recording_ready,recording_quarantined,recording_deleted_at')
      .eq('id', attemptId)
      .maybeSingle();
    if (!currentError && current && (current.recording_ready === true
      || current.recording_quarantined === true
      || current.recording_deleted_at
      || current.egress_status === 'failed')) return 'already_linked';
    return 'latch_failed';
  }

  // Only the attempt which owns the current, still-unstamped worker primary
  // may transition the reusable session. Existing audio, another attempt's
  // primary, and gate-death's null session slot all remain untouched.
  if (session.recording_egress_id === attemptEgressId
      && !session.recording_object_key
      && !['complete', 'ready', 'failed'].includes(String(session.recording_egress_status ?? ''))) {
    const { data: latchedSession, error: latchSessionError } = await db.from('call_sessions')
      .update({
        recording_egress_status: 'failed',
        // Bounded 0038 CHECK vocabulary; the detailed worker reason is audit-only.
        recording_finalize_defer_reason: 'provider_error',
      })
      .eq('id', sessionId)
      .eq('recording_egress_id', attemptEgressId)
      .is('recording_object_key', null)
      .is('recording_revoked_at', null)
      .is('recording_deleted_at', null)
      .eq('recording_quarantined', false)
      .select('id');
    if (latchSessionError) return 'latch_failed';
    if (!latchedSession || latchedSession.length === 0) {
      // The attempt is truthfully failed, but the parent mutation did not
      // prove its CAS. Do not claim a both-rows latch under an unknown race.
      return 'latch_failed';
    }
  }
  return 'failed_latched';
}


export async function finalizeAuthoritativeRecording(
  sessionId: string,
  deps: RecordingEgressDeps = {},
): Promise<RecordingFinalizeStatus> {
  const db = deps.db ?? supabase;
  const { data: session, error } = await db
    .from('call_sessions')
    .select('recording_object_key, recording_provenance, recording_egress_id, recording_egress_status, recording_revoked_at, recording_quarantined, recording_deleted_at, mode')
    .eq('id', sessionId)
    .single();
  if (error || !session) throw new Error('recording session not found');
  if (session.recording_revoked_at || session.recording_deleted_at || session.recording_quarantined === true) {
    return 'fallback_required';
  }
  // ── PR A: the WORKER-INBAND branch ──────────────────────────────────
  // A session whose egress id was minted by the in-worker recorder (0051
  // stamp with the synthetic `EG_worker_` id) has NO LiveKit egress to stop or
  // poll — the worker already uploaded the MP3 to the derived object key. Route
  // it to the branch that downloads + hashes + size-checks + manifests + links
  // that object directly. The default `egress` provider never mints this id, so
  // this dispatch is inert unless a deployment opted into `RECORDING_PROVIDER=
  // worker`. Guarded by `!recording_object_key` so an already-linked worker
  // recording (a completed finalize, or an idempotent retry) is `ready` without
  // re-downloading.
  if (
    typeof session.recording_egress_id === 'string'
    && isWorkerInbandEgressId(session.recording_egress_id)
  ) {
    if (session.recording_object_key) return 'ready';
    return finalizeWorkerInbandRecording(sessionId, deps);
  }
  // I‑1: a linked key is only authoritative when it came from the egress.
  // A browser_upload key with a live egress must fall through and be repointed.
  if (
    session.recording_object_key
    && session.recording_provenance === 'livekit_egress'
    && session.mode !== 'live'
  ) return 'ready';
  if (!session.recording_egress_id) {
    // No egress to defer to. An already-linked key (legacy row, or a fallback
    // the server previously licensed) is final — asking for another upload
    // would only earn a 409. Otherwise the browser copy is the last resort.
    return session.recording_object_key ? 'ready' : 'fallback_required';
  }

  const maxAttempts = env.recordingFinalizeMaxAttempts;
  const defer = async (reason: RecordingFinalizeDeferReason): Promise<'pending'> => {
    await recordFinalizeDeferral(db, sessionId, reason, maxAttempts);
    return 'pending';
  };

  const client = deps.client ?? egressClient();
  const egressId = String(session.recording_egress_id);
  let objectKey = egressObjectKey(sessionId);
  let manifestKey: string | null = null;
  let phoneAttemptId: string | null = null;
  let contentType = 'audio/ogg';

  // Phone egress writes an attempt-scoped MP3. The session row stores the
  // provider egress id, but the object key is owned by the bound attempt. Do
  // not guess the browser OGG key for a live phone session: that turns a
  // successfully captured call into an exhausted `object_unreadable` loop.
  if (session.mode === 'live') {
    const { data: attempt, error: attemptError } = await db
      .from('phone_call_attempts')
      .select('id,recording_object_key, recording_manifest_key')
      .eq('session_id', sessionId)
      .eq('egress_id', egressId)
      .not('recording_object_key', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (attemptError) throw new Error('phone recording binding read failed');
    if (!attempt?.recording_object_key) return defer('object_absent');
    phoneAttemptId = typeof attempt.id === 'string' ? attempt.id : null;
    objectKey = String(attempt.recording_object_key);
    manifestKey = typeof attempt.recording_manifest_key === 'string'
      ? attempt.recording_manifest_key
      : null;
    contentType = 'audio/mpeg';
  }

  await client.stopEgress(egressId).catch(() => undefined);
  const waited = await waitForTerminalEgress(client, egressId, deps.sleep ?? sleep);
  if (waited.kind === 'timeout') {
    // Three-way, per `probeEgressIdentity`: a response that carried items but
    // none of ours is a DIFFERENT fact from a quiet, correctly-filtered wait.
    return defer(waited.sawIdentityMismatch ? 'egress_identity_mismatch' : 'poll_timeout');
  }
  const info = waited.info;
  if (info.status !== EgressStatus.EGRESS_COMPLETE) {
    // Genuine PROVIDER evidence about OUR egress (FAILED / ABORTED /
    // LIMIT_REACHED). This may latch: the provider has spoken about this
    // egress and retrying cannot change its answer.
    await db.from('call_sessions').update({ recording_egress_status: 'failed' }).eq('id', sessionId);
    return 'fallback_required';
  }

  const { data: object, error: downloadError } = await db.storage
    .from(env.recordingsBucket)
    .download(objectKey);
  if (downloadError) return defer('object_unreadable');
  if (!object) return defer('object_absent');
  const bytes = Buffer.from(await object.arrayBuffer());
  // ── The latch split ──────────────────────────────────────────────────
  // A ZERO-BYTE download is evidence about STORAGE, not about the egress: a
  // transient S3 5xx, an eventually-consistent read, or a finalize racing the
  // object's own write all produce it, and latching `'failed'` on it turned a
  // recoverable moment into permanent loss of a recording that exists.
  // It becomes a deferral.
  //
  // OVERSIZE keeps latching. An object larger than `recordingMaxBytes` is a
  // DETERMINISTIC property of the bytes that will not improve with retries,
  // and deferring it would burn the whole attempt budget for nothing.
  //
  // This is a deliberate weakening of a one-way door, and it ships in the same
  // change as its mitigation: the deferral is bounded by
  // `RECORDING_FINALIZE_MAX_ATTEMPTS` and terminated by
  // `recording_finalize_exhausted_at`, and `reopen_recording_finalize` is the
  // audited way back for anything that did latch.
  if (bytes.length === 0) return defer('object_unreadable');
  if (bytes.length > env.recordingMaxBytes) {
    await db.from('call_sessions').update({ recording_egress_status: 'failed' }).eq('id', sessionId);
    return 'fallback_required';
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Phone manifests have exactly one writer: this finalizer. Write only after
  // the MP3 bytes are bounded and hashed, and verify an existing object by
  // exact canonical bytes so retries are idempotent rather than overwriting.
  if (session.mode === 'live') {
    if (manifestKey !== `${objectKey}.json`) return defer('manifest_unwritable');
    const manifestInfo = info as unknown as {
      duration?: bigint | null;
      endedAt?: bigint | null;
    };
    const durationMs = typeof manifestInfo.duration === 'bigint' && manifestInfo.duration > 0n
      ? Number(manifestInfo.duration / 1_000_000n)
      : null;
    const endedMs = typeof manifestInfo.endedAt === 'bigint' && manifestInfo.endedAt > 0n
      ? Number(manifestInfo.endedAt / 1_000_000n)
      : null;
    const manifestExpectation: RecordingManifestExpectation = {
      objectKey,
      contentType: contentType as 'audio/ogg' | 'audio/mpeg',
      sha256,
      sizeBytes: bytes.length,
      egressId,
    };
    const manifest = canonicalRecordingManifest(manifestExpectation, {
      providerDurationMs: Number.isSafeInteger(durationMs) ? durationMs : null,
      finalizedAt: Number.isSafeInteger(endedMs)
        ? new Date(endedMs as number).toISOString()
        : null,
    });
    const bucket = db.storage.from(env.recordingsBucket);
    const uploaded = await bucket.upload(manifestKey, manifest, {
      contentType: 'application/json',
      upsert: false,
    });
    if (uploaded.error) {
      const existing = await bucket.download(manifestKey);
      if (existing.error || !existing.data) return defer('manifest_unwritable');
      const existingBytes = Buffer.from(await existing.data.arrayBuffer());
      if (!recordingManifestMatches(existingBytes, manifestExpectation)) return defer('manifest_unwritable');
    }
  }

  // ── 0026: authoritative recording-timeline origin ──────────────────
  // EgressInfo.startedAt is bigint nanoseconds on the LiveKit server
  // clock. safeEgressStartedAtMs performs integer division by 1_000_000n
  // BEFORE Number conversion, so the nanosecond magnitude (~1.7e18) never
  // needs to fit in Number; only the resulting ms value (~1.7e12) does.
  // Invalid, zero, or out-of-range values degrade to null rather than
  // throwing or causing finalization fallback.
  const egressStartedAtMs = safeEgressStartedAtMs(info.startedAt);

  const { data: rpcData, error: rpcError } = await db.rpc('finalize_authoritative_recording', {
    p_session_id: sessionId,
    p_object_key: objectKey,
    p_sha256: sha256,
    p_size_bytes: bytes.length,
    p_content_type: contentType,
    p_correlation_id: null,
    p_recording_egress_started_at_ms: egressStartedAtMs,
  });
  if (rpcError) throw new Error('recording egress finalization failed');
  const rpcStatus = (rpcData as { status?: string } | null)?.status;
  if (rpcStatus === 'already_authoritative') {
    if (session.mode === 'live' && phoneAttemptId !== null && manifestKey !== null) {
      await persistPhoneAttemptEvidence(db, phoneAttemptId, sessionId, objectKey, manifestKey, sha256, bytes.length, contentType as 'audio/ogg' | 'audio/mpeg');
    }
    return 'ready';
  }
  if (rpcStatus === 'provenance_conflict') {
    // Row has provenance that cannot be upgraded to livekit_egress.
    // If a key exists, it stays as-is (ready); otherwise pending.
    const { data: current } = await db
      .from('call_sessions')
      .select('recording_object_key')
      .eq('id', sessionId)
      .single();
    if (current?.recording_object_key) {
      if (session.mode === 'live' && phoneAttemptId !== null && manifestKey !== null) {
        await persistPhoneAttemptEvidence(db, phoneAttemptId, sessionId, objectKey, manifestKey, sha256, bytes.length, contentType as 'audio/ogg' | 'audio/mpeg');
      }
      return 'ready';
    }
    return defer('provenance_conflict');
  }
  if (rpcStatus !== 'ok') {
    if (rpcStatus === 'terminal_state') {
      // Session is in a terminal recording state — cannot be repointed.
      // If a key exists, it stays as-is (ready); otherwise pending.
      const { data: current } = await db
        .from('call_sessions')
        .select('recording_object_key')
        .eq('id', sessionId)
        .single();
      if (current?.recording_object_key) return 'ready';
      return defer('terminal_state');
    }
    if (rpcStatus === 'no_egress') return 'fallback_required';
    return defer('rpc_unknown');
  }

  // Clear the deferral marker on the way out: a converged session that still
  // carried a stale `poll_timeout` would be counted by the health surface as a
  // session still waiting, which is the same class of untruth this change
  // exists to remove.
  // N-1: the TERMINUS is cleared here too, not only the defer reason. A session
  // that exhausted its budget and later converged — most often through the
  // recruiter play path — would otherwise keep counting toward
  // `exhausted_count` forever, and `reopen_recording_finalize` cannot clear it
  // for such a row because it refuses an already-linked key (`already_linked`).
  // A converged recording is not waiting on a human.
  await db.from('call_sessions').update({
    recording_egress_status: 'complete',
    recording_finalize_defer_reason: null,
    recording_finalize_exhausted_at: null,
  }).eq('id', sessionId);
  if (session.mode === 'live' && phoneAttemptId !== null && manifestKey !== null) {
    await persistPhoneAttemptEvidence(db, phoneAttemptId, sessionId, objectKey, manifestKey, sha256, bytes.length, contentType as 'audio/ogg' | 'audio/mpeg');
  }
  return 'ready';
}
