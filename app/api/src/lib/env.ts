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
  process.env.DEEPSEEK_REASONING_EFFORT,
  process.env.RESUME_MODEL_MAX_CONCURRENCY,
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
  process.env.WORKER_ORCHESTRATION,
  process.env.FLY_API_TOKEN,
  process.env.FLY_API_BASE_URL,
  process.env.WORKER_REAPER_GRACE_SEC,
  process.env.WORKER_ORPHAN_GRACE_SEC,
  process.env.PHONE_WORKER_READY_TIMEOUT_SEC,
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
  // Official DeepSeek gateway model. `deepseek-chat` (the legacy default) is
  // being discontinued, so the code default now points at V4-Flash to match the
  // official endpoint; fly.toml [env] pins the exact id explicitly.
  deepseekModel: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
  // Scoring runs on the larger V4-Pro model (not Flash) with reasoning HIGH
  // (via the global DEEPSEEK_REASONING_EFFORT below): the candidate scorecard is
  // an off-the-speech-path, quality-over-latency judgement over the whole
  // transcript, so it is worth the slower/pricier Pro model. fly.toml [env]
  // pins the exact id; this default keeps local/dev in step.
  deepseekScoringModel: process.env.DEEPSEEK_SCORING_MODEL ?? 'deepseek-v4-pro',
  /**
   * DeepSeek reasoning_effort. EMPTY (default) ⇒ the field is OMITTED from the
   * request body — which on V4-Flash means MODEL-DEFAULT reasoning, NOT "off":
   * V4-Flash THINKS BY DEFAULT when the field is absent (PR #238 finding; an
   * earlier version of this comment wrongly called omission the "fast" mode).
   * The literal string 'none' is what disables reasoning; 'high' / 'xhigh'
   * increase it. Any non-empty value is forwarded verbatim as
   * `reasoning_effort`; omission still carries no 400 risk. Not required, not
   * secret.
   */
  deepseekReasoningEffort: process.env.DEEPSEEK_REASONING_EFFORT ?? '',
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
  /**
   * PR A: recording PRODUCER selection. 'egress' (default) uses LiveKit Cloud
   * room-composite egress, which the Build plan caps at 2 concurrent jobs.
   * 'worker' records inside the agent worker (RecorderIO mixes candidate + bot
   * TTS → OGG → transcoded MP3 → presigned-PUT upload to the attempt object
   * key), which removes the egress-concurrency limit. Any value other than the
   * exact string 'worker' resolves to 'egress' — fail-safe to the proven path.
   */
  recordingProvider: (process.env.RECORDING_PROVIDER === 'worker' ? 'worker' : 'egress') as
    'egress' | 'worker',
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
  // ── 0090: funnel observability rollup refresh (disabled by default) ────
  // Master gate. False (default) ⇒ createFunnelRuntime() returns null: no
  // scheduler, no timer, no DB call. Enabling it starts ONE loop that
  // periodically recomputes screening_v2.funnel_stage_daily via the
  // advisory-locked, idempotent refresh_funnel_rollup RPC. The rollup is
  // purely derived, so nothing accumulates while this is off.
  funnelObservabilityEnabled: booleanEnv('FUNNEL_OBSERVABILITY_ENABLED', false),
  /** Cadence of the rollup recompute. 15 min default; 1 min–6 h bounds. */
  funnelRollupIntervalMs: positiveInt('FUNNEL_ROLLUP_INTERVAL_MS', 900_000, 60_000, 21_600_000),
  /** Trailing window (days) each recompute reaches back over. */
  funnelRollupWindowDays: positiveInt('FUNNEL_ROLLUP_WINDOW_DAYS', 30, 1, 3650),
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
  // ── PR B: on-demand Fly worker orchestration ──────────────────────────────
  // Everything here defaults OFF / to a proven value, so a deploy of this build
  // changes nothing about a running API. The Fly Machines client and the future
  // reaper are constructed only when `workerOrchestration` is true; until then
  // no machine is ever started or stopped by this code.
  /**
   * Master gate for the whole orchestration. False (default) ⇒ the on-demand
   * worker lifecycle is inert: no claim/start/wait/reap, no Fly API calls.
   */
  workerOrchestration: booleanEnv('WORKER_ORCHESTRATION', false),
  /**
   * App-scoped Fly deploy token (secret) used as the Machines API bearer. A
   * blank token does NOT crash import: the Fly client constructs and every call
   * fails closed with code 'auth', so callers degrade rather than throw at
   * startup. Only meaningful when `workerOrchestration` is true.
   */
  flyApiToken: process.env.FLY_API_TOKEN ?? '',
  /** Fly Machines API base origin. Defaults to the allowlisted production origin
   * (api.machines.dev — api.fly.io/v1 does not serve the Machines REST API). */
  flyApiBaseUrl: process.env.FLY_API_BASE_URL ?? 'https://api.machines.dev/v1',
  /**
   * Grace period (seconds) a machine may sit `started` with no active session
   * before the future reaper stops it — the cost-safety backstop (§2.5). Bounds
   * one grace window of possible cost leak; clamped 30..3600.
   */
  workerReaperGraceSec: positiveInt('WORKER_REAPER_GRACE_SEC', 180, 30, 3600),
  /**
   * T2③ ORPHAN-REAP grace (seconds). The SECOND, conservative grace window,
   * used ONLY by the orphan sweep that stops a MANAGED pool machine which Fly
   * reports `started` while its lease reads `stopped` (a manual start / prewarm
   * / secret-update restart left the DB behind). It is deliberately LONGER and
   * has a HIGHER floor than `workerReaperGraceSec`: an orphan is stopped without
   * a per-session LiveKit room to prove liveness against (a stopped lease has no
   * claimed session), so the only race guard is "the lease has not been touched
   * for a long time" — a mid-claim machine's lease moves within seconds, so a
   * ≥10-minute idle floor makes stopping a machine another process is bringing
   * up effectively impossible. Clamped 300..7200; default 600 (10 min). Only
   * meaningful when `workerOrchestration` is true.
   */
  workerOrphanGraceSec: positiveInt('WORKER_ORPHAN_GRACE_SEC', 600, 300, 7200),
  /**
   * Wall-clock budget (seconds) the dial gate gives a claimed machine to boot,
   * register with LiveKit and post its readiness ping before the dial is
   * DEFERRED (`worker_not_ready`) and the claim cleaned up. The service default
   * is 30s, but historical worker cold-boot is 15-25s+ and a browser+SDK warm
   * can push past 30s.
   *
   * T2④ COLD-FLEET PREWARM (Call D, 2026-09-08): `ensureReadyWorker` ALREADY
   * prewarms — it claims a stopped pool machine and STARTS it, then waits up to
   * this budget for the readiness ping — so a cold fleet is booted on the arm,
   * not left cold. The failure the owner kept hitting is the FIRST arm after a
   * deploy / secret-change: that boot is a genuine cold boot (a fresh image
   * pull + full worker+LiveKit registration) that can run past 75s on a
   * degraded fleet, so the gate DEFERRED (worker_not_ready) and the one-shot
   * owner-test slot was consumed before the machine finished coming up. Raising
   * the default to 120s covers that worst-case cold boot with margin. 120s is
   * the service's own MAX_READY_TIMEOUT_MS ceiling (worker-orchestration.ts),
   * so this is the largest budget the service will honour and it changes NO
   * refusal semantics — a machine that is genuinely never going to be ready
   * still DEFERS (just later), and the deferred attempt stays same-IST-day
   * retryable via the 0083 infra-abandon. Clamped 30..300. Only meaningful when
   * `workerOrchestration` is true. Revert to 75 by setting the env explicitly.
   */
  phoneWorkerReadyTimeoutSec: positiveInt('PHONE_WORKER_READY_TIMEOUT_SEC', 120, 30, 300),
  /**
   * The dispatch name of the NAMED browser worker (design §2.3b B-i). EMPTY by
   * default, which is byte-identical to today: the browser worker stays UNNAMED
   * and auto-dispatches into every screening room, and the browser exchange
   * flow performs NO explicit dispatch and NO worker gate. Only when this is set
   * AND `workerOrchestration` is on does the exchange flow (1) confirm a ready
   * on-demand worker before minting a join token and (2) explicitly dispatch
   * that named worker into the room. The name the API dispatches to MUST equal
   * the name the worker registers under (BROWSER_AGENT_NAME on the worker) — a
   * `names_agree` check surfaces a mismatch loudly (PR100 lesson). Naming and
   * dispatch are introduced TOGETHER behind the same flag precisely because
   * naming the browser worker silently stops its auto-dispatch.
   */
  browserAgentName: process.env.BROWSER_AGENT_NAME ?? '',
};
