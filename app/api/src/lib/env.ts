import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === 'replace_me') {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

/** Parse a non-negative integer env var with bounds checking. */
function uint(name: string, defaultVal: number, min = 0, max = 300_000): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultVal;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export const env = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  supabaseSchema: process.env.SUPABASE_SCHEMA ?? 'screening_v2',
  claudeModel: process.env.CLAUDE_MODEL ?? 'haiku',
  claudeScoringModel: process.env.CLAUDE_SCORING_MODEL ?? 'sonnet',
  companyName: process.env.COMPANY_NAME ?? 'the hiring team',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeTimeoutMs: uint('CLAUDE_TIMEOUT_MS', 120_000, 1_000, 300_000),
  port: Number(process.env.PORT ?? 8787),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  livekitUrl: process.env.LIVEKIT_URL ?? '',
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  recordingsBucket: process.env.RECORDINGS_BUCKET ?? 'recordings_v2',
  // ── Provider resilience (REL-05/REL-06) ─────────────────────
  // Referenced directly so the env contract checker's env contract checker regex
  // can detect these variables in runtime code.
  breakerFailureThreshold: process.env.BREAKER_FAILURE_THRESHOLD
    ? uint('BREAKER_FAILURE_THRESHOLD', 5, 1, 100)
    : 5,
  breakerCooldownMs: process.env.BREAKER_COOLDOWN_MS
    ? uint('BREAKER_COOLDOWN_MS', 30_000, 1_000, 300_000)
    : 30_000,
  breakerTimeoutMs: process.env.BREAKER_TIMEOUT_MS
    ? uint('BREAKER_TIMEOUT_MS', 60_000, 0, 300_000)
    : 60_000,
  claudeMaxOutputBytes: process.env.CLAUDE_MAX_OUTPUT_BYTES
    ? uint('CLAUDE_MAX_OUTPUT_BYTES', 5 * 1024 * 1024, 1024, 100 * 1024 * 1024)
    : 5 * 1024 * 1024,
};
