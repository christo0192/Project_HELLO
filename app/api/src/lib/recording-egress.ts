import { createHash } from 'node:crypto';
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  S3Upload,
  type EgressInfo,
} from 'livekit-server-sdk';
import { env } from './env.js';
import { supabase } from './supabase.js';

export type RecordingFinalizeStatus = 'ready' | 'fallback_required' | 'pending';

interface EgressClientLike {
  startRoomCompositeEgress: EgressClient['startRoomCompositeEgress'];
  stopEgress: EgressClient['stopEgress'];
  listEgress: EgressClient['listEgress'];
}

interface RecordingEgressDeps {
  client?: EgressClientLike;
  db?: typeof supabase;
  sleep?: (ms: number) => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function egressClient(): EgressClient {
  return new EgressClient(env.livekitUrl, env.livekitApiKey, env.livekitApiSecret);
}

function requireEgressConfig(): void {
  if (!env.recordingEgressEnabled) {
    if (env.recordingEgressRequired) {
      throw new Error('authoritative recording is required but egress is disabled');
    }
    return;
  }
  if (
    !env.recordingEgressS3Endpoint
    || !env.recordingEgressS3AccessKeyId
    || !env.recordingEgressS3SecretAccessKey
  ) {
    throw new Error('authoritative recording storage is not configured');
  }
}

export function authoritativeRecordingEnabled(): boolean {
  requireEgressConfig();
  return env.recordingEgressEnabled;
}

export function egressObjectKey(sessionId: string): string {
  return `${sessionId}-egress.ogg`;
}

export async function startAuthoritativeRecording(
  roomName: string,
  sessionId: string,
  deps: RecordingEgressDeps = {},
): Promise<{ status: 'disabled' | 'started'; egressId?: string }> {
  if (!authoritativeRecordingEnabled()) return { status: 'disabled' };

  const client = deps.client ?? egressClient();
  const db = deps.db ?? supabase;
  const { data: existing, error: existingError } = await db
    .from('call_sessions')
    .select('recording_egress_id')
    .eq('id', sessionId)
    .single();
  if (existingError || !existing) throw new Error('recording session not found');
  if (existing.recording_egress_id) {
    return { status: 'started', egressId: String(existing.recording_egress_id) };
  }

  const objectKey = egressObjectKey(sessionId);
  const output = new EncodedFileOutput({
    fileType: EncodedFileType.OGG,
    filepath: objectKey,
    disableManifest: false,
    output: {
      case: 's3',
      value: new S3Upload({
        accessKey: env.recordingEgressS3AccessKeyId,
        secret: env.recordingEgressS3SecretAccessKey,
        region: env.recordingEgressS3Region,
        endpoint: env.recordingEgressS3Endpoint,
        bucket: env.recordingsBucket,
        forcePathStyle: true,
      }),
    },
  });

  const info = await client.startRoomCompositeEgress(
    roomName,
    output,
    { audioOnly: true, videoOnly: false },
  );
  if (!info.egressId) throw new Error('recording egress returned no identifier');

  const { data, error } = await db
    .from('call_sessions')
    .update({
      recording_egress_id: info.egressId,
      recording_egress_status: 'active',
    })
    .eq('id', sessionId)
    .is('recording_egress_id', null)
    .select('id');

  if (error || !data || data.length !== 1) {
    await client.stopEgress(info.egressId).catch(() => undefined);
    throw new Error('recording egress could not be linked to session');
  }
  return { status: 'started', egressId: info.egressId };
}

function terminalEgressInfo(items: EgressInfo[]): EgressInfo | undefined {
  return items.find((item) => [
    EgressStatus.EGRESS_COMPLETE,
    EgressStatus.EGRESS_FAILED,
    EgressStatus.EGRESS_ABORTED,
    EgressStatus.EGRESS_LIMIT_REACHED,
  ].includes(item.status));
}

async function waitForTerminalEgress(
  client: EgressClientLike,
  egressId: string,
  wait: (ms: number) => Promise<void>,
): Promise<EgressInfo | undefined> {
  const deadline = Date.now() + env.recordingEgressFinalizeTimeoutMs;
  while (Date.now() < deadline) {
    const items = await client.listEgress({ egressId });
    const terminal = terminalEgressInfo(items);
    if (terminal) return terminal;
    await wait(500);
  }
  return undefined;
}

export async function finalizeAuthoritativeRecording(
  sessionId: string,
  deps: RecordingEgressDeps = {},
): Promise<RecordingFinalizeStatus> {
  const db = deps.db ?? supabase;
  const { data: session, error } = await db
    .from('call_sessions')
    .select('recording_object_key, recording_provenance, recording_egress_id, recording_egress_status')
    .eq('id', sessionId)
    .single();
  if (error || !session) throw new Error('recording session not found');
  // I‑1: a linked key is only authoritative when it came from the egress.
  // A browser_upload key with a live egress must fall through and be repointed.
  if (session.recording_object_key && session.recording_provenance === 'livekit_egress') return 'ready';
  if (!session.recording_egress_id) {
    // No egress to defer to. An already-linked key (legacy row, or a fallback
    // the server previously licensed) is final — asking for another upload
    // would only earn a 409. Otherwise the browser copy is the last resort.
    return session.recording_object_key ? 'ready' : 'fallback_required';
  }

  const client = deps.client ?? egressClient();
  const egressId = String(session.recording_egress_id);
  await client.stopEgress(egressId).catch(() => undefined);
  const info = await waitForTerminalEgress(client, egressId, deps.sleep ?? sleep);
  if (!info) return 'pending';
  if (info.status !== EgressStatus.EGRESS_COMPLETE) {
    await db.from('call_sessions').update({ recording_egress_status: 'failed' }).eq('id', sessionId);
    return 'fallback_required';
  }

  const objectKey = egressObjectKey(sessionId);
  const { data: object, error: downloadError } = await db.storage
    .from(env.recordingsBucket)
    .download(objectKey);
  if (downloadError || !object) return 'pending';
  const bytes = Buffer.from(await object.arrayBuffer());
  if (bytes.length === 0 || bytes.length > env.recordingMaxBytes) {
    await db.from('call_sessions').update({ recording_egress_status: 'failed' }).eq('id', sessionId);
    return 'fallback_required';
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const { data: rpcData, error: rpcError } = await db.rpc('finalize_authoritative_recording', {
    p_session_id: sessionId,
    p_object_key: objectKey,
    p_sha256: sha256,
    p_size_bytes: bytes.length,
    p_content_type: 'audio/ogg',
    p_correlation_id: null,
  });
  if (rpcError) throw new Error('recording egress finalization failed');
  const rpcStatus = (rpcData as { status?: string } | null)?.status;
  if (rpcStatus === 'already_authoritative') return 'ready';
  if (rpcStatus === 'provenance_conflict') {
    // Row has provenance that cannot be upgraded to livekit_egress.
    // If a key exists, it stays as-is (ready); otherwise pending.
    const { data: current } = await db
      .from('call_sessions')
      .select('recording_object_key')
      .eq('id', sessionId)
      .single();
    return current?.recording_object_key ? 'ready' : 'pending';
  }
  if (rpcStatus !== 'ok') {
    if (rpcStatus === 'terminal_state') {
      // Session is in a terminal recording state — cannot be repointed.
      // If a key exists, it stays as-is (ready); otherwise pending.
      const { data: current } = await db
        .from('call_sessions')
        .select('recording_object_key')
        .eq('id', sessionId)
        .single();
      return current?.recording_object_key ? 'ready' : 'pending';
    }
    if (rpcStatus === 'no_egress') return 'fallback_required';
    return 'pending';
  }

  await db.from('call_sessions').update({ recording_egress_status: 'complete' }).eq('id', sessionId);
  return 'ready';
}
