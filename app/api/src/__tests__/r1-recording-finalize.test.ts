/**
 * Finalize (job `r1.recording.finalize`, IMPLEMENTER-RULES C2/C11): from a `finishing` row and
 * whatever reached the object store to ready / partial / failed, with the multipart settled by the
 * longest uniform prefix, every artefact verified in a streaming pass, and never a buffered object.
 */
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuditSink, getAuditSink, type AuditEntry } from '../lib/audit.js';
import { decide, finalizeRecording, longestUniformPrefix, sniffMatches, type DecisionInput, type R1FinalizeDeps } from '../lib/r1/recording/finalize.js';
import { recordingKeys } from '../lib/r1/recording/keys.js';
import { MemoryR1ObjectStore } from '../lib/r1/recording/memory-store.js';
import type { R1StoredPart } from '../lib/r1/recording/store.js';
import {
  ROOM_ROUND,
  ROOM_SESSION,
  createRecordingFakeDb,
  liveRecordingTables,
  type FakeRecordingDb,
  type Row,
} from './support/r1-recording-fake-db.js';
import { START_MS } from './support/r1-recording-harness.js';

const MIB = 1024 * 1024;
const KEYS = recordingKeys(ROOM_ROUND, ROOM_SESSION);
const sha = (...buffers: Buffer[]): string => createHash('sha256').update(Buffer.concat(buffers)).digest('hex');

function mp4(size: number, fill = 1): Buffer {
  const b = Buffer.alloc(size, fill);
  b.write('ftyp', 4, 'latin1');
  return b;
}
function ogg(size: number, fill = 2): Buffer {
  const b = Buffer.alloc(size, fill);
  b.write('OggS', 0, 'latin1');
  return b;
}
const plain = (size: number, fill = 3): Buffer => Buffer.alloc(size, fill);

interface Fixture {
  db: FakeRecordingDb;
  store: MemoryR1ObjectStore;
  deps: R1FinalizeDeps;
  enqueued: Array<{ name: string; payload: any; options: any }>;
  /** The categories finalize logged (`deps.log`). */
  logs: string[];
  row: Row;
  uploadId: string | null;
  /** Store calls made by the fixture itself; everything after is the code under test. */
  setupCalls: number;
}

/** A `finishing` recording; `parts` become the multipart upload of stream.mp4, `objects` plain PUT objects. */
async function fixture(options: {
  row?: Partial<Row>;
  parts?: readonly Buffer[];
  objects?: Partial<Record<'video' | 'stream' | 'audio' | 'audioPartial', Buffer>>;
  maxBytes?: number;
  consents?: string[] | null;
  withdrawal?: { decision: 'withdrawn' | 'declined' | 'superseded'; at: string };
} = {}): Promise<Fixture> {
  const tables = liveRecordingTables({ consents: options.consents, withdrawal: options.withdrawal });
  const db = createRecordingFakeDb(tables);
  const store = new MemoryR1ObjectStore({ now: () => START_MS });
  let uploadId: string | null = null;
  if (options.parts) {
    uploadId = await store.createMultipart(KEYS.stream, 'video/mp4');
    options.parts.forEach((part, index) => store.putPart(uploadId!, index + 1, part));
  }
  for (const [name, bytes] of Object.entries(options.objects ?? {})) {
    const key = { video: KEYS.video, stream: KEYS.stream, audio: KEYS.audio, audioPartial: KEYS.audioPartial }[name as 'video'];
    store.putObject(key, bytes!, name === 'video' || name === 'stream' ? 'video/mp4' : 'audio/ogg');
  }
  const row: Row = {
    session_id: ROOM_SESSION,
    round_id: ROOM_ROUND,
    bucket: 'ik-r1-recordings',
    prefix: KEYS.prefix,
    requested_mode: 'av',
    status: 'finishing',
    layout: 'combined',
    has_video: true,
    upload_id: uploadId,
    parts_issued: options.parts?.length ?? 0,
    urls_issued: options.parts?.length ?? 0,
    video_key: null, video_bytes: null, video_sha256: null, video_etag: null, video_content_type: null,
    audio_key: null, audio_bytes: null, audio_sha256: null, audio_etag: null,
    started_at_ms: null, duration_ms: null, width: null, height: null, fps: null,
    frames_encoded: null, frames_dropped: null, camera_off_ms: null, degraded_at_ms: null,
    reported_stream_bytes: null, reported_parts: null,
    degraded_reason: null, failure_reason: null,
    finalize_attempts: 0,
    created_at: new Date(START_MS - 600_000).toISOString(),
    updated_at: new Date(START_MS - 1000).toISOString(),
    finalize_requested_at: new Date(START_MS - 1000).toISOString(),
    finalized_at: null,
    delete_after: new Date(START_MS + 90 * 86_400_000).toISOString(),
    delete_requested_at: null, delete_reason: null, deleted_at: null,
    ...options.row,
  };
  tables.interview_round_recordings!.push(row);
  const enqueued: Fixture['enqueued'] = [];
  const logs: string[] = [];
  const deps: R1FinalizeDeps = {
    db: db.client as never,
    store,
    maxBytes: options.maxBytes ?? 400 * MIB,
    now: () => new Date(START_MS),
    enqueue: async (name, payload, enqueueOptions) => { enqueued.push({ name, payload, options: enqueueOptions }); },
    log: (category) => { logs.push(category); },
  };
  return { db, store, deps, enqueued, logs, row, uploadId, setupCalls: store.calls.length };
}

