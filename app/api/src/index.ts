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
import {
  createPhoneRuntime,
  type PhoneRuntimeHandle,
} from './lib/phone-runtime/index.js';
import {
  armPhoneRuntime,
  clearPhoneRuntimeRegistration,
  recordPhoneRuntimeStartFailure,
} from './lib/phone-runtime/health.js';
import {
  createWorkerOrchestrationRuntime,
  type WorkerOrchestrationRuntimeHandle,
} from './lib/worker-orchestration-runtime.js';

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

// ── Phone runtime (disabled by default) ──────────────────────────────────────
// A THIRD independent try/catch, for the same reason the recording runtime has
// its own: three lanes, three gates, and no lane may prevent another — or the
// API — from starting.
//
// The gate is BOTH `PHONE_SCREENING_ENABLED` and `PHONE_RUNTIME_ENABLED`, and
// with the shipped defaults both are false, so `createPhoneRuntime` returns
// null and nothing is constructed: no runner, no scheduler, no timer, no DB
// poll, no LiveKit object and no call. This build changes nothing about a
// running deployment until an operator turns two switches on deliberately.
let phoneRuntime: PhoneRuntimeHandle | null = null;
try {
  phoneRuntime = createPhoneRuntime();
} catch {
  // Sanitized: the error is not logged verbatim because it can carry config text.
  startupLogger.warn('unknown_event', { error_category: 'phone_runtime_start_failed' });
  phoneRuntime = null;
  // ...and RECORDED, not only logged. Without this the health surface reports
  // `enabled: false` with no degrade reason — identical to a machine where an
  // operator deliberately left both switches off. On a fleet where the flags
  // ARE on, that is a false negative on the surface's most important question,
  // and a log line on one replica is not a signal anybody is watching.
  recordPhoneRuntimeStartFailure();
}

// ── On-demand worker orchestration reaper (disabled by default) ───────────────
// A FOURTH independent try/catch. `createWorkerOrchestrationRuntime` returns null
// unless `WORKER_ORCHESTRATION` is true, so with the shipped default nothing is
// constructed: no scheduler, no timer, no Fly client, no DB poll. It arms two
// loops — a prompt terminal-release pass and the reaper backstop — that together
// enforce invariant I2 (never leave a machine started without a live session).
// A failure to construct it must never prevent the API — or the other three
// runtimes — from serving.
let workerOrchestrationRuntime: WorkerOrchestrationRuntimeHandle | null = null;
try {
  workerOrchestrationRuntime = createWorkerOrchestrationRuntime();
} catch {
  // Sanitized: the error is not logged verbatim because it can carry config text.
  startupLogger.warn('unknown_event', {
    error_category: 'worker_orchestration_runtime_start_failed',
  });
  workerOrchestrationRuntime = null;
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
  if (phoneRuntime) {
    // ── ARMING IS GUARDED TOO, NOT ONLY CONSTRUCTION ────────────────────
    // `scheduler.start()` then `registerPhoneRuntime` used to sit here bare.
    // A throw from `start()` — a metric-name collision from the derived loop
    // set, a timer failure — skipped the registration, left `start_failed`
    // false, and published `enabled: false` with NO degrade reason on a fleet
    // where both switches are ON: the exact false negative the construction
    // guard above exists to close, left open one line later. The throw also
    // escaped this callback, where nothing catches it.
    //
    // `armPhoneRuntime` does both steps in the right order, records the
    // failure on the health surface, and never throws. It lives in
    // `health.ts` because a composition root cannot be unit-tested — this
    // file opens a socket on import — and an arming provable only by
    // grepping this file is an arming with no test.
    if (!armPhoneRuntime(phoneRuntime)) {
      // Sanitized: the error is not logged verbatim because it can carry
      // config text. The DURABLE signal is `start_failed` on the health
      // surface, which `armPhoneRuntime` has already set.
      startupLogger.warn('unknown_event', { error_category: 'phone_runtime_arm_failed' });
    }
  }
  if (workerOrchestrationRuntime) {
    // Only present when WORKER_ORCHESTRATION is on (construction returned null
    // otherwise). Start the reaper + terminal-release loops now that the process
    // is serving, mirroring the recording/ashby runtimes.
    workerOrchestrationRuntime.scheduler.start();
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
  if (phoneRuntime) {
    try {
      clearPhoneRuntimeRegistration();
      // Stopped in its own try, like the others. An in-flight `phone.dial`
      // claim either completes or fails UNDER ITS LEASE; an abandoned queue
      // lease is recovered by `reclaim_expired_jobs`, and an abandoned ATTEMPT
      // lease by `reclaim_phone_attempt_leases`, on any machine.
      await phoneRuntime.stop();
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
  if (workerOrchestrationRuntime) {
    try {
      // Stopped in its own try, like the others. A reap/terminal-release pass
      // in flight either completes or is dropped mid-loop; either way the next
      // process's loops (and the grace-based reaper) recover any machine left
      // started, so an interrupted sweep leaks nothing durable.
      await workerOrchestrationRuntime.stop();
    } catch {
      // Never let a worker-stop failure change the process exit code.
    }
  }
  process.exit(code);
});
