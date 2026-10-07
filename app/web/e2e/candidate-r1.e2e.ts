/**
 * Offline checks for the R1 candidate page (`/candidate/r1#<link token>`).
 *
 * The app under test is the REAL app on the Vite dev server, signed OUT like a
 * candidate's browser. Three things are faked and each is named:
 *   - the R1 candidate API (fixtures/r1-candidate-api.ts, PR-3 route shapes);
 *   - `livekit-client` (fixtures/mock-livekit-client.ts), driven from the test
 *     through `r1.mock`: the interviewer agent joins, announces phases,
 *     speaks and captions, and the room can end or drop;
 *   - nothing about capture: Chromium runs with fake camera and microphone
 *     devices, so `getUserMedia` returns real synthetic MediaStreamTracks and
 *     the self-view plays a real video element.
 *
 * Every state asserts no console error, no unmocked request, no external
 * request, no Authorization header and no link token outside a request body;
 * the key states also run axe STRICTLY and, on the phone project, fail on any
 * sideways scroll.
 *
 * The `.e2e.ts` suffix keeps this out of vitest (`src/**\/*.test.*`).
 */

import { auditA11y } from './fixtures/axe';
import { expect, test } from './fixtures/candidate-harness';
import {
  agree,
  bodiesOf,
  expectCandidateHygiene,
  expectMobileFits,
  heading,
  openLink,
  passDeviceCheck,
  reachLive,
  storedNonce,
  storedNonceRaw,
} from './fixtures/candidate-flows';
import { R1_ATTEMPT_TOKEN, R1_LINK_TOKEN, R1_NONCE } from './fixtures/r1-candidate-api';