let originalSink: ReturnType<typeof getAuditSink>;
let audits: AuditEntry[];
beforeEach(() => {
  audits = [];
  originalSink = getAuditSink();
  setAuditSink((entry) => { audits.push(entry); });
});
afterEach(() => {
  setAuditSink(originalSink);
  vi.restoreAllMocks();
});

describe('longestUniformPrefix (what R2 will accept to complete)', () => {
  const part = (n: number, mib: number): R1StoredPart => ({ n, size: mib * MIB, etag: `"e${n}"` });
  const sizes = (parts: R1StoredPart[]): number[] => parts.map((p) => p.size / MIB);

  it('keeps contiguous uniform parts and a shorter last part', () => {
    expect(sizes(longestUniformPrefix([part(1, 5), part(2, 5), part(3, 5)]))).toEqual([5, 5, 5]);
    expect(sizes(longestUniformPrefix([part(1, 5), part(2, 5), part(3, 2)]))).toEqual([5, 5, 2]);
    expect(sizes(longestUniformPrefix([part(1, 7), part(2, 7), part(3, 7)]))).toEqual([7, 7, 7]);
    expect(longestUniformPrefix([part(1, 1)]).map((p) => p.n)).toEqual([1]); // a lone part may be any size
    expect(longestUniformPrefix([part(1, 5), part(2, 3)]).map((p) => p.n)).toEqual([1, 2]);
  });

  it('stops at the first gap, the first short part followed by more, or a part larger than the first', () => {
    expect(longestUniformPrefix([part(1, 5), part(2, 5), part(4, 5)]).map((p) => p.n)).toEqual([1, 2]);
    expect(longestUniformPrefix([part(1, 5), part(2, 5), part(3, 2), part(4, 5)]).map((p) => p.n)).toEqual([1, 2, 3]);
    expect(longestUniformPrefix([part(1, 5), part(2, 5), part(3, 6)]).map((p) => p.n)).toEqual([1, 2]);
    expect(longestUniformPrefix([part(1, 5), part(2, 6)]).map((p) => p.n)).toEqual([1]);
    expect(longestUniformPrefix([part(2, 5), part(3, 5)])).toEqual([]); // no part 1
    expect(longestUniformPrefix([])).toEqual([]);
  });

  it('never lets a part below the 5 MiB R2 minimum be followed by another', () => {
    expect(longestUniformPrefix([part(1, 3), part(2, 3)]).map((p) => p.n)).toEqual([1]);
    expect(longestUniformPrefix([{ n: 1, size: 0, etag: '"z"' }])).toEqual([]);
  });

  it('sorts its input and caps at 60 parts', () => {
    expect(longestUniformPrefix([part(3, 5), part(1, 5), part(2, 5)]).map((p) => p.n)).toEqual([1, 2, 3]);
    const many = Array.from({ length: 64 }, (_, i) => part(i + 1, 5));
    expect(longestUniformPrefix(many)).toHaveLength(60);
  });
});

describe('sniffMatches', () => {
  it('reads ftyp at offset 4 for MP4 and OggS at offset 0 for OGG', () => {
    expect(sniffMatches(mp4(12), 12, 'mp4')).toBe(true);
    expect(sniffMatches(mp4(12), 7, 'mp4')).toBe(false); // too short to tell
    expect(sniffMatches(ogg(12), 12, 'ogg')).toBe(true);
    expect(sniffMatches(ogg(12), 3, 'ogg')).toBe(false);
    expect(sniffMatches(plain(12), 12, 'mp4')).toBe(false);
    expect(sniffMatches(plain(12), 12, 'ogg')).toBe(false);
    expect(sniffMatches(mp4(12), 12, 'ogg')).toBe(false);
    expect(sniffMatches(ogg(12), 12, 'mp4')).toBe(false);
  });
});

