import { describe, expect, it } from 'vitest';
import {
  AUDIO_FILE,
  AUDIO_PARTIAL_FILE,
  OGG_CONTENT_TYPE,
  STREAM_FILE,
  VIDEO_FILE,
  contentTypeForKind,
  isObjectKind,
  isRecordingMode,
  isRecordingPrefix,
  isUnderPrefix,
  keyForKind,
  mp4ContentType,
  recordingKeys,
  recordingPrefix,
  toCanonicalUuid,
} from '../lib/r1/recording/keys.js';

const ROUND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('R1 recording object layout (C2)', () => {
  it('derives the prefix and the four fixed keys from the two ids only', () => {
    expect(recordingKeys(ROUND, SESSION)).toEqual({
      prefix: `r1/${ROUND}/${SESSION}/`,
      stream: `r1/${ROUND}/${SESSION}/stream.mp4`,
      video: `r1/${ROUND}/${SESSION}/video.mp4`,
      audioPartial: `r1/${ROUND}/${SESSION}/audio.partial.ogg`,
      audio: `r1/${ROUND}/${SESSION}/audio.ogg`,
    });
    expect([STREAM_FILE, VIDEO_FILE, AUDIO_PARTIAL_FILE, AUDIO_FILE]).toEqual(['stream.mp4', 'video.mp4', 'audio.partial.ogg', 'audio.ogg']);
    expect(recordingPrefix(ROUND, SESSION)).toBe(`r1/${ROUND}/${SESSION}/`);
  });

  it('matches the database prefix check byte for byte (lower-case uuid::text)', () => {
    // 0127: prefix = 'r1/' || round_id::text || '/' || session_id::text || '/'
    expect(recordingPrefix(ROUND.toUpperCase(), SESSION.toUpperCase())).toBe(`r1/${ROUND}/${SESSION}/`);
  });

  it('refuses anything that is not two UUIDs: a hostile id can never shape a key', () => {
    for (const bad of [
      '',
      'not-a-uuid',
      `${ROUND}/../${SESSION}`,
      `${ROUND}/`,
      ` ${ROUND}`,
      `${ROUND}\n`,
      ROUND.replace(/-/g, ''),
      `${ROUND}x`,
      '../etc/passwd',
      '*',
      `${ROUND.slice(0, 35)}g`,
    ]) {
      expect(() => recordingKeys(bad, SESSION), JSON.stringify(bad)).toThrow(TypeError);
      expect(() => recordingKeys(ROUND, bad), JSON.stringify(bad)).toThrow(TypeError);
    }
    expect(() => recordingKeys(undefined as unknown as string, SESSION)).toThrow(TypeError);
    expect(() => recordingKeys(ROUND, 42 as unknown as string)).toThrow(TypeError);
  });

  it('canonicalises UUIDs to lower case and rejects non-strings', () => {
    expect(toCanonicalUuid(ROUND.toUpperCase())).toBe(ROUND);
    expect(toCanonicalUuid(ROUND)).toBe(ROUND);
    expect(toCanonicalUuid(`${ROUND} `)).toBeNull();
    expect(toCanonicalUuid(null)).toBeNull();
    expect(toCanonicalUuid(5)).toBeNull();
  });

  it('recognises a well-formed stored prefix and nothing else', () => {
    expect(isRecordingPrefix(`r1/${ROUND}/${SESSION}/`)).toBe(true);
    for (const bad of [
      `r1/${ROUND}/${SESSION}`, // no trailing slash
      `r2/${ROUND}/${SESSION}/`,
      `r1/${ROUND.toUpperCase()}/${SESSION}/`,
      `r1/${ROUND}/${SESSION}/extra/`,
      `r1/${ROUND}/`,
      `r1//${SESSION}/`,
      '',
      null,
      7,
    ]) {
      expect(isRecordingPrefix(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('knows whether a key lies under a prefix (the DB starts_with check)', () => {
    const keys = recordingKeys(ROUND, SESSION);
    expect(isUnderPrefix(keys.video, keys.prefix)).toBe(true);
    expect(isUnderPrefix(`r1/${ROUND}/${SESSION}x/video.mp4`, keys.prefix)).toBe(false);
    expect(isUnderPrefix('video.mp4', keys.prefix)).toBe(false);
    expect(isUnderPrefix(keys.video, '')).toBe(false);
  });

  it('maps each object kind to one fixed key and content type', () => {
    const keys = recordingKeys(ROUND, SESSION);
    expect(keyForKind(keys, 'audio_partial')).toBe(keys.audioPartial);
    expect(keyForKind(keys, 'audio')).toBe(keys.audio);
    expect(keyForKind(keys, 'video')).toBe(keys.video);
    expect(contentTypeForKind('audio_partial', 'av')).toBe('audio/ogg');
    expect(contentTypeForKind('audio', 'audio')).toBe(OGG_CONTENT_TYPE);
    // The MP4 carries video only when the recording was requested with it.
    expect(contentTypeForKind('video', 'av')).toBe('video/mp4');
    expect(contentTypeForKind('video', 'audio')).toBe('audio/mp4');
    expect(mp4ContentType('av')).toBe('video/mp4');
    expect(mp4ContentType('audio')).toBe('audio/mp4');
  });

  it('validates object kinds and modes as closed sets', () => {
    for (const k of ['audio_partial', 'audio', 'video']) expect(isObjectKind(k)).toBe(true);
    for (const k of ['stream', '../video', 'AUDIO', '', undefined, 3]) expect(isObjectKind(k)).toBe(false);
    for (const m of ['audio', 'av']) expect(isRecordingMode(m)).toBe(true);
    for (const m of ['off', 'video', 'AV', undefined, null]) expect(isRecordingMode(m)).toBe(false);
  });
});
