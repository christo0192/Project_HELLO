import * as http from 'node:http';
import { createApp } from './app.js';
import { env } from './lib/env.js';
import { createShutdownController } from './lib/shutdown.js';

const app = createApp();
const server = http.createServer(app);

const shutdown = createShutdownController({ graceMs: env.shutdownGraceMs });

server.listen(env.port, () => {
  console.log(`\n  HR screening bot API → http://localhost:${env.port}`);
  console.log(`  Brain: claude -p --model ${env.claudeModel}`);
  console.log(`  Supabase schema: ${env.supabaseSchema}`);
  console.log(`  CORS origin: ${env.webOrigin}`);
  console.log(`  Shutdown grace: ${env.shutdownGraceMs}ms\n`);
});

// REL-08: register SIGTERM/SIGINT handler; exit with code from drain result.
shutdown.boot(server).then((code) => {
  process.exit(code);
});
