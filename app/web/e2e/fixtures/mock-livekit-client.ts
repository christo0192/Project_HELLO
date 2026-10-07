/**
 * A scripted stand-in for `livekit-client`, aliased in by vite.e2e.config.ts.
 *
 * WHY MOCK THE SDK AND NOT THE NETWORK. A LiveKit room needs a signalling
 * WebSocket and a UDP media path, and the harness (rightly) blocks every
 * socket that is not its own. So the SDK's `Room` is replaced by a scripted
 * one the TEST drives through `window.__r1Mock`: it can make an interviewer
 * agent join, announce a phase, speak and caption, and it can end the room.
 *
 * WHAT STAYS REAL. Capture is not faked here. `createLocalVideoTrack` and
 * `createLocalAudioTrack` call the browser's own `getUserMedia` with the
 * constraints the SDK would build, and the harness launches Chromium with
 * `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`, so the
 * page receives genuine MediaStreamTracks from Chromium's synthetic camera and
 * microphone. The self-view plays a real video element.
 *
 * WHAT IS SYNTHETIC. Sender statistics (a real peer connection never exists)
 * are derived from the time a track has been published, at the frame rate the
 * capture settings report, and the level analyser reads a level the test sets.
 * Both are documented at their definitions below.
 *
 * Nothing here may import the app or any dependency: it is bundled into the
 * page by Vite and must be self-contained.
 */

export const ParticipantKind = { STANDARD: 0, INGRESS: 1, EGRESS: 2, SIP: 3, AGENT: 4 } as const;

export const RoomEvent = {
  TrackSubscribed: 'trackSubscribed',
  ActiveSpeakersChanged: 'activeSpeakersChanged',
  TranscriptionReceived: 'transcriptionReceived',
  ParticipantConnected: 'participantConnected',
  ParticipantDisconnected: 'participantDisconnected',
  ParticipantAttributesChanged: 'participantAttributesChanged',
  Reconnecting: 'reconnecting',
  Disconnected: 'disconnected',
} as const;

/** The subset of the SDK's DisconnectReason the page and the tests use (protocol values). */
export const DisconnectReason = { CLIENT_INITIATED: 1, ROOM_DELETED: 5, SIGNAL_CLOSE: 9 } as const;

export const Track = {
  Kind: { Audio: 'audio', Video: 'video' },
  Source: { Camera: 'camera', Microphone: 'microphone' },
} as const;

export const TrackEvent = { Muted: 'muted', Unmuted: 'unmuted', Ended: 'ended' } as const;

type Listener = (...args: unknown[]) => void;

