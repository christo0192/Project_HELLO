/**
 * Object layout of one R1 recording (IMPLEMENTER-RULES C2). Keys are derived on the SERVER from two
 * validated UUIDs and four constant names: nothing the worker (or a staff client) sends ever becomes
 * part of a key, so a hostile body cannot point a presigned URL at another session's objects.
 *
 *   r1/<round_id>/<session_id>/stream.mp4          multipart target (the worker's live fMP4 spool)
 *   r1/<round_id>/<session_id>/video.mp4           optional faststart copy (preferred deliverable)
 *   r1/<round_id>/<session_id>/audio.partial.ogg   growing stereo OGG, re-PUT every 120 s
 *   r1/<round_id>/<session_id>/audio.ogg           final OGG, only when the MP4 cannot carry the audio
 *
 * The same prefix is enforced in the database (`chk_r1_recording_prefix`, 0127), so a row whose prefix
 * disagrees with its ids cannot exist.
 */

export const R1_RECORDING_MODES = ['audio', 'av'] as const;
export type R1RecordingMode = (typeof R1_RECORDING_MODES)[number];

/** What `object-url` may sign: a fixed key per kind, never a caller-chosen name. */
export const R1_OBJECT_KINDS = ['audio_partial', 'audio', 'video'] as const;
export type R1ObjectKind = (typeof R1_OBJECT_KINDS)[number];

export const STREAM_FILE = 'stream.mp4';
export const VIDEO_FILE = 'video.mp4';
export const AUDIO_PARTIAL_FILE = 'audio.partial.ogg';
export const AUDIO_FILE = 'audio.ogg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The canonical (lower-case) form of a UUID string, or null for anything else. */
export function toCanonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;
}

export interface R1RecordingKeys {
  /** `r1/<round_id>/<session_id>/`, always with the trailing slash. */
  prefix: string;
  stream: string;
  video: string;
  audioPartial: string;
  audio: string;
}

/**
 * The prefix and the four fixed keys of one recording. THROWS on a malformed id: this is a
 * programming error (the caller must validate request input first), and a silent fallback would
 * risk signing a URL for the wrong path.
 */
export function recordingKeys(roundId: string, sessionId: string): R1RecordingKeys {
  const round = toCanonicalUuid(roundId);
  const session = toCanonicalUuid(sessionId);
  if (!round || !session) throw new TypeError('r1_recording_invalid_id');
  const prefix = `r1/${round}/${session}/`;
  return {
    prefix,
    stream: prefix + STREAM_FILE,
    video: prefix + VIDEO_FILE,
    audioPartial: prefix + AUDIO_PARTIAL_FILE,
    audio: prefix + AUDIO_FILE,
  };
}

export function recordingPrefix(roundId: string, sessionId: string): string {
  return recordingKeys(roundId, sessionId).prefix;
}

/** True for a well-formed R1 recording prefix (used to refuse a stored prefix that drifted). */
export function isRecordingPrefix(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  return (
    parts.length === 4 &&
    parts[0] === 'r1' &&
    parts[3] === '' &&
    parts[1] === parts[1]!.toLowerCase() &&
    parts[2] === parts[2]!.toLowerCase() &&
    toCanonicalUuid(parts[1]) !== null &&
    toCanonicalUuid(parts[2]) !== null
  );
}

/** Whether `key` lies under `prefix` (the DB check `starts_with(video_key, prefix)`). */
export function isUnderPrefix(key: string, prefix: string): boolean {
  return prefix.length > 0 && key.startsWith(prefix);
}

/** The fixed key `object-url` signs for a kind. */
export function keyForKind(keys: R1RecordingKeys, kind: R1ObjectKind): string {
  switch (kind) {
    case 'audio_partial':
      return keys.audioPartial;
    case 'audio':
      return keys.audio;
    case 'video':
      return keys.video;
  }
}

export function isObjectKind(value: unknown): value is R1ObjectKind {
  return typeof value === 'string' && (R1_OBJECT_KINDS as readonly string[]).includes(value);
}

export function isRecordingMode(value: unknown): value is R1RecordingMode {
  return typeof value === 'string' && (R1_RECORDING_MODES as readonly string[]).includes(value);
}

/** Content-Type of the MP4 (set at CreateMultipartUpload and signed into `video` object URLs). */
export function mp4ContentType(requestedMode: R1RecordingMode): 'video/mp4' | 'audio/mp4' {
  return requestedMode === 'av' ? 'video/mp4' : 'audio/mp4';
}

export const OGG_CONTENT_TYPE = 'audio/ogg';

/** The Content-Type signed into the PutObject URL of a kind. */
export function contentTypeForKind(kind: R1ObjectKind, requestedMode: R1RecordingMode): string {
  return kind === 'video' ? mp4ContentType(requestedMode) : OGG_CONTENT_TYPE;
}
