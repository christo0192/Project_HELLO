import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Handlers {
  onPhase: (phase: string) => void;
  onLeadName: (name: string | null) => void;
  onRoleplayLeft: (seconds: number | null) => void;
  onAgentPresent: (present: boolean) => void;
  onEnded: (reason: 'agent_ended' | 'aborted' | 'disconnected') => void;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const h = vi.hoisted(() => ({
  meetExchange: vi.fn(),
  otherApi: {
    status: vi.fn(),
    consentTemplate: vi.fn(),
    submitConsent: vi.fn(),
    withdrawConsent: vi.fn(),
    preflight: vi.fn(),
    createAttempt: vi.fn(),
    exchange: vi.fn(),
    ready: vi.fn(),
  },
  captureMeetAudio: vi.fn(),
  /** Where the address bar was each time the exchange was called. */
  seenAt: [] as string[],
  /** The waits the runner asked for (the sleep is made instant for these tests). */
  sleeps: [] as number[],
  /** What the page handed the runner, before the instant sleep was swapped in. */
  runDeps: [] as Array<{
    ticket: string;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    isCancelled: () => boolean;
  }>,
  created: [] as Array<{
    handlers: Handlers;
    getAudioElement: () => HTMLAudioElement | null;
    controller: { connect: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> };
  }>,
  connectImpl: null as null | ((handlers: Handlers) => Promise<void>),
}));

vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('../lib/r1/r1-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r1/r1-api')>()),
  r1Api: { ...h.otherApi, meetExchange: h.meetExchange },
}));
vi.mock('../lib/r1/r1-meet-room', () => ({
  captureMeetAudio: h.captureMeetAudio,
  createR1MeetRoom: vi.fn((handlers: Handlers, getAudioElement: () => HTMLAudioElement | null) => {
    const controller = {
      connect: vi.fn(async () => {
        if (h.connectImpl) await h.connectImpl(handlers);
      }),
      dispose: vi.fn(),
    };
    h.created.push({ handlers, getAudioElement, controller });
    return controller;
  }),
}));
vi.mock('../lib/r1/r1-meet', async (importOriginal) => {
  const original = await importOriginal<typeof import('../lib/r1/r1-meet')>();
  return {
    ...original,
    runMeetExchange: vi.fn((deps: Parameters<typeof original.runMeetExchange>[0]) => {
      h.runDeps.push(deps);
      return original.runMeetExchange({
        ...deps,
        sleep: async (ms: number) => {
          h.sleeps.push(ms);
        },
      });
    }),
  };
});

import { ApiError } from '../lib/api-client';
import { R1ApiError } from '../lib/r1/r1-api';
import { R1_MEET_EXCHANGE_MAX_CALLS, R1_MEET_EXCHANGE_WAITS_MS } from '../lib/r1/r1-meet';
import { createR1MeetRoom } from '../lib/r1/r1-meet-room';
import { R1_PHASE_LABELS } from '../lib/r1/r1-phase';
import { R1_MEET_TILE_COPY } from '../components/candidate-r1/r1-meet-copy';
import { R1_SCENARIO_COPY } from '../components/candidate-r1/r1-scenario';
import { R1MeetBridgePage } from './R1MeetBridgePage';

const TICKET = 'meet-ticket-not-a-secret-0123456789abcdef';
const RESUME = 'resume-not-a-secret';
const GRANT = {
  status: 'ready',
  url: 'wss://lk.invalid',
  livekit_token: 'room-token',
  expires_at: null,
};
const PREPARING = { status: 'preparing', resume_token: RESUME, retry_after_sec: 3 };

let track: { stop: ReturnType<typeof vi.fn> };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function openPage(hash: string = `#t=${TICKET}`, strict = false) {
  window.history.replaceState(null, '', `/candidate/r1/meet${hash}`);
  return render(strict ? <StrictMode><R1MeetBridgePage /></StrictMode> : <R1MeetBridgePage />);
}

