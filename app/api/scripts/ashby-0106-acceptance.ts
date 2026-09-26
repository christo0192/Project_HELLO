import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { runReconciliation } from '../src/integrations/ashby/reconciliation.js';
import { processAshbySignal, buildSignalEnqueueSpec, importDedupKey } from '../src/integrations/ashby/signal-worker.js';
import { createCheckpointStore, createEnabledMappingLoader, createMappingResolver, createReceiptStore, createSnapshotApplicationAuthorizer, createAshbySignalQueue } from '../src/integrations/ashby/stores.js';
import type { ApplicationHistoryLister } from '../src/integrations/ashby/activation-admission.js';
import type { AshbyResult, OpaqueRecord } from '../src/integrations/ashby/types.js';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
if (!/^http:\/\/(127\.0\.0\.1|localhost)(?::\d+)?\/$/.test(url.endsWith('/') ? url : `${url}/`)) {
  throw new Error(`refusing non-loopback SUPABASE_URL: ${url}`);
}
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for the local acceptance harness');
// The runtime adapters call .rpc/.from on the bound screening_v2 client.
const db = createClient(url, key, { auth: { persistSession: false }, db: { schema: 'screening_v2' } });
// Adapter signatures use the default public generic, but this runtime client
// must target the same screening_v2 schema as production's service-role client.
const runtimeDb = db as unknown as SupabaseClient;
const actor = '00000000-0000-4000-8000-000000000106';
const prefix = 'ts0106-';
const jobs = { a: `${prefix}job-a`, b: `${prefix}job-b` };
const stages = { a: `${prefix}stage-a`, b: `${prefix}stage-b` };
const oldApps = { a: `${prefix}old-a`, b: `${prefix}old-b` };
const freshApp = `${prefix}fresh-a`;
const checkpointKey = `${prefix}application.list`;

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function one<T>(p: any, label: string): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(`${label}: ${error.message}`);
  assert(data !== null, `${label}: empty response`);
  return data;
}
const stageRow = (applicationId: string, jobId: string, stageId: string) => ({
  id: applicationId, job: { id: jobId }, currentInterviewStage: { id: stageId },
});
const histories: Record<string, OpaqueRecord[]> = {};
const provider = {
  async applicationList<T = OpaqueRecord[]>(params?: { syncToken?: string }): Promise<AshbyResult<T>> {
    const rows = params?.syncToken ? [] : [
      stageRow(oldApps.a, jobs.a, stages.a), stageRow(oldApps.b, jobs.b, stages.b),
    ];
    return { results: rows as T, moreDataAvailable: false, moreDataAvailablePresent: true, syncToken: 'ts0106-token' };
  },
  async applicationInfo<T = OpaqueRecord>(applicationId: string): Promise<AshbyResult<T>> {
    return { results: (applicationId === freshApp ? stageRow(freshApp, jobs.a, stages.a) : stageRow(applicationId, jobs.a, stages.a)) as T, moreDataAvailable: false, moreDataAvailablePresent: true };
  },
  async applicationListHistory<T = OpaqueRecord[]>(params: { applicationId: string }): Promise<AshbyResult<T>> {
    return { results: (histories[params.applicationId] ?? []) as T, moreDataAvailable: false, moreDataAvailablePresent: true };
  },
};
const history: ApplicationHistoryLister = provider;

async function count(table: string, column: string, value: string): Promise<number> {
  const { count: n, error } = await db.schema('screening_v2').from(table).select('*', { count: 'exact', head: true }).eq(column, value);
  if (error) throw new Error(`count ${table}: ${error.message}`);
  return n ?? 0;
}

