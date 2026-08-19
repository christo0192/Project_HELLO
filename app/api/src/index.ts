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
import {
  createRecordingRuntime,
  type RecordingRuntimeHandle,
} from './lib/recording/runtime.js';
import {
  registerRecordingRuntime,
  clearRecordingRuntimeRegistration,
} from './lib/recording/health.js';

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

// ── Recording finalization runtime (disabled by default) ─────────────────────
// Built in its OWN try/catch, from its OWN gate, with no reference to the
// Ashby branch above. That independence is the point: the deployment this
// repair exists for has the Ashby runtime paused, and a session whose
// recording never finalized must still converge there. A failure of either
// runtime must not prevent the other from starting, and neither may prevent
// the API from serving HTTP.
let recordingRuntime: RecordingRuntimeHandle | null = null;
try {
  recordingRuntime = createRecordingRuntime();
} catch {
  // Sanitized: the error is not logged verbatim because it can carry config text.
  startupLogger.warn('unknown_event', { error_category: 'recording_runtime_start_failed' });
  recordingRuntime = null;
}

server.listen(env.port, () => {
  if (recordingRuntime) {
    recordingRuntime.scheduler.start();
    // Register the LIVE scheduler so /api/recordings/health reports real tick
    // bookkeeping rather than configuration. Process-local by design; the
    // fleet-wide signal is the durable backlog the same route reads from the DB.
    registerRecordingRuntime(recordingRuntime);
  }
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
  if (recordingRuntime) {
    try {
      clearRecordingRuntimeRegistration();
      // Stopped independently of the Ashby workers, and in its own try: a
      // finalize job in flight either completes or fails UNDER ITS LEASE, and
      // an abandoned lease is recovered by the reclaim loop on any machine.
      await recordingRuntime.stop();
    } catch {
      // Never let a worker-stop failure change the process exit code.
    }
  }
  process.exit(code);
});