describe('decide: the C11 verdict', () => {
  const base: DecisionInput = {
    claimLayout: 'combined', requestedMode: 'av', claimHasVideo: true, failureReason: null, degradedReason: null,
    hasMp4: true, hasOgg: false, truncated: false, oversize: false, invalidSeen: false,
  };
  const d = (patch: Partial<DecisionInput>) => decide({ ...base, ...patch });

  it('ready iff combined (as claimed), no failure reason, and audio-by-request or video without degradation', () => {
    expect(d({})).toMatchObject({ status: 'ready', layout: 'combined', hasVideo: true, failureReason: null });
    expect(d({ requestedMode: 'audio', claimHasVideo: false })).toMatchObject({ status: 'ready', layout: 'combined', hasVideo: false });
    // An audio recording is ready whatever a degradation says: there is no video to degrade.
    expect(d({ requestedMode: 'audio', claimHasVideo: false, degradedReason: 'cpu_loop_lag' }).status).toBe('ready');
    expect(d({ hasOgg: true })).toMatchObject({ status: 'ready', layout: 'combined', keepMp4: true, keepOgg: false }); // the OGG is transient
  });

  it('is partial when anything is off, even though a file is playable', () => {
    expect(d({ degradedReason: 'frame_drops' }).status).toBe('partial');
    expect(d({ claimHasVideo: false }).status).toBe('partial'); // asked for video, got none
    expect(d({ failureReason: 'upload_failed' })).toMatchObject({ status: 'partial', failureReason: 'upload_failed' });
    expect(d({ truncated: true })).toMatchObject({ status: 'partial', failureReason: 'upload_failed' });
    expect(d({ oversize: true })).toMatchObject({ status: 'partial', failureReason: 'oversize' });
    expect(d({ failureReason: 'encoder_crashed', truncated: true }).failureReason).toBe('encoder_crashed'); // the worker's reason wins
  });

  it('honours a split claim with both artefacts, and degrades by availability otherwise', () => {
    expect(d({ claimLayout: 'split', hasOgg: true, failureReason: 'encoder_crashed' })).toMatchObject({ status: 'partial', layout: 'split', keepMp4: true, keepOgg: true, hasVideo: true });
    expect(d({ claimLayout: 'split', hasOgg: false })).toMatchObject({ status: 'partial', layout: 'combined' }); // the audio tail is missing: never ready
    expect(d({ claimLayout: 'split', hasMp4: false, hasOgg: true })).toMatchObject({ status: 'partial', layout: 'audio_only', hasVideo: false, keepMp4: false, keepOgg: true });
    expect(d({ claimLayout: 'combined', hasMp4: false, hasOgg: true })).toMatchObject({ status: 'partial', layout: 'audio_only' });
    expect(d({ claimLayout: 'audio_only', hasMp4: false, hasOgg: true })).toMatchObject({ status: 'partial', layout: 'audio_only' });
    expect(d({ claimLayout: 'audio_only', hasMp4: true, hasOgg: false })).toMatchObject({ status: 'partial', layout: 'combined' });
    expect(d({ claimLayout: 'audio_only', hasMp4: true, hasOgg: true })).toMatchObject({ layout: 'audio_only', keepMp4: false, keepOgg: true });
  });

  it('without a complete (salvage): MP4+OGG split, MP4 only combined, OGG only audio_only, all partial/worker_lost; nothing is failed', () => {
    const salvage = { claimLayout: null, claimHasVideo: null } as const;
    expect(d({ ...salvage, hasOgg: true })).toMatchObject({ status: 'partial', layout: 'split', failureReason: 'worker_lost', hasVideo: true });
    expect(d({ ...salvage })).toMatchObject({ status: 'partial', layout: 'combined', failureReason: 'worker_lost' });
    expect(d({ ...salvage, hasMp4: false, hasOgg: true })).toMatchObject({ status: 'partial', layout: 'audio_only', failureReason: 'worker_lost', hasVideo: false });
    expect(d({ ...salvage, hasMp4: false })).toMatchObject({ status: 'failed', layout: null, failureReason: 'nothing_uploaded', hasVideo: false });
    expect(d({ ...salvage, requestedMode: 'audio', hasOgg: true })).toMatchObject({ layout: 'split', hasVideo: false });
  });

  it('names why nothing is playable: oversize, then integrity, else nothing_uploaded', () => {
    const none = { hasMp4: false, hasOgg: false } as const;
    expect(d({ ...none })).toMatchObject({ status: 'failed', failureReason: 'nothing_uploaded' });
    expect(d({ ...none, invalidSeen: true })).toMatchObject({ status: 'failed', failureReason: 'integrity' });
    expect(d({ ...none, invalidSeen: true, oversize: true })).toMatchObject({ status: 'failed', failureReason: 'oversize' });
    expect(d({ ...none, failureReason: 'upload_failed' }).failureReason).toBe('nothing_uploaded'); // the fact beats the worker's guess
  });
});

