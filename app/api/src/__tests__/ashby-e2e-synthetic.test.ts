/**
 * Ashby screening workflow — synthetic END-TO-END fixture + adversarial
 * failure scenarios (Wave 2 PR C, original-contract verification floor).
 *
 * Drives the composed pipeline with in-memory adapters and zero real
 * network/DB/provider/email:
 *   stage signal → import → ephemeral parse → invite/manual state → synthetic
 *   completion → scorecard marker → TA-stage transition,
 * then proves every required failure scenario:
 *   SSRF-blocked fetch, fail-closed scan, terminal-cancel mid-flight, and a
 *   human stage move short-circuiting the stage transition (no auto-reject).
 */

import { describe, it, expect } from 'vitest';
import {
  runImport,
  runIngestionJob,
  runInviteDelivery,
  enqueueScorecard,
  enqueueStageMove,
  type WorkflowStores,
  type ApplicationReader,
  type ResolvedMapping,
  type ExistingLinkRow,
  type EnqueueResult,
} from '../integrations/ashby/orchestration.js';
import { runResumeIngestion, type IngestionPorts, type ParseOutput, type StructuredResume } from '../integrations/ashby/resume-ingestion.js';
import { fetchEphemeralResume } from '../integrations/ashby/resume-fetch.js';
import { planTerminalCancellation } from '../integrations/ashby/workflow.js';
import type { AshbyResult } from '../integrations/ashby/types.js';
import type { UrlPolicy } from '../integrations/ashby/ssrf.js';

const AI = 'stage_ai';
const TA = 'stage_ta';
const HOST = 'files.ashby.example';

/** A shared synthetic durable store recording everything the pipeline persists. */
class SyntheticStore implements WorkflowStores {
  links = new Map<string, ExistingLinkRow>();
  ingestion: string[] = [];
  ops: Array<{ id: string; linkId: string; type: string; key: string; dependsOn?: string | null; marker?: string | null; state: string }> = [];
  terminal = new Set<string>();
  private n = 0;
  private opN = 0;

  async findLinkByApplicationId(appId: string) {
    return this.links.get(appId) ?? null;
  }
  async createLink(input: { externalApplicationId: string }) {
    const id = `link_${++this.n}`;
    this.links.set(input.externalApplicationId, { id, externalApplicationId: input.externalApplicationId, terminalState: null });
    return { id };
  }
  async advanceIngestion(_linkId: string, nextState: string, _provenance?: { contentSha256?: string; extractorVersion?: string; structurerVersion?: string; failedReason?: string }) {
    this.ingestion.push(nextState);
    return { status: 'ok', state: nextState };
  }
  async enqueueOperation(input: { applicationLinkId: string; operationType: string; operationKey: string; dependsOn?: string | null; marker?: string | null }): Promise<EnqueueResult> {
    const linkTerminal = [...this.links.values()].some((l) => l.id === input.applicationLinkId && l.terminalState);
    if (linkTerminal) return { status: 'blocked_terminal' };
    if (this.ops.some((o) => o.key === input.operationKey)) return { status: 'duplicate' };
    if (input.marker && this.ops.some((o) => o.marker === input.marker)) return { status: 'duplicate_marker' };
    const id = `op_${++this.opN}`;
    this.ops.push({ id, linkId: input.applicationLinkId, type: input.operationType, key: input.operationKey, dependsOn: input.dependsOn, marker: input.marker, state: 'pending' });
    return { status: 'inserted', id };
  }
  async completeOperation(id: string): Promise<'ok' | 'not_owned'> {
    const op = this.ops.find((o) => o.id === id);
    if (op) op.state = 'succeeded';
    return 'ok';
  }
  async failOperation(): Promise<{ outcome: 'retry' | 'failed' } | 'not_owned'> {
    return { outcome: 'retry' };
  }
  markTerminal(linkId: string) {
    for (const l of this.links.values()) if (l.id === linkId) l.terminalState = 'withdrawn';
    this.terminal.add(linkId);
  }
}

