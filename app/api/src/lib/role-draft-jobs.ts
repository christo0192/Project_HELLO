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
import { DEEPSEEK_TIMEOUT_CEILING_MS } from './env.js';
import { createLogger } from './logger.js';
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
 * DERIVED, AND THE DERIVATION WAS WRONG BEFORE. The earlier value was ten
 * minutes, justified as "two full call budgets plus slack". It was one.
 * `runDeepseekJSON` retries the provider ITSELF when a response will not parse
 * as JSON, and no phase is reported between those two calls — so the longest
 * legitimate gap between heartbeats is `2 x timeoutMs`, not one budget.
 *
 * At the env ceiling (`DEEPSEEK_TIMEOUT_MS` is validated to at most 300000)
 * that gap is 600000 — exactly the old constant. Any overhead at all pushed a
 * HEALTHY job past it, and the client was told "Hello stopped partway
 * through" about a draft that was still running, still billing, and would
 * shortly succeed into a row nobody was reading any more.
 *
 * So: two full calls at the ceiling, plus two minutes. It is a bound on a
 * dead process, and being late to declare one costs a spinner; being early
 * costs a paid ten-minute draft.
 */
/**
 * The longest a single provider call can take, which is the CEILING
 * `DEEPSEEK_TIMEOUT_MS` is validated against in `env.ts` — not a number
 * chosen here.
 *
 * `ROLE_DRAFT_STALE_MS` is derived from it, and the derivation is only sound
 * while the two agree: raising the env ceiling alone would let a healthy
 * worker exceed the stale window and be reaped mid-draft. That single edit
 * kept 110 tests green, so the link is asserted rather than described.
 */
export const ROLE_DRAFT_MAX_CALL_MS = DEEPSEEK_TIMEOUT_CEILING_MS;
export const ROLE_DRAFT_STALE_MS = 2 * ROLE_DRAFT_MAX_CALL_MS + 120_000;

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
  /** When the job began. The client's elapsed counter reads this on resume. */
  created_at: string | null;
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
  created_at?: string;
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
    created_at: row.created_at ?? null,
  };
}

const draftLogger = createLogger('role-draft');

/**
 * NEITHER OF THESE LOGS THE DRAFT ID OR THE ERROR TEXT, deliberately.
 *
 * `AllowedMeta` in `logger.ts` is a closed, PII-conscious key set, and the
 * right response to it is to fit the vocabulary rather than widen it for a
 * convenience feature. `error_category` says which write was lost and
 * `error_type` carries the POSTGRES ERROR CODE; neither can carry a job title
 * someone typed or a provider message that quotes one back.
 *
 * THE CODE, not `err.name`. postgrest-js does not construct an `Error` on
 * this path — `processResponse` assigns the parsed JSON body straight to
 * `error` — so `err instanceof Error ? err.name : typeof err` evaluated to the
 * literal string "object" for every database failure this module can have.
 * The logs named which write was lost and never why. `23502`, `23505`,
 * `42501` and `PGRST204` are each a different problem with a different fix,
 * they are what the rest of this file already branches on, and they carry
 * nothing sensitive.
 */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  // A CLIENT-SIDE NETWORK FAILURE HAS NO CODE, deliberately: postgrest-js
  // sets `code: ''` for fetch failures, DNS errors, aborts and
  // headers-overflow, with a comment saying it does not populate code or hint
  // for them. That is the class a ten-minute job most needs named — a pooler
  // reset mid-draft is the likeliest way a heartbeat goes missing — so it is
  // called what it is rather than folded into "unknown".
  if (code === '') return 'network';
  if (err instanceof Error) return err.name;
  return 'unknown';
}

/**
 * A dropped heartbeat is not cosmetic: `readRoleDraft` reads its absence as a
 * dead worker, so losing these quietly turns a healthy ten-minute draft into
 * "Hello stopped partway through". Logged rather than thrown, because failing
 * a draft over a failed DESCRIPTION of it would be the worse trade.
 */
function onHeartbeatFailure(_id: string, err: unknown): void {
  draftLogger.warn('db_error', {
    error_category: 'role_draft_heartbeat_write',
    error_type: errorCode(err),
  });
}

/**
 * The terminal write carries the result of up to six provider calls. If it is
 * lost the row stays `running`, goes stale, and is reported as `abandoned` —
 * so this line is the only place that loss is visible at all.
 */
