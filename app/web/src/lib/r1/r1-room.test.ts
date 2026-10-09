import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

interface FakeRoomShape {
  options: unknown;
  handlers: Map<string, Handler>;
  remoteParticipants: Map<string, unknown>;
  localParticipant: { publishTrack: ReturnType<typeof vi.fn> };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

const { rooms } = vi.hoisted(() => ({ rooms: [] as unknown[] }));

vi.mock('livekit-client', () => {
  class FakeRoom {
    options: unknown;
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map<string, unknown>();
    localParticipant = { publishTrack: vi.fn().mockResolvedValue(undefined) };
    connect = vi.fn().mockResolvedValue(undefined);
    // Like a real room, leaving reports Disconnected, and it may do so
    // synchronously: the controller must have claimed the ending already.
    disconnect = vi.fn(async () => {
      this.emit('disconnected');
    });
    removeAllListeners = vi.fn();
    constructor(options: unknown) {
      this.options = options;
      rooms.push(this);
    }
    on(event: string, handler: Handler) {
      this.handlers.set(event, handler);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      this.handlers.get(event)?.(...args);
    }
  }
  return {
    Room: FakeRoom,
    RoomEvent: {
      TrackSubscribed: 'trackSubscribed',
      ActiveSpeakersChanged: 'activeSpeakersChanged',
      TranscriptionReceived: 'transcriptionReceived',
      ParticipantConnected: 'participantConnected',
      ParticipantDisconnected: 'participantDisconnected',
      ParticipantAttributesChanged: 'participantAttributesChanged',
      Disconnected: 'disconnected',
    },
    DisconnectReason: { CLIENT_INITIATED: 1, ROOM_DELETED: 5, SIGNAL_CLOSE: 9 },
    Track: { Kind: { Audio: 'audio', Video: 'video' } },
    TrackEvent: { Muted: 'muted', Unmuted: 'unmuted', Ended: 'ended' },
    ParticipantKind: { STANDARD: 0, AGENT: 4 },
  };
});

import { R1_ROOM_OPTIONS, R1_VIDEO_PUBLISH_OPTIONS, type R1LocalMedia } from './r1-media';
import { createR1Room, type R1RoomHandlers } from './r1-room';

const ROOM_DELETED = 5;
const SIGNAL_CLOSE = 9;

const AGENT = { kind: 4, audioLevel: 0.4, attributes: { phase: 'icebreaker' } };
const CANDIDATE = { kind: 0, audioLevel: 0.9, attributes: { phase: 'ended' } };

function currentRoom(): FakeRoomShape {
  return rooms[rooms.length - 1] as FakeRoomShape;
}

function fakeTrack(kind: 'audio' | 'video') {
  const trackHandlers = new Map<string, Handler>();
  const track = {
    kind,
    isMuted: false,
    mediaStreamTrack: { readyState: 'live' },
    stop: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      trackHandlers.set(event, handler);
    }),
    mute: vi.fn(async () => {
      track.isMuted = true;
    }),
    unmute: vi.fn(async () => {
      track.isMuted = false;
    }),
    fire: (event: string) => trackHandlers.get(event)?.(),
  };
  return track;
}

function setup() {
  const audio = fakeTrack('audio');
  const video = fakeTrack('video');
  const media = { audio, video } as unknown as R1LocalMedia;
  const handlers: R1RoomHandlers = {
    onPhase: vi.fn(),
    onLeadName: vi.fn(),
    onRoleplayLeft: vi.fn(),
    onAwaitingReady: vi.fn(),
    onAgentPresent: vi.fn(),
    onAgentLevel: vi.fn(),
    onCaptions: vi.fn(),
    onCameraOn: vi.fn(),
    onEnded: vi.fn(),
  };
  const audioElement = document.createElement('audio');
  const controller = createR1Room(handlers, () => audioElement);
  return { audio, video, media, handlers, controller, audioElement };
}

beforeEach(() => {
  rooms.length = 0;
});

