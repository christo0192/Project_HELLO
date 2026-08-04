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
