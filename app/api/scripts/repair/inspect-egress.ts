/**
 * READ-ONLY operator probe: what does the provider actually say about this
 * session's authoritative recording egress?
 *
 * WHY THIS EXISTS
 *   The recording-convergence incident turned on one question — is the egress
 *   still live provider-side, did it complete, or did it abort? — and there
 *   was no tool that could answer it. Both investigations INFERRED the answer
 *   from the room's 600-second empty timeout; neither observed it. Every
 *   recovery decision (proceed to `--confirm`, or accept that the row will
 *   latch `'failed'`) depends on that observation, so it must be an
 *   observation.
 *
 *   It is also how the manifest object name is VERIFIED rather than assumed.
 *   `EgressInfo.manifestLocation` is the provider's own answer; this prints it
 *   next to the value `egressManifestObjectKey()` derives, so a drift between
 *   the two is visible before anything deletes anything.
 *
 * SAFETY CONTRACT
 *   - READ ONLY. It calls `listEgress` and reads the session row. It never
 *     calls `stopEgress`, never downloads bytes, never mints a URL, never
 *     writes to the database, and never touches storage.
 *   - The session id is a RUNTIME PARAMETER. No session id is ever committed
 *     to this file or to any fixture.
 *   - Output carries no signed URLs, tokens, credentials, candidate data, or
 *     provider error text. Object KEYS are printed because they are derived
 *     from the session id the operator already supplied and are needed to
 *     check the bucket by hand.
 *
 * USAGE
 *   cd app/api
 *   npx tsx scripts/repair/inspect-egress.ts --session-id=<uuid>
 *
 * EXIT CODES
 *   0  inspected (whatever the answer was)
 *   1  the session could not be read, or the provider could not be reached
 *   2  usage error
 */

import { EgressStatus, type EgressInfo } from 'livekit-server-sdk';
import { EgressClient } from 'livekit-server-sdk';
import { env } from '../../src/lib/env.js';
import {
  egressManifestObjectKey,
  egressObjectKey,
  probeEgressIdentity,
} from '../../src/lib/recording-egress.js';
import { supabase } from '../../src/lib/supabase.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class UsageError extends Error {}

function parseArgs(argv: string[]): { sessionId: string } {
  let sessionId: string | undefined;
  for (const arg of argv) {
    const match = /^--session-id=(.+)$/.exec(arg);
    if (match) {
      sessionId = match[1];
      continue;
    }
    if (arg.startsWith('--')) throw new UsageError(`unknown flag: ${arg.split('=')[0]}`);
  }
  if (!sessionId) throw new UsageError('--session-id=<uuid> is required (never hardcoded)');
  if (!UUID_PATTERN.test(sessionId)) throw new UsageError('--session-id must be a UUID');
  return { sessionId };
}