function onTerminalWriteFailure(_id: string, status: string, err: unknown): void {
  draftLogger.error('db_error', {
    error_category: `role_draft_terminal_write_${status}`,
    error_type: errorCode(err),
  });
}

export interface RoleDraftRunnerDeps {
  /** Seam for tests; defaults to the real generator. */
  run?: typeof generateRoleDraft;
  /** Seam for tests, so a suite never has to wait on a real clock. */
  now?: () => number;
}

/**
 * The caller's LIVE job, if they have one.
 *
 * This is what makes "a refresh picks the job back up" true rather than a
 * comment. The browser holds the job id in component state and nothing else,
 * so a reload, a navigation, or switching to another role in the list loses
 * the only handle to a job that keeps running and keeps billing. Asking the
 * server what it already has is the recovery: the row is the durable copy,
 * which is the entire reason this stopped being a streamed response.
 *
 * A STALE row is not returned. It belongs to a dead worker, and handing it
 * back would resume polling something that will never report again — and, far
 * worse for `startRoleDraft` below, would refuse to start a new draft forever.
 *
 * `uq_role_drafts_owner_running` does NOT share that view — to the index a
 * stale row is simply `running` — so `startRoleDraft` reads through this
 * filter with `readRunningRow` when the index disagrees, and expires the row.
 * Without that, this function's own promise is broken by the constraint that
 * was added to back it up.
 */
export async function readActiveRoleDraft(
  ownerId: string,
  deps: RoleDraftRunnerDeps = {},
): Promise<RoleDraftJob | null> {
  const now = deps.now ?? Date.now;
  const { data, error } = await supabase
    .from('role_drafts')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('status', 'running')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : null) as Row | undefined;
  if (!row) return null;
  if (now() - Date.parse(row.updated_at) > ROLE_DRAFT_STALE_MS) return null;
  return toJob(row);
}

/**
 * Raised when a live job exists for a DIFFERENT job role.
 *
 * Not an error the operator caused, and not one to paper over: substituting
 * the other role's job — which is what returning it would do — put a Sales
 * Advisor JD and six Sales Advisor questions into a form headed "Data
 * Engineer". The route answers 409 and names the role actually running.
 */
export class RoleDraftBusyError extends Error {
  constructor(readonly liveJobRole: string) {
    super(`A draft for "${liveJobRole}" is already running.`);
    this.name = 'RoleDraftBusyError';
  }
}

/**
 * The owner's `running` row EXACTLY AS THE DATABASE SEES IT — stale included.
 *
 * `readActiveRoleDraft` hides stale rows because a caller should not be told
 * to keep watching a dead worker. `uq_role_drafts_owner_running` does not
 * share that opinion: to the index a stale row is simply `running`, and it
 * blocks the next insert.
 *
 * That disagreement is a LOCKOUT, and it is the one the staleness filter was
 * written to prevent. A deploy mid-draft leaves the row `running` with a
 * frozen heartbeat; the operator is told the draft was abandoned and to try
 * again; the read says nothing is live, the insert hits 23505, and the retry
 * read says nothing is live again. Every press, forever, with only manual SQL
 * as the way out. So the 23505 path reads through the filter, not around it.
 */
