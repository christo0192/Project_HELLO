/**
 * routes/voice-worker.ts — the internal, service-authenticated readiness surface
 * the on-demand voice worker calls on LiveKit registration.
 *
 * ONE endpoint: `POST /internal/voice-worker/ready`. When the orchestrator
 * starts a claimed machine and the worker finishes booting + registering with
 * LiveKit, the worker POSTs here with its (app, machine_id, session_id, epoch).
 * We CAS the lease to `ready` via `mark_voice_worker_ready`. Only a `ready`
 * lease may receive a caller/candidate (design §2.2), so this ping is the
 * readiness handshake the orchestrator's `ensureReadyWorker` poll observes.
 *
 * ── AUTH IS THE EXISTING WORKER SECRET, DELIBERATELY ──────────────────
 * Same `WORKER_CONTEXT_SECRET` >=32-char constant-time bearer the phone-worker
 * routes use. This is the same principal (our own worker) on the same private
 * path asking the API to do something on its behalf; a third credential would
 * be a third thing to rotate and leak. (Mirrors routes/phone-worker.ts.)
 *
 * ── DISABLED BY DEFAULT ───────────────────────────────────────────────
 * The endpoint 404s (as if it did not exist) unless `env.workerOrchestration`
 * is true — the SAME master gate the service checks. A deploy of this build
 * exposes no functional readiness endpoint until an operator turns the flag on.
 * The 404 (not 503) is deliberate: a disabled deployment is indistinguishable
 * from one that never had the route, so a probe learns nothing.
 *
 * ── THE RESPONSE IS A THIN PROJECTION ─────────────────────────────────
 * We forward the RPC's `status` (`ready` | `stale`) and nothing else. A stale
 * ping — wrong session, superseded epoch, machine already stopped/draining —
 * is `ok:false, status:'stale'`, so the worker knows its claim was fenced and
 * must not proceed. Anything the RPC did not say `ready` for is not `ok`.
 */

import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { createLogger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { supabase } from '../lib/supabase.js';

const log = createLogger('voice-worker');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Fly app slugs are [a-z0-9-]; machine ids are hex. Bounded and structural. */
const FLY_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;

const readySchema = z
  .object({
    app: z.string().regex(FLY_ID_RE),
    machine_id: z.string().regex(FLY_ID_RE),
    session_id: z.string().regex(UUID_RE),
    epoch: z.number().int().min(0).max(9_007_199_254_740_991),
  })
  .strict();

/**
 * The BROWSER worker's readiness ping — MACHINE-level, session-less.
 *
 * The named browser worker learns its session only from the dispatch it has
 * not yet received (ready-before-dispatch, design §2.3b B-i). At registration
 * it knows only (app, machine_id), so it posts THIS shape and the API flips the
 * row it already claimed (which already carries session + epoch) to `ready`.
 * See migration 0080 for the epoch-safety argument.
 */
const readyMachineSchema = z
  .object({
    app: z.string().regex(FLY_ID_RE),
    machine_id: z.string().regex(FLY_ID_RE),
  })
  .strict();

/**
 * The service-role RPC caller. Mirrors `supabase.rpc(name, args)`; injected so
 * a test needs no database. Returns the jsonb `{status,...}` envelope.
 */
export type VoiceWorkerRpcCaller = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

export interface VoiceWorkerRouterDeps {
  /** Master gate. Defaults to `env.workerOrchestration`. */
  readonly enabled?: boolean;
  /** Injected RPC caller. Defaults to the service-role supabase client. */
  readonly rpc?: VoiceWorkerRpcCaller;
  readonly now?: () => Date;
}

/** Same constant-time worker bearer the phone-worker routes use. */
function requireWorkerPhoneAuth(
  req: import('express').Request,
  res: import('express').Response,
  next: import('express').NextFunction,
): void {
  const configured = process.env.WORKER_CONTEXT_SECRET;
  if (!configured || configured.length < 32) {
    res.status(503).json({ ok: false, error: 'worker_auth_not_configured' });
    return;
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.status(401).json({ ok: false, error: 'authentication_required' });
    return;
  }
  const supplied = Buffer.from(auth.slice(7), 'utf8');
  const expected = Buffer.from(configured, 'utf8');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.status(403).json({ ok: false, error: 'access_denied' });
    return;
  }
  next();
}

