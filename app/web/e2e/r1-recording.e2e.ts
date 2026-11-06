/**
 * R1 interview recordings, for staff (R1-REC), now that R1 has a home of its own.
 *
 * The app under test is the REAL app on the Vite dev server; only its backends are fake. The mint
 * answers with a `data:` URI (a 130 s silent WAV declared as a webm), so the player runs in a real
 * <video>/<audio> with no external request and without needing an H.264 decoder: this proves the
 * WIRING (when a link is minted, what is drawn, how the position is restored). Decoding a real
 * H.264 + AAC file and seeking it accurately is checked by hand (R1-REC E4), not here.
 *
 * Covers: the candidate's R1 tab (a chip per attempt, no player, the way to the review), every state of
 * a chip, the phone tab with R1 out of it, a viewer, an appeal, old links, the redirect from
 * /sessions/:id, and on the review page an expired link mid-view (exactly two mints, position restored)
 * and a bad first link (no automatic retry). The rest of the review page is r1-review.e2e.ts.
 */
import type { Locator } from '@playwright/test';
import { auditA11y } from './fixtures/axe';
import {
  R1_CANDIDATE_ID,
  R1_REC_LENGTH_SEC,
  R1_ROUND_ID,
  R1_SESSION_ATTEMPT_1,
  R1_SESSION_ATTEMPT_2,
} from './fixtures/data';
import { horizontalOverflow } from './fixtures/layout';
import { expect, test, type AppHarness } from './fixtures/harness';

const CANDIDATE = `/candidates/${R1_CANDIDATE_ID}`;
const R1_TAB = `${CANDIDATE}?tab=r1`;
const RECORDING = `/interviews/${R1_ROUND_ID}?tab=recording`;

/** The recording mints so far (a GET each, never a POST: a viewer cannot POST). */
const mints = (app: AppHarness) => app.calls.filter((c) => /\/api\/interview-rounds\/[^/]+\/recording\?session_id=/.test(c.url));

const position = (media: Locator) => media.evaluate((el: HTMLMediaElement) => el.currentTime);
const duration = (media: Locator) => media.evaluate((el: HTMLMediaElement) => el.duration);

async function noSideways(app: AppHarness, projectName: string) {
  if (projectName === 'mobile') {
    expect(await horizontalOverflow(app.page), 'the page must not scroll sideways at 390 px').toEqual({ overflowPx: 0, offenders: [] });
  }
}

