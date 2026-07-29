import { createApp } from './app.js';
import { env } from './lib/env.js';
import { createLogger } from './lib/logger.js';

const startupLogger = createLogger('startup');
const app = createApp();

app.listen(env.port, () => {
  // Log safe identifiers only — no origins, URLs, or credentials.
  startupLogger.info('startup_listen', {
    port: env.port,
    model: env.claudeModel,
    schema: env.supabaseSchema,
  });
});
