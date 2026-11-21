import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (...args: unknown[]) => void;

interface FakeRoomShape {
  options: unknown;
  handlers: Map<string, Handler>;
  remoteParticipants: Map<string, unknown>;
  localParticipant: {
    publishTrack: ReturnType<typeof vi.fn>;
    publishData: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setMetadata: ReturnType<typeof vi.fn>;
    setMicrophoneEnabled: ReturnType<typeof vi.fn>;
    setCameraEnabled: ReturnType<typeof vi.fn>;
  };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  startAudio: ReturnType<typeof vi.fn> | undefined;
  removeAllListeners: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => void;
}

interface FakeConfig {
  /** What each new room's `startAudio` does; undefined builds a room without the method. */
  startAudio: (() => unknown) | undefined;
  /** When set, `room.connect` waits for this promise. */
  connectGate: Promise<void> | null;
}

const { rooms, config, createLocalAudioTrack } = vi.hoisted(() => ({
  rooms: [] as unknown[],
  config: { startAudio: undefined, connectGate: null } as FakeConfig,
  createLocalAudioTrack: vi.fn(),
}));

vi.mock('livekit-client', () => {
  class FakeRoom {
    options: unknown;
    handlers = new Map<string, Handler>();
    remoteParticipants = new Map<string, unknown>();
    localParticipant = {
      publishTrack: vi.fn().mockResolvedValue(undefined),
      // Present so a test can prove the bridge never reaches for them.
      publishData: vi.fn(),
      setAttributes: vi.fn(),
      setMetadata: vi.fn(),
      setMicrophoneEnabled: vi.fn(),
      setCameraEnabled: vi.fn(),
    };
    connect = vi.fn(async () => {
      if (config.connectGate) await config.connectGate;
    });
    // Like a real room, leaving reports Disconnected, and it may do so
    // synchronously: the controller must have claimed the ending already.
    disconnect = vi.fn(async () => {
      this.emit('disconnected');
    });
    startAudio = config.startAudio ? vi.fn(config.startAudio) : undefined;
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
    Track: {
      Kind: { Audio: 'audio', Video: 'video' },
      Source: { Camera: 'camera', Microphone: 'microphone' },
    },
    TrackEvent: { Muted: 'muted', Unmuted: 'unmuted', Ended: 'ended' },
    ParticipantKind: { STANDARD: 0, AGENT: 4 },
    createLocalAudioTrack,
  };
});

import type { LocalAudioTrack } from 'livekit-client';
import { R1_ROOM_OPTIONS } from './r1-media';
import {
  captureMeetAudio,
  createR1MeetRoom,
  R1_MEET_AUDIO_CAPTURE_OPTIONS,
  R1_MEET_AUDIO_PUBLISH_OPTIONS,
  type R1MeetRoomHandlers,
} from './r1-meet-room';

const ROOM_DELETED = 5;
const SIGNAL_CLOSE = 9;

const AGENT = { kind: 4, identity: 'agent', attributes: { phase: 'icebreaker' } };
const CANDIDATE = { kind: 0, identity: 'someone-else', attributes: { phase: 'ended' } };

function currentRoom(): FakeRoomShape {
  return rooms[rooms.length - 1] as FakeRoomShape;
}

function fakeAudioTrack() {
  return { kind: 'audio', stop: vi.fn() };
}

function setup(options: { element?: boolean } = {}) {
  const track = fakeAudioTrack();
  const audio = track as unknown as LocalAudioTrack;
  const handlers: R1MeetRoomHandlers = {
    onPhase: vi.fn(),
    onLeadName: vi.fn(),
    onRoleplayLeft: vi.fn(),
    onAgentPresent: vi.fn(),
    onEnded: vi.fn(),
  };
  const audioElement = document.createElement('audio');
  const controller = createR1MeetRoom(handlers, () =>
    options.element === false ? null : audioElement,
  );
  return { track, audio, handlers, controller, audioElement };
}

