import { describe, expect, it, vi } from 'vitest';
import {
  publishR1Media,
  R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS,
  R1_ROOM_OPTIONS,
  R1_VIDEO_FPS,
  R1_VIDEO_HEIGHT,
  R1_VIDEO_MAX_BITRATE,
  R1_VIDEO_PUBLISH_OPTIONS,
  R1_VIDEO_WIDTH,
  r1AudioCaptureOptions,
  r1VideoCaptureOptions,
  stopR1Media,
  type R1LocalMedia,
} from './r1-media';

function fakeMedia(): R1LocalMedia & { audio: { stop: ReturnType<typeof vi.fn> } } {
  return {
    audio: { kind: 'audio', stop: vi.fn() },
    video: { kind: 'video', stop: vi.fn() },
  } as unknown as R1LocalMedia & { audio: { stop: ReturnType<typeof vi.fn> } };
}

describe('R1 camera budget (plan section 7.10)', () => {
  it('is 640x360 at 15 fps, 500 kbps, simulcast off', () => {
    expect([R1_VIDEO_WIDTH, R1_VIDEO_HEIGHT, R1_VIDEO_FPS]).toEqual([640, 360, 15]);
    expect(R1_VIDEO_MAX_BITRATE).toBe(500_000);
    expect(R1_VIDEO_PUBLISH_OPTIONS).toEqual({
      simulcast: false,
      videoEncoding: { maxBitrate: 500_000, maxFramerate: 15 },
    });
  });

  it('captures at the published resolution and frame rate', () => {
    expect(r1VideoCaptureOptions().resolution).toEqual({
      width: 640,
      height: 360,
      frameRate: 15,
    });
    expect(r1VideoCaptureOptions().facingMode).toBe('user');
  });

  it('pins a chosen camera by exact device id', () => {
    const options = r1VideoCaptureOptions('cam-2');
    expect(options.deviceId).toEqual({ exact: 'cam-2' });
    expect(options.resolution).toEqual({ width: 640, height: 360, frameRate: 15 });
    expect(options.facingMode).toBeUndefined();
  });

  it('captures speech-friendly audio and pins a chosen microphone', () => {
    expect(r1AudioCaptureOptions()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(r1AudioCaptureOptions('mic-1').deviceId).toEqual({ exact: 'mic-1' });
  });

  it('repeats the budget in the room defaults and skips video subscriber tuning', () => {
    expect(R1_ROOM_OPTIONS.publishDefaults).toEqual(R1_VIDEO_PUBLISH_OPTIONS);
    expect(R1_ROOM_OPTIONS.adaptiveStream).toBe(false);
    expect(R1_ROOM_OPTIONS.dynacast).toBe(false);
  });
});

describe('publishing', () => {
  it('publishes the microphone, then the camera under the budget', async () => {
    const media = fakeMedia();
    const publishTrack = vi.fn().mockResolvedValue(undefined);
    await publishR1Media({ localParticipant: { publishTrack } }, media);
    expect(publishTrack).toHaveBeenCalledTimes(2);
    expect(publishTrack.mock.calls[0]).toEqual([media.audio]);
    expect(publishTrack.mock.calls[1]).toEqual([media.video, R1_VIDEO_PUBLISH_OPTIONS]);
    const options = publishTrack.mock.calls[1][1];
    expect(options.simulcast).toBe(false);
    expect(options.videoEncoding.maxBitrate).toBe(500_000);
  });

  it('leaves the live audio publish on the SDK defaults', async () => {
    const publishTrack = vi.fn().mockResolvedValue(undefined);
    await publishR1Media({ localParticipant: { publishTrack } }, fakeMedia());
    // One argument, not `(track, undefined)`: nothing about the live audio is overridden.
    expect(publishTrack.mock.calls[0]).toHaveLength(1);
  });

  it('publishes the device-check microphone with DTX off, and the camera unchanged', async () => {
    expect(R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS).toEqual({ dtx: false });
    const media = fakeMedia();
    const publishTrack = vi.fn().mockResolvedValue(undefined);
    await publishR1Media(
      { localParticipant: { publishTrack } },
      media,
      R1_PREFLIGHT_AUDIO_PUBLISH_OPTIONS,
    );
    expect(publishTrack.mock.calls[0]).toEqual([media.audio, { dtx: false }]);
    expect(publishTrack.mock.calls[1]).toEqual([media.video, R1_VIDEO_PUBLISH_OPTIONS]);
  });

  it('stops whatever tracks exist and tolerates none', () => {
    const media = fakeMedia();
    stopR1Media(media);
    expect(media.audio.stop).toHaveBeenCalledTimes(1);
    expect((media.video as unknown as { stop: ReturnType<typeof vi.fn> }).stop).toHaveBeenCalled();
    expect(() => stopR1Media(null)).not.toThrow();
    expect(() => stopR1Media({})).not.toThrow();
  });
});