describe('connect and publish', () => {
  it('uses the R1 room options, then publishes the microphone and the camera', async () => {
    const { controller, media, audio, video } = setup();
    await controller.connect('wss://livekit.invalid', 'room-token', media);
    const room = currentRoom();
    expect(room.options).toEqual(R1_ROOM_OPTIONS);
    expect(room.connect).toHaveBeenCalledWith('wss://livekit.invalid', 'room-token');
    const calls = room.localParticipant.publishTrack.mock.calls;
    expect(calls[0]).toEqual([audio]);
    expect(calls[1]).toEqual([video, R1_VIDEO_PUBLISH_OPTIONS]);
    expect(calls[1][1]).toMatchObject({ simulcast: false });
  });

  it('reads the phase the agent already published before the page connected', async () => {
    const { controller, media, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', media);
    currentRoom().remoteParticipants.set('agent', AGENT);
    await connecting;
    expect(handlers.onPhase).toHaveBeenCalledWith('icebreaker');
  });

  it('does not take a phase from a participant that is not the agent', async () => {
    const { controller, media, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', media);
    currentRoom().remoteParticipants.set('other', CANDIDATE);
    await connecting;
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });
});

describe('following the interviewer', () => {
  it('follows phase attribute changes from the agent only', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantAttributesChanged', { phase: 'roleplay' }, {
      kind: 4,
      attributes: { phase: 'roleplay' },
    });
    expect(handlers.onPhase).toHaveBeenLastCalledWith('roleplay');

    room.emit('participantAttributesChanged', { phase: 'wrapup' }, {
      kind: 0,
      attributes: { phase: 'wrapup' },
    });
    expect(handlers.onPhase).toHaveBeenCalledTimes(1);
  });

  it('ignores attribute changes that do not touch the phase key', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('participantAttributesChanged', { mood: 'calm' }, {
      kind: 4,
      attributes: { phase: 'roleplay', mood: 'calm' },
    });
    expect(handlers.onPhase).not.toHaveBeenCalled();
  });

  it('ignores a phase value outside the vocabulary', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('participantAttributesChanged', { phase: 'jailbreak' }, {
      kind: 4,
      attributes: { phase: 'jailbreak' },
    });
    expect(handlers.onPhase).not.toHaveBeenCalled();
  });

  it('takes the phase of an agent that joins after the candidate', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('participantConnected', { kind: 4, attributes: { phase: 'opening' } });
    expect(handlers.onPhase).toHaveBeenCalledWith('opening');
  });

  it('reports speaker level for the agent only and clamps it', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('activeSpeakersChanged', [CANDIDATE, { kind: 4, audioLevel: 7 }]);
    expect(handlers.onAgentLevel).toHaveBeenLastCalledWith(1);
    room.emit('activeSpeakersChanged', [CANDIDATE]);
    expect(handlers.onAgentLevel).toHaveBeenLastCalledWith(0);
    room.emit('activeSpeakersChanged', [{ kind: 4, audioLevel: Number.NaN }]);
    expect(handlers.onAgentLevel).toHaveBeenLastCalledWith(0);
  });

  it('forwards agent captions with the phase that was current, never the candidate', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantAttributesChanged', { phase: 'roleplay' }, {
      kind: 4,
      attributes: { phase: 'roleplay' },
    });
    const segments = [{ id: 's1', text: 'Hello?', final: false, language: 'en' }];
    room.emit('transcriptionReceived', segments, { kind: 4 });
    expect(handlers.onCaptions).toHaveBeenCalledWith(
      [{ id: 's1', text: 'Hello?', final: false }],
      'roleplay',
    );
    room.emit('transcriptionReceived', segments, { kind: 0 });
    room.emit('transcriptionReceived', segments, undefined);
    expect(handlers.onCaptions).toHaveBeenCalledTimes(1);
  });

  it('plays only the agent audio', async () => {
    const { controller, media, audioElement } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    const attach = vi.fn();
    room.emit('trackSubscribed', { kind: 'audio', attach }, {}, { kind: 0 });
    expect(attach).not.toHaveBeenCalled();
    room.emit('trackSubscribed', { kind: 'video', attach }, {}, { kind: 4 });
    expect(attach).not.toHaveBeenCalled();
    room.emit('trackSubscribed', { kind: 'audio', attach }, {}, { kind: 4 });
    expect(attach).toHaveBeenCalledWith(audioElement);
  });
});

