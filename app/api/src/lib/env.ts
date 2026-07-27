import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === 'replace_me') {
    throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  }
  return v;
}

export const env = {
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  // Postgres schema that holds the v2 tables (NOT public).
  supabaseSchema: process.env.SUPABASE_SCHEMA ?? 'screening_v2',
  claudeModel: process.env.CLAUDE_MODEL ?? 'haiku',
  // Scoring needs accuracy -> default to a stronger model (still via claude -p).
  claudeScoringModel: process.env.CLAUDE_SCORING_MODEL ?? 'sonnet',
  companyName: process.env.COMPANY_NAME ?? 'the hiring team',
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',
  claudeTimeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS ?? 120000),
  port: Number(process.env.PORT ?? 8787),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  livekitUrl: process.env.LIVEKIT_URL ?? '',
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? '',
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  recordingsBucket: process.env.RECORDINGS_BUCKET ?? 'recordings_v2',
};
