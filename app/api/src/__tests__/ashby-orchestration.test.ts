/**
 * Ashby orchestration workers — import, ingestion job, invite delivery, and the
 * scorecard→stage saga, driven entirely by synthetic in-memory adapters with
 * full failure injection (no real network/DB/provider). Proves the composed
 * code paths and the disabled-by-default gate.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runImport,
  runIngestionJob,
  runInviteDelivery,
  enqueueScorecard,
  enqueueStageMove,
  type WorkflowStores,
  type ApplicationReader,
  type ResolvedMapping,
  type OrchestrationGates,
  type ExistingLinkRow,
  type EnqueueResult,
} from '../integrations/ashby/orchestration.js';
import type { IngestionPorts, ParseOutput, StructuredResume } from '../integrations/ashby/resume-ingestion.js';
import type { ResumeFetchOutcome } from '../integrations/ashby/resume-fetch.js';
import type { ScorecardSource, ScorecardScale } from '../integrations/ashby/scorecard.js';
import type { AshbyResult } from '../integrations/ashby/types.js';

const enabledGates: OrchestrationGates = { enabled: true, email: { providerApproved: false, domainVerified: false } };
const disabledGates: OrchestrationGates = { enabled: false, email: { providerApproved: false, domainVerified: false } };

function reader(app: Record<string, unknown>): ApplicationReader {
  return {
    applicationInfo: (async () => ({ results: app, moreDataAvailable: false })) as ApplicationReader['applicationInfo'],
  };
}

class FakeStores implements WorkflowStores {
  links = new Map<string, ExistingLinkRow>();
  ingestionStates: Array<{ linkId: string; state: string }> = [];
  operations: Array<{ linkId: string; type: string; key: string; dependsOn?: string | null; marker?: string | null }> = [];
  seededLink?: ExistingLinkRow;
  createdResumeHandle: string | null | undefined;
  advanceResult: { status: string; state?: string } = { status: 'ok' };
  enqueueResult: EnqueueResult = { status: 'inserted', id: 'op_1' };
  private n = 0;

  async findLinkByApplicationId(appId: string): Promise<ExistingLinkRow | null> {
    return this.seededLink ?? this.links.get(appId) ?? null;
  }
  async createLink(input: { externalApplicationId: string; externalResumeFileHandle: string | null }): Promise<{ id: string }> {
    const id = `link_${++this.n}`;
    this.createdResumeHandle = input.externalResumeFileHandle;
    this.links.set(input.externalApplicationId, { id, externalApplicationId: input.externalApplicationId, terminalState: null });
    return { id };
  }
  async advanceIngestion(linkId: string, nextState: string): Promise<{ status: string; state?: string }> {
    this.ingestionStates.push({ linkId, state: nextState });
    return this.advanceResult;
  }
  async enqueueOperation(input: { applicationLinkId: string; operationType: string; operationKey: string; dependsOn?: string | null; marker?: string | null }): Promise<EnqueueResult> {
    this.operations.push({ linkId: input.applicationLinkId, type: input.operationType, key: input.operationKey, dependsOn: input.dependsOn, marker: input.marker });
    return this.enqueueResult;
  }
  async completeOperation(): Promise<'ok' | 'not_owned'> { return 'ok'; }
  async failOperation(): Promise<{ outcome: 'retry' | 'failed' } | 'not_owned'> { return { outcome: 'retry' }; }
}

const AI = 'stage_ai';
function mapping(over: Partial<ResolvedMapping> = {}): ResolvedMapping {
  return { id: 'map_1', status: 'enabled', aiScreeningStageId: AI, deliveryMode: 'both', ...over };
}
const appAtAi = { application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: AI } } };

describe('runImport', () => {
  it('no-ops when the integration is disabled', async () => {
    const r = await runImport('app_1', { gates: disabledGates, client: reader(appAtAi), stores: new FakeStores(), resolveMapping: async () => mapping() });
    expect(r).toEqual({ status: 'disabled' });
  });

  it('imports at the AI stage: creates one link, seeds ingestion, enqueues both invite ops', async () => {
    const stores = new FakeStores();
    const r = await runImport('app_1', { gates: enabledGates, client: reader(appAtAi), stores, resolveMapping: async () => mapping() });
    expect(r.status).toBe('imported');
    if (r.status === 'imported') expect(r.reused).toBe(false);
    expect(stores.ingestionStates).toEqual([{ linkId: 'link_1', state: 'queued' }]);
    expect(stores.operations.filter((o) => o.type === 'invite_delivery')).toHaveLength(2);
  });

  it('reuses an existing non-terminal link (one linkage per application)', async () => {
    const stores = new FakeStores();
    stores.seededLink = { id: 'link_x', externalApplicationId: 'app_1', terminalState: null };
    const r = await runImport('app_1', { gates: enabledGates, client: reader(appAtAi), stores, resolveMapping: async () => mapping() });
    expect(r.status).toBe('imported');
    if (r.status === 'imported') { expect(r.reused).toBe(true); expect(r.applicationLinkId).toBe('link_x'); }
  });

  it('falls back to candidate.info when application.info omits the attached resume', async () => {
    const stores = new FakeStores();
    const candidateInfo = vi.fn(async () => ({
      results: { resumeFileHandle: { handle: 'candidate_resume_handle' } },
      moreDataAvailable: false,
    }));
    const app = {
      application: {
        id: 'app_1', job: { id: 'job_1' }, candidate: { id: 'candidate_1' },
        currentInterviewStage: { id: AI },
      },
    };

    const r = await runImport('app_1', {
      gates: enabledGates,
      client: { ...reader(app), candidateInfo: candidateInfo as ApplicationReader['candidateInfo'] },
      stores,
      resolveMapping: async () => mapping({ deliveryMode: 'manual' }),
      readResumeFileHandle: (value) => {
        const rec = value as { resumeFileHandle?: { handle?: unknown } };
        return typeof rec.resumeFileHandle?.handle === 'string' ? rec.resumeFileHandle.handle : null;
      },
    });

    expect(r.status).toBe('imported');
    expect(candidateInfo).toHaveBeenCalledOnce();
    expect(candidateInfo).toHaveBeenCalledWith('candidate_1');
    expect(stores.createdResumeHandle).toBe('candidate_resume_handle');
  });

  it('skips a terminal link, a non-AI stage, and an inactive mapping', async () => {
    const term = new FakeStores();
    term.seededLink = { id: 'l', externalApplicationId: 'app_1', terminalState: 'withdrawn' };
    expect((await runImport('app_1', { gates: enabledGates, client: reader(appAtAi), stores: term, resolveMapping: async () => mapping() })).status).toBe('skipped');

    const other = { application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: 'stage_human' } } };
    const r2 = await runImport('app_1', { gates: enabledGates, client: reader(other), stores: new FakeStores(), resolveMapping: async () => mapping() });
    expect(r2).toEqual({ status: 'skipped', reason: 'stage_not_ai' });

    const r3 = await runImport('app_1', { gates: enabledGates, client: reader(appAtAi), stores: new FakeStores(), resolveMapping: async () => mapping({ status: 'paused' }) });
    expect(r3).toEqual({ status: 'skipped', reason: 'mapping_inactive' });
  });
});

const GOOD: StructuredResume = { name: 'A', email: 'a@x.com', phone: null, skills: [], experience_years: null, current_role: null, summary: 's' };
function ingestionPorts(over: Partial<IngestionPorts> = {}): IngestionPorts {
  const bytes = Buffer.from('%PDF-1.4 x %%EOF');
  const okFetch: ResumeFetchOutcome = { ok: true, bytes, contentType: 'application/pdf', sha256: 'a'.repeat(64), finalHost: 'h', hops: 0 };
  return {
    presignedUrl: 'https://h/r.pdf',
    policy: { allowlistEnabled: true, allowedHosts: ['h'] },
    fetch: async () => okFetch,
    scan: async () => ({ safe: true, status: 'clean' }),
    guard: () => ({ ok: true, mime: 'application/pdf' }),
    parse: async (): Promise<ParseOutput> => ({ text: 't', structured: GOOD, structurerVersion: 'p1' }),
    fallbackFromText: () => GOOD,
    onState: () => {},
    extractorVersion: 'x1',
    ...over,
  };
}

describe('runIngestionJob', () => {
  it('is disabled by the gate and no_resume when no ports', async () => {
    const stores = new FakeStores();
    expect((await runIngestionJob('link_1', { gates: disabledGates, stores, buildIngestionPorts: () => ingestionPorts(), isCancelled: async () => false })).status).toBe('disabled');
    expect((await runIngestionJob('link_1', { gates: enabledGates, stores, buildIngestionPorts: () => null, isCancelled: async () => false })).status).toBe('no_resume');
  });

  it('runs the ingestion and advances the durable state store', async () => {
    const stores = new FakeStores();
    const r = await runIngestionJob('link_1', {
      gates: enabledGates,
      stores,
      buildIngestionPorts: ({ onState }) => ingestionPorts({ onState }),
      isCancelled: async () => false,
    });
    expect(r.status).toBe('done');
    if (r.status === 'done') expect(r.outcome.state).toBe('ready');
    expect(stores.ingestionStates.map((s) => s.state)).toContain('ready');
  });
});

describe('runInviteDelivery', () => {
  const base = { existingActiveInvite: null, applicationTerminal: false, externalApplicationId: 'app_1', recruiterReissuePath: '/mc/app_1/reissue' };
  it('blocks on disabled + terminal', () => {
    expect(runInviteDelivery('email', { gates: disabledGates, ...base }).status).toBe('disabled');
    expect(runInviteDelivery('email', { gates: enabledGates, ...base, applicationTerminal: true }).status).toBe('blocked_terminal');
  });
  it('gates email until provider approved; manual is token-free reissue', () => {
    expect(runInviteDelivery('email', { gates: enabledGates, ...base })).toMatchObject({ delivery: 'blocked_provider' });
    const approved: OrchestrationGates = { enabled: true, email: { providerApproved: true, domainVerified: true } };
    expect(runInviteDelivery('email', { gates: approved, ...base })).toMatchObject({ delivery: 'sent' });
    expect(runInviteDelivery('manual', { gates: enabledGates, ...base })).toMatchObject({ delivery: 'manual_reissue' });
  });
  it('reuses an active invite instead of issuing a second', () => {
    const r = runInviteDelivery('manual', { gates: enabledGates, ...base, existingActiveInvite: { status: 'active' } });
    expect(r.status).toBe('reused');
  });
});

const scale: ScorecardScale = { min: 1, max: 4 };
function source(): ScorecardSource {
  return { overallScore: 70, recommendation: 'advance', dimensions: [{ key: 'communication', score: 8 }], summary: 'ok', provenance: { model: 'm' }, reviewPath: '/review/s' };
}
function sagaDeps(stores: FakeStores, app: Record<string, unknown>, gates = enabledGates) {
  return { gates, stores, client: reader(app), scale, applicationLinkId: 'link_1', externalApplicationId: 'app_1', aiScreeningStageId: AI };
}

describe('scorecard → stage saga', () => {
  it('enqueues an idempotent scorecard, short-circuits on duplicate marker', async () => {
    const stores = new FakeStores();
    const r = await enqueueScorecard(source(), sagaDeps(stores, appAtAi));
    expect(r.status).toBe('scorecard_enqueued');
    stores.enqueueResult = { status: 'duplicate_marker' };
    expect((await enqueueScorecard(source(), sagaDeps(stores, appAtAi))).status).toBe('scorecard_duplicate');
  });

  it('blocks a scorecard built from an unsafe source', async () => {
    const stores = new FakeStores();
    const bad = { ...source(), reviewPath: 'https://evil/x' } as ScorecardSource;
    expect((await enqueueScorecard(bad, sagaDeps(stores, appAtAi))).status).toBe('blocked_scorecard');
  });

  it('enqueues stage_move only when still at the AI stage; a human move skips it', async () => {
    const stores = new FakeStores();
    const r = await enqueueStageMove('op_score', sagaDeps(stores, appAtAi));
    expect(r.status).toBe('stage_enqueued');
    expect(stores.operations.at(-1)?.dependsOn).toBe('op_score');

    const moved = { application: { id: 'app_1', job: { id: 'job_1' }, currentInterviewStage: { id: 'stage_human' } } };
    const r2 = await enqueueStageMove('op_score', sagaDeps(new FakeStores(), moved));
    expect(r2).toEqual({ status: 'stage_skipped', reason: 'human_moved' });
  });

  it('honors the disabled gate', async () => {
    expect((await enqueueScorecard(source(), sagaDeps(new FakeStores(), appAtAi, disabledGates))).status).toBe('disabled');
    expect((await enqueueStageMove('x', sagaDeps(new FakeStores(), appAtAi, disabledGates))).status).toBe('disabled');
  });
});
