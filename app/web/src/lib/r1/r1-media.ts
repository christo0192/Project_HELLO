/**
 * Capture and publish settings for the R1 candidate (plan section 7.10).
 *
 * The camera is published at 640x360, 15 fps, with simulcast OFF and the
 * encoder capped at 500 kbps. The worker is the only video subscriber and
 * records a single stream, so extra layers would only spend the candidate's
 * uplink. These values are the budget the plan's data-transfer arithmetic
 * (section 3.4) is built on; they are constants, not options, and the same
 * constants drive the preflight capture and the live publish so the device
 * check tests exactly what the interview will send.
 *
 * This module imports livekit-client for TYPES only, so it has no runtime
 * dependency on the SDK and is trivially testable.
 */

import type {
  AudioCaptureOptions,
  LocalAudioTrack,
  LocalVideoTrack,
  RoomOptions,
  TrackPublishOptions,
  VideoCaptureOptions,
} from 'livekit-client';

export const R1_VIDEO_WIDTH = 640;
export const R1_VIDEO_HEIGHT = 360;
export const R1_VIDEO_FPS = 15;
export const R1_VIDEO_MAX_BITRATE = 500_000;

export function r1VideoCaptureOptions(deviceId?: string): VideoCaptureOptions {
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' as const }),
    resolution: { width: R1_VIDEO_WIDTH, height: R1_VIDEO_HEIGHT, frameRate: R1_VIDEO_FPS },
  };
}

export function r1AudioCaptureOptions(deviceId?: string): AudioCaptureOptions {
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
  };
}

export const R1_VIDEO_PUBLISH_OPTIONS: TrackPublishOptions = {
  simulcast: false,
  videoEncoding: { maxBitrate: R1_VIDEO_MAX_BITRATE, maxFramerate: R1_VIDEO_FPS },
};

/**
 * Room options for every R1 connection. The candidate subscribes only to the
 * interviewer's audio, so adaptive streaming and dynacast (both video
 * subscriber optimisations) are off and the publish defaults repeat the
 * camera budget in case any track is published without explicit options.
 */
export const R1_ROOM_OPTIONS: RoomOptions = {
  adaptiveStream: false,
  dynacast: false,
  publishDefaults: R1_VIDEO_PUBLISH_OPTIONS,
};

export interface R1LocalMedia {
  audio: LocalAudioTrack;
  video: LocalVideoTrack;
}

/** The surface of a connected room that publishing needs. */
export interface TrackPublisher {
  localParticipant: {
    publishTrack: (
      track: LocalAudioTrack | LocalVideoTrack,
      options?: TrackPublishOptions,
    ) => Promise<unknown>;
  };
}

/**
 * Audio publish options for the device check ONLY. The SDK enables Opus DTX by
 * default (livekit-client `publishDefaults.dtx`), so a candidate who is quiet
 * after the microphone check sends about 2.5 packets a second and would never
 * reach the 50-packet threshold. The check turns DTX off so it measures the
 * uplink and not how much the candidate happens to say; the live interview's
 * publish is deliberately unchanged.
 */
export const R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS: TrackPublishOptions = { dtx: false };

/**
 * Publish the microphone, then the camera under the R1 budget. `audioOptions`
 * is passed only by the device check (see above); the live publish omits it.
 */
export async function publishR1Media(
  room: TrackPublisher,
  media: R1LocalMedia,
  audioOptions?: TrackPublishOptions,
): Promise<void> {
  if (audioOptions) await room.localParticipant.publishTrack(media.audio, audioOptions);
  else await room.localParticipant.publishTrack(media.audio);
  await room.localParticipant.publishTrack(media.video, R1_VIDEO_PUBLISH_OPTIONS);
}

export function stopR1Media(media: Partial<R1LocalMedia> | null | undefined): void {
  media?.audio?.stop();
  media?.video?.stop();
}