class Emitter {
  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }

  removeAllListeners(): this {
    this.listeners.clear();
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** What the page asked of the browser, recorded for the test to assert on. */
export interface MediaRequest {
  kind: 'audio' | 'video';
  /** The SDK-level options the app passed to createLocalVideoTrack / createLocalAudioTrack. */
  options: Record<string, unknown>;
  /** The constraints this mock handed to the real getUserMedia. */
  constraints: MediaTrackConstraints;
  /** What the real (fake-device) track settled on. */
  settings: MediaTrackSettings;
}

export interface PublishRecord {
  roomIndex: number;
  kind: 'audio' | 'video';
  options: Record<string, unknown> | null;
}

export interface ConnectRecord {
  roomIndex: number;
  url: string;
  token: string;
}

export interface DisconnectRecord {
  roomIndex: number;
  stopTracks: boolean;
}

/** The test's remote control, published as `window.__r1Mock`. */
export interface R1MockControls {
  rooms: MockRoom[];
  /** Every local track the page captured, in creation order. */
  tracks: Array<{ kind: 'audio' | 'video'; mediaStreamTrack: MediaStreamTrack }>;
  mediaRequests: MediaRequest[];
  publishes: PublishRecord[];
  connects: ConnectRecord[];
  disconnects: DisconnectRecord[];
  /** The level `createAudioAnalyser` reports, 0..1. Set 0 to simulate a silent microphone. */
  micVolume: number;
  /** When set, the next `room.connect` rejects with this message. */
  failNextConnect: string | null;
  /** The newest room (the live one, once the interview is joined). */
  current(): MockRoom | null;
  /** The interviewer agent in the newest room, if it has joined. */
  agent(): MockParticipant | null;
  joinAgent(attributes?: Record<string, string>): void;
  setPhase(phase: string): void;
  speak(level: number): void;
  caption(id: string, text: string, final: boolean): void;
  /** A non-agent participant tries to drive the page (must be ignored). */
  intrude(attributes: Record<string, string>): void;
  /** The interviewer leaves the room (it stays in the room until this is called). */
  removeAgent(): void;
  /** The room goes away without the agent saying so, for `reason` (an SDK DisconnectReason). */
  drop(reason?: number): void;
}

declare global {
  interface Window {
    __r1Mock?: R1MockControls;
  }
}

export class MockParticipant extends Emitter {
  attributes: Record<string, string> = {};
  audioLevel = 0;
  constructor(
    public identity: string,
    public kind: number,
  ) {
    super();
  }
}

type SenderStat = { framesSent: number; frameWidth: number; frameHeight: number; framesPerSecond: number };

class MockLocalTrack extends Emitter {
  isMuted = false;
  publishedAt: number | null = null;
  /** The options of the latest publish, or null when published on the SDK defaults. */
  publishOptions: Record<string, unknown> | null = null;
  constructor(
    public kind: 'audio' | 'video',
    public mediaStreamTrack: MediaStreamTrack,
  ) {
    super();
    mediaStreamTrack.addEventListener('ended', () => this.emit(TrackEvent.Ended));
  }

  attach(element: HTMLMediaElement): HTMLMediaElement {
    element.srcObject = new MediaStream([this.mediaStreamTrack]);
    void element.play?.().catch(() => undefined);
    return element;
  }

  detach(element: HTMLMediaElement): HTMLMediaElement {
    if (element.srcObject) element.srcObject = null;
    return element;
  }

  stop(): void {
    this.mediaStreamTrack.stop();
  }

  async mute(): Promise<this> {
    this.isMuted = true;
    this.mediaStreamTrack.enabled = false;
    this.emit(TrackEvent.Muted);
    return this;
  }

  async unmute(): Promise<this> {
    this.isMuted = false;
    this.mediaStreamTrack.enabled = true;
    this.emit(TrackEvent.Unmuted);
    return this;
  }

  /** Seconds the track has been published (0 before the first publish). */
  protected publishedSeconds(): number {
    return this.publishedAt === null ? 0 : (performance.now() - this.publishedAt) / 1000;
  }
}

export class LocalAudioTrack extends MockLocalTrack {
  constructor(mediaStreamTrack: MediaStreamTrack) {
    super('audio', mediaStreamTrack);
  }

  /**
   * SYNTHETIC: one 20 ms Opus packet per 20 ms published (50 a second), unless the
   * SDK's default Opus DTX is on. DTX is on unless the publish says `dtx: false`, and a
   * quiet candidate under DTX sends only about 2.5 packets a second, which is why the
   * device check publishes with DTX off. Modelling it here makes the e2e fail if the
   * check stops doing so.
   */
  async getSenderStats(): Promise<{ packetsSent: number } | undefined> {
    if (this.publishedAt === null) return undefined;
    const packetsPerSecond = this.publishOptions?.dtx === false ? 50 : 2.5;
    return { packetsSent: Math.floor(this.publishedSeconds() * packetsPerSecond) };
  }
}

export class LocalVideoTrack extends MockLocalTrack {
  constructor(mediaStreamTrack: MediaStreamTrack) {
    super('video', mediaStreamTrack);
  }

  /** SYNTHETIC: frames at the frame rate the real capture settings report. */
  async getSenderStats(): Promise<SenderStat[]> {
    if (this.publishedAt === null) return [];
    const settings = this.mediaStreamTrack.getSettings();
    const fps = settings.frameRate ?? 15;
    return [
      {
        framesSent: Math.floor(this.publishedSeconds() * fps),
        frameWidth: settings.width ?? 0,
        frameHeight: settings.height ?? 0,
        framesPerSecond: fps,
      },
    ];
  }
}

export class MockRoom extends Emitter {
  state = 'disconnected';
  remoteParticipants = new Map<string, MockParticipant>();
  localParticipant: {
    identity: string;
    publishTrack: (track: MockLocalTrack, options?: Record<string, unknown>) => Promise<void>;
  };
  index: number;

  constructor(public options: Record<string, unknown> = {}) {
    super();
    const controls = ensureControls();
    this.index = controls.rooms.length;
    controls.rooms.push(this);
    this.localParticipant = {
      identity: 'candidate',
      publishTrack: async (track, options) => {
        track.publishedAt = performance.now();
        track.publishOptions = options ?? null;
        controls.publishes.push({ roomIndex: this.index, kind: track.kind, options: options ?? null });
      },
    };
  }

  async connect(url: string, token: string): Promise<void> {
    const controls = ensureControls();
    controls.connects.push({ roomIndex: this.index, url, token });
    if (controls.failNextConnect) {
      const message = controls.failNextConnect;
      controls.failNextConnect = null;
      throw new Error(message);
    }
    this.state = 'connected';
  }

  async disconnect(stopTracks = true): Promise<void> {
    ensureControls().disconnects.push({ roomIndex: this.index, stopTracks });
    if (this.state === 'disconnected') return;
    this.state = 'disconnected';
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  }
}

export const Room = MockRoom;

function ensureControls(): R1MockControls {
  if (window.__r1Mock) return window.__r1Mock;
  const controls: R1MockControls = {
    rooms: [],
    tracks: [],
    mediaRequests: [],
    publishes: [],
    connects: [],
    disconnects: [],
    micVolume: 0.25,
    failNextConnect: null,
    current: () => controls.rooms[controls.rooms.length - 1] ?? null,
    agent: () => {
      const room = controls.current();
      return room ? ([...room.remoteParticipants.values()].find((p) => p.kind === ParticipantKind.AGENT) ?? null) : null;
    },
    joinAgent(attributes = {}) {
      const room = controls.current();
      if (!room) throw new Error('no room to join');
      const agent = new MockParticipant('agent-interviewer', ParticipantKind.AGENT);
      agent.attributes = { ...attributes };
      room.remoteParticipants.set(agent.identity, agent);
      room.emit(RoomEvent.ParticipantConnected, agent);
    },
    setPhase(phase) {
      const room = controls.current();
      const agent = controls.agent();
      if (!room || !agent) throw new Error('no agent in the room');
      agent.attributes = { ...agent.attributes, phase };
      room.emit(RoomEvent.ParticipantAttributesChanged, { phase }, agent);
    },
    speak(level) {
      const room = controls.current();
      const agent = controls.agent();
      if (!room || !agent) throw new Error('no agent in the room');
      agent.audioLevel = level;
      room.emit(RoomEvent.ActiveSpeakersChanged, [agent]);
    },
    caption(id, text, final) {
      const room = controls.current();
      const agent = controls.agent();
      if (!room || !agent) throw new Error('no agent in the room');
      room.emit(RoomEvent.TranscriptionReceived, [{ id, text, final, language: 'en' }], agent);
    },
    intrude(attributes) {
      const room = controls.current();
      if (!room) throw new Error('no room');
      const other = new MockParticipant('someone-else', ParticipantKind.STANDARD);
      other.attributes = { ...attributes };
      room.remoteParticipants.set(other.identity, other);
      room.emit(RoomEvent.ParticipantConnected, other);
      room.emit(RoomEvent.ParticipantAttributesChanged, attributes, other);
    },
    removeAgent() {
      const room = controls.current();
      const agent = controls.agent();
      if (!room || !agent) throw new Error('no agent in the room');
      room.remoteParticipants.delete(agent.identity);
      room.emit(RoomEvent.ParticipantDisconnected, agent);
    },
    drop(reason) {
      const room = controls.current();
      if (!room) throw new Error('no room');
      room.state = 'disconnected';
      room.emit(RoomEvent.Disconnected, reason);
    },
  };
  window.__r1Mock = controls;
  return controls;
}

/** Build the constraints the real SDK builds: `ideal` for sizes and rates, `exact` for a chosen device. */
function videoConstraints(options: Record<string, unknown>): MediaTrackConstraints {
  const resolution = (options.resolution ?? {}) as { width?: number; height?: number; frameRate?: number };
  const constraints: MediaTrackConstraints = {};
  if (resolution.width) constraints.width = { ideal: resolution.width };
  if (resolution.height) constraints.height = { ideal: resolution.height };
  if (resolution.frameRate) constraints.frameRate = { ideal: resolution.frameRate };
  if (options.facingMode) constraints.facingMode = { ideal: options.facingMode as string };
  if (options.deviceId) constraints.deviceId = options.deviceId as ConstrainDOMString;
  return constraints;
}

export async function createLocalVideoTrack(options: Record<string, unknown> = {}): Promise<LocalVideoTrack> {
  const controls = ensureControls();
  const constraints = videoConstraints(options);
  const stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
  const [track] = stream.getVideoTracks();
  controls.mediaRequests.push({ kind: 'video', options, constraints, settings: track.getSettings() });
  controls.tracks.push({ kind: 'video', mediaStreamTrack: track });
  return new LocalVideoTrack(track);
}

export async function createLocalAudioTrack(options: Record<string, unknown> = {}): Promise<LocalAudioTrack> {
  const controls = ensureControls();
  const constraints: MediaTrackConstraints = {};
  for (const key of ['echoCancellation', 'noiseSuppression', 'autoGainControl'] as const) {
    if (typeof options[key] === 'boolean') constraints[key] = options[key] as boolean;
  }
  if (options.deviceId) constraints.deviceId = options.deviceId as ConstrainDOMString;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
  const [track] = stream.getAudioTracks();
  controls.mediaRequests.push({ kind: 'audio', options, constraints, settings: track.getSettings() });
  controls.tracks.push({ kind: 'audio', mediaStreamTrack: track });
  return new LocalAudioTrack(track);
}

/** SYNTHETIC level: Chromium's fake microphone beeps on its own schedule, which would make the check flaky. */
export function createAudioAnalyser(): {
  calculateVolume: () => number;
  analyser: null;
  cleanup: () => Promise<void>;
} {
  const controls = ensureControls();
  return {
    calculateVolume: () => controls.micVolume,
    analyser: null,
    cleanup: async () => undefined,
  };
}

// Publish the remote control the moment the page loads the SDK stand-in, so a test
// can use it (e.g. to set the microphone level) before the first room exists.
ensureControls();