function report(step: string, fields: Record<string, unknown> = {}): void {
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${value === null || value === undefined ? 'null' : String(value)}`)
    .join(' ');
  console.log(`[inspect-egress] ${step}${rendered ? ` ${rendered}` : ''}`);
}

/** Human-readable enum NAME, not the wire integer. */
function egressStatusName(status: EgressStatus | undefined): string {
  if (status === undefined) return 'unknown';
  const name = EgressStatus[status];
  return typeof name === 'string' ? name : `unmapped_${String(status)}`;
}

const SESSION_COLUMNS = [
  'status',
  'ended_at',
  'recording_object_key',
  'recording_provenance',
  'recording_egress_id',
  'recording_egress_status',
  'recording_finalize_attempts',
  'recording_finalize_last_attempt_at',
  'recording_finalize_defer_reason',
  'recording_finalize_exhausted_at',
  'recording_deleted_at',
  'recording_revoked_at',
  'recording_quarantined',
].join(', ');

async function main(): Promise<number> {
  const { sessionId } = parseArgs(process.argv.slice(2));

  const { data, error } = await supabase
    .from('call_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', sessionId)
    .single();
  if (error || !data) {
    report('session_read_failed');
    return 1;
  }
  const row = data as unknown as Record<string, unknown>;

  report('session', {
    status: row.status,
    ended_at: row.ended_at,
    has_object_key: Boolean(row.recording_object_key),
    provenance: row.recording_provenance ?? null,
    egress_status: row.recording_egress_status ?? null,
    has_egress_id: Boolean(row.recording_egress_id),
  });
  report('finalize_state', {
    attempts: row.recording_finalize_attempts ?? 0,
    last_attempt_at: row.recording_finalize_last_attempt_at ?? null,
    defer_reason: row.recording_finalize_defer_reason ?? null,
    exhausted_at: row.recording_finalize_exhausted_at ?? null,
  });
  report('terminal_gates', {
    deleted: Boolean(row.recording_deleted_at),
    revoked: Boolean(row.recording_revoked_at),
    quarantined: row.recording_quarantined === true,
  });
  report('derived_keys', {
    object: egressObjectKey(sessionId),
    manifest: egressManifestObjectKey(sessionId),
  });

  const egressId = row.recording_egress_id;
  if (typeof egressId !== 'string' || egressId.length === 0) {
    report('provider_skipped', { reason: 'no_egress_id' });
    return 0;
  }

  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    report('provider_skipped', { reason: 'livekit_not_configured' });
    return 0;
  }

  let items: EgressInfo[];
  try {
    const client = new EgressClient(env.livekitUrl, env.livekitApiKey, env.livekitApiSecret);
    items = await client.listEgress({ egressId });
  } catch {
    // Sanitized: provider error text is never printed.
    report('provider_unreachable');
    return 1;
  }

  // The D-4 identity check, made OBSERVABLE. `probeEgressIdentity` is the same
  // function the finalizer uses, so what is printed here is exactly what the
  // finalizer would conclude — including "the provider ignored the egressId
  // filter and handed back somebody else's egress", which used to be
  // indistinguishable from "not terminal yet".
  const probe = probeEgressIdentity(items, egressId);
  report('provider', {
    items_returned: items.length,
    identity: probe.outcome,
  });

  const mine = items.find((item) => item.egressId === egressId);
  if (!mine) {
    report('provider_detail', { note: 'no_returned_item_matches_this_egress_id' });
    return 0;
  }

  const fileResults = Array.isArray(mine.fileResults) ? mine.fileResults : [];
  const legacyFile = mine.result?.case === 'file' ? mine.result.value : undefined;
  report('provider_detail', {
    status: egressStatusName(mine.status),
    // On a healthy COMPLETE this provider has been observed returning an EMPTY
    // `fileResults` while the deprecated `result` oneof carries the file — so
    // BOTH are reported and neither is trusted alone.
    file_results: fileResults.length,
    has_legacy_file_result: Boolean(legacyFile),
    // The AUTHORITATIVE manifest location. Compare it against `derived_keys`
    // above before anything relies on the derivation.
    manifest_location: mine.manifestLocation || null,
    file_name: fileResults[0]?.filename ?? legacyFile?.filename ?? null,
    file_size: (fileResults[0]?.size ?? legacyFile?.size ?? null)?.toString() ?? null,
    error_code: mine.errorCode || null,
  });

  if (mine.status === EgressStatus.EGRESS_COMPLETE) {
    report('verdict', { proceed: 'finalize_can_link' });
  } else if (
    mine.status === EgressStatus.EGRESS_FAILED
    || mine.status === EgressStatus.EGRESS_ABORTED
    || mine.status === EgressStatus.EGRESS_LIMIT_REACHED
  ) {
    // Terminal-but-not-complete: finalization will latch `'failed'`. That is
    // recoverable now (0038's audited reopen RPC) but it is still a decision.
    report('verdict', { proceed: 'finalize_will_latch_failed' });
  } else {
    report('verdict', { proceed: 'not_terminal_yet' });
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof UsageError) {
      console.error(`[inspect-egress] usage: ${err.message}`);
      process.exit(2);
    }
    console.error('[inspect-egress] unexpected failure');
    process.exit(1);
  });
