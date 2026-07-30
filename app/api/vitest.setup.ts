// Set synthetic environment before any imports that read process.env.
// This runs in the vitest worker context before test files are loaded.

process.env.SUPABASE_URL = 'https://test-project.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_SCHEMA = 'screening_v2';
process.env.CLAUDE_MODEL = 'haiku';
process.env.CLAUDE_SCORING_MODEL = 'sonnet';
process.env.COMPANY_NAME = 'Test Company';
process.env.CLAUDE_BIN = 'claude';
process.env.CLAUDE_TIMEOUT_MS = '30000';
process.env.PORT = '0'; // ephemeral
process.env.WEB_ORIGIN = 'http://localhost:5173';
process.env.LIVEKIT_URL = 'http://livekit-test:7880';
process.env.LIVEKIT_API_KEY = 'test-livekit-key';
process.env.LIVEKIT_API_SECRET = 'test-livekit-secret';
process.env.RECORDINGS_BUCKET = 'recordings_v2';
// Provider resilience env vars
process.env.BREAKER_FAILURE_THRESHOLD = '5';
process.env.BREAKER_COOLDOWN_MS = '30000';
process.env.BREAKER_TIMEOUT_MS = '60000';
process.env.CLAUDE_MAX_OUTPUT_BYTES = '5242880';
process.env.RESUME_SCANNER = 'test';
process.env.RESUME_MAX_COMPRESSED_BYTES = '10485760';
process.env.RESUME_PARSER_TIMEOUT_MS = '30000';
process.env.RESUME_MAX_TEXT_LENGTH = '50000';
