/**
 * The `r1` fixture: a real page of the real app, signed OUT like a candidate's
 * browser, with the R1 candidate API answered locally and `livekit-client`
 * replaced by the scripted stand-in (see mock-livekit-client.ts).
 *
 * It reuses the recruiter harness's guards wholesale (request and WebSocket
 * interception, console capture, unmocked/external failure at teardown) and
 * differs in exactly three ways:
 *   1. no admin session is seeded, so the page cannot lean on one;
 *   2. the fake API is the R1 router only: every non-R1 `/api/*` call is an
 *      unmocked endpoint and fails the test;
 *   3. it exposes `state` (what the fake server knows and received) and
 *      `mock` (the remote control for the fake room and the media records).
 *
 * Chromium runs with fake camera and microphone devices and the context has
 * camera and microphone permission (playwright.config.ts), so `getUserMedia`
 * returns real, synthetic MediaStreamTracks.
 */

import { test as base, expect, type Page } from '@playwright/test';
import { installHarness, reportHarness, type AppHarness } from './harness';
import { createR1State, r1Router, type R1MockState } from './r1-candidate-api';
import type { ConnectRecord, DisconnectRecord, MediaRequest, PublishRecord } from './mock-livekit-client';

export interface MockSnapshot {
  roomCount: number;
  /** The options each Room was constructed with, in creation order. */
  roomOptions: Array<Record<string, unknown>>;
  mediaRequests: MediaRequest[];
  publishes: PublishRecord[];
  connects: ConnectRecord[];
  disconnects: DisconnectRecord[];
  tracks: Array<{ kind: 'audio' | 'video'; readyState: MediaStreamTrackState }>;
}

export interface MockRemote {
  snapshot(): Promise<MockSnapshot>;
  joinAgent(attributes?: Record<string, string>): Promise<void>;
  setPhase(phase: string): Promise<void>;
  /** Several interviewer attributes in one update; `''` removes one (see mock-livekit-client.ts). */
  setAgentAttributes(attributes: Record<string, string>): Promise<void>;
  speak(level: number): Promise<void>;
  caption(id: string, text: string, final: boolean): Promise<void>;
  intrude(attributes: Record<string, string>): Promise<void>;
  removeAgent(): Promise<void>;
  /** The room goes away; `reason` is the SDK's DisconnectReason (5 is ROOM_DELETED). */
  drop(reason?: number): Promise<void>;
  setMicVolume(volume: number): Promise<void>;
  failNextConnect(message: string): Promise<void>;
}

function remote(page: Page): MockRemote {
  return {
    snapshot: () =>
      page.evaluate(() => {
        const mock = window.__r1Mock;
        return {
          roomCount: mock?.rooms.length ?? 0,
          roomOptions: (mock?.rooms ?? []).map((room) => room.options),
          mediaRequests: mock?.mediaRequests ?? [],
          publishes: mock?.publishes ?? [],
          connects: mock?.connects ?? [],
          disconnects: mock?.disconnects ?? [],
          tracks: (mock?.tracks ?? []).map((t) => ({ kind: t.kind, readyState: t.mediaStreamTrack.readyState })),
        };
      }),
    joinAgent: (attributes) => page.evaluate((a) => window.__r1Mock!.joinAgent(a), attributes),
    setPhase: (phase) => page.evaluate((p) => window.__r1Mock!.setPhase(p), phase),
    setAgentAttributes: (attributes) =>
      page.evaluate((a) => window.__r1Mock!.setAgentAttributes(a), attributes),
    speak: (level) => page.evaluate((l) => window.__r1Mock!.speak(l), level),
    caption: (id, text, final) => page.evaluate(([i, t, f]) => window.__r1Mock!.caption(i as string, t as string, f as boolean), [id, text, final] as const),
    intrude: (attributes) => page.evaluate((a) => window.__r1Mock!.intrude(a), attributes),
    removeAgent: () => page.evaluate(() => window.__r1Mock!.removeAgent()),
    drop: (reason) => page.evaluate((r) => window.__r1Mock!.drop(r), reason),
    setMicVolume: (volume) => page.evaluate((v) => { window.__r1Mock!.micVolume = v; }, volume),
    failNextConnect: (message) => page.evaluate((m) => { window.__r1Mock!.failNextConnect = m; }, message),
  };
}

export interface R1Harness extends AppHarness {
  /** What the fake R1 server holds and has received. */
  state: R1MockState;
  /** The remote control for the scripted room and the recorded media activity. */
  mock: MockRemote;
}

export const test = base.extend<{ r1: R1Harness }>({
  r1: [
    async ({ page }, use, testInfo) => {
      const state = createR1State();
      const harness = await installHarness(page, testInfo, { signedIn: false, api: r1Router(state) });
      await use(Object.assign(harness, { state, mock: remote(page) }));
      await reportHarness(harness, testInfo);
    },
    { auto: true },
  ],
});

export { expect };