function announce(room: FakeRoomShape, value: string) {
  room.emit('participantAttributesChanged', { phase: value }, {
    kind: 4,
    identity: 'agent',
    attributes: { phase: value },
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  rooms.length = 0;
  config.startAudio = () => Promise.resolve();
  config.connectGate = null;
  createLocalAudioTrack.mockReset();
});

describe('capturing the meeting audio', () => {
  it('pins the capture options: echo cancellation on, no second noise or gain pass', () => {
    expect(R1_MEET_AUDIO_CAPTURE_OPTIONS).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('captures with exactly those options and returns the track', async () => {
    const track = fakeAudioTrack();
    createLocalAudioTrack.mockResolvedValue(track);
    await expect(captureMeetAudio()).resolves.toBe(track);
    expect(createLocalAudioTrack).toHaveBeenCalledTimes(1);
    expect(createLocalAudioTrack.mock.calls[0]).toEqual([R1_MEET_AUDIO_CAPTURE_OPTIONS]);
    expect(createLocalAudioTrack.mock.calls[0][0]).toEqual({
      echoCancellation: true,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('lets a capture failure reach the page', async () => {
    createLocalAudioTrack.mockRejectedValue(new Error('NotAllowedError'));
    await expect(captureMeetAudio()).rejects.toThrow('NotAllowedError');
  });
});

describe('connect and publish', () => {
  it('pins the publish options: the microphone source with DTX off', () => {
    expect(R1_MEET_AUDIO_PUBLISH_OPTIONS).toEqual({ source: 'microphone', dtx: false });
  });

  it('uses the R1 room options and publishes the meeting audio once, as the microphone', async () => {
    const { controller, audio } = setup();
    await controller.connect('wss://livekit.invalid', 'room-token', audio);
    const room = currentRoom();
    expect(rooms).toHaveLength(1);
    expect(room.options).toEqual(R1_ROOM_OPTIONS);
    expect(room.connect).toHaveBeenCalledWith('wss://livekit.invalid', 'room-token');
    const calls = room.localParticipant.publishTrack.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([audio, { source: 'microphone', dtx: false }]);
  });

  it('never publishes data, attributes, metadata or a camera', async () => {
    const { controller, audio } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    announce(room, 'roleplay');
    announce(room, 'ended');
    const local = room.localParticipant;
    expect(local.publishData).not.toHaveBeenCalled();
    expect(local.setAttributes).not.toHaveBeenCalled();
    expect(local.setMetadata).not.toHaveBeenCalled();
    expect(local.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(local.setCameraEnabled).not.toHaveBeenCalled();
    expect(local.publishTrack).toHaveBeenCalledTimes(1);
  });

  it('offers only connect and dispose: no mute, no leave, no camera control', () => {
    const { controller } = setup();
    expect(Object.keys(controller).sort()).toEqual(['connect', 'dispose']);
  });

  it('asks the browser to start remote audio once, after publishing', async () => {
    const { controller, audio } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    expect(room.startAudio).toHaveBeenCalledTimes(1);
    const published = room.localParticipant.publishTrack.mock.invocationCallOrder[0];
    expect(room.startAudio!.mock.invocationCallOrder[0]).toBeGreaterThan(published);
  });

  it('does not fail the connect when starting audio is refused', async () => {
    config.startAudio = () => Promise.reject(new Error('NotAllowedError'));
    const { controller, audio, handlers } = setup();
    await expect(controller.connect('wss://x.invalid', 't', audio)).resolves.toBeUndefined();
    // Let the swallowed rejection settle: the setup fails the test on an unhandled one.
    await Promise.resolve();
    await Promise.resolve();
    expect(currentRoom().startAudio).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });

  it('does not fail the connect when starting audio throws at once', async () => {
    config.startAudio = () => {
      throw new Error('boom');
    };
    const { controller, audio } = setup();
    await expect(controller.connect('wss://x.invalid', 't', audio)).resolves.toBeUndefined();
    expect(currentRoom().startAudio).toHaveBeenCalledTimes(1);
  });

  it('connects on a room that has no startAudio', async () => {
    config.startAudio = undefined;
    const { controller, audio } = setup();
    await expect(controller.connect('wss://x.invalid', 't', audio)).resolves.toBeUndefined();
    expect(currentRoom().localParticipant.publishTrack).toHaveBeenCalledTimes(1);
  });

  it('lets a publish failure reach the page', async () => {
    const { controller, audio } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', audio);
    currentRoom().localParticipant.publishTrack.mockRejectedValueOnce(new Error('publish failed'));
    await expect(connecting).rejects.toThrow('publish failed');
  });

  it('reads everything an agent already published when the bridge connects', async () => {
    const { controller, audio, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', audio);
    currentRoom().remoteParticipants.set('agent', {
      kind: 4,
      identity: 'agent',
      attributes: { phase: 'roleplay', leadname: 'Meera Iyer', rpleft: '300' },
    });
    await connecting;
    expect(handlers.onAgentPresent).toHaveBeenCalledWith(true);
    expect(handlers.onPhase).toHaveBeenCalledWith('roleplay');
    expect(handlers.onLeadName).toHaveBeenCalledWith('Meera Iyer');
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(300);
  });

  it('does not take anything from a participant already present that is not the agent', async () => {
    const { controller, audio, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', audio);
    currentRoom().remoteParticipants.set('other', CANDIDATE);
    await connecting;
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onAgentPresent).not.toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });

  it('publishes nothing when disposed while connecting', async () => {
    const gate = deferred();
    config.connectGate = gate.promise;
    const { controller, audio, track, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', audio);
    controller.dispose();
    gate.resolve();
    await connecting;
    const room = currentRoom();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(room.startAudio).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });

  it('publishes nothing when the interview ended while connecting, and reports the end once', async () => {
    const gate = deferred();
    config.connectGate = gate.promise;
    const { controller, audio, track, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', audio);
    announce(currentRoom(), 'ended');
    gate.resolve();
    await connecting;
    expect(currentRoom().localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
  });
});

describe('the interviewer is the only one trusted', () => {
  const FULL_BRIEFING = { phase: 'transition', leadname: 'Meera Iyer', rpleft: '480' };

  it('reports the phase, the name and the clock from the agent, phase first', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const order: string[] = [];
    vi.mocked(handlers.onPhase).mockImplementation(() => void order.push('phase'));
    vi.mocked(handlers.onLeadName).mockImplementation(() => void order.push('name'));
    vi.mocked(handlers.onRoleplayLeft).mockImplementation(() => void order.push('clock'));
    currentRoom().emit('participantAttributesChanged', FULL_BRIEFING, {
      kind: 4,
      identity: 'agent',
      attributes: FULL_BRIEFING,
    });
    expect(handlers.onPhase).toHaveBeenCalledWith('transition');
    expect(handlers.onLeadName).toHaveBeenCalledWith('Meera Iyer');
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(480);
    expect(order).toEqual(['phase', 'name', 'clock']);
  });

  it('ignores a participant who is not the agent: no phase, no end, no name, no clock', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    const spoof = { phase: 'ended', leadname: 'Someone Else', rpleft: '5' };
    room.emit('participantAttributesChanged', spoof, { kind: 0, identity: 'x', attributes: spoof });
    room.emit('participantConnected', { kind: 0, identity: 'intruder', attributes: spoof });
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
    expect(room.disconnect).not.toHaveBeenCalled();
  });

  it('reports only what moved, so an unchanged clock is never restarted', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const attributes = { phase: 'roleplay', leadname: 'Meera Iyer', rpleft: '410' };
    currentRoom().emit('participantAttributesChanged', { rpleft: '410' }, {
      kind: 4,
      identity: 'agent',
      attributes,
    });
    expect(handlers.onRoleplayLeft).toHaveBeenCalledTimes(1);
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(410);
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
  });

  it('does not read the ready flag: the tile has no button', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    currentRoom().emit('participantAttributesChanged', { awaiting: 'ready' }, {
      kind: 4,
      identity: 'agent',
      attributes: { phase: 'transition', awaiting: 'ready' },
    });
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
  });

  it('ignores attribute changes that touch none of the keys it reads', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    currentRoom().emit('participantAttributesChanged', { mood: 'calm' }, {
      kind: 4,
      identity: 'agent',
      attributes: { ...FULL_BRIEFING, mood: 'calm' },
    });
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
  });

  it('reports an invalid value as absent and ignores a phase outside the vocabulary', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const attributes = { phase: 'jailbreak', leadname: '<script>', rpleft: '-5' };
    currentRoom().emit('participantAttributesChanged', attributes, {
      kind: 4,
      identity: 'agent',
      attributes,
    });
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onLeadName).toHaveBeenCalledWith(null);
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(null);
  });

  it('takes everything from an agent that joins after the bridge', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    currentRoom().emit('participantConnected', {
      kind: 4,
      identity: 'agent',
      attributes: FULL_BRIEFING,
    });
    expect(handlers.onAgentPresent).toHaveBeenCalledWith(true);
    expect(handlers.onPhase).toHaveBeenCalledWith('transition');
    expect(handlers.onLeadName).toHaveBeenCalledWith('Meera Iyer');
    expect(handlers.onRoleplayLeft).toHaveBeenCalledWith(480);
  });

  it('plays only the agent audio, never anyone else and never video', async () => {
    const { controller, audio, audioElement } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    const attach = vi.fn();
    room.emit('trackSubscribed', { kind: 'audio', attach }, {}, { kind: 0 });
    expect(attach).not.toHaveBeenCalled();
    room.emit('trackSubscribed', { kind: 'video', attach }, {}, { kind: 4 });
    expect(attach).not.toHaveBeenCalled();
    room.emit('trackSubscribed', { kind: 'audio', attach }, {}, { kind: 4 });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(audioElement);
  });

  it('attaches nothing while the page has no audio element', async () => {
    const { controller, audio } = setup({ element: false });
    await controller.connect('wss://x.invalid', 't', audio);
    const attach = vi.fn();
    currentRoom().emit('trackSubscribed', { kind: 'audio', attach }, {}, { kind: 4 });
    expect(attach).not.toHaveBeenCalled();
  });
});

describe('agent presence', () => {
  const agent = (identity: string, attributes: Record<string, string> = {}) => ({
    kind: 4,
    identity,
    attributes,
  });

  it('reports the interviewer present even though it has published no phase', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    currentRoom().emit('participantConnected', agent('interviewer'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
    expect(handlers.onAgentPresent).toHaveBeenLastCalledWith(true);
    expect(handlers.onPhase).not.toHaveBeenCalled();
  });

  it('never counts a participant that is not an agent', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    room.emit('participantConnected', { kind: 0, identity: 'intruder', attributes: {} });
    room.emit('participantConnected', { kind: 3, identity: 'sip', attributes: {} });
    expect(handlers.onAgentPresent).not.toHaveBeenCalled();
  });

  it('reports on change only, counting a rejoining agent once', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
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
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    room.emit('participantConnected', agent('a'));
    room.emit('participantDisconnected', { kind: 0, identity: 'a' });
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
  });

  it('reports nothing once the interview has ended', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    room.emit('participantConnected', agent('a'));
    room.emit('disconnected', SIGNAL_CLOSE);
    room.emit('participantDisconnected', agent('a'));
    expect(handlers.onAgentPresent).toHaveBeenCalledTimes(1);
  });
});

describe('ending is exactly once (parity with the browser room)', () => {
  it('leaves the room itself when the agent sets phase=ended, and stops the audio', async () => {
    const { controller, audio, track, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    announce(room, 'ended');
    // The fake's disconnect() emits Disconnected synchronously: it is not a second ending.
    expect(room.disconnect).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(handlers.onPhase).toHaveBeenLastCalledWith('ended');
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');

    // The room deletion that follows must not read as a dropped connection.
    room.emit('disconnected', ROOM_DELETED);
    announce(room, 'roleplay');
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onPhase).toHaveBeenCalledTimes(1);
  });

  it('reports nothing after phase=ended, not even what came with it', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const ending = { phase: 'ended', leadname: 'Meera Iyer', rpleft: '30' };
    currentRoom().emit('participantAttributesChanged', ending, {
      kind: 4,
      identity: 'agent',
      attributes: ending,
    });
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
  });

  it('does not end for a participant who sets phase=ended on themselves', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    room.emit('participantAttributesChanged', { phase: 'ended' }, CANDIDATE);
    expect(room.disconnect).not.toHaveBeenCalled();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });

  it('reports an unexpected disconnect once, as disconnected', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    room.emit('disconnected', SIGNAL_CLOSE);
    room.emit('disconnected', SIGNAL_CLOSE);
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
  });

  it('reports a technical abort when the worker went aborted and then ended', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    announce(room, 'roleplay');
    announce(room, 'aborted');
    announce(room, 'ended');
    expect(handlers.onEnded).toHaveBeenCalledTimes(1);
    expect(handlers.onEnded).toHaveBeenCalledWith('aborted');
  });

  it.each([ROOM_DELETED, SIGNAL_CLOSE])(
    'still reports the abort when the room goes (cause %s) without the ended attribute',
    async (cause) => {
      const { controller, audio, handlers } = setup();
      await controller.connect('wss://x.invalid', 't', audio);
      const room = currentRoom();
      announce(room, 'aborted');
      room.emit('disconnected', cause);
      expect(handlers.onEnded).toHaveBeenCalledTimes(1);
      expect(handlers.onEnded).toHaveBeenCalledWith('aborted');
    },
  );

  it.each(['closing', 'finishing'])(
    'treats a deleted room as a finished interview once the agent reached %s',
    async (last) => {
      const { controller, audio, handlers } = setup();
      await controller.connect('wss://x.invalid', 't', audio);
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
      const { controller, audio, handlers } = setup();
      await controller.connect('wss://x.invalid', 't', audio);
      const room = currentRoom();
      announce(room, last);
      room.emit('disconnected', ROOM_DELETED);
      expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
    },
  );

  it('does not read a network loss during closing as a finished interview', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    announce(room, 'closing');
    room.emit('disconnected', SIGNAL_CLOSE);
    expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
  });

  it('reads a deleted room before any phase was announced as a lost connection', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    currentRoom().emit('disconnected', ROOM_DELETED);
    expect(handlers.onEnded).toHaveBeenCalledWith('disconnected');
  });

  it('keeps a plain ended as a finished interview', async () => {
    const { controller, audio, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    announce(room, 'finishing');
    announce(room, 'ended');
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
  });

  it('takes the phase of an agent already present into the ending rules', async () => {
    const { controller, audio, handlers } = setup();
    const connecting = controller.connect('wss://x.invalid', 't', audio);
    currentRoom().remoteParticipants.set('agent', { ...AGENT, attributes: { phase: 'closing' } });
    await connecting;
    currentRoom().emit('disconnected', ROOM_DELETED);
    expect(handlers.onEnded).toHaveBeenCalledWith('agent_ended');
  });
});

describe('dispose', () => {
  it('tears down without reporting anything, then ignores every later event', async () => {
    const { controller, audio, track, handlers } = setup();
    await controller.connect('wss://x.invalid', 't', audio);
    const room = currentRoom();
    controller.dispose();
    expect(room.removeAllListeners).toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();

    // The fake keeps its listeners, so these reach the controller: it must stay silent.
    room.emit('disconnected', SIGNAL_CLOSE);
    room.emit('participantConnected', { kind: 4, identity: 'agent', attributes: { phase: 'roleplay' } });
    announce(room, 'ended');
    expect(handlers.onEnded).not.toHaveBeenCalled();
    expect(handlers.onPhase).not.toHaveBeenCalled();
    expect(handlers.onAgentPresent).not.toHaveBeenCalled();
    expect(handlers.onLeadName).not.toHaveBeenCalled();
    expect(handlers.onRoleplayLeft).not.toHaveBeenCalled();
  });

  it('is safe before any connect', () => {
    const { controller, handlers } = setup();
    expect(() => controller.dispose()).not.toThrow();
    expect(handlers.onEnded).not.toHaveBeenCalled();
  });
});