test.describe('link and notice', () => {
  test('a link with no token is refused without a single API call', async ({ r1 }, testInfo) => {
    await openLink(r1, '');
    await expect(heading(r1.page, 'We could not open this link')).toBeVisible();
    expect(r1.state.requests).toEqual([]);
    await expectMobileFits(r1.page, testInfo);
    await auditA11y(r1.page, testInfo, 'r1-link-invalid', { strict: true });
    r1.expectHealthy();
  });

  test('a malformed token is refused without a single API call', async ({ r1 }) => {
    await openLink(r1, '#not-a-token');
    await expect(heading(r1.page, 'We could not open this link')).toBeVisible();
    expect(r1.state.requests).toEqual([]);
    r1.expectHealthy();
  });

  test('the fragment is stripped at once and the token travels only in request bodies', async ({ r1 }) => {
    await openLink(r1);
    await expect(heading(r1.page, 'Notice and consent for your AI interview')).toBeVisible();
    expect(r1.page.url()).not.toContain(R1_LINK_TOKEN);
    expect(new URL(r1.page.url()).pathname).toBe('/candidate/r1');
    expect(bodiesOf(r1, '/api/r1/status').every((body) => body?.link_token === R1_LINK_TOKEN)).toBe(true);
    // The notice is fetched per link: a POST carrying the token in its body, never a GET or a URL.
    expect(r1.state.requests.filter((request) => request.path === '/api/r1/consent-template')).toEqual([
      { method: 'POST', path: '/api/r1/consent-template', query: '', body: { link_token: R1_LINK_TOKEN, locale: 'en-IN' } },
    ]);
    expect(await r1.page.evaluate(() => document.body.innerHTML.includes('e2e1e2e1'))).toBe(false);
    expectCandidateHygiene(r1);
    r1.expectHealthy();
  });

  test('a browser that cannot run the interview sends the link token nowhere', async ({ r1 }, testInfo) => {
    await r1.page.addInitScript(() => {
      delete (window as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    });
    await openLink(r1);
    await expect(heading(r1.page, 'This browser cannot run the interview')).toBeVisible();
    expect(r1.state.requests).toEqual([]);
    expect(r1.page.url()).not.toContain(R1_LINK_TOKEN);
    expect(new URL(r1.page.url()).pathname).toBe('/candidate/r1');
    await expectMobileFits(r1.page, testInfo);
    await auditA11y(r1.page, testInfo, 'r1-unsupported', { strict: true });
    r1.expectHealthy();
  });

  test('the notice shows the whole notice and one checkbox per purpose', async ({ r1 }, testInfo) => {
    await openLink(r1);
    const { page } = r1;
    await expect(heading(page, 'Notice and consent for your AI interview')).toBeVisible();

    const notice = page.getByRole('region', { name: 'Full notice' });
    await expect(notice.getByRole('heading', { name: 'Who processes it' })).toBeVisible();
    await expect(notice.getByText('DeepSeek (language model)')).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    await expect(page.getByText(/select all/i)).toHaveCount(0);

    const agreeButton = page.getByRole('button', { name: 'I agree and continue' });
    await expect(agreeButton).toBeDisabled();
    const boxes = await page.getByRole('checkbox').all();
    for (const box of boxes.slice(0, 2)) await box.check();
    await expect(agreeButton).toBeDisabled();
    await boxes[2].check();
    await expect(agreeButton).toBeEnabled();

    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-notice', { strict: true });
    r1.expectHealthy();
  });

  test('declining closes the link and never touches the camera or microphone', async ({ r1 }, testInfo) => {
    await r1.page.addInitScript(() => {
      const w = window as unknown as { __gumCalls: number };
      w.__gumCalls = 0;
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => {
        w.__gumCalls += 1;
        return original(constraints);
      };
    });
    await openLink(r1);
    await r1.page.getByRole('button', { name: 'I do not agree' }).click();
    await expect(heading(r1.page, 'This interview cannot start without your consent')).toBeVisible();
    await expect(r1.page.getByText(/conversation with a person instead/)).toBeVisible();

    expect(r1.state.declined).toBe(true);
    expect(bodiesOf(r1, '/api/r1/consent')).toEqual([
      expect.objectContaining({ status: 'declined', consents: [], template_version: 'e2e-r1-v1' }),
    ]);
    expect(r1.state.requests.filter((request) => /preflight|attempts|exchange/.test(request.path))).toEqual([]);
    expect(await r1.page.evaluate(() => (window as unknown as { __gumCalls: number }).__gumCalls)).toBe(0);
    expect((await r1.mock.snapshot()).mediaRequests).toEqual([]);

    await expectMobileFits(r1.page, testInfo);
    await auditA11y(r1.page, testInfo, 'r1-declined', { strict: true });
    expectCandidateHygiene(r1);
    r1.expectHealthy();
  });

  test('a budget pause says the link stays valid and can be re-checked', async ({ r1 }, testInfo) => {
    r1.state.consentRequired = false;
    r1.state.budgetPaused = true;
    await openLink(r1);
    await expect(heading(r1.page, 'We cannot start interviews right now')).toBeVisible();
    await expect(r1.page.getByText(/Your link stays valid/)).toBeVisible();
    await auditA11y(r1.page, testInfo, 'r1-paused', { strict: true });

    r1.state.budgetPaused = false;
    await r1.page.getByRole('button', { name: 'Check again' }).click();
    await expect(heading(r1.page, 'Video interview')).toBeVisible();
    r1.expectHealthy();
  });

  test('withdrawing consent needs a confirmation and ends the link for this candidate', async ({ r1 }) => {
    r1.state.consentRequired = false;
    await openLink(r1);
    await expect(heading(r1.page, 'Video interview')).toBeVisible();
    await r1.page.getByRole('button', { name: 'Withdraw my consent' }).click();
    expect(r1.state.withdrawn).toBe(false);
    await r1.page
      .getByRole('group', { name: 'Withdraw consent' })
      .getByRole('button', { name: 'Withdraw my consent' })
      .click();
    await expect(heading(r1.page, 'We have recorded your withdrawal')).toBeVisible();
    expect(r1.state.withdrawn).toBe(true);
    r1.expectHealthy();
  });
});

test.describe('device check', () => {
  test('captures at 640x360 and 15 fps from the real fake camera and shows a mirrored self-view', async ({ r1 }, testInfo) => {
    r1.state.consentRequired = false;
    await openLink(r1);
    await expect(heading(r1.page, 'Video interview')).toBeVisible();
    await auditA11y(r1.page, testInfo, 'r1-landing', { strict: true });
    await expectMobileFits(r1.page, testInfo);

    await passDeviceCheck(r1.page);
    const preview = r1.page.getByLabel('Your camera preview');
    // A genuine synthetic video frame reached the element.
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.readyState)).toBeGreaterThanOrEqual(2);
    expect(await preview.evaluate((video) => getComputedStyle(video).transform)).toBe('matrix(-1, 0, 0, 1, 0, 0)');

    const snapshot = await r1.mock.snapshot();
    const camera = snapshot.mediaRequests.find((request) => request.kind === 'video');
    expect(camera?.options).toMatchObject({ resolution: { width: 640, height: 360, frameRate: 15 } });
    expect(camera?.constraints).toMatchObject({
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 15 },
    });
    expect([camera?.settings.width, camera?.settings.height]).toEqual([640, 360]);
    expect(camera?.settings.frameRate).toBeLessThanOrEqual(15.5);
    // Camera first, then microphone; both before the preflight room.
    expect(snapshot.mediaRequests.map((request) => request.kind)).toEqual(['video', 'audio']);

    // The preflight published the real budget, in its own disposable room.
    expect(snapshot.connects).toHaveLength(1);
    expect(bodiesOf(r1, '/api/r1/preflight')).toEqual([{ link_token: R1_LINK_TOKEN }]);
    expect(snapshot.publishes.map((publish) => publish.kind)).toEqual(['audio', 'video']);
    // The check measures the uplink, so its microphone is published with Opus DTX off: a quiet
    // candidate under the SDK default would send ~2.5 packets a second and never reach 50.
    expect(snapshot.publishes[0].options).toEqual({ dtx: false });
    expect(snapshot.publishes[1].options).toEqual({
      simulcast: false,
      videoEncoding: { maxBitrate: 500_000, maxFramerate: 15 },
    });
    expect(snapshot.disconnects).toEqual([{ roomIndex: 0, stopTracks: false }]);

    await expectMobileFits(r1.page, testInfo);
    await auditA11y(r1.page, testInfo, 'r1-readiness-passed', { strict: true });
    expectCandidateHygiene(r1);
    r1.expectHealthy();
  });

  test('a refused camera is explained, and nothing else is requested', async ({ r1 }, testInfo) => {
    await r1.page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException('Permission denied', 'NotAllowedError');
      };
    });
    r1.state.consentRequired = false;
    await openLink(r1);
    await r1.page.getByRole('button', { name: 'Check my camera and microphone' }).click();
    await r1.page.getByRole('button', { name: /Test camera, microphone and connection/ }).click();
    await expect(r1.page.getByRole('alert')).toContainText('Camera permission is blocked');
    await expect(r1.page.getByRole('button', { name: 'Test again' })).toBeEnabled();
    expect(r1.state.requests.filter((request) => request.path === '/api/r1/preflight')).toEqual([]);

    await expectMobileFits(r1.page, testInfo);
    await auditA11y(r1.page, testInfo, 'r1-readiness-camera-denied', { strict: true });
    r1.expectHealthy();
  });

  test('a silent microphone is explained, the camera is released, and no preflight is spent', async ({ r1 }) => {
    r1.state.consentRequired = false;
    await openLink(r1);
    await r1.page.getByRole('button', { name: 'Check my camera and microphone' }).click();
    await r1.mock.setMicVolume(0);
    await r1.page.getByRole('button', { name: /Test camera, microphone and connection/ }).click();
    await expect(r1.page.getByRole('alert')).toContainText('could not hear a clear voice', { timeout: 15_000 });
    expect(r1.state.requests.filter((request) => request.path === '/api/r1/preflight')).toEqual([]);
    const { tracks } = await r1.mock.snapshot();
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((track) => track.readyState === 'ended')).toBe(true);
    r1.expectHealthy();
  });
});