describe('finalizeRecording: a clean recording', () => {
  it('completes the multipart, verifies it, and marks the recording ready (streamed MP4 is the deliverable)', async () => {
    const parts = [mp4(5 * MIB, 1), plain(5 * MIB, 2), plain(2 * MIB, 3)];
    const f = await fixture({
      parts,
      objects: { audioPartial: ogg(1000) },
      row: { reported_stream_bytes: 12 * MIB, reported_parts: 3, duration_ms: 600_000 },
    });
    const outcome = await finalizeRecording(f.deps, ROOM_SESSION);
    expect(outcome).toEqual({ kind: 'finalized', status: 'ready', layout: 'combined' });

    const head = await f.store.head(KEYS.stream);
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({
      status: 'ready',
      layout: 'combined',
      has_video: true,
      upload_id: null,
      video_key: KEYS.stream,
      video_bytes: 12 * MIB,
      video_sha256: sha(...parts),
      video_etag: head!.etag,
      video_content_type: 'video/mp4',
      audio_key: null, audio_bytes: null, audio_sha256: null, audio_etag: null,
      failure_reason: null,
      finalize_attempts: 1,
      finalized_at: new Date(START_MS).toISOString(),
    });
    // The transient checkpoint is gone; the multipart is closed; only the deliverable remains.
    expect(f.store.objectKeys()).toEqual([KEYS.stream]);
    expect(f.store.openUploadIds()).toEqual([]);
    expect(audits.map((a) => [a.event, a.metadata?.status, a.metadata?.layout])).toEqual([['recording.integrity_verified', 'ready', 'combined']]);
    expect(audits[0]!.userId).toBeNull(); // the system actor
    expect(JSON.stringify(audits)).not.toMatch(/r1\/|https|mem-upload|upload_id/);
  });

  it('prefers the faststart video.mp4 and removes stream.mp4', async () => {
    const stream = [mp4(5 * MIB, 1), plain(3 * MIB, 2)];
    const video = mp4(8 * MIB, 9);
    const f = await fixture({ parts: stream, objects: { video }, row: { reported_stream_bytes: 8 * MIB } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'ready' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ video_key: KEYS.video, video_bytes: 8 * MIB, video_sha256: sha(video) });
    expect(f.store.objectKeys()).toEqual([KEYS.video]);
  });

  it('falls back to stream.mp4 when video.mp4 is not an MP4 (and removes the junk)', async () => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1 * MIB)], objects: { video: plain(2000) } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'ready' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ video_key: KEYS.stream });
    expect(f.store.objectKeys()).toEqual([KEYS.stream]);
  });

  it('an audio-only recording is ready as audio/mp4 and has no video', async () => {
    const f = await fixture({ row: { requested_mode: 'audio', has_video: false }, parts: [mp4(5 * MIB, 4), plain(1000)] });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'ready', layout: 'combined' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ has_video: false, video_content_type: 'audio/mp4' });
  });

  it('a camera that never appeared (degraded video_unavailable) is partial, not ready', async () => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1000)], row: { degraded_reason: 'video_unavailable', has_video: false } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'partial', layout: 'combined' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'partial', has_video: false, degraded_reason: 'video_unavailable' });
  });

  it('keeps the OGG with a split layout and removes everything else', async () => {
    const f = await fixture({
      parts: [mp4(5 * MIB), plain(1 * MIB)],
      objects: { audio: ogg(4000), audioPartial: ogg(3000) },
      row: { layout: 'split', failure_reason: 'encoder_crashed' },
    });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'split' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({
      status: 'partial', layout: 'split', failure_reason: 'encoder_crashed',
      video_key: KEYS.stream, audio_key: KEYS.audio, audio_bytes: 4000, audio_sha256: sha(ogg(4000)),
    });
    expect(f.store.objectKeys().sort()).toEqual([KEYS.audio, KEYS.stream].sort());
  });

  it('audio.partial.ogg is kept when it is the ONLY audio (audio_only)', async () => {
    const f = await fixture({ objects: { audioPartial: ogg(3000) }, row: { layout: 'audio_only', has_video: false, failure_reason: 'encoder_unavailable' } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ video_key: null, audio_key: KEYS.audioPartial, has_video: false });
    expect(f.store.objectKeys()).toEqual([KEYS.audioPartial]);
  });
});

