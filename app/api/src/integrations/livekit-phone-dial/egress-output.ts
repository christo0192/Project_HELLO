/**
 * livekit-phone-dial/egress-output.ts — the S3 output descriptor for an
 * attempt-scoped phone recording.
 *
 * Split out of `recording.ts` on purpose. `recording.ts` owns the ORDERING
 * that makes the disclosure gate real, and it names no SDK symbol at all — a
 * property a structural test asserts, and one that keeps the safety-critical
 * file readable without knowing anything about proto output descriptors. The
 * SDK types live here, behind a lazy import, exactly as `verify.ts` and
 * `stores.ts` do it: several suites partially `vi.mock('livekit-server-sdk')`,
 * and a static value import anywhere in `app.ts`'s graph breaks app load.
 *
 * The bucket, credentials and codec deliberately mirror
 * `lib/recording-egress.ts` rather than inventing a second convention: a phone
 * recording and a browser recording land in the same bucket. Phone output is
 * MP3 so it is directly usable by recruiters and downstream transcription.
 * Only the KEY differs, and
 * it differs because it must — an attempt-scoped key is the thing that makes a
 * reconnect's audio nameable, and therefore deletable.
 */

import { env } from '../../lib/env.js';

/**
 * True iff an attempt egress could actually be written. Checked BEFORE a
 * recording is attempted so a missing bucket is a refusal rather than an
 * exception thrown after the disclosure has already been delivered.
 */
export function phoneEgressConfigured(): boolean {
  // THREE clauses, not four. `env.recordingsBucket` carries a default
  // (`recordings_v2`), so a bucket clause could never be false — and a
  // conjunct that cannot fail is not a stricter check, it is a decorative one
  // that makes the guard read stronger than it is. The three credentials below
  // have no defaults and are the whole question.
  return (
    env.recordingEgressS3Endpoint !== undefined
    && env.recordingEgressS3Endpoint !== ''
    && env.recordingEgressS3AccessKeyId !== undefined
    && env.recordingEgressS3AccessKeyId !== ''
    && env.recordingEgressS3SecretAccessKey !== undefined
    && env.recordingEgressS3SecretAccessKey !== ''
  );
}

/**
 * Build the output descriptor for one attempt's recording.
 *
 * ASYNC, because the SDK is imported lazily and its enums cannot be read at
 * module load — several suites partially mock `livekit-server-sdk`, and a
 * top-level `EncodedFileType.MP3` would throw under one. This is the same
 * constraint that keeps `recording-egress.ts`'s `terminalEgressStatuses()` a
 * function rather than a const.
 *
 * `disableManifest` is left FALSE — the manifest is WANTED. It is a second
 * object with its own `.json` suffix, and 0043 stores its key alongside the
 * recording's precisely so a purge deletes both. Suppressing it would make the
 * manifest column dead weight; forgetting it in the purge is the documented
 * trap this lane has already hit once.
 */
export async function createPhoneEgressOutput(objectKey: string): Promise<unknown> {
  const { EncodedFileOutput, EncodedFileType, S3Upload } = await import('livekit-server-sdk');
  return new EncodedFileOutput({
    fileType: EncodedFileType.MP3,
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
}

/** Lazily-constructed `EgressClient`, narrowed to the two methods used. */
export async function createPhoneEgressClient(): Promise<{
  startRoomCompositeEgress(
    roomName: string,
    output: unknown,
    options?: { audioOnly?: boolean; videoOnly?: boolean },
  ): Promise<{ egressId?: string; startedAt?: bigint | null }>;
  stopEgress(egressId: string): Promise<unknown>;
}> {
  const { EgressClient } = await import('livekit-server-sdk');
  const client = new EgressClient(env.livekitUrl, env.livekitApiKey, env.livekitApiSecret);
  return client as unknown as {
    startRoomCompositeEgress(
      roomName: string,
      output: unknown,
      options?: { audioOnly?: boolean; videoOnly?: boolean },
    ): Promise<{ egressId?: string; startedAt?: bigint | null }>;
    stopEgress(egressId: string): Promise<unknown>;
  };
}
