/**
 * routes/ashby-mission-control.ts — authorized HR/admin Mission Control for the
 * Ashby screening workflow.
 *
 * Mounted AFTER the global recruiter-auth + viewer-read-only middleware, so an
 * unauthenticated or candidate caller is already rejected (401/403). Reads
 * require interviewer+ (HR reviewers); state-changing actions require admin.
 *
 * Surfaces (sanitized — opaque ids + lifecycle/operation/ingestion states +
 * sanitized codes only; NEVER candidate PII, invite tokens, presigned URLs,
 * transcripts, or recordings):
 *   GET  /mappings                 — job mappings incl. paused/drift + completeness
 *   GET  /workflows                — application workflows incl. pending/expired/
 *                                    failed_review/cancelled/withdrawn/delivery/
 *                                    writeback states
 *   POST /mappings/:id/pause       — admin: pause a mapping
 *   POST /mappings/:id/resume      — admin: resume (enable) a complete, non-drift mapping
 *   POST /workflows/:id/cancel     — admin: atomic terminal cancellation
 *   POST /operations/:id/retry     — admin: retry a failed safe operation
 *
 * Every mutation is race-safe + audited inside its RPC (0031). Candidate results
 * are never exposed here.
 */

import { Router, type Request, type Response } from 'express';
import { supabase } from '../lib/supabase.js';
import { requireRole } from '../lib/rbac.js';
import { recordAudit } from '../lib/audit.js';
import { createMissionControlStore, type MissionControlStore } from '../integrations/ashby/workflow-stores.js';
import {
  loadAshbyConfig,
  loadAshbyRuntimeConfig,
  describeAshbyConfig,
  describeAshbyRuntime,
  isAshbyRuntimeActive,
} from '../integrations/ashby/config.js';
import { probeJobStages } from '../integrations/ashby/probe.js';
import { createAshbyProbeClient } from '../integrations/ashby/runtime.js';
import {
  snapshotScheduler,
  readBacklog,
  evaluateDegradation,
  DEGRADE_THRESHOLDS,
  type BacklogView,
  readScannerHealth,
  type ScannerHealthView,
} from '../integrations/ashby/runtime-health.js';
import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiresAt,
  INVITE_TTL_HOURS,
} from '../lib/invite-token.js';
import { env } from '../lib/env.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TERMINAL_STATES = new Set(['withdrawn', 'deleted', 'manual_stage_cancel']);
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function boundedLimit(raw: unknown): number {
  const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

/**
 * First configured web origin, used to build the candidate join link. WEB_ORIGIN
 * is a validated canonical allowlist (see app.ts), so this is not user input.
 */
function primaryWebOrigin(): string {
  const first = env.webOrigin.split(',')[0]?.trim() ?? '';
  return first.replace(/\/+$/, '');
}

function sanitizedReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, 200);
  return trimmed.length > 0 ? trimmed : null;
}

const DELIVERY_MODES = new Set(['email', 'manual', 'both']);
const OPAQUE_ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const MAX_LABEL_LEN = 120;

/** Validate an optional opaque tenant id. `null` when absent, `false` when bad. */
function optionalOpaqueId(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !OPAQUE_ID_RE.test(raw)) return false;
  return raw;
}

export interface AshbyMissionControlDeps {
  store?: MissionControlStore;
  /**
   * Injected read-only tenant reader for the stage probe. Production resolves
   * it from the runtime (null when the runtime gates are closed), so a disabled
   * integration answers 503 without constructing a client or touching the network.
   */
  probeReader?: Parameters<typeof probeJobStages>[1] | null;
  /** Injected config sources for deterministic health tests. */
  configSource?: NodeJS.ProcessEnv;
  /** Injected scheduler snapshot (tests). Production reads the live registry. */
  schedulerSnapshot?: () => ReturnType<typeof snapshotScheduler>;
  /** Injected backlog reader (tests). Production queries the database. */
  backlog?: () => Promise<BacklogView>;
  /** Injected scanner-readiness reader (tests). Production reads the signature DB. */
  scanner?: () => Promise<ScannerHealthView>;
}