describe('finalizeRecording: crash salvage and damaged uploads', () => {
  it('settles a non-uniform upload with the longest valid prefix and flags the shortfall', async () => {
    const f = await fixture({
      parts: [mp4(5 * MIB), plain(5 * MIB), plain(3 * MIB), plain(5 * MIB)], // part 4 follows a short part: invalid
      row: { reported_stream_bytes: 18 * MIB },
    });
    const outcome = await finalizeRecording(f.deps, ROOM_SESSION);
    expect(outcome).toEqual({ kind: 'finalized', status: 'partial', layout: 'combined' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ video_bytes: 13 * MIB, failure_reason: 'upload_failed' });
    expect(f.store.callsOf('completeMultipart')).toHaveLength(1);
  });

  it('a gap in the part numbers keeps only the contiguous prefix', async () => {
    const f = await fixture({ row: { layout: null, has_video: null } });
    f.row.upload_id = await f.store.createMultipart(KEYS.stream, 'video/mp4');
    f.store.putPart(f.row.upload_id, 1, mp4(5 * MIB));
    f.store.putPart(f.row.upload_id, 2, plain(5 * MIB));
    f.store.putPart(f.row.upload_id, 4, plain(5 * MIB)); // part 3 never arrived
    await finalizeRecording(f.deps, ROOM_SESSION);
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ video_bytes: 10 * MIB, layout: 'combined', status: 'partial', failure_reason: 'worker_lost' });
  });

  it('aborts the upload when no part qualifies, and an OGG alone becomes an audio-only recording', async () => {
    const f = await fixture({ parts: [], objects: { audioPartial: ogg(2000) }, row: { layout: null, has_video: null } });
    expect(f.uploadId).not.toBeNull();
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
    expect(f.store.callsOf('abortMultipart')).toHaveLength(1);
    expect(f.store.callsOf('completeMultipart')).toHaveLength(0);
    expect(f.store.openUploadIds()).toEqual([]);
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ failure_reason: 'worker_lost', audio_key: KEYS.audioPartial, upload_id: null });
  });

  it('nothing uploaded at all is failed / nothing_uploaded', async () => {
    const f = await fixture({ parts: [], row: { layout: null, has_video: null } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'failed', layout: null });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({
      status: 'failed', layout: null, has_video: false, failure_reason: 'nothing_uploaded', video_key: null, audio_key: null, upload_id: null,
    });
  });

  it.each([
    ['MP4 and OGG', { parts: [mp4(5 * MIB), plain(10)], objects: { audio: ogg(500) } }, 'partial', 'split'],
    ['MP4 only', { parts: [mp4(5 * MIB), plain(10)] }, 'partial', 'combined'],
    ['OGG only', { objects: { audioPartial: ogg(500) } }, 'partial', 'audio_only'],
  ] as const)('without a complete: %s is %s / %s with worker_lost', async (_label, shape, status, layout) => {
    const f = await fixture({ ...shape, row: { layout: null, has_video: null } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status, layout });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ failure_reason: 'worker_lost', finalize_attempts: 1 });
  });

  it('tolerates NoSuchUpload (a previous run completed it) and clears the stale upload id', async () => {
    const f = await fixture({ objects: { stream: mp4(5 * MIB + 10) } });
    f.row.upload_id = 'mem-upload-already-gone';
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'ready' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ upload_id: null, video_key: KEYS.stream });
    expect(f.logs).toEqual([]); // stream.mp4 is there: nothing was lost
  });

  it('a stream.mp4 that is not an MP4 is not a deliverable (failed / integrity, objects left for the erase job)', async () => {
    const f = await fixture({ parts: [plain(5 * MIB), plain(1000)] });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'failed', layout: null });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'failed', failure_reason: 'integrity' });
    expect(f.store.has(KEYS.stream)).toBe(true);
  });

  it('a bad MP4 beside a good OGG leaves the audio, partial, and removes the junk', async () => {
    const f = await fixture({ parts: [plain(5 * MIB), plain(1000)], objects: { audio: ogg(900) }, row: { layout: 'split' } });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
    expect(f.store.objectKeys()).toEqual([KEYS.audio]);
  });

  it('an object over R1_RECORDING_MAX_BYTES is removed: failed / oversize (or partial beside a valid OGG)', async () => {
    const big = await fixture({ maxBytes: 16 * MIB, row: { layout: 'combined' } });
    big.store.putRepeating(KEYS.stream, 17 * MIB, mp4(1000), 'video/mp4');
    expect(await finalizeRecording(big.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'failed', layout: null });
    expect(big.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'failed', failure_reason: 'oversize' });
    expect(big.store.has(KEYS.stream)).toBe(false);
    expect(big.store.callsOf('read')).toHaveLength(0); // never even read

    const withOgg = await fixture({ maxBytes: 16 * MIB, objects: { audioPartial: ogg(800) } });
    withOgg.store.putRepeating(KEYS.stream, 17 * MIB, mp4(1000), 'video/mp4');
    expect(await finalizeRecording(withOgg.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
    expect(withOgg.db.tables.interview_round_recordings![0]).toMatchObject({ failure_reason: 'oversize' });
  });

  it('a shortfall against what the worker reported on stream.mp4 downgrades ready to partial; video.mp4 ignores it', async () => {
    const short = await fixture({ parts: [mp4(5 * MIB), plain(2 * MIB)], row: { reported_stream_bytes: 30 * MIB } });
    expect(await finalizeRecording(short.deps, ROOM_SESSION)).toMatchObject({ status: 'partial' });
    expect(short.db.tables.interview_round_recordings![0].failure_reason).toBe('upload_failed');

    const faststart = await fixture({ parts: [mp4(5 * MIB), plain(2 * MIB)], objects: { video: mp4(9 * MIB) }, row: { reported_stream_bytes: 30 * MIB } });
    expect(await finalizeRecording(faststart.deps, ROOM_SESSION)).toMatchObject({ status: 'ready' });

    const exact = await fixture({ parts: [mp4(5 * MIB), plain(2 * MIB)], row: { reported_stream_bytes: 7 * MIB } });
    expect(await finalizeRecording(exact.deps, ROOM_SESSION)).toMatchObject({ status: 'ready' });
  });
});

