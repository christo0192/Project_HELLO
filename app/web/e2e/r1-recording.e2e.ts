/**
 * R1 interview recordings, for staff (R1-REC).
 *
 * The app under test is the REAL app on the Vite dev server; only its backends are fake. The mint
 * answers with a `data:` URI (a 130 s silent WAV declared as a webm), so the player runs in a real
 * <video>/<audio> with no external request and without needing an H.264 decoder: this proves the
 * WIRING (when a link is minted, what is drawn, how the position is restored, where a transcript
 * click lands). Decoding a real H.264 + AAC file and seeking it accurately is checked by hand
 * (R1-REC E4), not here.
 *
 * Covers: Overview Load (video and audio-only), the Review tab's transcript click-to-seek (admin),
 * an expired link mid-view (exactly two mints, position restored), a bad first link (no automatic
 * retry), every state without a player, and a viewer (row and Load, denied transcript).
 */
import type { Locator } from '@playwright/test';
import { auditA11y } from './fixtures/axe';
import {
  R1_CANDIDATE_ID,
  R1_REC_LENGTH_SEC,
  R1_SESSION_ATTEMPT_1,
  R1_SESSION_ATTEMPT_2,
  R1_TURN_LATE_SEC,
} from './fixtures/data';
import { horizontalOverflow } from './fixtures/layout';
import { expect, test, type AppHarness } from './fixtures/harness';

const OVERVIEW = `/candidates/${R1_CANDIDATE_ID}?tab=overview`;
const REVIEW = `/candidates/${R1_CANDIDATE_ID}?tab=review`;

/** The recording mints so far (a GET each, never a POST: a viewer cannot POST). */
const mints = (app: AppHarness) => app.calls.filter((c) => /\/api\/interview-rounds\/[^/]+\/recording\?session_id=/.test(c.url));

const position = (media: Locator) => media.evaluate((el: HTMLMediaElement) => el.currentTime);
const duration = (media: Locator) => media.evaluate((el: HTMLMediaElement) => el.duration);

async function noSideways(app: AppHarness, projectName: string) {
  if (projectName === 'mobile') {
    expect(await horizontalOverflow(app.page), 'the page must not scroll sideways at 390 px').toEqual({ overflowPx: 0, offenders: [] });
  }
}

test.describe('Overview: one row per attempt', () => {
  test('Load recording mints once, on the click, and plays the attempt in a <video> from a data: link', async ({ app, page }, testInfo) => {
    await app.goto(OVERVIEW);
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    await expect(first).toBeVisible();
    // Nothing was minted by drawing the page.
    expect(mints(app)).toHaveLength(0);
    await expect(first.locator('video, audio')).toHaveCount(0);
    await expect(first.getByText(/Length 2m 10s/)).toBeVisible();
    await expect(first.getByText(/Kept until/)).toBeVisible();

    await first.getByRole('button', { name: 'Load recording, Attempt 1 (counted)' }).click();
    const video = first.locator('video');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute('src', /^data:/);
    await expect(video).toHaveAttribute('controls', '');
    await expect(video).toHaveAttribute('preload', 'metadata');
    await expect(video).toHaveAttribute('controlslist', 'nodownload');
    await expect(video).not.toHaveAttribute('crossorigin', /.*/);
    await expect.poll(() => duration(video)).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);

    expect(mints(app)).toHaveLength(1);
    expect(mints(app)[0].method).toBe('GET');
    expect(mints(app)[0].url).toContain(`session_id=${R1_SESSION_ATTEMPT_1}`);
    // The signed link is nowhere in the text of the page.
    await expect(page.locator('body')).not.toContainText('data:audio');
    expect(app.external).toEqual([]);

    await noSideways(app, testInfo.project.name);
    await auditA11y(page, testInfo, 'r1-recording-ready', { strict: true });
    app.expectHealthy();
  });

  test('an attempt with no picture is an <audio>, not a black box', async ({ app, page }) => {
    await app.goto(OVERVIEW);
    const second = page.getByRole('group', { name: 'Attempt 2 (retake)' });
    await second.getByRole('button', { name: 'Load recording, Attempt 2 (retake)' }).click();
    await expect(second.locator('audio')).toHaveCount(1);
    await expect(second.locator('video')).toHaveCount(0);
    await expect.poll(() => duration(second.locator('audio'))).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    app.expectHealthy();
  });

  test('two attempts: each has its own Load, and loading one does not mint the other', async ({ app, page }) => {
    await app.goto(OVERVIEW);
    await page.getByRole('button', { name: 'Load recording, Attempt 2 (retake)' }).click();
    await expect(page.locator('audio')).toHaveCount(1);
    expect(mints(app)).toHaveLength(1);
    expect(mints(app)[0].url).toContain(`session_id=${R1_SESSION_ATTEMPT_2}`);
    await expect(page.getByRole('button', { name: 'Load recording, Attempt 1 (counted)' })).toBeVisible();
    app.expectHealthy();
  });
});