async function readRunningRow(ownerId: string): Promise<Row | null> {
  const { data, error } = await supabase
    .from('role_drafts')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('status', 'running')
    .order('updated_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (Array.isArray(data) ? (data[0] as Row) : null) ?? null;
}

/**
 * Move a dead worker's row out of `running` so the next draft can start.
 *
 * The verdict `readRoleDraft` already reports at read time, finally written
 * down. Fenced on `status = 'running'` and on the heartbeat, so a worker that
 * wakes up between the read and this write cannot have its live job killed.
 */
async function expireStaleRoleDraft(ownerId: string, staleBefore: string): Promise<void> {
  const { error } = await supabase
    .from('role_drafts')
    .update({
      status: 'failed',
      error_reason: 'abandoned',
      error_message: 'Hello stopped partway through. Try again.',
      phase: null,
      updated_at: new Date().toISOString(),
    })
    .eq('owner_id', ownerId)
    .eq('status', 'running')
    .lt('updated_at', staleBefore);
  // THE ONE WRITE WHOSE FAILURE REINSTATES THE LOCKOUT, and it was the only
  // write in this module with no failure logger. If it is a no-op — a pooler
  // reset, a permission denied — the retry insert hits 23505 again and the
  // operator gets "Internal server error" on every press, with nothing
  // anywhere naming the expiry as the cause. That is the diagnosis-by-SQL
  // situation this function exists to end.
  if (error) {
    draftLogger.error('db_error', {
      error_category: 'role_draft_expire_stale',
      error_type: errorCode(error),
    });
  }
}

/**
 * Create the job row and start the work. Returns as soon as the row exists.
 *
 * ONE LIVE JOB PER OWNER. Each start detaches up to six v4-pro calls into the
 * process that also serves live-call operations, and nothing else bounds how
 * often the button can be pressed — the UI's guard is per-component, so two
 * tabs, or a script holding a valid interviewer token, could start hundreds a
 * minute. `uq_role_drafts_owner_running` (0101) is what enforces it; a
 * SELECT-then-INSERT cannot, because a concurrent request sees the same empty
 * result.
 *
 * IT BOUNDS ROWS, NOT GENERATIONS, and the difference is worth stating.
 * `cancelRoleDraft` frees the slot the instant it writes `status='cancelled'`,
 * but `shouldCancel` is only read BETWEEN attempts — so the 240-300s call
 * already in flight runs to completion and keeps billing. Start, cancel,
 * start, cancel is therefore a way to hold several generations open at once,
 * bounded only by the per-user rate limit. An idempotency window on start
 * would close it; the constraint alone does not, and this comment used to
 * claim otherwise.
 *
 * A live job for the SAME role is RETURNED — the caller asked to be drafting
 * and they now are, which is exactly what a second tab should see. A live job
 * for a DIFFERENT role raises `RoleDraftBusyError`, because silently handing
 * back the other role's draft is how a Sales Advisor script ended up in a form
 * headed "Data Engineer".
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
  // ONE LIVE JOB, AND IT MUST BE FOR THIS JOB ROLE.
  //
  // Returning any live job regardless of what it was drafting put someone
  // else's subject into this form: start "Sales Advisor", close the tab, open
  // the form again, type "Data Engineer", press Ask Hello — and eight minutes
  // later a Sales Advisor JD, skills and six Sales Advisor questions land in a
  // form whose Job role says Data Engineer. On a fresh form there is nothing
  // to overwrite, so the confirm never fires and only an info notice mentions
  // it. A live job for a DIFFERENT role is left alone to finish; this one
  // starts its own.
  const now = deps.now ?? Date.now;
  const live = await readActiveRoleDraft(ownerId, deps);
  if (live) {
    if (live.job_role.trim() === jobRole.trim()) return live;
    throw new RoleDraftBusyError(live.job_role);
  }

  const insert = async () =>
    supabase
      .from('role_drafts')
      .insert({ owner_id: ownerId, job_role: jobRole, status: 'running' })
      .select()
      .single();

  let { data, error } = await insert();
  if (error && (error as { code?: string }).code === '23505') {
    // THE INDEX SAW SOMETHING THE READ DID NOT. Exactly two things can put a
    // `running` row here after `readActiveRoleDraft` said there was none:
    //
    //   a CONCURRENT start that won by microseconds — the right answer is the
    //   job that now exists, which is what arriving second should look like;
    //
    //   a STALE row, which the read filters out and the index does not. That
    //   is the lockout case. The row is expired — writing down the verdict
    //   `readRoleDraft` already reports — and the insert is retried ONCE.
    // THREE things can put a `running` row here, not two: a concurrent start
    // that won; a stale row the read filters and the index does not; and
    // nothing at all, when the blocking row settled between the failed insert
    // and this read. The third used to fall through to a 500 carrying the raw
    // unique violation at the one moment a retry would have worked.
    const row = await readRunningRow(ownerId);
    if (row && now() - Date.parse(row.updated_at) <= ROLE_DRAFT_STALE_MS) {
      if (row.job_role.trim() === jobRole.trim()) return toJob(row);
      throw new RoleDraftBusyError(row.job_role);
    }
    // NO ROW AT ALL is the third case, and it used to fall through to a 500.
    // The conflicting job settled between the insert and this read — two tabs
    // press Ask Hello, the first wins, and its draft fails on a provider 502
    // before the second tab's read lands. Retrying is simply correct: the
    // constraint that refused is no longer being violated.
    if (row) {
      await expireStaleRoleDraft(ownerId, new Date(now() - ROLE_DRAFT_STALE_MS).toISOString());
    }
    ({ data, error } = await insert());
    // A SECOND 23505 IS A CONFLICT, NOT A CRASH. Losing the race twice —
    // another start landing between the expiry and this retry — used to
    // `throw error` with the raw postgrest body, which is not an `Error`, so
    // `finalErrorHandler` logged `error_category: 'UnknownError'` and answered
    // 500 "internal server error". The operator was owed either the live job
    // or a 409 naming it, and `23505` — the one code that says which condition
    // occurred — was discarded one layer above the `errorCode()` helper this
    // module added to stop exactly that.
    if (error && (error as { code?: string }).code === '23505') {
      // STALENESS APPLIES HERE TOO. `readRunningRow` is deliberately
      // unfiltered — it is what the expiry path uses to see the row the index
      // can see — so returning it directly would hand back a DEAD worker's
      // job as though it were live, or refuse the operator in the name of a
      // job nobody is running. `expireStaleRoleDraft` logs and swallows its
      // failures, so that is a reachable state, not a hypothetical one.
      const winner = await readRunningRow(ownerId);
      const live = winner && now() - Date.parse(winner.updated_at) <= ROLE_DRAFT_STALE_MS;
      if (winner && live) {
        if (winner.job_role.trim() === jobRole.trim()) return toJob(winner);
        throw new RoleDraftBusyError(winner.job_role);
      }
      // NO LIVE WINNER. Losing the race twice while nothing is actually
      // holding the slot means the expiry write is failing — the row is there
      // and stale, or gone entirely, and either way a third insert is not
      // obviously going to fare better than the second.
      //
      // An earlier comment here claimed "a second 23505 with no readable
      // winner still means someone else holds the slot". It does not: the
      // read one line above returned nothing. What is true is that this
      // request cannot be served and the operator should be told to try
      // again rather than shown an Internal Server Error, which is what the
      // raw postgrest body produced. The log line is the part that says
      // which of the two it was.
      draftLogger.warn('db_error', {
        error_category: 'role_draft_start_conflict',
        error_type: errorCode(error),
      });
      throw new RoleDraftBusyError(winner?.job_role ?? jobRole);
    }
  }
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
        // Best-effort for the DRAFT, load-bearing for the READER: this write
        // is also the heartbeat, and a job whose heartbeat stops is reported
        // as `abandoned`. Losing these silently turns a healthy ten-minute
        // draft into "Hello stopped partway through".
        //
        // FENCED on `status = 'running'` because two PostgREST requests have
        // no ordering guarantee: without it, a late `checking` write can land
        // after the terminal write and leave a settled row advertising a
        // phase it is no longer in.
        void supabase
          .from('role_drafts')
          .update({ phase, updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('status', 'running')
          .then(
            ({ error }) => {
              if (error) onHeartbeatFailure(id, error);
            },
            (err) => onHeartbeatFailure(id, err),
          );
      },
      shouldCancel: async () => {
        // A FAILED READ ANSWERS "NOT CANCELLED", and that is the only safe
        // answer — but the explicit check below changes NOTHING, and an
        // earlier version of this comment claimed otherwise.
        //
        // `.single()` returns `{ data: null, error }` on failure, so
        // `Boolean(null?.cancelled_at)` was already false; deleting the line
        // is a no-op, which a review proved by deleting it. It is kept because
        // it states the decision rather than leaving it to an optional-chain
        // coincidence, and it would still hold if supabase-js ever returned
        // stale data alongside an error.
        //
        // The decision itself: an unknown cannot be treated as "cancelled"
        // without killing healthy jobs on a pooler blip. The generator asks
        // again before every attempt, so one bad read costs at most one
        // attempt of delay, not the operator's decision.
        const { data, error } = await supabase
          .from('role_drafts')
          .select('cancelled_at')
          .eq('id', id)
          .single();
        if (error) return false;
        return Boolean((data as { cancelled_at: string | null } | null)?.cancelled_at);
      },
    });

    // The result of up to six provider calls and ten minutes of waiting. If
    // this write is dropped the row stays `running` with a frozen heartbeat,
    // and the operator is eventually told the draft was abandoned — about
    // work that succeeded and is now unrecoverable. Worth knowing about.
    const { data: written, error: writeError } = await supabase
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
      .eq('status', 'running')
      // SELECTED so zero rows is observable. The fence used to mean exactly
      // one thing — the operator cancelled — and `expireStaleRoleDraft` gave
      // it a second: a live job whose heartbeat writes were dropped can be
      // expired by a concurrent start, and then ten minutes of paid output
      // lands on a row that no longer matches. PostgREST reports that as
      // success, so without this the loss is entirely silent.
      .select('id');
    if (writeError) onTerminalWriteFailure(id, 'succeeded', writeError);
    else if (Array.isArray(written) && written.length === 0) {
      // ZERO ROWS HAS TWO CAUSES, and only one is a problem.
      //
      // The operator cancelled while the last attempt was finishing — normal,
      // and discarding the result is the correct response to it. Or the row
      // was expired out from under a live worker whose heartbeats were being
      // dropped, in which case ten minutes of paid output has just been thrown
      // away and nobody would otherwise know. Reading the row is the only way
      // to tell, and this path is rare enough to afford it.
      const { data: row, error: readError } = await supabase
        .from('role_drafts')
        .select('status')
        .eq('id', id)
        .maybeSingle();
      const status = (row as { status?: string } | null)?.status;
      if (readError) {
        // The read itself failed, so we cannot tell a cancel from a discard.
        // Reporting `row_missing` here named a cause that CANNOT occur —
        // nothing in this codebase deletes `role_drafts` rows — while hiding
        // the failure that did.
        draftLogger.warn('db_error', {
          error_category: 'role_draft_result_discarded',
          error_type: 'read_failed',
        });
      } else if (status !== 'cancelled') {
        draftLogger.warn('db_error', {
          error_category: 'role_draft_result_discarded',
          error_type: status ?? 'row_missing',
        });
      }
    }
  } catch (err) {
    const isDraftError = err instanceof RoleDraftError;
    const { error: writeError } = await supabase
      .from('role_drafts')
      .update({
        status: 'failed',
        error_reason: isDraftError ? err.reason : 'provider_unavailable',
        error_message: isDraftError
          ? err.message
          : 'Hello could not be reached. Try again in a moment.',
        // WRITTEN HERE TOO, and the KEY IS OMITTED when there is no number.
        //
        // Without it every failed job reported `attempts: 0`, so a job that
        // burned the whole budget was indistinguishable from one that never
        // got a call away. But `attempts` is `integer not null default 0`
        // (0101), so writing an explicit null defeated the repair on exactly
        // the branch it was written for: every non-`RoleDraftError` throw —
        // the provider outages — produced a 23502 not_null_violation, the
        // whole terminal write was rejected, the row stayed `running` with a
        // frozen heartbeat, and the operator was eventually told the draft was
        // ABANDONED rather than that the provider could not be reached.
        ...(isDraftError && typeof err.attempts === 'number'
          ? { attempts: err.attempts }
          : {}),
        phase: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('status', 'running');
    if (writeError) onTerminalWriteFailure(id, 'failed', writeError);
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
  const { data, error } = await supabase
    .from('role_drafts')
    .select('*')
    .eq('id', id)
    // Scoped to the owner: a draft carries a job title someone typed, and
    // there is no reason for one recruiter to read another's.
    .eq('owner_id', ownerId)
    .maybeSingle();
  // A DATABASE FAILURE IS NOT A MISSING DRAFT. Swallowing it here made the
  // route answer 404 — documented as "no such draft for this caller" — for a
  // pooler reset, which is a different thing and deserves a different answer.
  if (error) throw error;
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

/**
 * Ask a running job to stop. The generator reads this between attempts.
 *
 * THROWS on a database failure rather than returning false. `false` means
 * "there was no running job to cancel" — a race the operator cannot be blamed
 * for and nothing to report. A pooler reset means the opposite: the job IS
 * running, `cancelled_at` was never written, and v4-pro will keep spending.
 * Collapsing the two left the client silently claiming it had stopped
 * something it had not, which is the one thing this function exists to do.
 */
export async function cancelRoleDraft(ownerId: string, id: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('role_drafts')
    .update({ status: 'cancelled', cancelled_at: new Date().toISOString() })
    .eq('id', id)
    .eq('owner_id', ownerId)
    .eq('status', 'running')
    .select('id');
  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}