describe('finalizeRecording: the multipart upload was aborted by somebody else (incident 2026-10-21, session 482cb480)', () => {
  // The incident row: av, the picture given up at 240.7 s, then the encoder lost; part 1 reached R2, the
  // upload was aborted before hang-up (most likely by the sweep), and the worker claimed `split`.
  const INCIDENT = { layout: 'split', has_video: true, failure_reason: 'encoder_crashed', degraded_reason: 'cpu_loop_lag', reported_parts: 1 } as const;

  async function abortedUpload(objects: NonNullable<Parameters<typeof fixture>[0]>['objects']): Promise<Fixture> {
    const f = await fixture({ parts: [mp4(5 * MIB, 1), plain(1 * MIB, 2)], objects, row: INCIDENT });
    await f.store.abortMultipart(KEYS.stream, f.uploadId!);
    f.setupCalls = f.store.calls.length;
    return f;
  }

  it('a split claim with the crashed encoder\'s prefix as video.mp4 beside audio.ogg finalizes split WITH video, and the loss is logged', async () => {
    const video = mp4(7 * MIB, 9);
    const f = await abortedUpload({ video, audio: ogg(4000), audioPartial: ogg(3000) });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'split' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({
      status: 'partial', layout: 'split', has_video: true, failure_reason: 'encoder_crashed', degraded_reason: 'cpu_loop_lag',
      upload_id: null,
      video_key: KEYS.video, video_bytes: 7 * MIB, video_sha256: sha(video), video_content_type: 'video/mp4',
      audio_key: KEYS.audio, audio_bytes: 4000, audio_sha256: sha(ogg(4000)),
    });
    expect(f.store.objectKeys().sort()).toEqual([KEYS.audio, KEYS.video].sort()); // the checkpoint is transient
    expect(f.store.callsOf('completeMultipart')).toHaveLength(0);
    // The stream.mp4 parts are gone even though video.mp4 rescued the picture: still worth a line.
    expect(f.logs).toEqual(['r1_recording_upload_missing']);
  });

  it('without video.mp4 (what production had) it is still audio_only without video, but no longer silent', async () => {
    const f = await abortedUpload({ audio: ogg(4000), audioPartial: ogg(3000) });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({
      status: 'partial', layout: 'audio_only', has_video: false, failure_reason: 'encoder_crashed',
      upload_id: null, video_key: null, audio_key: KEYS.audio,
    });
    expect(f.logs).toEqual(['r1_recording_upload_missing']);
  });

  it('checks before it clears the id: a transient HEAD failure retries the check, and the line is written once', async () => {
    const f = await abortedUpload({ audio: ogg(4000) });
    f.store.failNext('head', 'unavailable'); // the stream.mp4 HEAD inside the settle step
    await expect(finalizeRecording(f.deps, ROOM_SESSION)).rejects.toThrow('r1_storage_unavailable');
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'finishing', upload_id: f.uploadId });
    expect(f.logs).toEqual([]);
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
    expect(f.logs).toEqual(['r1_recording_upload_missing']);
  });

  it('by default the line is a warn of the r1-recording logger carrying the category only', async () => {
    const f = await abortedUpload({ audio: ogg(4000) });
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((line: unknown) => { lines.push(String(line)); });
    const { log: _injected, ...deps } = f.deps;
    expect(await finalizeRecording(deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', layout: 'audio_only' });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', component: 'r1-recording', error_category: 'r1_recording_upload_missing' });
    for (const secret of [f.uploadId!, ROOM_SESSION, ROOM_ROUND, 'r1/', 'mem-upload']) expect(lines[0]).not.toContain(secret);
  });
});