const findH1 = (name: string) => screen.findByRole('heading', { level: 1, name });
const tile = () => document.querySelector('section.r1-meet-tile') as HTMLElement;

/** Let every pending promise in the page's chain settle (real timers: a macrotask drains them). */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 3; i += 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  });
}

async function toLive() {
  openPage();
  await findH1(R1_MEET_TILE_COPY.live.title);
  return h.created[h.created.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.seenAt.length = 0;
  h.sleeps.length = 0;
  h.runDeps.length = 0;
  h.created.length = 0;
  h.connectImpl = null;
  track = { stop: vi.fn() };
  h.captureMeetAudio.mockResolvedValue(track);
  h.meetExchange.mockImplementation(async () => {
    h.seenAt.push(window.location.pathname + window.location.search + window.location.hash);
    return GRANT;
  });
  // jsdom has no WebRTC: give it the two APIs the capability check looks for.
  vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {});
  Object.defineProperty(window.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (window.navigator as { mediaDevices?: unknown }).mediaDevices;
  window.history.replaceState(null, '', '/');
});

function expectNothingSent(): void {
  expect(h.meetExchange).not.toHaveBeenCalled();
  for (const spy of Object.values(h.otherApi)) expect(spy).not.toHaveBeenCalled();
  expect(createR1MeetRoom).not.toHaveBeenCalled();
}

describe('the ticket', () => {
  it('without one, idles and makes no call and no media request', async () => {
    openPage('');
    await findH1(R1_MEET_TILE_COPY.idle.title);
    await settle();
    expect(tile()).toHaveAttribute('data-state', 'idle');
    expect(tile()).toHaveAttribute('data-reason', 'no_ticket');
    expectNothingSent();
    expect(h.captureMeetAudio).not.toHaveBeenCalled();
    expect(h.runDeps).toHaveLength(0);
  });

  it.each([
    ['too short', '#t=short-ticket'],
    ['the wrong key', `#x=${TICKET}`],
    ['no key at all', `#${TICKET}`],
    ['characters outside the alphabet', `#t=${TICKET.slice(0, 40)}!`],
  ])('that is %s idles with no call, and the fragment is stripped all the same', async (_what, hash) => {
    openPage(hash);
    await findH1(R1_MEET_TILE_COPY.idle.title);
    await settle();
    expect(window.location.pathname).toBe('/candidate/r1/meet');
    expect(window.location.hash).toBe('');
    expectNothingSent();
    expect(h.captureMeetAudio).not.toHaveBeenCalled();
  });

  it('is stripped from the address bar BEFORE the first exchange, and sent only in the body', async () => {
    openPage();
    await findH1(R1_MEET_TILE_COPY.live.title);
    expect(h.seenAt).toEqual(['/candidate/r1/meet']);
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
    expect(h.meetExchange).toHaveBeenCalledWith(TICKET, null);
    expect(window.location.href).not.toContain(TICKET);
    expect(document.documentElement.innerHTML).not.toContain(TICKET);
    expect(document.documentElement.innerHTML).not.toContain('room-token');
  });
});

describe('before any call', () => {
  it('an unsupported browser shows the cannot-join tile and sends the ticket nowhere', async () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    openPage();
    await findH1(R1_MEET_TILE_COPY.unavailable.title);
    await settle();
    expect(tile()).toHaveAttribute('data-reason', 'unsupported');
    expectNothingSent();
    expect(h.captureMeetAudio).not.toHaveBeenCalled();
  });

  it('no meeting audio shows the cannot-join tile and spends no ticket', async () => {
    h.captureMeetAudio.mockRejectedValue(new Error('NotAllowedError'));
    openPage();
    await findH1(R1_MEET_TILE_COPY.unavailable.title);
    await settle();
    expect(tile()).toHaveAttribute('data-reason', 'no_audio');
    expectNothingSent();
  });

  it('captures the meeting audio before the exchange starts', async () => {
    const order: string[] = [];
    h.captureMeetAudio.mockImplementation(async () => {
      order.push('capture');
      return track;
    });
    h.meetExchange.mockImplementation(async () => {
      order.push('exchange');
      return GRANT;
    });
    openPage();
    await findH1(R1_MEET_TILE_COPY.live.title);
    expect(order).toEqual(['capture', 'exchange']);
  });
});