describe('what else the interviewer publishes', () => {
  const FULL_BRIEFING = {
    phase: 'transition',
    leadname: 'Meera Iyer',
    rpleft: '840',
    awaiting: 'ready',
  };

  it('reports the name, the clock and the wait that came with the phase, phase first', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const order: string[] = [];
    vi.mocked(handlers.onPhase).mockImplementation(() => void order.push('phase'));
    vi.mocked(handlers.onLeadName).mockImplementation(() => void order.push('name'));
    vi.mocked(handlers.onRoleplayLeft).mockImplementation(() => void order.push('clock'));
    vi.mocked(handlers.onAwaitingReady).mockImplementation(() => void order.push('awaiting'));
    currentRoom().emit('participantAttributesChanged', FULL_BRIEFING, {
      kind: 4,
      attributes: FULL_BRIEFING,
    });
    expect(handlers.onPhase).toHaveBeenCalledWith('transition');
    expect(handlers.onLeadName).toHaveBeenCalledWith('Meera Iyer');
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(840);
    expect(handlers.onAwaitingReady).toHaveBeenCalledWith(true);
    // The page must freeze the clock for the OLD phase before it takes the new number.
    expect(order).toEqual(['phase', 'name', 'clock', 'awaiting']);
  });

  it('reacts to an attribute change that does not touch the phase', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const attributes = { phase: 'roleplay', rpleft: '810' };
    currentRoom().emit('participantAttributesChanged', { rpleft: '810' }, { kind: 4, attributes });
    expect(handlers.onRoleplayLeft).toHaveBeenCalledTimes(1);
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(810);
    // Only what moved is reported: re-reporting the phase or the rest would restart a clock.
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onAwaitingReady).not.toHaveBeenCalled();
  });

  it('reports a cleared attribute as gone', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    // The server drops an attribute set to the empty string: it is in `changed`, not in the snapshot.
    currentRoom().emit('participantAttributesChanged', { awaiting: '', rpleft: '' }, {
      kind: 4,
      attributes: { phase: 'roleplay', leadname: 'Meera Iyer' },
    });
    expect(handlers.onAwaitingReady).toHaveBeenCalledWith(false);
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(null);
    expect(handlers.onLeadName).not.toHaveBeenCalled();
  });

  it('reports an invalid value as absent, never as the value', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const attributes = { leadname: '<script>', rpleft: '-5', awaiting: 'yes' };
    currentRoom().emit('participantAttributesChanged', attributes, { kind: 4, attributes });
    expect(handlers.onLeadName).toHaveBeenCalledWith(null);
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(null);
    expect(handlers.onAwaitingReady).toHaveBeenCalledWith(false);
  });

  it('takes none of it from a participant that is not the agent', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantAttributesChanged', FULL_BRIEFING, { kind: 0, attributes: FULL_BRIEFING });
    room.emit('participantConnected', { kind: 0, identity: 'intruder', attributes: FULL_BRIEFING });
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
    expect(handlers.onAwaitingReady).not.toHaveBeenCalled();
  });

  it('ignores attribute changes that touch none of the keys it reads', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('participantAttributesChanged', { mood: 'calm' }, {
      kind: 4,
      attributes: { ...FULL_BRIEFING, mood: 'calm' },
    });
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
    expect(handlers.onAwaitingReady).not.toHaveBeenCalled();
  });

  it('reads everything an agent already published when the page connects', async () => {
    const { controller, media, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', media);
    currentRoom().remoteParticipants.set('agent', {
      kind: 4,
      identity: 'agent',
      attributes: { phase: 'roleplay', leadname: 'Meera Iyer', rpleft: '300' },
    });
    await connecting;
    expect(handlers.onPhase).toHaveBeenCalledWith('roleplay');
    expect(handlers.onLeadName).toHaveBeenCalledWith('Meera Iyer');
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(300);
    expect(handlers.onAwaitingReady).toHaveBeenCalledWith(false);
  });

  it('reads everything from an agent that joins after the candidate', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('participantConnected', {
      kind: 4,
      identity: 'agent',
      attributes: FULL_BRIEFING,
    });
    expect(handlers.onLeadName).toHaveBeenCalledWith('Meera Iyer');
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(840);
    expect(handlers.onAwaitingReady).toHaveBeenCalledWith(true);
  });

  it('reports nothing once the interview has ended, and nothing after phase=ended', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    const ending = { phase: 'ended', leadname: 'Meera Iyer', awaiting: 'ready' };
    room.emit('participantAttributesChanged', ending, { kind: 4, attributes: ending });
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onAwaitingReady).not.toHaveBeenCalled();
    room.emit('participantAttributesChanged', FULL_BRIEFING, { kind: 4, attributes: FULL_BRIEFING });
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
  });
});