describe('finalizeRecording: errors are closed codes, and a transient store failure is retryable', () => {
  it.each([
    ['listParts', 'unavailable', 'r1_storage_unavailable'],
    ['completeMultipart', 'unavailable', 'r1_storage_unavailable'],
    ['head', 'unavailable', 'r1_storage_unavailable'],
    ['read', 'unavailable', 'r1_storage_unavailable'],
    ['head', 'access_denied', 'r1_storage_access'],
    ['completeMultipart', 'invalid_request', 'r1_storage_rejected'],
    ['head', 'bad_response', 'r1_storage_error'],
  ] as const)('%s failing with %s throws %s and writes nothing', async (op, code, thrown) => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1000)] });
    f.store.failNext(op, code);
    await expect(finalizeRecording(f.deps, ROOM_SESSION)).rejects.toThrow(thrown);
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'finishing', video_key: null, finalized_at: null });
    // The same job, retried, finishes the work.
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'ready' });
    expect(f.db.tables.interview_round_recordings![0].finalize_attempts).toBe(2);
  });

  it('a length mismatch between HEAD and the stream is a retryable r2_short_read, never a verdict', async () => {
    const f = await fixture({});
    f.store.putVirtual(KEYS.stream, 1000, async function* () { yield mp4(900); }, 'video/mp4');
    await expect(finalizeRecording(f.deps, ROOM_SESSION)).rejects.toThrow('r2_short_read');
    f.store.putVirtual(KEYS.stream, 1000, async function* () { yield mp4(600); yield plain(600); }, 'video/mp4');
    await expect(finalizeRecording(f.deps, ROOM_SESSION)).rejects.toThrow('r2_short_read');
    expect(f.db.tables.interview_round_recordings![0].status).toBe('finishing');
  });

  it('an object that vanishes between HEAD and read is treated as absent', async () => {
    const f = await fixture({ objects: { stream: mp4(2000), audioPartial: ogg(500) }, row: { layout: 'split' } });
    const read = f.store.read.bind(f.store);
    f.store.read = async (key: string) => {
      if (key === KEYS.stream) f.store.disappear(KEYS.stream);
      return read(key);
    };
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'finalized', status: 'partial', layout: 'audio_only' });
  });

  it('a failed removal of the leftovers does not undo the verdict', async () => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1000)], objects: { audioPartial: ogg(300) } });
    f.store.failNext('remove', 'unavailable');
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized', status: 'ready' });
    expect(f.db.tables.interview_round_recordings![0].status).toBe('ready');
    expect(f.store.has(KEYS.audioPartial)).toBe(true); // erased with the prefix, or by the lifecycle rule
  });

  it('a database error is a closed code', async () => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1000)] });
    f.db.failOn('interview_round_recordings', 'select');
    await expect(finalizeRecording(f.deps, ROOM_SESSION)).rejects.toThrow('r1_recording_db_error');
    const g = await fixture({ parts: [mp4(5 * MIB), plain(1000)] });
    g.db.failOn('interview_round_consents', 'select');
    await expect(finalizeRecording(g.deps, ROOM_SESSION)).rejects.toThrow('r1_consent_read_error');
  });

  it('no error or audit row carries a key, an upload id, a URL or an ETag', async () => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1000)] });
    f.store.failNext('head', 'unavailable');
    const error = await finalizeRecording(f.deps, ROOM_SESSION).catch((e: Error) => e);
    expect((error as Error).message).toBe('r1_storage_unavailable');
    expect(String((error as Error).stack)).not.toMatch(new RegExp(`${ROOM_SESSION}|${ROOM_ROUND}|mem-upload|https|stream\.mp4`));
  });
});

