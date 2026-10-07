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
import { AGENT_NAME_RE } from '../integrations/livekit-phone-dial/agent-name.js';

const log = createLogger('voice-worker');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Fly app slugs are [a-z0-9-]; machine ids are hex. Bounded and structural. */
const FLY_ID_RE = /^[A-Za-z0-9_.-]{1,256}$/;
/**
 * The browser worker's Fly app (BROWSER_FLY_APP). Duplicated as a literal so
 * this thin route does not import the orchestration runtime; the browser host
 * report below is accepted for THIS app only.
 */
const BROWSER_APP = 'project-hello-voice';
// DNS hostnames only: no scheme, port, path, whitespace, or credentials.
// IPv4 literals are valid hostname labels and intentionally accepted.
// Mirrors the worker's _BROWSER_DNS_HOST_RE and migration 0118's CHECK (which also
// requires lowercase: the schema below lowercases an accepted value).
const DNS_LABEL = '[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?';
export const LIVEKIT_HOST_RE = new RegExp(
  String.raw`^(?=.{1,253}$)(?:${DNS_LABEL})(?:\.(?:${DNS_LABEL}))*$`,
);

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
 *
 * ── OPTIONAL `agent_name` (M009 E2) ───────────────────────────────────
 * A phone worker that registered with LiveKit under its PER-MACHINE name
 * (`<base>-<flyMachineId>`, behind the worker-side PHONE_PER_MACHINE_AGENT_NAME
 * flag) reports that exact name here, so the API can dispatch the session's job
 * to the machine leased for it instead of to whichever worker LiveKit picks.
 * Absent (every browser worker, every flag-off phone worker) the body and the
 * handling are byte-identical to before. The pattern is the 0112 CHECK
 * constraint's, so a name this schema admits is a name the column accepts.
 * Still `.strict()`: an unknown key is a 400, never silently dropped.
 */
const readyMachineSchema = z
  .object({
    app: z.string().regex(FLY_ID_RE),
    machine_id: z.string().regex(FLY_ID_RE),
    agent_name: z.string().regex(AGENT_NAME_RE).optional(),
    livekit_host: z
      .string()
      .regex(LIVEKIT_HOST_RE)
      .transform((value) => value.toLowerCase())
      .optional(),
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
      // ── R1: record the reported LiveKit host BEFORE marking ready ──────
      // Same ordering safety as the agent name below: the R1 gate admits a
      // worker only when the lease carries its endpoint host, and it reads
      // `ready` and the host from the same row. If `ready` could land before
      // the host, the gate would read a ready lease with no (or an OLD) host.
      //
      // Scope, all deliberate:
      //   - BROWSER app only. A phone body that carries `livekit_host` is
      //     accepted and IGNORED (200, only mark_ready runs): a 400 would defer
      //     phone dials, and the lease column / RPC are browser-only anyway.
      //   - PRESENT only. A body without the key (every Cloud browser worker and
      //     every phone worker — the worker sends it only when it is opted into
      //     R1) makes NO host RPC: the live Cloud lane's calls here are exactly
      //     what they were before 0118, and an API deploy never needs 0118 for
      //     Cloud readiness. A stale host from an earlier boot cannot leak into
      //     a host-less report either: claim/reset null it in the database.
      //   - FAIL-CLOSED, like the name. Anything but `ok` is NOT marked ready:
      //     `stale` (no starting/ready browser lease) answers 200 {ok:false,
      //     status:'stale'} exactly like a stale ready, and every other outcome
      //     (driver error, throw, invalid_request, unrecognised) is a 500. The
      //     worker treats the ping as fail-open and re-posts on reconnect, and
      //     the R1 gate's ready budget then times out and DEFERS rather than
      //     admitting a worker whose endpoint it cannot prove. The worker's
      //     post is bounded-retried ONCE after a short backoff (a transient 5xx
      //     or this 500 is thereby recoverable inside the budget) and re-posts
      //     on every websocket reconnect; there is no further retry. Logs carry
      //     the event kind only — never the host, the machine id or driver
      //     detail.
      if (parsed.data.app === BROWSER_APP && parsed.data.livekit_host !== undefined) {
        let hostStatus: unknown;
        try {
          const hosted = await rpc('set_voice_worker_livekit_host', {
            p_app: parsed.data.app,
            p_machine_id: parsed.data.machine_id,
            p_livekit_host: parsed.data.livekit_host,
            p_now: now().toISOString(),
          });
          hostStatus = (!hosted.error && hosted.data && typeof hosted.data === 'object'
            && !Array.isArray(hosted.data)
            ? (hosted.data as Record<string, unknown>).status
            : undefined);
        } catch {
          log.info('unknown_event', { error_category: 'browser_ready_host_record_error' });
          return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
        }
        if (hostStatus === 'stale') {
          log.info('unknown_event', { error_category: 'voice_worker_ready_machine_stale' });
          return res.json({ ok: false, status: 'stale' });
        }
        if (hostStatus !== 'ok') {
          log.info('unknown_event', { error_category: 'browser_ready_host_record_rejected' });
          return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
        }
      }
      // ── M009 E2: record the reported per-machine name BEFORE marking ready.
      // ORDER IS THE SAFETY PROPERTY. The dial gate dispatches the moment it
      // reads `ready`; if `ready` landed first, a dial could read a ready lease
      // whose name is still null and dispatch the SHARED name — which this
      // worker no longer answers — dialling the candidate into a room with no
      // agent. So the name is written first and `ready` only follows a
      // confirmed `ok`.
      //
      // Any failure here (driver error, `invalid_request`, anything
      // unrecognised) is a 500 and the row is NOT marked ready. That is
      // deliberately fail-closed on the API side: the worker treats this ping
      // as fail-open, the gate's ready budget then times out and DEFERS the
      // dial (worker_not_ready), and nothing is ever dispatched to a name the
      // lease does not carry. Logs carry the event kind only — never the name,
      // the machine id or the driver message.
      //
      // `stale` is the ONE benign answer and is NOT a 500: the RPC only names
      // a `starting`/`ready` lease, so a lease that is already `busy` (a
      // targeted dial marked it, and the SDK's replacement idle process then
      // re-posts this ping from its own prewarm) or `draining` answers
      // `stale` on EVERY call. Turning that into a 500 would emit a 5xx and a
      // "rejected" log line per successful call, drowning the real signal. It
      // gets exactly the legacy path's answer for a non-ready claim — 200
      // {ok:false, status:'stale'} — and STILL never calls mark_ready, so the
      // ordering guarantee above is unchanged.
      if (parsed.data.agent_name !== undefined) {
        const named = await rpc('set_voice_worker_agent_name', {
          p_app: parsed.data.app,
          p_machine_id: parsed.data.machine_id,
          p_agent_name: parsed.data.agent_name,
          p_now: now().toISOString(),
        });
        const namedStatus = (!named.error && named.data && typeof named.data === 'object'
          && !Array.isArray(named.data)
          ? (named.data as Record<string, unknown>).status
          : undefined);
        if (namedStatus === 'stale') {
          log.info('unknown_event', { error_category: 'voice_worker_ready_machine_stale' });
          return res.json({ ok: false, status: 'stale' });
        }
        if (namedStatus !== 'ok') {
          log.info('unknown_event', { error_category: 'voice_worker_agent_name_rejected' });
          return res.status(500).json({ ok: false, error: 'voice_worker_ready_error' });
        }
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
