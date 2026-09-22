/**
 * Ask Hello drafting, as a JOB rather than a ten-minute HTTP call.
 *
 * WHY. Drafting runs v4-pro up to three times at 133-206s a call. As a single
 * streamed response that meant: nothing survived a refresh or a closed laptop;
 * the stream was silent for one whole model call between phases, so any proxy
 * idle timeout reaped it mid-draft; and Cancel stopped the writes while the
 * generation carried on billing. All three are consequences of tying ten
 * minutes of work to one socket.
 *
 * Here the work outlives the request. `start` writes a row and returns
 * immediately; the generation runs on, writing its phase to that row; the
 * client polls. A refresh picks the job back up, cancellation is a flag the
 * generator reads between attempts, and every HTTP call is short and ordinary.
 *
 * NOTHING DOWNSTREAM READS THE DRAFT. The operator reviews it in the form and
 * presses Save, which writes `roles` through the existing validated path. A
 * lost row costs a retry, never data — which is what makes a disposable table
 * and a best-effort background task the right shape here.
 */
import { supabase } from './supabase.js';
import {
  generateRoleDraft,
  RoleDraftError,
  ROLE_DRAFT_MAX_ATTEMPTS,
  type RoleDraftPhase,
} from './role-authoring.js';

/**
 * A `running` row whose heartbeat is older than this belongs to a process that
 * died — a redeploy mid-draft, an OOM, a machine reaped by Fly.
 *
 * Generous on purpose: one v4-pro call can legitimately take 270s with no
 * phase change, so anything tighter would declare healthy jobs dead. Two full
 * call budgets plus slack.
 */
export const ROLE_DRAFT_STALE_MS = 10 * 60 * 1000;

export type RoleDraftJobStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RoleDraftJob {
  id: string;
  job_role: string;
  status: RoleDraftJobStatus;
  phase: RoleDraftPhase | null;
  draft: unknown | null;
  attempts: number;
  repaired: string[];
  error_reason: string | null;
  error_message: string | null;
  max_attempts: number;
}

interface Row {
  id: string;
  owner_id: string;
  job_role: string;
  status: RoleDraftJobStatus;
  phase: RoleDraftPhase | null;
  draft: unknown | null;
  attempts: number;
  repaired: unknown;
  error_reason: string | null;
  error_message: string | null;
  cancelled_at: string | null;
  updated_at: string;
}

function toJob(row: Row): RoleDraftJob {
  return {
    id: row.id,
    job_role: row.job_role,
    status: row.status,
    phase: row.phase,
    draft: row.draft,
    attempts: row.attempts,
    repaired: Array.isArray(row.repaired) ? (row.repaired as string[]) : [],
    error_reason: row.error_reason,
    error_message: row.error_message,
    max_attempts: ROLE_DRAFT_MAX_ATTEMPTS,
  };
}

export interface RoleDraftRunnerDeps {
  /** Seam for tests; defaults to the real generator. */
  run?: typeof generateRoleDraft;
  /** Seam for tests, so a suite never has to wait on a real clock. */
  now?: () => number;
}

/**
 * Create the job row and start the work. Returns as soon as the row exists.
 *
 * The generation is deliberately NOT awaited: the caller is an HTTP request
 * that must answer in milliseconds. Its failures are captured into the row, so
 * nothing is lost by not awaiting it — but it must never reject, because an
 * unhandled rejection in Node 22 takes the whole process down and this API
 * also serves live-call operations.
 */
export async function startRoleDraft(
  ownerId: string,
  jobRole: string,
  deps: RoleDraftRunnerDeps = {},
): Promise<RoleDraftJob> {
  const { data, error } = await supabase
    .from('role_drafts')
    .insert({ owner_id: ownerId, job_role: jobRole, status: 'running' })
    .select()
    .single();
  if (error) throw error;

  const row = data as Row;
  // Fire and forget, with every failure funnelled into the row.
  void runDraft(row.id, jobRole, deps).catch(() => {
    /* `runDraft` already records its own failures; this guard exists only so a
       rejection can never escape into an unhandled-rejection process kill. */
  });
  return toJob(row);
}

async function runDraft(id: string, jobRole: string, deps: RoleDraftRunnerDeps): Promise<void> {
  const run = deps.run ?? generateRoleDraft;
  try {
    const { draft, attempts, repaired } = await run(jobRole, {
      onProgress: (phase) => {
        // Best-effort: a progress write that fails must not fail the draft it
        // is only describing. `updated_at` doubles as the heartbeat.
        void supabase
          .from('role_drafts')
          .update({ phase, updated_at: new Date().toISOString() })
          .eq('id', id)
          .then(undefined, () => undefined);
      },
      shouldCancel: async () => {
        const { data } = await supabase
          .from('role_drafts')
          .select('cancelled_at')
          .eq('id', id)
          .single();
        return Boolean((data as { cancelled_at: string | null } | null)?.cancelled_at);
      },
    });

    await supabase
      .from('role_drafts')
      .update({
        status: 'succeeded',
        draft,
        attempts,
        repaired,
        phase: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      // A cancelled job must not be resurrected by a result that arrived
      // afterwards.
      .eq('status', 'running');
  } catch (err) {
    const isDraftError = err instanceof RoleDraftError;
    await supabase
      .from('role_drafts')
      .update({
        status: 'failed',
        error_reason: isDraftError ? err.reason : 'provider_unavailable',
        error_message: isDraftError
          ? err.message
          : 'Hello could not be reached. Try again in a moment.',
        phase: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'running');
  }
}

/**
 * Read a job, converting a dead one into an honest failure.
 *
 * A `running` row with a stale heartbeat is a process that died. Reporting it
 * as still running would leave the operator watching a spinner for a machine
 * that no longer exists — the exact "feels stuck forever" the progress
 * reporting was added to prevent.
 */
export async function readRoleDraft(
  ownerId: string,
  id: string,
  deps: RoleDraftRunnerDeps = {},
): Promise<RoleDraftJob | null> {
  const now = deps.now ?? Date.now;
  const { data } = await supabase
    .from('role_drafts')
    .select('*')
    .eq('id', id)
    // Scoped to the owner: a draft carries a job title someone typed, and
    // there is no reason for one recruiter to read another's.
    .eq('owner_id', ownerId)
    .maybeSingle();
  if (!data) return null;

  const row = data as Row;
  if (row.status === 'running' && now() - Date.parse(row.updated_at) > ROLE_DRAFT_STALE_MS) {
    return {
      ...toJob(row),
      status: 'failed',
      error_reason: 'abandoned',
      error_message: 'Hello stopped partway through. Try again.',
    };
  }
  return toJob(row);
}

/** Ask a running job to stop. The generator reads this between attempts. */
export async function cancelRoleDraft(ownerId: string, id: string): Promise<boolean> {
  const { data } = await supabase
    .from('role_drafts')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner_id', ownerId)
    .eq('status', 'running')
    .select('id');
  return Array.isArray(data) && data.length > 0;
}