test.describe('the R1 tab', () => {
  test('one row per round: status, attempts, a chip per attempt and the way to the review, and no player', async ({ app, page }, testInfo) => {
    await app.goto(R1_TAB);
    const panel = page.getByRole('tabpanel', { name: 'R1 interview' });
    const rounds = panel.getByRole('list', { name: 'R1 rounds' });
    await expect(rounds.getByText('Attempt 1 (counted): Ready')).toBeVisible();
    await expect(rounds.getByText('Attempt 2 (retake): Ready')).toBeVisible();
    await expect(rounds.getByText('2 of 2 attempts used')).toBeVisible();
    await expect(rounds.getByRole('link', { name: 'Open R1 review' })).toHaveAttribute('href', `/interviews/${R1_ROUND_ID}`);

    await expect(page.locator('video, audio')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Load recording/ })).toHaveCount(0);
    expect(mints(app)).toHaveLength(0);

    await noSideways(app, testInfo.project.name);
    await auditA11y(page, testInfo, 'r1-tab', { strict: true });
    app.expectHealthy();
  });

  test('the row opens the review, where the recording plays', async ({ app, page }) => {
    await app.goto(R1_TAB);
    await page.getByRole('link', { name: 'Open R1 review' }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}$`));
    await page.getByRole('tab', { name: 'Recording' }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('video')).toHaveCount(1);
    expect(mints(app)).toHaveLength(1);
    expect(mints(app)[0].method).toBe('GET');
    expect(app.external).toEqual([]);
    app.expectHealthy();
  });

  const STATES = [
    ['processing', { state: 'processing' as const }, 'Processing'],
    ['recording', { state: 'recording' as const }, 'Recording'],
    ['failed', { state: 'failed' as const, reason: 'integrity' }, 'Unavailable'],
    ['deleted', { state: 'deleted' as const, reason: 'retention', deleted_at: '2026-12-01T08:00:00.000Z' }, 'Deleted'],
    ['none', { state: 'none' as const }, 'No recording'],
  ] as const;

  for (const [name, recording, word] of STATES) {
    test(`${name}: the chip says so in a word, and nothing plays`, async ({ app, page }, testInfo) => {
      Object.assign(app.db.r1.rounds[0].attempts![0], { recording: { ...app.db.r1.rounds[0].attempts![0].recording, ...recording } });
      await app.goto(R1_TAB);
      await expect(page.getByRole('list', { name: 'Recordings' }).getByText(`Attempt 1 (counted): ${word}`)).toBeVisible();
      await expect(page.locator('video, audio')).toHaveCount(0);
      expect(mints(app)).toHaveLength(0);
      await noSideways(app, testInfo.project.name);
      app.expectHealthy();
    });
  }

  test('a viewer sees the row and can reach the recording, and is offered no action', async ({ app, page }, testInfo) => {
    app.db.me.role = 'viewer';
    await app.goto(R1_TAB);
    await expect(page.getByRole('list', { name: 'Recordings' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Reissue link|Cancel round|Grant retake|Send R1/ })).toHaveCount(0);
    await page.getByRole('link', { name: 'Open R1 review' }).click();
    await page.getByRole('tab', { name: 'Recording' }).click();
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await expect(page.locator('video')).toHaveCount(1);
    expect(mints(app)).toHaveLength(1);
    await noSideways(app, testInfo.project.name);
    app.expectHealthy();
  });

  test('while an appeal blocks decision use the result is withheld, the chip stays, and no R1 line is in the header', async ({ app, page }, testInfo) => {
    const detail = app.db.candidateDetail;
    app.db.candidateDetail = (id) => {
      const found = detail(id);
      return found && { ...found, candidate: { ...found.candidate, decision_use_blocked_at: '2026-10-05T00:00:00.000Z' } };
    };
    Object.assign(app.db.r1.rounds[0], { recommendation: 'hold', overall: 58 });
    await app.goto(R1_TAB);
    const rounds = page.getByRole('list', { name: 'R1 rounds' });
    await expect(rounds.getByText('Scorecards are suppressed while an appeal is under review.')).toBeVisible();
    await expect(rounds.getByText(/No results yet/)).toHaveCount(0);
    await expect(rounds.getByText('Attempt 1 (counted): Ready')).toBeVisible();
    await expect(page.getByText(/^R1 role-play:/)).toHaveCount(0);
    await noSideways(app, testInfo.project.name);
    await auditA11y(page, testInfo, 'r1-tab-appeal', { strict: true });
    app.expectHealthy();
  });
});

test.describe('the header', () => {
  test('the score stays the phone one, with the R1 result on a line of its own, labelled AI', async ({ app, page }, testInfo) => {
    Object.assign(app.db.r1.rounds[0], { recommendation: 'hold', overall: 58 });
    await app.goto(R1_TAB);
    await expect(page.getByText('R1 role-play: Borderline 58 (AI)')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Latest screening score' })).not.toContainText('58');
    await noSideways(app, testInfo.project.name);
    app.expectHealthy();
  });

  test('on Phone screening the header is compact: the score steps aside and the R1 result stays, among the facts', async ({ app, page }, testInfo) => {
    Object.assign(app.db.r1.rounds[0], { recommendation: 'hold', overall: 58 });
    const read = app.db.candidateDetail;
    const phone = {
      ...read(R1_CANDIDATE_ID)!.sessions[0],
      id: '33333333-3333-4333-8333-333333333399',
      mode: 'live' as const,
      interview_round_id: null,
    };
    app.db.sessionDetails[phone.id] = { session: phone, transcript: [], assessment: null };
    app.db.candidateDetail = (id) => {
      const found = read(id);
      return found && { ...found, sessions: [phone, ...found.sessions] };
    };
    await app.goto(`${CANDIDATE}?tab=phone`);
    await expect(page.getByRole('tabpanel', { name: 'Phone screening' }).locator('[data-log-header]')).toBeVisible();
    await expect(page.getByText('R1 role-play: Borderline 58 (AI)')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Latest screening score' })).toHaveCount(0);
    await noSideways(app, testInfo.project.name);
    app.expectHealthy();
  });
});

test.describe('the Phone screening tab', () => {
  test('has no R1 session in it, and asks nothing of R1', async ({ app, page }) => {
    await app.goto(`${CANDIDATE}?tab=phone`);
    const panel = page.getByRole('tabpanel', { name: 'Phone screening' });
    await expect(panel.getByText(/R1 role-play/)).toHaveCount(0);
    await expect(page.locator('video')).toHaveCount(0);
    expect(mints(app)).toHaveLength(0);
    // Neither attempt's transcript was read for the phone workspace.
    expect(app.calls.filter((c) => /\/api\/screening\//.test(c.url))).toEqual([]);
    app.expectHealthy();
  });
});

test.describe('where a link lands', () => {
  test('a bare link to a candidate with only an R1 interview opens the R1 tab', async ({ app, page }) => {
    await app.goto(CANDIDATE);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('R1 interview');
    app.expectHealthy();
  });

  for (const [old, name] of [['overview', 'Profile'], ['review', 'Phone screening']] as const) {
    test(`?tab=${old} still opens, on ${name}`, async ({ app, page }) => {
      await app.goto(`${CANDIDATE}?tab=${old}`);
      await expect(page.getByRole('tab', { selected: true })).toHaveText(name);
      app.expectHealthy();
    });
  }

  test('/sessions/:id for an R1 session goes to that attempt\'s recording', async ({ app, page }) => {
    await app.goto(`/sessions/${R1_SESSION_ATTEMPT_2}`);
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}\\?attempt=2&tab=recording$`));
    await expect(page.getByRole('tab', { name: 'Recording' })).toHaveAttribute('aria-selected', 'true');
    app.expectHealthy();
  });

  test('the scorecard of an attempt a retake replaced stays one click away, now the session page redirects', async ({ app, page }) => {
    const deciding = app.db.r1.review.assessment!;
    app.db.r1.review.replaced_assessments = [
      { ...deciding, id: 'replaced-scorecard', session_id: R1_SESSION_ATTEMPT_2, recommendation: 'reject', raw_recommendation: 'reject', overall_score: 31 },
    ];
    await app.goto(`/interviews/${R1_ROUND_ID}?attempt=2`);
    const result = page.getByRole('region', { name: 'AI recommendation' });
    await expect(result).toContainText('Reject');
    await expect(result).toContainText('A later attempt replaced it as the result of this round.');
    await page.getByRole('group', { name: 'Attempt' }).getByRole('button', { name: 'Attempt 1 (counted)' }).click();
    await expect(result).not.toContainText('A later attempt replaced it');
    app.expectHealthy();
  });

  test('the sessions list on Profile goes straight there too', async ({ app, page }) => {
    await app.goto(`${CANDIDATE}?tab=profile`);
    await page.getByRole('link', { name: 'View details for session 1' }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}\\?attempt=1&tab=recording$`));
    app.expectHealthy();
  });
});

test.describe('the review page at 1366x768', () => {
  test('the video stays on screen beside a transcript with room to read', async ({ app, page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await app.goto(RECORDING);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const video = page.locator('video');
    await expect.poll(() => duration(video)).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    await video.evaluate((el: HTMLMediaElement) => el.pause());
    await expect(video).toBeInViewport({ ratio: 1 });
    const transcript = (await page.getByRole('region', { name: 'Transcript turns' }).boundingBox())!;
    expect(transcript.height).toBeGreaterThan(300);
    app.expectHealthy();
  });
});

test.describe('the link expires, or was bad to begin with', () => {
  test('an error after metadata: exactly one more mint, a new link, and the position is restored', async ({ app, page }) => {
    await app.goto(RECORDING);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const video = page.locator('video');
    await expect.poll(() => duration(video)).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    const firstLink = (await video.getAttribute('src'))!;

    await video.evaluate((el: HTMLMediaElement) => {
      el.pause();
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
    await expect(page.getByRole('tabpanel', { name: 'Recording' }).getByRole('alert')).toHaveCount(0);
    app.expectHealthy();
  });

  test('an error before metadata (a bad first link): the error block at once, no automatic retry; Try again works', async ({ app, page }, testInfo) => {
    await app.goto(RECORDING);
    // First mint: undecodable. Second: the playable default (`null`).
    app.db.r1.mints[R1_SESSION_ATTEMPT_1] = [{ url: 'data:audio/wav;base64,AAAA', content_type: 'video/webm', expires_in_sec: 300 }, null];
    await page.getByRole('button', { name: 'Play', exact: true }).click();

    const panel = page.getByRole('tabpanel', { name: 'Recording' });
    await expect(panel.getByRole('alert')).toContainText('The recording could not be played. Try again.');
    await expect(page.locator('video')).toHaveCount(0);
    // It did not retry on its own.
    expect(mints(app)).toHaveLength(1);
    await auditA11y(page, testInfo, 'r1-recording-error', { strict: true });

    await panel.getByRole('button', { name: /^Try again/ }).click();
    await expect(page.locator('video')).toHaveCount(1);
    await expect.poll(() => duration(page.locator('video'))).toBeGreaterThan(R1_REC_LENGTH_SEC - 5);
    expect(mints(app)).toHaveLength(2);
    app.expectHealthy();
  });
});
