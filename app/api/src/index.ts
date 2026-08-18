import * as http from 'node:http';
import { createApp } from './app.js';
import { env } from './lib/env.js';
import { createShutdownController } from './lib/shutdown.js';
import { createLogger } from './lib/logger.js';
import { supabase } from './lib/supabase.js';
import { createAshbyRuntime } from './integrations/ashby/runtime.js';
import { createAshbyWorkers, type AshbyWorkers } from './integrations/ashby/runtime-workers.js';
import {
  registerAshbyScheduler,
  clearAshbySchedulerRegistration,
} from './integrations/ashby/runtime-health.js';

const startupLogger = createLogger('startup');
const app = createApp();
const server = http.createServer(app);

const shutdown = createShutdownController({ graceMs: env.shutdownGraceMs });

// ── Ashby runtime (disabled by default) ──────────────────────────────────────
// `createAshbyRuntime` returns null unless ASHBY_INTEGRATION_ENABLED, a usable
// ASHBY_WEBHOOK_SECRET, ASHBY_RUNTIME_ENABLED, and ASHBY_API_KEY are ALL set.
// With the shipped defaults nothing is constructed: no client, no timer, no DB
// poll, no network. Deploying this build changes nothing about the running API.
//
// The runtime is BUILT here but the scheduler is STARTED inside the listen
// callback below, so background polling only begins once the process is
// actually serving. (An earlier revision started it before `listen`; the
// handoff described the corrected order, so the code now matches the claim.)
let ashbyWorkers: AshbyWorkers | null = null;
try {
  const runtime = createAshbyRuntime({ supabase: supabase as never });
  if (runtime) {
    ashbyWorkers = createAshbyWorkers({ runtime });
  }
} catch {
  // A misconfigured runtime must never prevent the API from serving HTTP.
  // Sanitized: the error is not logged verbatim because it can carry config text.
  startupLogger.warn('unknown_event', { error_category: 'ashby_runtime_start_failed' });
  ashbyWorkers = null;
}

server.listen(env.port, () => {
  if (ashbyWorkers) {
    ashbyWorkers.scheduler.start();
    // Register the LIVE scheduler so the Mission Control health surface reports
    // real tick bookkeeping instead of configuration. The registry is
    // process-local by design; the fleet-wide signal is the durable backlog.
    registerAshbyScheduler(ashbyWorkers.scheduler, ashbyWorkers.loopIntervalsMs);
  }
  startupLogger.info('startup_listen', {
    port: env.port,
    model: env.deepseekModel,
    schema: env.supabaseSchema,
  });
});

// REL-08: register SIGTERM/SIGINT handler; exit with code from drain result.
// The Ashby scheduler is stopped BEFORE exiting so in-flight leased work either
// completes or is failed under its lease — never abandoned holding a lease.
// `lib/shutdown.ts` exposes no drain hook, so the sequencing lives here rather
// than widening that module (and its dedicated suite).
shutdown.boot(server).then(async (code) => {
  if (ashbyWorkers) {
    try {
      clearAshbySchedulerRegistration();
      await ashbyWorkers.stop();
    } catch {
      // Never let a worker-stop failure change the process exit code.
    }
  }
  process.exit(code);
});