export function createAshbyMissionControlRouter(deps: AshbyMissionControlDeps = {}): Router {
  const router = Router();
  let cached: MissionControlStore | undefined = deps.store;
  const store = (): MissionControlStore => {
    if (!cached) cached = createMissionControlStore(supabase as never);
    return cached;
  };

  // Lazily resolve the probe reader. When any gate is closed the factory
  // returns null, so no client is built and the probe route answers 503
  // without a network call. `undefined` in deps means "resolve from config";
  // an explicit `null` means "disabled" (tests).
  //
  // This builds ONLY a client — not a whole runtime — so the route owns no
  // parser pool or other resource it would need to shut down (finding L3).
  let probeResolved = false;
  let probeReader: Parameters<typeof probeJobStages>[1] | null = null;
  const resolveProbeReader = (): Parameters<typeof probeJobStages>[1] | null => {
    if (deps.probeReader !== undefined) return deps.probeReader;
    if (probeResolved) return probeReader;
    probeResolved = true;
    try {
      const source = deps.configSource ?? process.env;
      probeReader = createAshbyProbeClient({
        config: loadAshbyConfig(source),
        runtimeConfig: loadAshbyRuntimeConfig(source),
      });
    } catch {
      probeReader = null;
    }
    return probeReader;
  };

  // ── Reads (interviewer+) ──────────────────────────────────────────────────
  router.get('/mappings', requireRole('interviewer'), async (req: Request, res: Response) => {
    try {
      const mappings = await store().listMappings(boundedLimit(req.query.limit));
      await recordAudit(req, 'resource.list', 200, { metadata: { resource: 'ashby_mapping', count: mappings.length } });
      res.json({ ok: true, mappings });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_read_error' });
    }
  });

  router.get('/workflows', requireRole('interviewer'), async (req: Request, res: Response) => {
    try {
      const workflows = await store().listWorkflows(boundedLimit(req.query.limit));
      await recordAudit(req, 'resource.list', 200, { metadata: { resource: 'ashby_workflow', count: workflows.length } });
      res.json({ ok: true, workflows });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_read_error' });
    }
  });

  // ── Actions (admin) ───────────────────────────────────────────────────────
  async function setStatus(req: Request, res: Response, next: 'paused' | 'enabled'): Promise<void> {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ ok: false, error: 'invalid_mapping_id' });
      return;
    }
    try {
      const actorId = req.authUser?.id ?? null;
      if (!actorId) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const result = await store().setMappingStatus(id, next, sanitizedReason(req.body?.reason), actorId);
      if (result.status === 'ok') {
        res.json({ ok: true, status: result.mappingStatus ?? next });
        return;
      }
      if (result.status === 'not_found') { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      // incomplete_cannot_enable / drifted_cannot_enable / invalid_status → 409.
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  }

  router.post('/mappings/:id/pause', requireRole('admin'), (req, res) => { void setStatus(req, res, 'paused'); });
  router.post('/mappings/:id/resume', requireRole('admin'), (req, res) => { void setStatus(req, res, 'enabled'); });

  router.post('/workflows/:id/cancel', requireRole('admin'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid_workflow_id' }); return; }
    const terminalState = typeof req.body?.terminal_state === 'string' ? req.body.terminal_state : 'manual_stage_cancel';
    if (!TERMINAL_STATES.has(terminalState)) { res.status(400).json({ ok: false, error: 'invalid_terminal_state' }); return; }
    try {
      const actorId = req.authUser?.id ?? null;
      if (!actorId) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const result = await store().cancelApplication(id, terminalState, sanitizedReason(req.body?.reason), actorId);
      if (result.status === 'ok') {
        res.json({ ok: true, cancelled_operations: result.cancelledOperations ?? 0, cancelled_ingestion: result.cancelledIngestion ?? 0 });
        return;
      }
      if (result.status === 'already_terminal') { res.status(409).json({ ok: false, error: 'already_terminal' }); return; }
      if (result.status === 'not_found') { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  // ── Health / operability (interviewer+) ───────────────────────────────────
  // Deliberately NOT on the public /api/health, which stays a liveness-only
  // {ok:true}. Booleans, bounded integers, counts and timestamps ONLY — never
  // the API key, the webhook secret, an allowlisted host, an invite token, a
  // presigned URL, or any candidate field.
  router.get('/health', requireRole('interviewer'), async (_req: Request, res: Response) => {
    try {
      const source = deps.configSource ?? process.env;
      const cfg = loadAshbyConfig(source);
      const rc = loadAshbyRuntimeConfig(source);
      const integration = describeAshbyConfig(cfg);
      const runtime = describeAshbyRuntime(cfg, rc);

      // Two INDEPENDENT liveness signals, because neither alone is truthful:
      //  - the in-process scheduler heartbeat (real tick bookkeeping, but only
      //    describes THIS machine);
      //  - the durable backlog (correct fleet-wide, on any machine).
      // Config-active is never reported as worker-live.
      const scheduler = deps.schedulerSnapshot
        ? deps.schedulerSnapshot()
        : snapshotScheduler();
      let backlog: BacklogView | null = null;
      let backlogError = false;
      try {
        backlog = deps.backlog ? await deps.backlog() : await readBacklog(supabase as never);
      } catch {
        // A backlog read failure must not take the whole health surface down,
        // but it must not be silently reported as a healthy zero either.
        backlogError = true;
      }

      // Resume malware-scanner readiness. Read on every call (behind a short
      // TTL in the reader) so a database that goes stale becomes visible
      // without a redeploy. Never throws.
      const scanner = deps.scanner ? await deps.scanner() : await readScannerHealth(source);

      const verdict = backlog
        ? evaluateDegradation({ active: runtime.active, scheduler, backlog, scanner })
        : {
            status: 'degraded' as const,
            reasons: runtime.active && !scanner.ready
              ? ['backlog_unavailable', `scanner_${scanner.reason ?? 'not_ready'}`]
              : ['backlog_unavailable'],
          };

      res.json({
        ok: true,
        status: verdict.status,
        reasons: verdict.reasons,
        integration,
        runtime,
        scheduler,
        backlog,
        backlogError,
        scanner,
        thresholds: DEGRADE_THRESHOLDS,
        // No live-connectivity claim is made anywhere here: nothing in this
        // handler contacts Ashby, so asserting "provider ok" would be a lie.
        provider: 'unknown',
      });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_read_error' });
    }
  });

  // ── Mapping provisioning (admin) ──────────────────────────────────────────
  // ALWAYS creates/updates a PAUSED mapping. Enabling stays the separate
  // POST /mappings/:id/resume action, which the DB still gates on stage
  // completeness and absence of drift.
  router.post('/mappings', requireRole('admin'), async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const actorId = req.authUser?.id ?? null;
    if (!actorId) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

    const externalJobId = body.external_job_id;
    if (typeof externalJobId !== 'string' || !OPAQUE_ID_RE.test(externalJobId)) {
      res.status(400).json({ ok: false, error: 'invalid_external_job_id' }); return;
    }
    const roleId = body.role_id;
    if (typeof roleId !== 'string' || !UUID_RE.test(roleId)) {
      res.status(400).json({ ok: false, error: 'invalid_role_id' }); return;
    }
    const ownerId = typeof body.owner_id === 'string' && UUID_RE.test(body.owner_id)
      ? body.owner_id
      : actorId;
    const deliveryMode = typeof body.delivery_mode === 'string' ? body.delivery_mode : 'manual';
    if (!DELIVERY_MODES.has(deliveryMode)) {
      res.status(400).json({ ok: false, error: 'invalid_delivery_mode' }); return;
    }
    // The TTL is fixed at 24h by a DB CHECK; reject an explicit disagreement
    // rather than silently overriding the caller.
    if (body.invite_ttl_hours !== undefined && body.invite_ttl_hours !== 24) {
      res.status(400).json({ ok: false, error: 'invalid_invite_ttl_hours' }); return;
    }
    const id = body.id === undefined || body.id === null
      ? null
      : (typeof body.id === 'string' && UUID_RE.test(body.id) ? body.id : false);
    if (id === false) { res.status(400).json({ ok: false, error: 'invalid_mapping_id' }); return; }

    const ai = optionalOpaqueId(body.ai_screening_stage_id);
    const ta = optionalOpaqueId(body.ta_screening_stage_id);
    const form = optionalOpaqueId(body.feedback_form_id);
    const interview = optionalOpaqueId(body.interview_id);
    const attribution = optionalOpaqueId(body.attribution_user_id);
    if (ai === false || ta === false || form === false || interview === false || attribution === false) {
      res.status(400).json({ ok: false, error: 'invalid_stage_id' }); return;
    }
    const rawLabel = body.label;
    if (rawLabel !== undefined && rawLabel !== null
        && (typeof rawLabel !== 'string' || rawLabel.length > MAX_LABEL_LEN)) {
      res.status(400).json({ ok: false, error: 'invalid_label' }); return;
    }

    try {
      const result = await store().upsertMapping({
        id,
        externalJobId,
        roleId,
        ownerId,
        deliveryMode: deliveryMode as 'email' | 'manual' | 'both',
        aiScreeningStageId: ai,
        taScreeningStageId: ta,
        feedbackFormId: form,
        interviewId: interview,
        attributionUserId: attribution,
        label: typeof rawLabel === 'string' ? rawLabel : null,
        actorId,
      });
      if (result.status === 'ok' || result.status === 'created' || result.status === 'updated') {
        await recordAudit(req, 'resource.create', 200, {
          metadata: { resource: 'ashby_mapping', status: 'paused' },
        });
        res.status(201).json({ ok: true, id: result.id, status: 'paused' });
        return;
      }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  // ── Read-only tenant stage probe (admin) ──────────────────────────────────
  // Discovery only: performs exactly one allowlisted READ operation
  // (jobInterviewPlan.info) and returns sanitized stage ids + bounded titles.
  // It NEVER writes a mapping — an admin applies the ids through POST /mappings.
  router.get('/jobs/:externalJobId/stages', requireRole('admin'), async (req: Request, res: Response) => {
    const jobId = req.params.externalJobId;
    if (typeof jobId !== 'string' || !OPAQUE_ID_RE.test(jobId)) {
      res.status(400).json({ ok: false, error: 'invalid_external_job_id' }); return;
    }
    const reader = resolveProbeReader();
    if (!reader) {
      // Runtime gates closed → no client is constructed and no call is made.
      res.status(503).json({ ok: false, error: 'integration_disabled' }); return;
    }
    try {
      const result = await probeJobStages(jobId, reader);
      await recordAudit(req, 'resource.read', 200, {
        metadata: { resource: 'ashby_job_stages', count: result.stages.length },
      });
      res.json({ ok: true, stages: result.stages, empty: result.empty });
    } catch {
      // A tenant 401/403/404 is reported as a sanitized capability failure and
      // enables nothing. Never echo the provider body.
      res.status(502).json({ ok: false, error: 'probe_unavailable' });
    }
  });

  // ── Manual invite delivery / reissue (admin) ──────────────────────────────
  // The delivery half of the manual channel. Minting an invite only produces a
  // SHA-256 digest, so without this endpoint the candidate could never be
  // contacted and the delivery operation would report success for work that
  // never happened. The operation worker therefore parks manual deliveries as
  // `awaiting_manual_delivery`; this route is what genuinely completes them.
  //
  // TOKEN HANDLING: the plaintext is minted here, hashed, and the DIGEST alone
  // is sent to the RPC. The plaintext is returned exactly once in this HTTPS
  // response and is never logged, audited, persisted, put in a URL query, or
  // sent to Ashby. The candidate link carries it in the URL FRAGMENT, which
  // browsers do not send to servers and which CandidateJoinPage strips
  // immediately into memory.
  router.post('/workflows/:id/invite', requireRole('admin'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid_workflow_id' }); return; }
    const actorId = req.authUser?.id ?? null;
    if (!actorId) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

    // A one-time secret must never be cached by a proxy, the browser, or a
    // back/forward restore.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');

    try {
      const token = generateInviteToken();
      const expiresAt = inviteExpiresAt().toISOString();
      const result = await store().reissueManualInvite({
        applicationLinkId: id,
        tokenDigest: hashInviteToken(token),
        expiresAt,
        actorId,
      });

      if (result.status !== 'ok') {
        if (result.status === 'not_found') { res.status(404).json({ ok: false, error: 'not_found' }); return; }
        // blocked_terminal / not_ready / invalid_* are all 409 conflicts.
        res.status(409).json({ ok: false, error: result.status });
        return;
      }

      // Audited WITHOUT the token — opaque ids and a count only.
      await recordAudit(req, 'resource.create', 200, {
        metadata: {
          resource: 'ashby_manual_invite',
          application_link_id: id,
          invite_id: result.inviteId ?? null,
          revoked_invites: result.revokedInvites ?? 0,
        },
      });

      res.json({
        ok: true,
        invite_id: result.inviteId,
        // Fragment, never a query parameter.
        join_url: `${primaryWebOrigin()}/candidate/join#${token}`,
        expires_at: expiresAt,
        ttl_hours: INVITE_TTL_HOURS,
        revoked_invites: result.revokedInvites ?? 0,
      });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  router.post('/operations/:id/retry', requireRole('admin'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid_operation_id' }); return; }
    try {
      const actorId = req.authUser?.id ?? '';
      const result = await store().retryOperation(id, actorId);
      if (result.status === 'ok') { res.json({ ok: true }); return; }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  return router;
}

/** Default router instance (production wiring). */
export const ashbyMissionControlRouter = createAshbyMissionControlRouter();