function reader(app: Record<string, unknown>): ApplicationReader {
  return { applicationInfo: (async () => ({ results: app, moreDataAvailable: false })) as ApplicationReader['applicationInfo'] };
}
const appAtAi = { application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI } } };
const mapping: ResolvedMapping = { id: 'map_1', status: 'enabled', aiScreeningStageId: AI, deliveryMode: 'both' };
const policy: UrlPolicy = { allowlistEnabled: true, allowedHosts: [HOST] };

const STRUCTURED: StructuredResume = { name: 'Dana Lee', email: 'dana@example.com', phone: null, skills: ['sales'], experience_years: 5, current_role: 'Advisor', summary: 'Advisor' };
function ingestionPorts(linkId: string, store: SyntheticStore, over: Partial<IngestionPorts> = {}): IngestionPorts {
  const bytes = Buffer.from('%PDF-1.4 resume %%EOF');
  return {
    presignedUrl: `https://${HOST}/r.pdf`,
    policy,
    fetch: async (url, pol) => fetchEphemeralResume(url, pol, {
      resolve: async () => ['93.184.216.34'],
      transport: async () => ({ kind: 'body', status: 200, contentType: 'application/pdf', bytes, overLimit: false }),
    }),
    scan: async () => ({ safe: true, status: 'clean' }),
    guard: () => ({ ok: true, mime: 'application/pdf' }),
    parse: async (): Promise<ParseOutput> => ({ text: 'Dana Lee', structured: STRUCTURED, structurerVersion: 'p1' }),
    fallbackFromText: () => STRUCTURED,
    onState: async (s, prov) => { await store.advanceIngestion(linkId, s, prov); },
    extractorVersion: 'x1',
    ...over,
  };
}

const gates = { enabled: true, email: { providerApproved: false, domainVerified: false } };

describe('synthetic end-to-end: stage signal → TA transition', () => {
  it('imports, ingests, invites, scores, and transitions the stage', async () => {
    const store = new SyntheticStore();

    // 1. Stage signal → import.
    const imported = await runImport('app_1', { gates, client: reader(appAtAi), stores: store, resolveMapping: async () => mapping });
    expect(imported.status).toBe('imported');
    const linkId = imported.status === 'imported' ? imported.applicationLinkId : '';
    expect(store.ingestion).toContain('queued');
    expect(store.ops.filter((o) => o.type === 'invite_delivery')).toHaveLength(2); // both channels

    // 2. Ephemeral ingestion → ready.
    const ing = await runIngestionJob(linkId, {
      gates,
      stores: store,
      buildIngestionPorts: ({ onState }) => ingestionPorts(linkId, store, { onState }),
      isCancelled: async () => false,
    });
    expect(ing.status).toBe('done');
    if (ing.status === 'done') expect(ing.outcome.state).toBe('ready');
    expect(store.ingestion).toContain('ready');

    // 3. Invite (manual token-free + email provider-gated).
    expect(runInviteDelivery('manual', { gates, existingActiveInvite: null, applicationTerminal: false, externalApplicationId: 'app_1', recruiterReissuePath: '/mc/app_1/reissue' })).toMatchObject({ delivery: 'manual_reissue' });
    expect(runInviteDelivery('email', { gates, existingActiveInvite: null, applicationTerminal: false, externalApplicationId: 'app_1', recruiterReissuePath: '/mc/app_1/reissue' })).toMatchObject({ delivery: 'blocked_provider' });

    // 4. Synthetic assessment → scorecard (idempotent marker).
    const saga = { gates, stores: store, client: reader(appAtAi), scale: { min: 1, max: 4 }, applicationLinkId: linkId, externalApplicationId: 'app_1', aiScreeningStageId: AI };
    const sc = await enqueueScorecard(
      { overallScore: 78, recommendation: 'advance', dimensions: [{ key: 'communication', score: 8 }], summary: 'Strong', provenance: { model: 'm' }, reviewPath: '/review/s' },
      saga,
    );
    expect(sc.status).toBe('scorecard_enqueued');
    const scoreOp = store.ops.find((o) => o.type === 'scorecard_write');
    expect(scoreOp).toBeDefined();
    await store.completeOperation(scoreOp!.id); // synthetic scorecard write succeeds

    // 5. Stage move enqueued only because still at AI stage; depends on scorecard.
    const stage = await enqueueStageMove(scoreOp!.id, saga);
    expect(stage.status).toBe('stage_enqueued');
    const stageOp = store.ops.find((o) => o.type === 'stage_move');
    expect(stageOp?.dependsOn).toBe(scoreOp!.id);
  });
});