describe('ending is exactly once', () => {
  it('leaves the room itself when the agent sets phase=ended', async () => {
    const { controller, media, handlers, audio, video } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantAttributesChanged', { phase: 'ended' }, {
      kind: 4,
      attributes: { phase: 'ended' },
    });
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(handlers.onPhase).toHaveBeenLastCalledWith('ended');
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');

    // The room deletion that follows must not read as a dropped connection.
    room.emit('disconnected');
    room.emit('participantAttributesChanged', { phase: 'roleplay' }, {
      kind: 4,
      attributes: { phase: 'roleplay' },
    });
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onPhase).toHaveBeenCalledTimes(1);
  });

  it('does not end for a candidate who sets phase=ended on themselves', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantAttributesChanged', { phase: 'ended' }, CANDIDATE);
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });

  it('reports an unexpected disconnect once', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('disconnected');
    room.emit('disconnected');
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
  });

  it('leave disconnects, stops the tracks and reports left once', async () => {
    const { controller, media, handlers, audio, video } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    await controller.leave();
    await controller.leave();
    room.emit('disconnected');
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('left');
  });

  it('dispose tears down without reporting anything', async () => {
    const { controller, media, handlers, audio } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    controller.dispose();
    room.emit('disconnected');
    expect(room.removeAllListeners).toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalled();
    expect(audio.stop).toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });
});

describe('camera and microphone controls', () => {
  it('mutes and unmutes the microphone and returns the resulting state', async () => {
    const { controller, media, audio } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    expect(await controller.setMicMuted(true)).toBe(true);
    expect(audio.mute).toHaveBeenCalledTimes(1);
    expect(await controller.setMicMuted(false)).toBe(false);
    expect(audio.unmute).toHaveBeenCalledTimes(1);
  });

  it('turns the camera off and on, and reports it', async () => {
    const { controller, media, video } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    expect(await controller.setCameraOn(false)).toBe(false);
    expect(video.mute).toHaveBeenCalledTimes(1);
    expect(await controller.setCameraOn(true)).toBe(true);
  });

  it('reports the camera as off when the track mutes or the device disappears', async () => {
    const { controller, media, handlers, video } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    expect(handlers.onCameraOn).toHaveBeenLastCalledWith(true);
    video.isMuted = true;
    video.fire('muted');
    expect(handlers.onCameraOn).toHaveBeenLastCalledWith(false);
    video.isMuted = false;
    video.fire('unmuted');
    expect(handlers.onCameraOn).toHaveBeenLastCalledWith(true);
    video.mediaStreamTrack.readyState = 'ended';
    video.fire('ended');
    expect(handlers.onCameraOn).toHaveBeenLastCalledWith(false);
  });
});

