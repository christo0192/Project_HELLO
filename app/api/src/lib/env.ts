import 'dotenv/config';

// Keep direct process.env reads visible to the env-contract checker for vars
// parsed through helper functions below.
const _contractVisibleEnvReads = [
  process.env.CLAUDE_TIMEOUT_MS,
  process.env.DEEPSEEK_TIMEOUT_MS,
  process.env.PORT,
  process.env.SHUTDOWN_GRACE_MS,
  process.env.BREAKER_FAILURE_THRESHOLD,
  process.env.BREAKER_COOLDOWN_MS,
  process.env.BREAKER_TIMEOUT_MS,
  process.env.CLAUDE_MAX_OUTPUT_BYTES,
  process.env.DEEPSEEK_MAX_OUTPUT_BYTES,
  process.env.RECORDING_DOWNLOAD_TTL_SEC,
  process.env.RECORDING_MAX_BYTES,
  process.env.RECORDING_EGRESS_ENABLED,
  process.env.RECORDING_EGRESS_REQUIRED,
  process.env.RECORDING_EGRESS_FINALIZE_TIMEOUT_MS,
  process.env.RECORDING_FINALIZE_WORKER_ENABLED,
  process.env.RECORDING_FINALIZE_GRACE_SEC,
  process.env.RECORDING_FINALIZE_MAX_ATTEMPTS,
  process.env.RECORDING_FINALIZE_CONCURRENCY,
  process.env.RECORDING_FINALIZE_SWEEP_ADMISSION,
  process.env.RECORDING_FINALIZE_SWEEP_MAX_AGE_SEC,
  process.env.RECORDING_FINALIZE_POLL_MS,
  process.env.RECORDING_FINALIZE_SWEEP_MS,
  process.env.RECORDING_FINALIZE_RECLAIM_MS,
  process.env.RECORDING_FINALIZE_RECLAIM_LIMIT,
  process.env.RECORDING_FINALIZE_LEASE_SEC,
  process.env.RECORDING_FINALIZE_HALT_TTL_MS,
  process.env.RECORDING_JOB_REAP_MS,
  process.env.RECORDING_JOB_REAP_AGE_SEC,
  process.env.RECORDING_JOB_REAP_LIMIT,
];
void _contractVisibleEnvReads;

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === 'replace_me') {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

/**
 * Parse a positive integer environment variable.
 * Throws at import time (before server.listen) for NaN, Infinity, negative, zero, fraction, or out-of-range.
 */
function booleanEnv(name: string, defaultVal: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either "true" or "false"`);
}

function positiveInt(name: string, defaultVal: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be a finite number, got "${raw}"`);
  }
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer, got "${raw}"`);
  }
  if (n < min || n > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

export const env = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseSchema: process.env.SUPABASE_SCHEMA ?? 'screening_v2',
  claudeModel: process.env.CLAUDE_MODEL ?? 'haiku',
  claudeScoringModel: process.env.CLAUDE_SCORING_MODEL ?? 'sonnet',
  deepseekApiKey: process.env.DEEPSEEK_API_KEY ?? '',
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
  deepseekScoringModel: process.env.DEEPSEEK_SCORING_MODEL ?? 'deepseek-chat',
  deepseekTimeoutMs: positiveInt('DEEPSEEK_TIMEOUT_MS', 120000, 1, 300000),
  deepseekMaxOutputBytes: positiveInt(
    'DEEPSEEK_MAX_OUTPUT_BYTES', 5 * 1024 * 1024, 1024, 100 * 1024 * 1024,
  ),
  companyName: process.env.COMPANY_NAME ?? 'the hiring team',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeTimeoutMs: positiveInt('CLAUDE_TIMEOUT_MS', 120000, 1, 300000),
  // PORT 0 = ephemeral (OS-assigned), 1-65535 = explicit
  port: positiveInt('PORT', 8787, 0, 65535),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  livekitUrl: process.env.LIVEKIT_URL ?? '',
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  recordingsBucket: process.env.RECORDINGS_BUCKET ?? 'recordings_v2',
  recordingEgressEnabled: booleanEnv('RECORDING_EGRESS_ENABLED', false),
  recordingEgressRequired: booleanEnv('RECORDING_EGRESS_REQUIRED', false),
  recordingEgressS3Endpoint: process.env.RECORDING_EGRESS_S3_ENDPOINT ?? '',
  recordingEgressS3Region: process.env.RECORDING_EGRESS_S3_REGION ?? 'ap-south-1',
  recordingEgressS3AccessKeyId: process.env.RECORDING_EGRESS_S3_ACCESS_KEY_ID ?? '',
  recordingEgressS3SecretAccessKey: process.env.RECORDING_EGRESS_S3_SECRET_ACCESS_KEY ?? '',
  recordingEgressFinalizeTimeoutMs: positiveInt(
    'RECORDING_EGRESS_FINALIZE_TIMEOUT_MS', 20_000, 1_000, 120_000,
  ),
  // ── 0038: durable recording-finalization convergence ──────────────────
  // Every knob here defaults to the DISABLED or conservative value, so a
  // deploy of this build changes nothing about a running API. The trigger
  // still records finalization intent durably in `job_queue` while the
  // worker is off; enabling it later drains that intent.
  /**
   * Master gate. False (default) ⇒ `createRecordingRuntime()` returns null:
   * no queue runner, no scheduler, no timer, no DB poll.
   */
  recordingFinalizeWorkerEnabled: booleanEnv('RECORDING_FINALIZE_WORKER_ENABLED', false),
  /**
   * Delay between a session becoming terminal and its finalize job becoming
   * claimable. Exists so the job does not race the egress's own flush. The
   * trigger's own grace is a migration-level literal; this one bounds the
   * SWEEPER, which must not re-enqueue a row the trigger just queued.
   */
  recordingFinalizeGraceSec: positiveInt('RECORDING_FINALIZE_GRACE_SEC', 60, 10, 900),
  /**
   * Deferral budget per SESSION before `recording_finalize_exhausted_at` is
   * stamped. Distinct from the queue job's `max_attempts`, which counts only
   * genuine handler throws — a deferral refunds that one and charges this one.
   */
  recordingFinalizeMaxAttempts: positiveInt('RECORDING_FINALIZE_MAX_ATTEMPTS', 5, 1, 20),
  /**
   * In-flight finalize jobs per machine. Pinned rather than left to the
   * runner's default of 2, because the producer/consumer balance below is an
   * INVARIANT, not an accident:
   *
   *   admission ≤ concurrency × (sweepMs / pollMs)
   *   20        ≤ 4           × (300000 / 60000) = 20   ✓
   *
   * At the runner's default of 2 the sweeper would enqueue 4 rows/min against
   * a 2 rows/min drain and the backlog would grow while the sweep ran.
   * `effectiveSweepAdmission` in lib/recording/config.ts enforces this at
   * construction — it CLAMPS admission to the drain capacity and logs the
   * clamp rather than refusing to start, because degrading a rate is right
   * where refusing to start a convergence subsystem is not. A test asserts
   * both the invariant at the defaults and the clamp above them.
   */
  recordingFinalizeConcurrency: positiveInt('RECORDING_FINALIZE_CONCURRENCY', 4, 1, 32),
  /** Rows the sweeper may enqueue per tick. The first bound on a cold backlog. */
  recordingFinalizeSweepAdmission: positiveInt('RECORDING_FINALIZE_SWEEP_ADMISSION', 20, 1, 200),
  /**
   * How far back the sweeper may reach at all. The second bound: the first
   * enable runs against accumulated history, and "everything ever recorded"
   * is not a work list anyone chose.
   */
  recordingFinalizeSweepMaxAgeSec: positiveInt(
    'RECORDING_FINALIZE_SWEEP_MAX_AGE_SEC', 604_800, 3_600, 2_592_000,
  ),
  /** Queue-runner tick cadence. */
  recordingFinalizePollMs: positiveInt('RECORDING_FINALIZE_POLL_MS', 60_000, 1_000, 600_000),
  /** Sweeper tick cadence. */
  recordingFinalizeSweepMs: positiveInt('RECORDING_FINALIZE_SWEEP_MS', 300_000, 10_000, 3_600_000),
  /**
   * Reclaim cadence. Without a reclaim loop a machine that dies mid-finalize
   * leaves the job `active` with an expired lease, and `uq_job_queue_dedup_active`
   * covers `active` — so the trigger's `on conflict do nothing` and the
   * sweeper's dedup-keyed enqueue both become silent no-ops and the session is
   * stuck forever, one level up from the defect this whole change repairs.
   */
  recordingFinalizeReclaimMs: positiveInt('RECORDING_FINALIZE_RECLAIM_MS', 60_000, 5_000, 3_600_000),
  /**
   * Per-pass reclaim limit. `reclaim_expired_jobs` is queue-name-AGNOSTIC
   * (its signature has no queue name), so with both runtimes enabled this
   * loop and the Ashby reclaim loop share ONE global budget. Kept well below
   * the Ashby loop's 50 so neither starves the other.
   */
  recordingFinalizeReclaimLimit: positiveInt('RECORDING_FINALIZE_RECLAIM_LIMIT', 25, 1, 500),
  /** Lease granted per finalize claim. Must exceed the finalize timeout. */
  recordingFinalizeLeaseSec: positiveInt('RECORDING_FINALIZE_LEASE_SEC', 180, 30, 900),
  /**
   * TTL of the in-process halt-flag cache. The runner's admission gate runs on
   * EVERY poll of EVERY queue and its contract says whatever it consults must
   * be CHEAP; an uncached DB read there would turn a transient blip into a
   * fleet-wide claim freeze.
   */
  recordingFinalizeHaltTtlMs: positiveInt('RECORDING_FINALIZE_HALT_TTL_MS', 5_000, 500, 60_000),
  /** Cadence of the bounded terminal-job reaper. */
  recordingJobReapMs: positiveInt('RECORDING_JOB_REAP_MS', 900_000, 60_000, 86_400_000),
  /** Retention window for COMPLETED job_queue rows before they are reaped. */
  recordingJobReapAgeSec: positiveInt('RECORDING_JOB_REAP_AGE_SEC', 604_800, 3_600, 7_776_000),
  /** Rows the reaper may delete per pass. */
  recordingJobReapLimit: positiveInt('RECORDING_JOB_REAP_LIMIT', 500, 1, 5_000),
  /** MIG-06: TTL (seconds) for recruiter recording download signed URLs. Range 60..900. */
  recordingDownloadTtlSec: positiveInt('RECORDING_DOWNLOAD_TTL_SEC', 300, 60, 900),
  /**
   * REC-03 (PROPOSED): reduced bounded browser-upload cap — default 25 MiB,
   * hard max 50 MiB, strictly below the old 100 MB multer cap (C-3). Oversize
   * is rejected by multer (LIMIT_FILE_SIZE → 413) BEFORE the body is fully
   * buffered. This bounds memory — it is NOT constant-memory streaming.
   */
  recordingMaxBytes: positiveInt('RECORDING_MAX_BYTES', 25 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  /** REL-08: grace period (ms) before forced connection teardown. */
  shutdownGraceMs: positiveInt('SHUTDOWN_GRACE_MS', 30000, 100, 300000),
  /** REL-05/REL-06 provider resilience controls. */
  breakerFailureThreshold: positiveInt('BREAKER_FAILURE_THRESHOLD', 5, 1, 100),
  breakerCooldownMs: positiveInt('BREAKER_COOLDOWN_MS', 30000, 1000, 300000),
  // Zero disables the breaker's separate timeout; the runner still has its CLI timeout.
  breakerTimeoutMs: positiveInt('BREAKER_TIMEOUT_MS', 60000, 0, 300000),
  claudeMaxOutputBytes: positiveInt(
    'CLAUDE_MAX_OUTPUT_BYTES', 5 * 1024 * 1024, 1024, 100 * 1024 * 1024,
  ),
};