test.describe('Review tab (admin): click a transcript turn to seek', () => {
  test('the R1 session plays through the R1 player, never the legacy one, and a click lands on the turn', async ({ app, page }, testInfo) => {
    await app.goto(REVIEW);
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    await panel.getByRole('combobox').selectOption(R1_SESSION_ATTEMPT_1);
    await expect(panel.getByRole('option', { name: /R1 role-play/ })).toHaveCount(2);

    // The R1 player, not the legacy "Recording loads on request" row.
    const load = panel.getByRole('button', { name: 'Load recording, R1 role-play' });
    await expect(load).toBeVisible();
    await expect(panel.getByText('Recording loads on request; the link expires automatically.')).toHaveCount(0);

    // Turns are placed on the recording from its anchor; the one with no time stays untimed.
    const late = panel.getByRole('button', { name: /Turn 2:/ });
    await expect(late).toContainText('1:10');
    await expect(panel.getByRole('button', { name: /Turn 1:/ })).toContainText('0:05');
    await expect(panel.getByText('no timing data')).toHaveCount(1);
    expect(mints(app)).toHaveLength(0);

    await late.click();
    const video = panel.locator('video');
    await expect(video).toHaveCount(1);
    // Seeks to the turn less the one-second lead-in (same tolerance as transcript-seek.e2e.ts).
    const target = R1_TURN_LATE_SEC - 1;
    await expect.poll(() => position(video), { timeout: 10_000 }).toBeGreaterThanOrEqual(target - 1);
    expect(await position(video)).toBeLessThan(target + 15);

    // An earlier turn seeks backwards in the same, already loaded, file: no second mint.
    await panel.getByRole('button', { name: /Turn 1:/ }).click();
    await expect.poll(() => position(video), { timeout: 10_000 }).toBeLessThan(10);
    expect(mints(app)).toHaveLength(1);

    // No legacy download was ever asked for an R1 session.
    expect(app.calls.filter((c) => /\/api\/recordings\//.test(c.url))).toEqual([]);

    await noSideways(app, testInfo.project.name);
    app.expectHealthy();
  });

  test('a bare link lands on the Review tab with the newest R1 session, not a broken legacy player', async ({ app, page }) => {
    await app.goto(`/candidates/${R1_CANDIDATE_ID}`);
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    // The default selection is the newest session: the retake, which has a recording of its own.
    await expect(panel.getByRole('button', { name: 'Load recording, R1 role-play' })).toBeVisible();
    await expect(panel.getByText('Recording loads on request; the link expires automatically.')).toHaveCount(0);
    expect(app.calls.filter((c) => /\/api\/recordings\//.test(c.url))).toEqual([]);
    app.expectHealthy();
  });
});

test.describe('the link expires, or was bad to begin with', () => {
  test('an error after metadata: exactly one more mint, a new link, and the position is restored', async ({ app, page }) => {
    await app.goto(OVERVIEW);
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    await first.getByRole('button', { name: /^Load recording/ }).click();
    const video = first.locator('video');
    await expect.poll(() => duration(video)).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    const firstLink = (await video.getAttribute('src'))!;

    await video.evaluate((el: HTMLMediaElement) => {
      el.currentTime = 40;
    });
    await expect.poll(() => position(video)).toBeGreaterThanOrEqual(39);

    // The next mint is a NEW link (a different signature in real life; a different media-type
    // parameter here), then the browser reports the old one dead, as it does at expiry.
    app.db.r1.mints[R1_SESSION_ATTEMPT_1] = [
      { url: firstLink.replace('data:audio/wav;', 'data:audio/wav;v=2;'), content_type: 'video/webm', expires_in_sec: 300 },
    ];
    await video.evaluate((el: HTMLMediaElement) => {
      el.dispatchEvent(new Event('error'));
    });

    await expect.poll(() => mints(app).length).toBe(2);
    await expect(video).toHaveAttribute('src', /v=2/);
    expect((await video.getAttribute('src')) !== firstLink).toBe(true);
    // The new file loads and the playhead goes back to where it was.
    await expect.poll(() => position(video), { timeout: 10_000 }).toBeGreaterThanOrEqual(39);
    expect(await position(video)).toBeLessThan(55);
    await expect(first.getByRole('alert')).toHaveCount(0);
    app.expectHealthy();
  });

  test('an error before metadata (a bad first link): the error block at once, no automatic retry; Try again works', async ({ app, page }, testInfo) => {
    await app.goto(OVERVIEW);
    // First mint: undecodable. Second: the playable default (`null`).
    app.db.r1.mints[R1_SESSION_ATTEMPT_1] = [{ url: 'data:audio/wav;base64,AAAA', content_type: 'video/webm', expires_in_sec: 300 }, null];
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    await first.getByRole('button', { name: /^Load recording/ }).click();

    const alert = first.getByRole('alert');
    await expect(alert).toContainText('The recording could not be played. Try again.');
    await expect(first.locator('video')).toHaveCount(0);
    // It did not retry on its own.
    expect(mints(app)).toHaveLength(1);
    await auditA11y(page, testInfo, 'r1-recording-error', { strict: true });

    await first.getByRole('button', { name: 'Try again, Attempt 1 (counted)' }).click();
    await expect(first.locator('video')).toHaveCount(1);
    await expect.poll(() => duration(first.locator('video'))).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    expect(mints(app)).toHaveLength(2);
    app.expectHealthy();
  });
});

test.describe('states without a player', () => {
  const STATES = [
    ['processing', { state: 'processing' as const }, 'The recording is being prepared. This usually takes a few minutes.', false],
    ['recording', { state: 'recording' as const }, 'In progress. It can be played a few minutes after the interview ends.', false],
    ['failed', { state: 'failed' as const, reason: 'integrity' }, 'It failed an integrity check and is withheld.', true],
    [
      'deleted',
      { state: 'deleted' as const, reason: 'retention', deleted_at: '2026-12-01T08:00:00.000Z' },
      'after the retention period',
      true,
    ],
  ] as const;

  for (const [name, recording, words, strictAxe] of STATES) {
    test(`${name}: says so, and there is no media element and no Load`, async ({ app, page }, testInfo) => {
      Object.assign(app.db.r1.rounds[0].attempts![0], { recording: { ...app.db.r1.rounds[0].attempts![0].recording, ...recording } });
      await app.goto(OVERVIEW);
      const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
      await expect(first).toContainText(words);
      await expect(first.locator('video, audio')).toHaveCount(0);
      await expect(first.getByRole('button', { name: /^Load recording/ })).toHaveCount(0);
      expect(mints(app)).toHaveLength(0);
      await noSideways(app, testInfo.project.name);
      if (strictAxe) await auditA11y(page, testInfo, `r1-recording-${name}`, { strict: true });
      app.expectHealthy();
    });
  }

  test('processing offers "Check again", which re-reads the rounds and then offers Load', async ({ app, page }) => {
    const recording = app.db.r1.rounds[0].attempts![0].recording;
    app.db.r1.rounds[0].attempts![0].recording = { ...recording, state: 'processing' };
    await app.goto(OVERVIEW);
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    const reads = () => app.calls.filter((c) => /\/interview-rounds$/.test(c.url)).length;
    const before = reads();
    // The recording finishes on the server.
    app.db.r1.rounds[0].attempts![0].recording = recording;
    await first.getByRole('button', { name: 'Check again, Attempt 1 (counted)' }).click();
    await expect(first.getByRole('button', { name: 'Load recording, Attempt 1 (counted)' })).toBeVisible();
    expect(reads()).toBeGreaterThan(before);
    app.expectHealthy();
  });

  test('a completed round says plainly when no recording was made', async ({ app, page }) => {
    app.db.r1.rounds[0].attempts![0].recording = { state: 'none' };
    await app.goto(OVERVIEW);
    await expect(page.getByRole('group', { name: 'Attempt 1 (counted)' })).toContainText('No recording was made for this attempt.');
    app.expectHealthy();
  });

  test('a recording that the mint finds deleted replaces the player in place', async ({ app, page }) => {
    await app.goto(OVERVIEW);
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    // Consent was withdrawn after the list was read.
    app.db.r1.rounds[0].attempts![0].recording = {
      ...app.db.r1.rounds[0].attempts![0].recording,
      state: 'deleted',
      reason: 'consent_withdrawn',
      deleted_at: '2026-12-01T08:00:00.000Z',
    };
    await first.getByRole('button', { name: /^Load recording/ }).click();
    await expect(first).toContainText('because consent was withdrawn');
    await expect(first.locator('video, audio')).toHaveCount(0);
    app.expectHealthy();
  });
});

test.describe('a viewer', () => {
  test('sees the row and can load the recording; the Review tab points to the Overview tab', async ({ app, page }, testInfo) => {
    app.db.me.role = 'viewer';
    await app.goto(OVERVIEW);
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    await expect(first).toBeVisible();
    // Read-only card: none of the round's actions, and the only button in the row is Load.
    await expect(page.getByRole('button', { name: /Reissue link|Cancel round|Grant retake|Send R1/ })).toHaveCount(0);
    await expect(first.getByRole('button')).toHaveCount(1);
    await first.getByRole('button', { name: /^Load recording/ }).click();
    await expect(first.locator('video')).toHaveCount(1);
    expect(mints(app)).toHaveLength(1);
    expect(mints(app)[0].method).toBe('GET');

    // The transcript is admin-only (the API says 403): the Review tab says where the recording is.
    await page.getByRole('tab', { name: 'Review' }).click();
    const panel = page.getByRole('tabpanel', { name: 'Review' });
    await expect(panel.getByText('The recording is on the Overview tab.')).toBeVisible();
    await expect(panel.getByRole('button', { name: /Load recording/ })).toHaveCount(0);
    await noSideways(app, testInfo.project.name);

    // The 403 is the point of the test, and the browser logs it; nothing else may be logged.
    const others = app.consoleErrors.filter((e) => !/status of 403/.test(e));
    app.consoleErrors.splice(0, app.consoleErrors.length, ...others);
    app.expectHealthy();
  });
});

test.describe('a hidden tab does not keep playing', () => {
  test('switching to the Review tab pauses the Overview recording', async ({ app, page }) => {
    await app.goto(OVERVIEW);
    const first = page.getByRole('group', { name: 'Attempt 1 (counted)' });
    await first.getByRole('button', { name: /^Load recording/ }).click();
    const video = first.locator('video');
    await expect.poll(() => duration(video)).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    // Muted autoplay is always allowed; the point is only that the page pauses what is playing.
    await video.evaluate(async (el: HTMLMediaElement) => {
      el.muted = true;
      await el.play();
    });
    await expect.poll(() => video.evaluate((el: HTMLMediaElement) => el.paused)).toBe(false);
    await page.getByRole('tab', { name: 'Review' }).click();
    // The Overview panel is hidden now, so a ROLE locator no longer finds the video (hidden
    // elements are left out of the accessibility tree); a CSS locator still does. It is the only
    // <video> on the page: the Review tab's player has not loaded one.
    const hidden = page.locator('video');
    await expect(hidden).toHaveCount(1);
    await expect.poll(() => hidden.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    // The position and the link survive: coming back does not need another mint, and it does not
    // start playing again by itself.
    const stoppedAt = await hidden.evaluate((el: HTMLMediaElement) => el.currentTime);
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(video).toHaveAttribute('src', /^data:/);
    expect(await video.evaluate((el: HTMLMediaElement) => el.paused)).toBe(true);
    expect(await position(video)).toBeCloseTo(stoppedAt, 0);
    expect(mints(app)).toHaveLength(1);
    app.expectHealthy();
  });
});