describe('finalizeRecording: when there is nothing (more) to do', () => {
  it('skips a missing row, a row that is not finishing, and a deleted or leaving one, touching nothing', async () => {
    const none = await fixture({});
    none.db.tables.interview_round_recordings!.length = 0;
    expect(await finalizeRecording(none.deps, ROOM_SESSION)).toEqual({ kind: 'skipped', reason: 'no_row' });

    for (const status of ['preparing', 'uploading', 'ready', 'partial', 'failed']) {
      const f = await fixture({ row: { status }, parts: [mp4(5 * MIB)] });
      expect(await finalizeRecording(f.deps, ROOM_SESSION), status).toEqual({ kind: 'skipped', reason: 'not_finishing' });
      expect(f.store.calls.slice(f.setupCalls)).toEqual([]);
    }
    const gone = await fixture({ row: { status: 'deleted', deleted_at: '2026-10-12T09:00:00.000Z' } });
    expect(await finalizeRecording(gone.deps, ROOM_SESSION)).toEqual({ kind: 'skipped', reason: 'deleted' });
    const leaving = await fixture({ row: { delete_requested_at: '2026-10-12T09:00:00.000Z' } });
    expect(await finalizeRecording(leaving.deps, ROOM_SESSION)).toEqual({ kind: 'skipped', reason: 'deleted' });
    expect(leaving.store.calls.slice(leaving.setupCalls)).toEqual([]);
  });

  // The fixture's recording was made at START_MS - 10 min.
  const WITHDREW_AFTER = new Date(START_MS - 120_000).toISOString();
  const WITHDREW_BEFORE = new Date(START_MS - 3_600_000).toISOString();

  it('a consent withdrawn or declined since complete: marks the recording for erasure, queues the erase job, verifies and keeps nothing', async () => {
    for (const decision of ['withdrawn', 'declined'] as const) {
      for (const consents of [null, ['ai_interview']]) {
        const f = await fixture({ consents, withdrawal: { decision, at: WITHDREW_AFTER }, parts: [mp4(5 * MIB), plain(10)] });
        expect(await finalizeRecording(f.deps, ROOM_SESSION), `${decision} ${consents}`).toEqual({ kind: 'erase_requested' });
        expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'finishing', delete_reason: 'consent_withdrawn', video_key: null });
        expect(f.db.tables.interview_round_recordings![0].delete_requested_at).toBe(new Date(START_MS).toISOString());
        expect(f.enqueued).toEqual([{
          name: 'r1.recording.erase',
          payload: { session_id: ROOM_SESSION, reason: 'consent_withdrawn' },
          options: { dedupKey: `r1.recording.erase:session:${ROOM_SESSION}`, maxAttempts: 5 },
        }]);
        expect(f.store.calls.slice(f.setupCalls)).toEqual([]); // not even a HEAD
        expect(audits).toEqual([]);
      }
    }
  });

  it('a consent that was only SUPERSEDED (or is not there yet) is not a withdrawal: the recording is finalized and kept', async () => {
    // Review round 1: a retake that needs the latest template closes the old consent and inserts the new
    // one as two writes; between them (or for good when the insert fails) the round has no live consent.
    const cases: Array<[string, Parameters<typeof fixture>[0]]> = [
      ['superseded, replacement missing', { consents: null, withdrawal: { decision: 'superseded', at: WITHDREW_AFTER } }],
      ['no consent row at all', { consents: null }],
      ['superseded, replacement lacks recording', { consents: ['ai_interview'], withdrawal: { decision: 'superseded', at: WITHDREW_AFTER } }],
    ];
    for (const [label, options] of cases) {
      const f = await fixture({ ...options, parts: [mp4(5 * MIB), plain(1000)] });
      expect(await finalizeRecording(f.deps, ROOM_SESSION), label).toMatchObject({ kind: 'finalized', status: 'ready' });
      const row = f.db.tables.interview_round_recordings![0];
      expect(row, label).toMatchObject({ status: 'ready', delete_reason: null, delete_requested_at: null, video_key: KEYS.stream });
      expect(f.enqueued, label).toEqual([]);
      expect(f.store.has(KEYS.stream), label).toBe(true);
    }
  });

  it('a withdrawal from BEFORE the recording was made does not erase it (the candidate re-consented after it)', async () => {
    const f = await fixture({ consents: ['ai_interview'], withdrawal: { decision: 'withdrawn', at: WITHDREW_BEFORE }, parts: [mp4(5 * MIB), plain(1000)] });
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toMatchObject({ kind: 'finalized' });
    expect(f.enqueued).toEqual([]);
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ delete_requested_at: null });
  });

  it('loses the compare-and-set cleanly when the recording was erased while it ran: nothing is written or removed', async () => {
    const f = await fixture({ parts: [mp4(5 * MIB), plain(1000)], objects: { audioPartial: ogg(300) } });
    f.db.hooks.beforeWrite = (table, op, patch, matching) => {
      if (table === 'interview_round_recordings' && op === 'update' && patch?.status === 'ready') {
        f.db.hooks.beforeWrite = undefined;
        Object.assign(matching[0]!, { delete_requested_at: '2026-10-12T10:00:00.000Z' });
      }
    };
    expect(await finalizeRecording(f.deps, ROOM_SESSION)).toEqual({ kind: 'raced' });
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ status: 'finishing', video_key: null });
    expect(f.store.has(KEYS.audioPartial)).toBe(true); // the erase job removes the prefix
    expect(f.store.callsOf('remove')).toEqual([]);
    expect(audits).toEqual([]);
  });
});

describe('finalizeRecording: never buffers an object', () => {
  it('streams a 512 MiB object in 64 KiB chunks with flat memory and no whole-object buffering call', async () => {
    const f = await fixture({ maxBytes: 1024 * MIB });
    const total = 512 * MIB;
    const chunkSize = 64 * 1024;
    const head = mp4(chunkSize, 1);
    const body = Buffer.alloc(chunkSize, 7);
    let peak = 0;
    const baseline = () => process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
    (globalThis as { gc?: () => void }).gc?.();
    const start = baseline();
    f.store.putVirtual(KEYS.stream, total, async function* () {
      yield head;
      for (let sent = chunkSize, n = 0; sent < total; sent += chunkSize, n += 1) {
        if (n % 256 === 0) peak = Math.max(peak, baseline() - start);
        yield body;
      }
    }, 'video/mp4', '"virtual-512"');

    const concat = vi.spyOn(Buffer, 'concat');
    const arrayBuffer = vi.spyOn(Response.prototype, 'arrayBuffer');
    const outcome = await finalizeRecording(f.deps, ROOM_SESSION);
    expect(outcome).toMatchObject({ kind: 'finalized', status: 'ready' });
    expect(concat).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(f.db.tables.interview_round_recordings![0]).toMatchObject({ video_bytes: total });
    expect(f.db.tables.interview_round_recordings![0].video_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(peak).toBeLessThan(25 * MIB);
    // And the hash is the real one: 1 x head chunk + 8191 x body chunk.
    const expected = createHash('sha256');
    expected.update(head);
    for (let i = 1; i < total / chunkSize; i += 1) expected.update(body);
    expect(f.db.tables.interview_round_recordings![0].video_sha256).toBe(expected.digest('hex'));
  }, 120_000);
});