test.describe('the full interview', () => {
  test('consent, device check, join, role-play phases and a clean end', async ({ r1 }, testInfo) => {
    const { page } = r1;
    await openLink(r1);
    await agree(page);
    await expect(heading(page, 'Video interview')).toBeVisible();
    expect(bodiesOf(r1, '/api/r1/consent')).toEqual([
      expect.objectContaining({
        status: 'granted',
        consents: ['ai_interview', 'recording', 'ai_evaluation'],
        template_version: 'e2e-r1-v1',
        link_token: R1_LINK_TOKEN,
      }),
    ]);
    await passDeviceCheck(page);
    await page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(page.getByRole('region', { name: 'Live video interview' })).toBeVisible();

    // Order on the wire: attempt, then exchange, then the live room.
    expect(r1.state.requests.map((request) => request.path).filter((path) => /attempts|exchange/.test(path))).toEqual([
      '/api/r1/attempts',
      '/api/r1/exchange',
    ]);
    expect(bodiesOf(r1, '/api/r1/attempts')).toEqual([{ link_token: R1_LINK_TOKEN }]);
    expect(bodiesOf(r1, '/api/r1/exchange')).toEqual([{ attempt_token: R1_ATTEMPT_TOKEN, nonce: R1_NONCE }]);
    expect(await storedNonce(page)).toBe(R1_NONCE);
    // The entry names the link by a short digest and never holds the token itself.
    expect(await storedNonceRaw(page)).not.toContain(R1_LINK_TOKEN);
    expect(await page.evaluate(() => window.localStorage.length)).toBe(0);

    // The live room publishes the camera budget: 640x360 @ 15, simulcast off, 500 kbps.
    const afterJoin = await r1.mock.snapshot();
    expect(afterJoin.connects).toHaveLength(2);
    expect(afterJoin.roomOptions[1]).toMatchObject({
      adaptiveStream: false,
      dynacast: false,
      publishDefaults: { simulcast: false, videoEncoding: { maxBitrate: 500_000, maxFramerate: 15 } },
    });
    const live = afterJoin.publishes.filter((publish) => publish.roomIndex === 1);
    expect(live.map((publish) => publish.kind)).toEqual(['audio', 'video']);
    // The live microphone is published on the SDK defaults: only the device check overrides them.
    expect(live[0].options).toBeNull();
    expect(live[1].options).toEqual({ simulcast: false, videoEncoding: { maxBitrate: 500_000, maxFramerate: 15 } });

    // Before the interviewer joins: a plain label, no lead card.
    await expect(page.getByRole('status').filter({ hasText: 'Connecting' })).toBeVisible();
    // Once the interviewer is in the room, "waiting for your interviewer" is no longer true, even
    // though the worker has not published a phase yet.
    await r1.mock.joinAgent();
    await expect(page.getByRole('status').filter({ hasText: 'Interview in progress' })).toBeVisible();
    await expect(page.getByText(/Waiting for your interviewer/)).toHaveCount(0);
    await r1.mock.setPhase('icebreaker');
    await expect(page.getByText('Getting to know you')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your role-play' })).toHaveCount(0);

    // The agent speaks: the aura reacts and captions are labelled.
    await r1.mock.speak(0.6);
    await expect(page.getByLabel('Interviewer is speaking')).toBeVisible();
    await r1.mock.caption('c1', 'Could you walk me through your background?', true);
    await expect(page.getByText('Could you walk me through your background?')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Live captions' }).getByText('Interviewer')).toBeVisible();

    // The role-play: lead card and label, learner-labelled captions.
    await r1.mock.setPhase('transition');
    const lead = page.getByRole('region', { name: 'Your role-play' });
    await expect(lead.getByText('Meera from Pune')).toBeVisible();
    await r1.mock.setPhase('roleplay');
    await expect(page.getByRole('status').filter({ hasText: 'You are the Program Advisor' })).toBeVisible();
    await r1.mock.caption('c2', 'Hello? Yes, this is Meera speaking.', true);
    await expect(page.getByText('Learner (simulated by the AI)')).toBeVisible();
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-live-roleplay', { strict: true });

    // Someone who is not the interviewer cannot move the page or end it.
    await r1.mock.intrude({ phase: 'ended' });
    await expect(page.getByRole('region', { name: 'Live video interview' })).toBeVisible();
    await expect(lead).toBeVisible();

    await r1.mock.setPhase('roleplay_exit');
    await expect(page.getByRole('region', { name: 'Your role-play' })).toHaveCount(0);
    await r1.mock.setPhase('wrapup');
    await expect(page.getByText('Ask anything about the role or the next steps.')).toBeVisible();

    // The agent ends the interview: the page leaves the room itself.
    await r1.mock.setPhase('ended');
    await expect(heading(page, 'Your interview is complete.')).toBeVisible();
    const afterEnd = await r1.mock.snapshot();
    expect(afterEnd.disconnects.some((entry) => entry.roomIndex === 1 && entry.stopTracks)).toBe(true);
    expect(afterEnd.tracks.every((track) => track.readyState === 'ended')).toBe(true);
    expect(await storedNonceRaw(page)).toBeNull();
    // No link to /appeal: it needs a one-time grant R1 cannot issue yet, and without one that
    // page tells the candidate their own link is invalid.
    await expect(page.getByText(/reply to the hiring team.s email and they will send you an appeal link/)).toBeVisible();
    await expect(page.getByRole('link')).toHaveCount(0);
    await expect(page.locator('a[href*="appeal"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rejoin interview' })).toHaveCount(0);

    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-ended', { strict: true });
    expectCandidateHygiene(r1);
    r1.expectHealthy();
  });

  test('turning the camera off shows the banner, and on clears it', async ({ r1 }, testInfo) => {
    await reachLive(r1);
    const { page } = r1;
    await expect(page.getByText(/Your camera is off/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Turn camera off' }).click();
    await expect(page.getByText(/Your camera is off/)).toBeVisible();
    await auditA11y(page, testInfo, 'r1-live-camera-off', { strict: true });
    await page.getByRole('button', { name: 'Turn camera on' }).click();
    await expect(page.getByText(/Your camera is off/)).toHaveCount(0);

    await page.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(page.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true');
    r1.expectHealthy();
  });

  test('leaving asks first, then leaves the room and keeps the nonce for a rejoin', async ({ r1 }) => {
    await reachLive(r1);
    const { page } = r1;
    await page.getByRole('button', { name: 'Leave interview' }).click();
    await expect(page.getByText(/rejoin within 90 seconds/)).toBeVisible();
    // The way back is a button on the next screen, never "open your link again".
    await expect(page.getByText(/your link/i)).toHaveCount(0);
    await page.getByRole('button', { name: 'Stay in the interview' }).click();
    await expect(page.getByRole('region', { name: 'Live video interview' })).toBeVisible();

    await page.getByRole('button', { name: 'Leave interview' }).click();
    await page.getByRole('button', { name: 'Yes, leave' }).click();
    await expect(heading(page, 'You left the interview.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Rejoin interview' })).toBeVisible();
    expect(await storedNonce(page)).toBe(R1_NONCE);
    expect((await r1.mock.snapshot()).tracks.every((track) => track.readyState === 'ended')).toBe(true);
    expectCandidateHygiene(r1);
    r1.expectHealthy();
  });

  test('a dropped connection says so, keeps the nonce, and is not mistaken for a clean end', async ({ r1 }) => {
    await reachLive(r1);
    await r1.mock.joinAgent();
    await r1.mock.setPhase('roleplay');
    await r1.mock.drop();
    await expect(heading(r1.page, 'The connection to your interview ended.')).toBeVisible();
    expect(await storedNonce(r1.page)).toBe(R1_NONCE);
    r1.expectHealthy();
  });

  test('a dropped candidate rejoins from the same tab with the nonce the first attempt stored', async ({ r1 }, testInfo) => {
    // Nothing is seeded: the first attempt stores the nonce itself, as in a real session. A
    // reload would land on /candidate/r1 with no fragment, and the email link opens a new tab with
    // empty storage, so the in-page button is the only way back inside the 90 second window.
    await reachLive(r1);
    const { page } = r1;
    await r1.mock.joinAgent();
    await r1.mock.setPhase('roleplay');
    await r1.mock.drop();
    await expect(heading(page, 'The connection to your interview ended.')).toBeVisible();
    await expect(page.getByText(/select Rejoin within 90 seconds and keep this tab open/)).toBeVisible();
    await expect(page.getByText(/open your link/i)).toHaveCount(0);
    expect(page.url()).not.toContain(R1_LINK_TOKEN);
    expect(await storedNonce(page)).toBe(R1_NONCE);
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-ended-rejoin', { strict: true });

    await page.getByRole('button', { name: 'Rejoin interview' }).click();
    await expect(heading(page, 'Video interview')).toBeVisible();
    await passDeviceCheck(page);
    await page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(page.getByRole('region', { name: 'Live video interview' })).toBeVisible();

    // Without the nonce the fake server refuses the second attempt as r1_busy: the candidate's own
    // session is still live. It is admitted only because the page presented the stored nonce.
    expect(bodiesOf(r1, '/api/r1/attempts')).toEqual([
      { link_token: R1_LINK_TOKEN },
      { link_token: R1_LINK_TOKEN, nonce: R1_NONCE },
    ]);
    expect(bodiesOf(r1, '/api/r1/status')).toHaveLength(2);
    expect(bodiesOf(r1, '/api/r1/preflight')).toHaveLength(2);
    expect((await r1.mock.snapshot()).connects).toHaveLength(4);
    expectCandidateHygiene(r1);
    r1.expectHealthy();
  });

  test('a candidate who left on purpose can rejoin the same way', async ({ r1 }) => {
    await reachLive(r1);
    const { page } = r1;
    await page.getByRole('button', { name: 'Leave interview' }).click();
    await page.getByRole('button', { name: 'Yes, leave' }).click();
    await expect(heading(page, 'You left the interview.')).toBeVisible();
    await page.getByRole('button', { name: 'Rejoin interview' }).click();
    await passDeviceCheck(page);
    await page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(page.getByRole('region', { name: 'Live video interview' })).toBeVisible();
    expect(bodiesOf(r1, '/api/r1/attempts')[1]).toEqual({ link_token: R1_LINK_TOKEN, nonce: R1_NONCE });
    r1.expectHealthy();
  });

  test('a technical abort is told as a stop on our side, not as a finished interview', async ({ r1 }, testInfo) => {
    await reachLive(r1);
    const { page } = r1;
    await r1.mock.joinAgent();
    await r1.mock.setPhase('roleplay');
    await r1.mock.setPhase('aborted');
    await expect(page.getByText('Stopping early')).toBeVisible();
    await r1.mock.setPhase('ended');
    await expect(heading(page, 'Your interview was stopped because of a technical problem.')).toBeVisible();
    await expect(page.getByText(/will not count against you/)).toBeVisible();
    await expect(page.getByText(/will send you a new link/)).toBeVisible();
    await expect(page.getByText('Your interview is complete.')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Rejoin interview' })).toHaveCount(0);
    expect(await storedNonceRaw(page)).toBeNull();
    await auditA11y(page, testInfo, 'r1-aborted', { strict: true });
    r1.expectHealthy();
  });

  test('a room deleted while the interviewer was wrapping up is a finished interview', async ({ r1 }) => {
    await reachLive(r1);
    await r1.mock.joinAgent();
    await r1.mock.setPhase('wrapup');
    await r1.mock.setPhase('finishing');
    // The worker's `ended` attribute never arrived; the room was deleted (DisconnectReason 5).
    await r1.mock.drop(5);
    await expect(heading(r1.page, 'Your interview is complete.')).toBeVisible();
    await expect(r1.page.getByRole('button', { name: 'Rejoin interview' })).toHaveCount(0);
    r1.expectHealthy();
  });

  test('a room deleted mid role-play is still a lost connection', async ({ r1 }) => {
    await reachLive(r1);
    await r1.mock.joinAgent();
    await r1.mock.setPhase('roleplay');
    await r1.mock.drop(5);
    await expect(heading(r1.page, 'The connection to your interview ended.')).toBeVisible();
    await expect(r1.page.getByRole('button', { name: 'Rejoin interview' })).toBeVisible();
    r1.expectHealthy();
  });

  test('the label returns to waiting if the interviewer leaves before announcing a phase', async ({ r1 }) => {
    await reachLive(r1);
    await r1.mock.joinAgent();
    await expect(r1.page.getByText('Interview in progress')).toBeVisible();
    await r1.mock.removeAgent();
    await expect(r1.page.getByText('Connecting')).toBeVisible();
    r1.expectHealthy();
  });

  test('waits while the interviewer is prepared, polling the same exchange', async ({ r1 }) => {
    r1.state.exchangePreparing = 1;
    r1.state.consentRequired = false;
    await openLink(r1);
    await passDeviceCheck(r1.page);
    await r1.page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(heading(r1.page, 'Preparing your interview…')).toBeVisible();
    await expect(r1.page.getByRole('region', { name: 'Live video interview' })).toBeVisible({ timeout: 15_000 });
    expect(bodiesOf(r1, '/api/r1/attempts')).toHaveLength(1);
    expect(bodiesOf(r1, '/api/r1/exchange')).toHaveLength(2);
    r1.expectHealthy();
  });
});

test.describe('join failures keep the link valid and release the devices', () => {
  test('r1_busy is explained and the candidate can try again', async ({ r1 }, testInfo) => {
    r1.state.consentRequired = false;
    r1.state.failures.attempts = { status: 409, error: 'r1_busy' };
    await openLink(r1);
    await passDeviceCheck(r1.page);
    await r1.page.getByRole('button', { name: 'Continue to interview' }).click();
    const alert = r1.page.getByRole('alert');
    await expect(alert).toContainText('Another interview is finishing');
    await expect(alert).toContainText('Your link stays valid');
    await expect(r1.page.getByRole('button', { name: 'Check my camera and microphone' })).toBeEnabled();
    expect(bodiesOf(r1, '/api/r1/exchange')).toEqual([]);
    expect((await r1.mock.snapshot()).tracks.every((track) => track.readyState === 'ended')).toBe(true);
    await expectMobileFits(r1.page, testInfo);
    await auditA11y(r1.page, testInfo, 'r1-busy', { strict: true });
    r1.consoleErrors.length = 0; // a 409 is logged by the browser's network layer
    r1.expectHealthy();
  });

  test('a room that will not connect releases the devices and returns to the landing page', async ({ r1 }) => {
    r1.state.consentRequired = false;
    await openLink(r1);
    await passDeviceCheck(r1.page);
    await r1.mock.failNextConnect('signalling failed');
    await r1.page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(r1.page.getByRole('alert')).toContainText('could not start your interview');
    expect((await r1.mock.snapshot()).tracks.every((track) => track.readyState === 'ended')).toBe(true);
    r1.expectHealthy();
  });

  test('a failed connect keeps the nonce, so the retry is let back into the candidate\'s own session', async ({ r1 }) => {
    // The attempt was admitted before the room failed to connect (ICE or TCP blocked), so the
    // candidate's own session is live: a retry without the nonce is refused as r1_busy.
    r1.state.consentRequired = false;
    await openLink(r1);
    await passDeviceCheck(r1.page);
    await r1.mock.failNextConnect('could not establish pc connection');
    await r1.page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(r1.page.getByRole('alert')).toContainText('could not start your interview');
    expect(await storedNonce(r1.page)).toBe(R1_NONCE);

    await passDeviceCheck(r1.page);
    await r1.page.getByRole('button', { name: 'Continue to interview' }).click();
    await expect(r1.page.getByRole('region', { name: 'Live video interview' })).toBeVisible();
    expect(bodiesOf(r1, '/api/r1/attempts')).toEqual([
      { link_token: R1_LINK_TOKEN },
      { link_token: R1_LINK_TOKEN, nonce: R1_NONCE },
    ]);
    r1.expectHealthy();
  });
});