describe('the exchange', () => {
  it('under StrictMode is sent exactly once, after exactly one capture', async () => {
    openPage(`#t=${TICKET}`, true);
    await findH1(R1_MEET_TILE_COPY.live.title);
    await settle();
    expect(h.captureMeetAudio).toHaveBeenCalledTimes(1);
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
    expect(createR1MeetRoom).toHaveBeenCalledTimes(1);
    expect(h.created[0].controller.connect).toHaveBeenCalledTimes(1);
  });

  it('joins the room with the grant and the captured track, and plays into the hidden audio element', async () => {
    const room = await toLive();
    expect(room.controller.connect).toHaveBeenCalledWith('wss://lk.invalid', 'room-token', track);
    const element = room.getAudioElement();
    expect(element).toBeInstanceOf(HTMLAudioElement);
    expect(element).toHaveAttribute('autoplay');
    expect(element).toHaveAttribute('playsinline');
    expect(element).toHaveClass('hidden');
    expect(track.stop).not.toHaveBeenCalled();
    for (const spy of Object.values(h.otherApi)) expect(spy).not.toHaveBeenCalled();
  });

  it('idles when the server says the Meet switch is off, and stops the meeting audio', async () => {
    h.meetExchange.mockRejectedValue(new R1ApiError('meet_disabled', 503));
    openPage();
    await findH1(R1_MEET_TILE_COPY.idle.title);
    await settle();
    expect(tile()).toHaveAttribute('data-reason', 'disabled');
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
    expect(track.stop).toHaveBeenCalled();
    expect(createR1MeetRoom).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_request', 400, 'invalid'],
    ['ticket_unknown', 404, 'invalid'],
    ['ticket_already_claimed', 409, 'claimed'],
    ['ticket_not_yet_valid', 425, 'not_yet'],
    ['ticket_expired', 410, 'expired'],
    ['round_not_live', 409, 'round_closed'],
    ['http_503', 503, 'unavailable'],
    ['rate_limited', 429, 'rate_limited'],
    ['http_500', 500, 'unavailable'],
    ['some_new_conflict', 409, 'unavailable'],
    ['r1_malformed_response', 200, 'malformed'],
  ])('answered %s (%i) shows the cannot-join tile after ONE call', async (code, status, reason) => {
    h.meetExchange.mockRejectedValue(new R1ApiError(code, status));
    openPage();
    await findH1(R1_MEET_TILE_COPY.unavailable.title);
    await settle();
    expect(tile()).toHaveAttribute('data-reason', reason);
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
    expect(track.stop).toHaveBeenCalled();
    expect(createR1MeetRoom).not.toHaveBeenCalled();
  });

  it('says it is preparing on a 202, then joins on the 200 with the resume token', async () => {
    const second = deferred<typeof GRANT>();
    h.meetExchange
      .mockResolvedValueOnce(PREPARING)
      .mockImplementationOnce(() => second.promise);
    openPage();
    await screen.findByText(R1_MEET_TILE_COPY.connecting.body);
    await settle();
    expect(tile()).toHaveAttribute('data-state', 'connecting');
    expect(tile()).toHaveAttribute('data-reason', 'preparing');
    expect(h.meetExchange).toHaveBeenCalledTimes(2);
    expect(h.meetExchange).toHaveBeenNthCalledWith(1, TICKET, null);
    expect(h.meetExchange).toHaveBeenNthCalledWith(2, TICKET, RESUME);
    expect(h.sleeps).toEqual([3_000]);
    await act(async () => {
      second.resolve(GRANT);
    });
    await findH1(R1_MEET_TILE_COPY.live.title);
    expect(h.created[0].controller.connect).toHaveBeenCalledWith('wss://lk.invalid', 'room-token', track);
    expect(document.documentElement.innerHTML).not.toContain(RESUME);
  });

  it('retries a network failure within the same budget', async () => {
    h.meetExchange
      .mockRejectedValueOnce(new ApiError('network_error', 0))
      .mockResolvedValueOnce(GRANT);
    openPage();
    await findH1(R1_MEET_TILE_COPY.live.title);
    expect(h.meetExchange).toHaveBeenCalledTimes(2);
    expect(h.meetExchange).toHaveBeenNthCalledWith(2, TICKET, null);
    expect(h.sleeps).toEqual([3_000]);
  });

  it('gives up after the bounded schedule when the worker never comes up', async () => {
    h.meetExchange.mockResolvedValue(PREPARING);
    openPage();
    await findH1(R1_MEET_TILE_COPY.unavailable.title);
    await settle();
    expect(tile()).toHaveAttribute('data-reason', 'timeout');
    expect(h.meetExchange).toHaveBeenCalledTimes(R1_MEET_EXCHANGE_MAX_CALLS);
    expect(h.sleeps).toEqual([...R1_MEET_EXCHANGE_WAITS_MS]);
    expect(track.stop).toHaveBeenCalled();
    expect(createR1MeetRoom).not.toHaveBeenCalled();
  });

  it('wires the runner with the ticket, a timer sleep, the monotonic clock and the mount flag', async () => {
    const { unmount } = openPage();
    await findH1(R1_MEET_TILE_COPY.live.title);
    expect(h.runDeps).toHaveLength(1);
    const deps = h.runDeps[0];
    expect(deps.ticket).toBe(TICKET);
    const before = performance.now();
    const read = deps.now();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(performance.now());
    expect(deps.isCancelled()).toBe(false);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let slept = false;
    void deps.sleep(5_000).then(() => {
      slept = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(slept).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(slept).toBe(true);
    vi.useRealTimers();

    unmount();
    expect(deps.isCancelled()).toBe(true);
  });
});

describe('leaving early', () => {
  it('unmounted during the exchange: no room, the track stopped, no further call', async () => {
    const pending = deferred<typeof GRANT>();
    h.meetExchange.mockImplementation(() => pending.promise);
    const { unmount } = openPage();
    await settle();
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
    unmount();
    expect(track.stop).toHaveBeenCalled();
    pending.resolve(GRANT);
    await settle();
    expect(createR1MeetRoom).not.toHaveBeenCalled();
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
  });

  it('unmounted during a 202 wait: no further call', async () => {
    const pending = deferred<typeof PREPARING>();
    h.meetExchange.mockImplementation(() => pending.promise);
    const { unmount } = openPage();
    await settle();
    unmount();
    pending.resolve(PREPARING);
    await settle();
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
    expect(createR1MeetRoom).not.toHaveBeenCalled();
  });

  it('unmounted while the audio is being captured: the track is stopped and nothing is sent', async () => {
    const pending = deferred<typeof track>();
    h.captureMeetAudio.mockImplementation(() => pending.promise);
    const { unmount } = openPage();
    await settle();
    unmount();
    pending.resolve(track);
    await settle();
    expect(track.stop).toHaveBeenCalled();
    expectNothingSent();
  });

  it('unmounted while connecting: the controller is disposed and the track stopped', async () => {
    const pending = deferred<void>();
    h.connectImpl = () => pending.promise;
    const { unmount } = openPage();
    await settle();
    expect(h.created).toHaveLength(1);
    unmount();
    expect(h.created[0].controller.dispose).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    pending.resolve();
    await settle();
  });
});

describe('the room', () => {
  it('a failed connect shows the cannot-join tile, disposes the controller and stops the audio', async () => {
    h.connectImpl = async () => {
      throw new Error('could not establish signal connection');
    };
    openPage();
    await findH1(R1_MEET_TILE_COPY.unavailable.title);
    expect(tile()).toHaveAttribute('data-reason', 'connect_failed');
    expect(h.created[0].controller.dispose).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
  });

  it('an ending while connecting is never replaced by the live tile', async () => {
    h.connectImpl = async (handlers) => {
      handlers.onEnded('agent_ended');
    };
    openPage();
    await findH1(R1_MEET_TILE_COPY.ended.agent_ended.title);
    await settle();
    expect(tile()).toHaveAttribute('data-state', 'ended');
    expect(track.stop).toHaveBeenCalled();
  });

  it('the interviewer drives the tile: presence, phase label, lead card and clock', async () => {
    const room = await toLive();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting');
    act(() => room.handlers.onAgentPresent(true));
    expect(screen.getByRole('status')).toHaveTextContent('Interview in progress');
    act(() => room.handlers.onPhase('icebreaker'));
    expect(screen.getByRole('status')).toHaveTextContent(R1_PHASE_LABELS.icebreaker.label);
    expect(screen.queryByText(R1_PHASE_LABELS.icebreaker.detail)).toBeNull();
    expect(screen.queryByRole('region', { name: R1_SCENARIO_COPY.heading })).toBeNull();

    act(() => {
      room.handlers.onPhase('transition');
      room.handlers.onLeadName('Meera Iyer');
      room.handlers.onRoleplayLeft(480);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Role-play briefing');
    const card = screen.getByRole('region', { name: R1_SCENARIO_COPY.heading });
    expect(card).toHaveTextContent('Meera Iyer');
    expect(card).toHaveTextContent(R1_SCENARIO_COPY.price);
    expect(card).toHaveTextContent(R1_SCENARIO_COPY.intro);
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 8 min left');

    act(() => room.handlers.onPhase('roleplay'));
    expect(screen.getByRole('status')).toHaveTextContent(R1_PHASE_LABELS.roleplay.label);
    expect(screen.getByRole('region', { name: R1_SCENARIO_COPY.heading })).toHaveClass(
      'r1-scenario--compact',
    );

    // A pause keeps the card of the phase the interview will resume in.
    act(() => room.handlers.onPhase('paused_disconnected'));
    expect(screen.getByRole('region', { name: R1_SCENARIO_COPY.heading })).toBeVisible();

    act(() => room.handlers.onPhase('wrapup'));
    expect(screen.queryByRole('region', { name: R1_SCENARIO_COPY.heading })).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it.each([
    ['agent_ended' as const],
    ['aborted' as const],
    ['disconnected' as const],
  ])('ends with the %s tile and stops the meeting audio', async (reason) => {
    const room = await toLive();
    act(() => room.handlers.onEnded(reason));
    const copy = R1_MEET_TILE_COPY.ended[reason];
    expect(screen.getByRole('heading', { level: 1, name: copy.title })).toBeVisible();
    expect(screen.getByText(copy.body)).toBeVisible();
    expect(tile()).toHaveAttribute('data-reason', reason);
    expect(track.stop).toHaveBeenCalled();
    expect(h.meetExchange).toHaveBeenCalledTimes(1);
  });
});

describe('the page itself', () => {
  it('declares a no-referrer policy in the document head while it is mounted', async () => {
    const { unmount } = openPage('');
    await findH1(R1_MEET_TILE_COPY.idle.title);
    expect(document.head.querySelector('meta[name="referrer"][content="no-referrer"]')).not.toBeNull();
    unmount();
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
  });

  it('passes axe while idle', async () => {
    const { container } = openPage('');
    await findH1(R1_MEET_TILE_COPY.idle.title);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe while live with the briefing card on', async () => {
    const room = await toLive();
    act(() => {
      room.handlers.onAgentPresent(true);
      room.handlers.onPhase('transition');
      room.handlers.onLeadName('Meera Iyer');
      room.handlers.onRoleplayLeft(480);
    });
    await expect(document.body).toHaveNoViolations();
  });
});