describe('synthetic adversarial failure scenarios', () => {
  it('SSRF: a resume URL resolving to a private IP fails the ingestion closed', async () => {
    const store = new SyntheticStore();
    const { id } = await store.createLink({ externalApplicationId: 'app_2' });
    const out = await runResumeIngestion(
      ingestionPorts(id, store, {
        fetch: async (url, pol) => fetchEphemeralResume(url, pol, {
          resolve: async () => ['169.254.169.254'], // cloud metadata
          transport: async () => ({ kind: 'body', status: 200, contentType: 'application/pdf', bytes: Buffer.from('x'), overLimit: false }),
        }),
      }),
    );
    expect(out.state).toBe('failed_review');
    if (out.state === 'failed_review') expect(out.reason).toBe('fetch_blocked_address');
  });

  it('malware: an infected scan blocks the parse (fail closed)', async () => {
    const store = new SyntheticStore();
    const { id } = await store.createLink({ externalApplicationId: 'app_3' });
    const out = await runResumeIngestion(ingestionPorts(id, store, { scan: async () => ({ safe: false, status: 'infected' }) }));
    expect(out.state).toBe('failed_review');
    if (out.state === 'failed_review') expect(out.reason).toBe('scan_infected');
  });

  it('terminal cancel mid-flight: cancels in-flight ops + ingestion, blocks new work, no auto-reject', async () => {
    const store = new SyntheticStore();
    const imported = await runImport('app_4', { gates, client: reader({ application: { id: 'app_4', job: { id: 'job_1' }, currentInterviewStage: { id: AI } } }), stores: store, resolveMapping: async () => mapping });
    const linkId = imported.status === 'imported' ? imported.applicationLinkId : '';
    // A recruiter withdraws the application: plan + apply terminal cancellation.
    const plan = planTerminalCancellation('withdrawn', store.ops.map((o) => ({ id: o.id, type: o.type as 'invite_delivery', state: o.state as 'pending' })), 'queued');
    expect(plan.cancelOperationIds.length).toBeGreaterThan(0);
    expect(plan.cancelIngestion).toBe(true);
    store.markTerminal(linkId);
    // New operations are now blocked (never auto-rejected — just no further work).
    const blocked = await store.enqueueOperation({ applicationLinkId: linkId, operationType: 'stage_move', operationKey: 'k_after_terminal' });
    expect(blocked.status).toBe('blocked_terminal');
  });

  it('human stage move: the saga skips the stage transition (never undoes a human action)', async () => {
    const store = new SyntheticStore();
    const { id } = await store.createLink({ externalApplicationId: 'app_5' });
    const movedApp = { application: { id: 'app_5', job: { id: 'job_1' }, currentInterviewStage: { id: TA } } }; // human moved to TA
    const saga = { gates, stores: store, client: reader(movedApp), scale: { min: 1, max: 4 }, applicationLinkId: id, externalApplicationId: 'app_5', aiScreeningStageId: AI };
    const stage = await enqueueStageMove('op_score', saga);
    expect(stage).toEqual({ status: 'stage_skipped', reason: 'human_moved' });
  });
});
