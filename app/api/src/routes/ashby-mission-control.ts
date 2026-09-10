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
 *   POST /ingestions/:linkId/retry — admin: bounded, audited retry of ONE
 *                                    parse-class failed_review ingestion
 *   GET  /jobs/:externalJobId/stages         — admin: read-only stage discovery
 *   GET  /jobs/:externalJobId/feedback-form  — admin: read-only feedback-form
 *                                    SCHEMA discovery (ids/labels/types/scales;
 *                                    never feedback content)
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
import {
  probeJobStages,
  probeJobFeedbackForms,
  probeFeedbackFormDefinition,
  type FormDefinitionReader,
} from '../integrations/ashby/probe.js';
import { createAshbyProbeClient } from '../integrations/ashby/runtime.js';
import { HELLO_CHRISTY_SCORECARD_BINDING } from '../integrations/ashby/scorecard.js';
import { previewScorecardBinding, withRoleFit, type MetricToBind } from '../integrations/ashby/scorecard-autobind.js';
import { loadActiveRoleScorecard } from '../lib/scorecards/store.js';
import {
  snapshotScheduler,
  readBacklog,
  evaluateDegradation,
  DEGRADE_THRESHOLDS,
  type BacklogView,
  readScannerHealth,
  type ScannerHealthView,
  snapshotReconcilePass,
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
  /**
   * Injected read-only reader for one feedback-form DEFINITION (#275 binding
   * preview). Production uses the same probe client as the stage probe; an
   * explicit `null` means "disabled" (tests).
   */
  formDefinitionReader?: FormDefinitionReader | null;
  /**
   * Injected role/metric lookups for the binding preview (tests). Production
   * reads the mapping's role and the role's ACTIVE scorecard version.
   */
  scorecardPreview?: {
    /** `undefined` = mapping not found; `null` = mapping has no role. */
    readMappingRoleId(mappingId: string): Promise<string | null | undefined>;
    /** `null` = the role has no active v2 scorecard (v1 legacy path). */
    loadMetrics(roleId: string): Promise<MetricToBind[] | null>;
  };
  /** Injected last-reconciliation-pass snapshot for deterministic health tests. */
  reconcilePass?: () => ReturnType<typeof snapshotReconcilePass>;
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
  let probeClient: ReturnType<typeof createAshbyProbeClient> = null;
  const resolveProbeClient = (): ReturnType<typeof createAshbyProbeClient> => {
    if (probeResolved) return probeClient;
    probeResolved = true;
    try {
      const source = deps.configSource ?? process.env;
      probeClient = createAshbyProbeClient({
        config: loadAshbyConfig(source),
        runtimeConfig: loadAshbyRuntimeConfig(source),
      });
    } catch {
      probeClient = null;
    }
    return probeClient;
  };
  const resolveProbeReader = (): Parameters<typeof probeJobStages>[1] | null => {
    if (deps.probeReader !== undefined) return deps.probeReader;
    return resolveProbeClient();
  };
  // The same gated client serves the form-DEFINITION read; a disabled
  // integration answers 503 here exactly as it does for the stage probe.
  const resolveFormDefinitionReader = (): FormDefinitionReader | null => {
    if (deps.formDefinitionReader !== undefined) return deps.formDefinitionReader;
    // `probeReader: null` is the "integration disabled" seam every existing
    // test relies on; it must disable THIS reader too, so no test (or gate)
    // that closed the stage probe can have a real client built behind it.
    if (deps.probeReader === null) return null;
    return resolveProbeClient();
  };
  const scorecardPreview = deps.scorecardPreview ?? {
    async readMappingRoleId(mappingId: string): Promise<string | null | undefined> {
      const { data, error } = await supabase
        .from('ashby_job_mappings')
        .select('role_id')
        .eq('id', mappingId)
        .eq('provider', 'ashby')
        .maybeSingle();
      if (error) throw new Error('ashby_mc_mapping_role_error');
      if (!data) return undefined;
      const roleId = (data as { role_id?: string | null }).role_id ?? null;
      return typeof roleId === 'string' && UUID_RE.test(roleId) ? roleId : null;
    },
    async loadMetrics(roleId: string): Promise<MetricToBind[] | null> {
      const version = await loadActiveRoleScorecard(supabase as never, roleId);
      if (!version) return null;
      return version.metrics.map((m) => ({ key: m.key, name: m.name }));
    },
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

      // Last reconciliation pass observed BY THIS PROCESS (null when this
      // process has run none — never a fleet-wide claim). Counts and sanitized
      // codes only; this is what makes the runbook's admission gates
      // executable over HTTP instead of only inside the worker.
      const reconcile = deps.reconcilePass ? deps.reconcilePass() : snapshotReconcilePass();

      res.json({
        ok: true,
        status: verdict.status,
        reasons: verdict.reasons,
        integration,
        runtime,
        scheduler,
        reconcile,
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

  // ── Read-only feedback-form schema discovery (admin) ──────────────────────
  // The Ashby UI hides the internal form/section/field ids that a scorecard
  // binding would need, so HR cannot even review what a form is made of. This
  // performs the SAME single allowlisted READ as the stage probe
  // (jobInterviewPlan.info) and returns sanitized SCHEMA only.
  //
  // `applicationFeedback.list` is NOT called here and no feedback CONTENT is
  // read: no answer, score, comment, or interviewer note. Nothing is persisted
  // and no binding is created — an admin copies the ids by hand into the
  // approved configuration process. Write-back stays fail-closed either way.
  router.get('/jobs/:externalJobId/feedback-form', requireRole('admin'), async (req: Request, res: Response) => {
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
      const result = await probeJobFeedbackForms(jobId, reader);
      // Audit carries bounded COUNTS only. A form/field id is tenant
      // configuration; putting one in an audit row or a log would spread it
      // beyond the one authenticated response that asked for it.
      await recordAudit(req, 'resource.read', 200, {
        metadata: {
          resource: 'ashby_job_feedback_forms',
          count: result.forms.length,
          field_count: result.forms.reduce((n, f) => n + f.fieldCount, 0),
          truncated: result.truncated,
        },
      });
      res.json({ ok: true, forms: result.forms, empty: result.empty, truncated: result.truncated });
    } catch {
      // A tenant 401/403/404 or an unparseable body is a sanitized capability
      // failure. Never echo the provider body.
      res.status(502).json({ ok: false, error: 'probe_unavailable' });
    }
  });

  // ── Read-only scorecard binding preview (admin) — issue #275 ──────────────
  // v2 metrics bind to the tenant form BY NAME at write time (see
  // integrations/ashby/scorecard-autobind.ts). This shows a recruiter what
  // that binding WOULD do for one mapping's role — which metrics have a Score
  // field titled exactly like them, which do not and why, and whether the four
  // fixed fields are still where the verified binding expects them — BEFORE a
  // candidate is scored. One allowlisted READ (feedbackFormDefinition.info) of
  // the verified form, plus two server-side table reads. Nothing is written,
  // persisted, bound, or submitted; no feedback content is read.
  router.get('/mappings/:id/scorecard-binding', requireRole('admin'), async (req: Request, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) { res.status(400).json({ ok: false, error: 'invalid_mapping_id' }); return; }
    const reader = resolveFormDefinitionReader();
    if (!reader) {
      // Runtime gates closed → no client is constructed and no call is made.
      res.status(503).json({ ok: false, error: 'integration_disabled' }); return;
    }
    const formDefinitionId = HELLO_CHRISTY_SCORECARD_BINDING.formDefinitionId;
    if (!HELLO_CHRISTY_SCORECARD_BINDING.verified || !formDefinitionId) {
      res.status(409).json({ ok: false, error: 'binding_unverified' }); return;
    }

    let roleId: string | null | undefined;
    let metrics: MetricToBind[] | null;
    try {
      roleId = await scorecardPreview.readMappingRoleId(id);
      if (roleId === undefined) { res.status(404).json({ ok: false, error: 'mapping_not_found' }); return; }
      metrics = roleId ? await scorecardPreview.loadMetrics(roleId) : null;
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_read_error' }); return;
    }

    try {
      const form = await probeFeedbackFormDefinition(formDefinitionId, reader);
      if (!form) { res.status(502).json({ ok: false, error: 'probe_unavailable' }); return; }
      // No active v2 scorecard → the worker takes the v1 legacy path, which
      // uses the static binding and needs no name matching. Say so rather than
      // rendering an empty metric table as "nothing to bind".
      // A v2 write also carries the derived "Role fit" dimension (#282 signal
      // on the form's kept v1 field), so the preview shows that row as well.
      const preview = previewScorecardBinding(HELLO_CHRISTY_SCORECARD_BINDING, form, metrics ? withRoleFit(metrics) : []);
      const scoringPath: 'v2_autobind' | 'v1_legacy' | 'no_role' = !roleId ? 'no_role' : metrics ? 'v2_autobind' : 'v1_legacy';
      // Audit carries bounded COUNTS only — a field path or metric name is
      // tenant configuration and stays inside the one authenticated response.
      await recordAudit(req, 'resource.read', 200, {
        metadata: {
          resource: 'ashby_scorecard_binding_preview',
          scoring_path: scoringPath,
          metric_count: preview.metrics.length,
          bound_count: preview.metrics.filter((m) => m.status === 'bound').length,
          ready: preview.ready,
        },
      });
      res.json({ ok: true, scoringPath, preview });
    } catch {
      // A tenant 401/403/404 or an unparseable body is a sanitized capability
      // failure. Never echo the provider body.
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

  /**
   * Bounded, audited admin retry of a parse-class `failed_review` ingestion.
   *
   * Deliberately NOT a counter reset. The RPC charges an attempt against the
   * unchanged 0032 ceiling, so this can be used a bounded number of times and
   * an exhausted row answers 409 rather than being resurrected. Everything
   * that decides whether the retry is allowed — state, terminal application,
   * the parse-availability reason allowlist — is enforced SERVER-SIDE in the
   * RPC, not here; this route contributes authentication, an admin gate, id
   * validation and the audit record.
   *
   * It issues no invite and moves no stage. Clearing the ingestion is what
   * eventually lets the ordinary 0035 invite prerequisite hold; nothing here
   * short-circuits that.
   */
  router.post('/ingestions/:applicationLinkId/retry', requireRole('admin'), async (req: Request, res: Response) => {
    const linkId = req.params.applicationLinkId;
    if (!UUID_RE.test(linkId)) {
      res.status(400).json({ ok: false, error: 'invalid_application_link_id' });
      return;
    }
    try {
      const actorId = req.authUser?.id ?? '';
      const result = await store().retryIngestionParse(linkId, actorId);
      // Opaque link id and a stable status only — never the failure reason
      // text, an external Ashby id, a file handle, or a candidate field.
      await recordAudit(req, 'resource.update', result.status === 'ok' ? 200 : 409, {
        metadata: {
          resource: 'ashby_resume_ingestion',
          application_link_id: linkId,
          outcome: result.status,
        },
      });
      if (result.status === 'ok') { res.json({ ok: true }); return; }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  /**
   * ONE-SHOT release of a LEGACY `parse_bad_output` ingestion (0041).
   *
   * A DELIBERATELY SEPARATE route rather than a widening of the retry above.
   * `parse_bad_output` never meant "this document is bad" — the parser parent
   * raises it only when `JSON.parse` of the child's stdout throws — and our own
   * dependency was breaking that channel: pdf.js logs warnings through
   * `console.log`, i.e. to stdout, so a PDF it merely warned about had a
   * `Warning: ` line prepended to the child's valid JSON. Those rows recorded a
   * verdict the document never earned, and document verdicts are refused by the
   * ordinary recovery for ever.
   *
   * Everything that decides eligibility is SERVER-SIDE in the RPC: the reason
   * must be exactly `parse_bad_output`, the row must predate a boundary the
   * migration stamped at application time, the one-shot flag must be unspent,
   * the unchanged five-attempt ceiling must still allow it, and the application
   * must not be terminal. This route contributes authentication, the admin
   * gate, id validation and the audit record — and nothing else. A newer
   * `parse_bad_output` is a genuine protocol anomaly and is refused here just
   * as firmly as an unparseable document.
   *
   * It issues no invite, moves no stage, and calls no provider.
   */
  router.post('/ingestions/:applicationLinkId/retry-legacy-parse', requireRole('admin'), async (req: Request, res: Response) => {
    const linkId = req.params.applicationLinkId;
    if (!UUID_RE.test(linkId)) {
      res.status(400).json({ ok: false, error: 'invalid_application_link_id' });
      return;
    }
    try {
      const actorId = req.authUser?.id ?? '';
      const result = await store().retryLegacyBadOutput(linkId, actorId);
      // Opaque link id and a stable status only — never the failure reason
      // text, an external Ashby id, a file handle, a candidate field, or the
      // boundary itself.
      await recordAudit(req, 'resource.update', result.status === 'ok' ? 200 : 409, {
        metadata: {
          resource: 'ashby_resume_ingestion',
          application_link_id: linkId,
          outcome: result.status,
        },
      });
      if (result.status === 'ok') { res.json({ ok: true }); return; }
      res.status(409).json({ ok: false, error: result.status });
    } catch {
      res.status(500).json({ ok: false, error: 'mission_control_action_error' });
    }
  });

  /**
   * Audited re-drive of a MODEL-DEGRADED ready ingestion (0084).
   *
   * A DELIBERATELY SEPARATE route from the two retries above, because it
   * admits the one row both of them refuse for ever: a "successful"
   * ingestion (`state = 'ready'`) whose structuring silently fell back to
   * the deterministic extractor when the model call failed (RCA 2026-09-07:
   * one of three identical résumés), leaving the candidate permanently
   * non-dialable with no operator remedy short of a new application.
   *
   * Everything that decides eligibility is SERVER-SIDE in the RPC: the state
   * must be `ready`, the structurer tag must be in the
   * `deterministic-fallback%` family, the application must not be terminal,
   * the unchanged five-attempt ceiling must still allow it, and an in-flight
   * ingestion job refuses before anything is spent. The recovery is
   * self-limiting — a re-run the model answers rewrites the tag and closes
   * the door. This route contributes authentication, the admin gate, id
   * validation and the audit record, and nothing else.
   *
   * It issues no invite, moves no stage, and calls no provider.
   */
  router.post('/ingestions/:applicationLinkId/retry-model-degraded', requireRole('admin'), async (req: Request, res: Response) => {
    const linkId = req.params.applicationLinkId;
    if (!UUID_RE.test(linkId)) {
      res.status(400).json({ ok: false, error: 'invalid_application_link_id' });
      return;
    }
    try {
      const actorId = req.authUser?.id ?? '';
      const result = await store().retryModelDegraded(linkId, actorId);
      // Opaque link id and a stable status only — never a structurer tag, an
      // external Ashby id, a file handle, or a candidate field.
      await recordAudit(req, 'resource.update', result.status === 'ok' ? 200 : 409, {
        metadata: {
          resource: 'ashby_resume_ingestion',
          application_link_id: linkId,
          outcome: result.status,
        },
      });
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