export function createVoiceWorkerRouter(deps: VoiceWorkerRouterDeps = {}): Router {
  const router = Router();
  const enabled = deps.enabled ?? env.workerOrchestration;
  const now = deps.now ?? ((): Date => new Date());
  const rpc: VoiceWorkerRpcCaller = deps.rpc
    ?? (async (name, args) => {
      const { data, error } = await (supabase as unknown as {
        rpc(n: string, a: Record<string, unknown>): Promise<{ data: unknown; error: { message?: string } | null }>;
      }).rpc(name, args);
      return { data, error: error ? { message: error.message } : null };
    });

  router.post('/ready', requireWorkerPhoneAuth, async (req, res) => {
    try {
      // The master switch first, and BEFORE any database work. A disabled
      // deployment 404s — indistinguishable from one that never had the route.
      if (!enabled) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const parsed = readySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid_request' });
      }
      const { data, error } = await rpc('mark_voice_worker_ready', {
        p_app: parsed.data.app,
        p_machine_id: parsed.data.machine_id,
        p_session_id: parsed.data.session_id,
        p_epoch: parsed.data.epoch,
        p_now: now().toISOString(),
      });
      if (error) {
        // Sanitized: never the driver message.
        return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
      }
      const status = (data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).status
        : undefined);
      if (status === 'ready') {
        log.info('unknown_event', { error_category: 'voice_worker_ready' });
        return res.json({ ok: true, status: 'ready' });
      }
      // Any non-ready verdict — 'stale', 'invalid_request', or an unrecognised
      // answer — is forwarded as not-ok so the worker does not proceed on a
      // fenced or unknown claim.
      log.info('unknown_event', { error_category: 'voice_worker_ready_stale' });
      return res.json({ ok: false, status: typeof status === 'string' ? status : 'stale' });
    } catch {
      return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
    }
  });

  // ── POST /ready-machine — the BROWSER worker's session-less readiness ──
  // Same auth, same master gate, same 404-when-disabled posture as /ready.
  // Drops session_id/epoch: the browser worker posts this at registration,
  // before it knows its session (ready-before-dispatch). The API flips the
  // already-claimed row for (app, machine_id) to `ready` via the session-less
  // RPC 0080. A stale/absent claim answers `stale` and the worker does not
  // proceed — but the worker treats readiness as fail-open anyway, so the
  // API's start-wait budget + reaper are the true backstops.
  router.post('/ready-machine', requireWorkerPhoneAuth, async (req, res) => {
    try {
      if (!enabled) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const parsed = readyMachineSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid_request' });
      }
      const { data, error } = await rpc('mark_voice_worker_ready_machine', {
        p_app: parsed.data.app,
        p_machine_id: parsed.data.machine_id,
        p_now: now().toISOString(),
      });
      if (error) {
        return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
      }
      const status = (data && typeof data === 'object' && !Array.isArray(data)
        ? (data as Record<string, unknown>).status
        : undefined);
      if (status === 'ready') {
        log.info('unknown_event', { error_category: 'voice_worker_ready_machine' });
        return res.json({ ok: true, status: 'ready' });
      }
      log.info('unknown_event', { error_category: 'voice_worker_ready_machine_stale' });
      return res.json({ ok: false, status: typeof status === 'string' ? status : 'stale' });
    } catch {
      return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
    }
  });

  return router;
}

/** Production wiring: gated on `env.workerOrchestration`, service-role RPC. */
export const voiceWorkerRouter = createVoiceWorkerRouter();
