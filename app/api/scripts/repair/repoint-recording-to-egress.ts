/**
 * One-shot operator repair: repoint a session's authoritative recording from
 * a browser_upload object to its completed LiveKit room-composite egress.
 *
 * WHY THIS EXISTS
 *   Before the 0025 / egress-precedence fix, a browser fallback could win the
 *   race against a completing egress and permanently claim the session row.
 *   The egress bytes are intact in storage — only the pointer is wrong. This
 *   script fixes the pointer for already-affected sessions.
 *
 * SAFETY CONTRACT
 *   - The session id is a RUNTIME PARAMETER. No session id is ever committed
 *     to this file, to a migration, or to any fixture.
 *   - Dry-run by default. Mutation requires an explicit --confirm.
 *   - Fail-closed: any refusal (terminal state, no egress, egress not
 *     complete, unusable object) aborts before the RPC runs.
 *   - Idempotent: the RPC returns 'already_authoritative' on rerun, so a
 *     second invocation is a no-op that still exits 0.
 *   - Terminal immutability is honoured by the RPC itself — deleted, revoked,
 *     and quarantined rows are refused and left byte-identical.
 *   - Output carries no object keys, signed URLs, tokens, or candidate data.
 *
 * USAGE
 *   cd app/api
 *   npx tsx scripts/repair/repoint-recording-to-egress.ts --session-id=<uuid>
 *   npx tsx scripts/repair/repoint-recording-to-egress.ts --session-id=<uuid> --confirm
 *
 * EXIT CODES
 *   0  repointed, already authoritative, or dry-run completed
 *   1  refused (precondition failed) or the repoint did not converge
 *   2  usage error
 */

import { createDbAuditSink } from '../../src/lib/audit.js';
import { env } from '../../src/lib/env.js';
import {
  egressObjectKey,
  finalizeAuthoritativeRecording,
} from '../../src/lib/recording-egress.js';
import { supabase } from '../../src/lib/supabase.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface Args {
  sessionId: string;
  confirm: boolean;
}

function parseArgs(argv: string[]): Args {
  let sessionId: string | undefined;
  let confirm = false;

  for (const arg of argv) {
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    const match = /^--session-id=(.+)$/.exec(arg);
    if (match) {
      sessionId = match[1];
      continue;
    }
    if (arg.startsWith('--')) {
      throw new UsageError(`unknown flag: ${arg.split('=')[0]}`);
    }
  }

  if (!sessionId) {
    throw new UsageError('--session-id=<uuid> is required (never hardcoded)');
  }
  if (!UUID_PATTERN.test(sessionId)) {
    throw new UsageError('--session-id must be a UUID');
  }
  return { sessionId, confirm };
}

class UsageError extends Error {}

/** Structured, PII-free progress line. */
function report(step: string, fields: Record<string, unknown> = {}): void {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${value === null ? 'null' : String(value)}`)
    .join(' ');
  console.log(`[repoint] ${step}${rendered ? ` ${rendered}` : ''}`);
}

interface SessionRow {
  status: string | null;
  recording_object_key: string | null;
  recording_provenance: string | null;
  recording_superseded_object_key: string | null;
  recording_egress_id: string | null;
  recording_egress_status: string | null;
  recording_deleted_at: string | null;
  recording_revoked_at: string | null;
  recording_quarantined: boolean | null;
}

const SESSION_COLUMNS =
  'status, recording_object_key, recording_provenance, recording_superseded_object_key, '
  + 'recording_egress_id, recording_egress_status, recording_deleted_at, '
  + 'recording_revoked_at, recording_quarantined';

async function readSession(sessionId: string): Promise<SessionRow> {
  const { data, error } = await supabase
    .from('call_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', sessionId)
    .single();
  if (error || !data) throw new Error('session not found');
  return data as unknown as SessionRow;
}

async function main(): Promise<number> {
  const { sessionId, confirm } = parseArgs(process.argv.slice(2));

  const before = await readSession(sessionId);
  report('preflight', {
    status: before.status,
    provenance: before.recording_provenance,
    egress_status: before.recording_egress_status,
    has_key: before.recording_object_key !== null,
  });

  // ── Fail-closed preconditions ──────────────────────────────────────
  // These mirror the RPC's own guards. Checking them here means the
  // operator gets a precise refusal instead of an opaque status code, and
  // no provider call is made for a session that can never be repointed.
  if (
    before.recording_deleted_at !== null
    || before.recording_revoked_at !== null
    || before.recording_quarantined === true
  ) {
    report('refused', { reason: 'terminal_state' });
    return 1;
  }
  if (!before.recording_egress_id) {
    report('refused', { reason: 'no_egress' });
    return 1;
  }
  if (before.recording_provenance === 'livekit_egress') {
    report('noop', { reason: 'already_authoritative' });
    return 0;
  }

  if (!confirm) {
    report('dry_run', { would_repoint: true, rerun_with: '--confirm' });
    return 0;
  }

  // finalizeAuthoritativeRecording is the same code path production uses:
  // stop the egress if still running, wait for a terminal state, require
  // EGRESS_COMPLETE, download and hash the object with size bounds, then
  // call the service-role-only finalize_authoritative_recording RPC.
  const status = await finalizeAuthoritativeRecording(sessionId);
  report('finalize', { status });

  if (status !== 'ready') {
    // 'fallback_required' ⇒ the egress terminally failed or produced an
    // unusable object; 'pending' ⇒ not terminal yet, or storage could not
    // serve the object. Neither is repairable by rewriting the pointer.
    report('refused', { reason: `finalize_${status}` });
    return 1;
  }

  const after = await readSession(sessionId);
  const expectedKey = egressObjectKey(sessionId);
  const converged =
    after.recording_provenance === 'livekit_egress'
    && after.recording_object_key === expectedKey
    && after.recording_egress_status === 'complete';

  report('verify', {
    provenance: after.recording_provenance,
    points_at_egress: after.recording_object_key === expectedKey,
    egress_status: after.recording_egress_status,
    superseded_tracked: after.recording_superseded_object_key !== null,
    // Terminal protections must still read exactly as they did before.
    deleted: after.recording_deleted_at !== null,
    revoked: after.recording_revoked_at !== null,
    quarantined: after.recording_quarantined === true,
  });

  if (!converged) {
    report('refused', { reason: 'did_not_converge' });
    return 1;
  }

  // I‑5: append-only evidence. The DB-side 'repointed' integrity event is
  // written by the RPC; this is the operator-facing audit half, recorded
  // under the system actor (userId null ⇒ actor_type 'system').
  await createDbAuditSink(supabase as any)({
    event: 'admin.session_override',
    correlationId: null,
    userId: null,
    userRole: null,
    method: 'CLI',
    path: '/repair/repoint-recording-to-egress',
    statusCode: 200,
    timestamp: new Date().toISOString(),
    metadata: {
      session_id: sessionId,
      recovery_kind: 'recording_egress_repoint',
      prior_provenance: before.recording_provenance,
      new_provenance: 'livekit_egress',
      superseded_tracked: after.recording_superseded_object_key !== null,
    },
  });

  report('done', { repointed: true, bucket_configured: Boolean(env.recordingsBucket) });
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(`[repoint] usage: ${error.message}`);
      process.exit(2);
    }
    // Never echo provider payloads — they may carry URLs or credentials.
    console.error('[repoint] failed: unrecoverable error during repair');
    process.exit(1);
  });
