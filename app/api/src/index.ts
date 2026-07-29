import * as http from 'node:http';
import { createApp } from './app.js';
import { env } from './lib/env.js';
import { createShutdownController } from './lib/shutdown.js';
import { createLogger } from './lib/logger.js';

const startupLogger = createLogger('startup');
const app = createApp();
const server = http.createServer(app);

const shutdown = createShutdownController({ graceMs: env.shutdownGraceMs });

server.listen(env.port, () => {
  startupLogger.info('startup_listen', {
    port: env.port,
    model: env.claudeModel,
    schema: env.supabaseSchema,
  });
});

// REL-08: register SIGTERM/SIGINT handler; exit with code from drain result.
shutdown.boot(server).then((code) => {
  process.exit(code);
});
