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

export type RecordingFinalizeStatus = 'ready' | 'fallback_required' | 'pending';

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
 * The manifest object LiveKit writes alongside every egress file.
 *
 * `startAuthoritativeRecording` sets `disableManifest: false`, so a manifest
 * exists for EVERY egress-recorded session — and nothing in this repository
 * ever deleted it, on the erasure path or anywhere else.
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

export async function finalizeAuthoritativeRecording(
  sessionId: string,
  deps: RecordingEgressDeps = {},
): Promise<RecordingFinalizeStatus> {
  const db = deps.db ?? supabase;
  const { data: session, error } = await db
    .from('call_sessions')
    .select('recording_object_key, recording_provenance, recording_egress_id, recording_egress_status')
    .eq('id', sessionId)
    .single();
  if (error || !session) throw new Error('recording session not found');
  // I‑1: a linked key is only authoritative when it came from the egress.
  // A browser_upload key with a live egress must fall through and be repointed.
  if (session.recording_object_key && session.recording_provenance === 'livekit_egress') return 'ready';
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

  const objectKey = egressObjectKey(sessionId);
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
    p_content_type: 'audio/ogg',
    p_correlation_id: null,
    p_recording_egress_started_at_ms: egressStartedAtMs,
  });
  if (rpcError) throw new Error('recording egress finalization failed');
  const rpcStatus = (rpcData as { status?: string } | null)?.status;
  if (rpcStatus === 'already_authoritative') return 'ready';
  if (rpcStatus === 'provenance_conflict') {
    // Row has provenance that cannot be upgraded to livekit_egress.
    // If a key exists, it stays as-is (ready); otherwise pending.
    const { data: current } = await db
      .from('call_sessions')
      .select('recording_object_key')
      .eq('id', sessionId)
      .single();
    if (current?.recording_object_key) return 'ready';
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
  return 'ready';
}