describe('agent presence', () => {
  const agent = (identity: string, attributes: Record<string, string> = {}) => ({
    kind: 4,
    identity,
    attributes,
  });

  it('reports the interviewer present even though it has published no phase', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('participantConnected', agent('interviewer'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentPresent).toHaveBeenLastCalledWith(true);
    expect(handlers.onPhase).not.toHaveBeenCalled();
  });

  it('finds an interviewer who was already in the room when the candidate connected', async () => {
    const { controller, media, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', media);
    currentRoom().remoteParticipants.set('interviewer', agent('interviewer'));
    await connecting;
    expect(handlers.onAgentPresent).toHaveBeenCalledWith(true);
    expect(handlers.onPhase).not.toHaveBeenCalled();
  });

  it('never counts a participant that is not an agent', async () => {
    const { controller, media, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', media);
    currentRoom().remoteParticipants.set('other', { kind: 0, identity: 'other', attributes: {} });
    await connecting;
    currentRoom().emit('participantConnected', { kind: 0, identity: 'intruder', attributes: {} });
    currentRoom().emit('participantConnected', { kind: 3, identity: 'sip', attributes: {} });
    expect(handlers.onAgentPresent).not.toHaveBeenCalled();
  });

  it('reports on change only, counting a reconnecting agent once', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantConnected', agent('a'));
    room.emit('participantConnected', agent('a'));
    room.emit('participantConnected', agent('b'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);

    room.emit('participantDisconnected', agent('a'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
    room.emit('participantDisconnected', agent('b'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(2);
    expect(handlers.onAgentPresent).toHaveBeenLastCalledWith(false);
  });

  it('ignores the departure of someone who is not an agent', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantConnected', agent('a'));
    room.emit('participantDisconnected', { kind: 0, identity: 'a' });
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
  });

  it('reports nothing once the interview has ended', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    room.emit('participantConnected', agent('a'));
    room.emit('disconnected', SIGNAL_CLOSE);
    room.emit('participantDisconnected', agent('a'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
  });
});

describe('what the ending tells the candidate', () => {
  const announce = (room: FakeRoomShape, value: string) =>
    room.emit('participantAttributesChanged', { phase: value }, {
      kind: 4,
      attributes: { phase: value },
    });

  it('reports a technical abort when the worker went aborted and then ended', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    announce(room, 'roleplay');
    announce(room, 'aborted');
    announce(room, 'ended');
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('aborted');
  });

  it('still reports the abort if the ended attribute never arrives and the room goes', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    announce(room, 'aborted');
    room.emit('disconnected', ROOM_DELETED);
    expect(handlers.onEnded).toHaveBeenCalledWith('aborted');
  });

  it('reports an abort for any disconnect cause once the worker announced it', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    announce(room, 'aborted');
    room.emit('disconnected', SIGNAL_CLOSE);
    expect(handlers.onEnded).toHaveBeenCalledWith('aborted');
  });

  it.each(['closing', 'finishing'])(
    'treats a deleted room as a finished interview once the agent reached %s',
    async (last) => {
      const { controller, media, handlers } = setup();
      await controller.connect('wss://x.invalid', 't', media);
      const room = currentRoom();
      announce(room, 'wrapup');
      announce(room, last);
      room.emit('disconnected', ROOM_DELETED);
      expect(handlers.onEnded).toHaveBeenCalledTimes(1);
      expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
    },
  );

  it.each(['icebreaker', 'roleplay', 'wrapup'])(
    'still reads a deleted room during %s as a lost connection',
    async (last) => {
      const { controller, media, handlers } = setup();
      await controller.connect('wss://x.invalid', 't', media);
      const room = currentRoom();
      announce(room, last);
      room.emit('disconnected', ROOM_DELETED);
      expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
    },
  );

  it('does not read a network loss during closing as a finished interview', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    announce(room, 'closing');
    room.emit('disconnected', SIGNAL_CLOSE);
    expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
  });

  it('reads a deleted room before any phase was announced as a lost connection', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    currentRoom().emit('disconnected', ROOM_DELETED);
    expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
  });

  it('keeps a plain ended as a finished interview', async () => {
    const { controller, media, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', media);
    const room = currentRoom();
    announce(room, 'finishing');
    announce(room, 'ended');
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
  });
});