let mappingIds: string[] = [];
let snapshotRun: string | null = null;
try {
  const role = await one<{ id: string }>(db.schema('screening_v2').from('roles').select('id').limit(1).single(), 'seed role');
  for (const k of ['a', 'b'] as const) {
    const created = await one(db.schema('screening_v2').rpc('upsert_ashby_job_mapping', {
      p_mapping_id: null, p_external_job_id: jobs[k], p_role_id: role.id,
      p_ai_screening_stage_id: stages[k], p_ta_screening_stage_id: `${prefix}ta-${k}`,
      p_feedback_form_id: null, p_interview_id: null, p_attribution_user_id: null,
      p_owner_id: actor, p_delivery_mode: 'manual', p_invite_ttl_hours: 24,
      p_status: 'paused', p_label: null, p_actor_id: actor,
    }), `create mapping ${k}`) as { id?: string; status?: string };
    assert(created.status === 'ok' && created.id, `mapping ${k} was not created`);
    mappingIds.push(created.id);
    histories[oldApps[k]] = [{ stageId: stages[k], enteredStageAt: '2020-01-01T00:00:00.000Z', leftStageAt: null }];
  }
  for (const id of mappingIds) {
    const enabled = await one(db.schema('screening_v2').rpc('set_ashby_mapping_status', {
      p_mapping_id: id, p_status: 'enabled', p_reason: 'ts0106 acceptance', p_actor_id: actor,
    }), 'enable mapping') as { status?: string; activation_epoch?: number };
    assert(enabled.status === 'ok' && enabled.activation_epoch === 1, 'actual enable did not stamp generation 1');
  }

  const receipts = createReceiptStore(runtimeDb);
  const checkpoints = createCheckpointStore(runtimeDb);
  const mappings = createEnabledMappingLoader(runtimeDb);
  const full = await runReconciliation({ client: provider, history, checkpoints, receipts, mappings, checkpointKey, owner: `${prefix}reconcile`, caps: { maxPages: 2, maxItems: 10 } });
  assert(full.mode === 'full' && full.observed === 2 && full.admitted === 0 && full.skipped.preActivation === 2 && full.recovered === 0 && full.enqueued === 0, `old full proof mismatch: ${JSON.stringify(full)}`);
  const incremental = await runReconciliation({ client: provider, history, checkpoints, receipts, mappings, checkpointKey, owner: `${prefix}reconcile-2`, caps: { maxPages: 2, maxItems: 10 } });
  assert(incremental.mode === 'incremental' && incremental.admitted === 0 && incremental.enqueued === 0, `old incremental proof mismatch: ${JSON.stringify(incremental)}`);
  assert(await count('ashby_event_receipts', 'webhook_action_id', `stage:${oldApps.a}:${stages.a}`) === 0, 'old A produced a receipt');
  assert(await count('ashby_event_receipts', 'webhook_action_id', `stage:${oldApps.b}:${stages.b}`) === 0, 'old B produced a receipt');
  assert(await count('job_queue', 'dedup_key', `ashby:signal:candidateStageChange:stage:${oldApps.a}:${stages.a}`) === 0, 'old A produced queue work');
  assert(await count('job_queue', 'dedup_key', `ashby:signal:candidateStageChange:stage:${oldApps.b}:${stages.b}`) === 0, 'old B produced queue work');

  histories[freshApp] = [{ stageId: stages.a, enteredStageAt: new Date().toISOString(), leftStageAt: null }];
  const webhookId = `stage:${freshApp}:${stages.a}`;
  const signal = buildSignalEnqueueSpec({ webhookActionId: webhookId, action: 'candidateStageChange', externalApplicationId: freshApp });
  await receipts.record({ webhookActionId: webhookId, action: 'candidateStageChange', metadata: { source: 'ts0106-webhook' }, enqueue: signal });
  const queue = createAshbySignalQueue(runtimeDb);
  // Read the precise durable row by dedup key. The legacy dequeue_job RPC
  // returns SETOF as an array while PgAdapter's generic dequeue expects an
  // object; the production worker uses the separate lease-safe claim path.
  const signalJob = await one<{ id: string; payload: Record<string, unknown> }>(
    db.schema('screening_v2').from('job_queue').select('id,payload')
      .eq('dedup_key', `ashby:signal:candidateStageChange:${webhookId}`).single(),
    'durable webhook signal job');
  const imports: string[] = [];
  const result = await processAshbySignal(signalJob.payload as any, {
    client: provider, mappings: createMappingResolver(runtimeDb), receipts, enforceActivationFence: true, history,
    isSnapshotApplicationAuthorized: createSnapshotApplicationAuthorizer(runtimeDb),
    onImportEligible: async ({ applicationId, jobId, stageId }) => {
      imports.push(applicationId);
      await queue.enqueue('ashby.import', { provider: 'ashby', externalApplicationId: applicationId, jobId, stageId }, { dedupKey: importDedupKey(applicationId), maxAttempts: 5 });
    },
  });
  assert(result.decision === 'import_eligible' && imports.length === 1, `fresh signal was not admitted: ${JSON.stringify(result)}`);
  await queue.complete(signalJob as never);
  assert(await count('job_queue', 'dedup_key', `ashby:import:${freshApp}`) === 1, 'fresh signal did not create import queue work');

  const mapA = await one<{ id: string; config_version: number; activation_epoch: number }>(db.schema('screening_v2').from('ashby_job_mappings').select('id,config_version,activation_epoch').eq('id', mappingIds[0]).single(), 'mapping A snapshot facts');
  const preview = await one(db.schema('screening_v2').rpc('create_ashby_snapshot_preview', {
    p_mapping_id: mapA.id, p_external_job_id: jobs.a, p_stage_id: stages.a, p_config_version: mapA.config_version,
    p_activation_epoch: mapA.activation_epoch, p_actor_id: actor,
    p_snapshot: [{ applicationId: `${prefix}explicit-a`, jobId: jobs.a, stageId: stages.a }], p_expected_count: 1,
    p_expires_at: new Date(Date.now() + 60_000).toISOString(),
  }), 'snapshot preview') as { status?: string; run_id?: string };
  assert(preview.status === 'ok' && preview.run_id, 'snapshot preview failed'); snapshotRun = preview.run_id;
  const confirmed = await one(db.schema('screening_v2').rpc('confirm_ashby_snapshot_import', { p_run_id: snapshotRun, p_mapping_id: mapA.id, p_expected_count: 1, p_actor_id: actor }), 'snapshot confirm') as { status?: string; queued_count?: number };
  assert(confirmed.status === 'ok' && confirmed.queued_count === 1, 'snapshot confirm failed');
  assert(await count('job_queue', 'dedup_key', `ashby:signal:candidateStageChange:stage:${prefix}explicit-a:${stages.a}`) === 1, 'explicit A was not queued');
  assert(await count('job_queue', 'dedup_key', `ashby:signal:candidateStageChange:stage:${prefix}explicit-a:${stages.b}`) === 0, 'explicit A queued B');

  for (const id of mappingIds) await one(db.schema('screening_v2').rpc('set_ashby_mapping_status', { p_mapping_id: id, p_status: 'paused', p_reason: 'ts0106 pause', p_actor_id: actor }), 'pause mapping');
  for (const id of mappingIds) await one(db.schema('screening_v2').rpc('set_ashby_mapping_status', { p_mapping_id: id, p_status: 'enabled', p_reason: 'ts0106 re-enable', p_actor_id: actor }), 're-enable mapping');
  const checkpoint = await one<{ status: string; sync_token: string | null }>(
    db.schema('screening_v2').from('ashby_sync_checkpoints')
      .select('status,sync_token').eq('checkpoint_key', checkpointKey).single(), 'post-enable checkpoint');
  assert(checkpoint.status === 'idle' && checkpoint.sync_token !== null,
    're-enable unexpectedly armed full resync');
  // Explicitly force a LOCAL-ONLY sweep to prove the admission fence still
  // excludes the old stage sitters when an unrelated recovery scans them.
  await one(db.schema('screening_v2').rpc('mark_ashby_sync_full_resync', {
    p_checkpoint_key: checkpointKey, p_reason: 'ts0106-local-test',
  }), 'local acceptance forced sweep');
  const afterReenable = await runReconciliation({ client: provider, history, checkpoints, receipts, mappings, checkpointKey, owner: `${prefix}reconcile-3`, caps: { maxPages: 2, maxItems: 10 } });
  assert(afterReenable.enqueued === 0 && afterReenable.recovered === 0 && (afterReenable.skipped.preActivation ?? 0) >= 2, `pause/re-enable reopened old backlog: ${JSON.stringify(afterReenable)}`);
  console.log(JSON.stringify({ pass: true, proof: { full, incremental, freshSignal: result.decision, explicitQueued: confirmed.queued_count, afterReenable }, counts: { oldReceipts: 0, oldJobs: 0, freshImportJobs: 1 } }));
} finally {
  if (snapshotRun) await db.schema('screening_v2').from('ashby_mapping_snapshot_imports').delete().eq('id', snapshotRun);
  await db.schema('screening_v2').from('job_queue').delete().like('dedup_key', `${prefix}%`);
  await db.schema('screening_v2').from('ashby_event_receipts').delete().like('webhook_action_id', `stage:${prefix}%`);
  for (const id of mappingIds) await db.schema('screening_v2').from('ashby_job_mappings').delete().eq('id', id);
}
