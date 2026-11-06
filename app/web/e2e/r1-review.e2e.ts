/**
 * The R1 review page in a real browser: real layout, real <video>, real axe.
 *
 * The app under test is the real app; only its backends are fake. The mint answers with a `data:` URI,
 * so this proves the wiring (when a link is minted, what is drawn, where a click lands), not decoding.
 * Nothing here measures time: the harness's clock is frozen.
 *
 * The screenshots are the look at each tab at 1440x900.
 */
import path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { ARTIFACTS_DIR, auditA11y } from './fixtures/axe';
import { R1_CANDIDATE_ID, R1_ROUND_ID, R1_REVIEW_CUT_TURN, R1_REVIEW_SEEK_SEC } from './fixtures/data';
import { expect, test, type AppHarness } from './fixtures/harness';
import { horizontalOverflow } from './fixtures/layout';

const ADDRESS = `/interviews/${R1_ROUND_ID}`;

const mints = (app: AppHarness) => app.calls.filter((c) => /\/api\/interview-rounds\/[^/]+\/recording\?session_id=/.test(c.url));
const reads = (app: AppHarness) => app.calls.filter((c) => /\/api\/interview-rounds\/[^/]+\/review$/.test(c.url));
const position = (media: Locator) => media.evaluate((el: HTMLMediaElement) => el.currentTime);
const lit = (page: Page) => page.locator('[data-turn-row][aria-current="true"]');

async function look(page: Page, name: string, project: string) {
  await page.screenshot({ path: path.join(ARTIFACTS_DIR, 'r1-review', project, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

async function noSideways(app: AppHarness) {
  expect(await horizontalOverflow(app.page), 'the page must not scroll sideways').toEqual({ overflowPx: 0, offenders: [] });
}

test.describe('a look at each tab', () => {
  for (const tab of ['overview', 'briefing', 'resume', 'recording'] as const) {
    test(`${tab} reads, fits and passes axe`, async ({ app, page }, testInfo) => {
      await app.goto(`${ADDRESS}?tab=${tab}`);
      await expect(page.getByRole('heading', { level: 1 })).toContainText('Sales Program Advisor role-play, Naveen Kapoor');
      await expect(page.getByRole('tab', { selected: true })).toHaveText(new RegExp(tab, 'i'));
      await noSideways(app);
      await look(page, tab, testInfo.project.name);
      await auditA11y(page, testInfo, `r1-review-${tab}`, { strict: true });
      expect(mints(app)).toHaveLength(0);
      app.expectHealthy();
    });
  }

  test('Recording keeps the video, the controls and the strip on the first screen', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'the first-screen rule is for the 1440x900 layout');
    await app.goto(`${ADDRESS}?tab=recording`);
    const bottom = await page.locator('[data-call-strip]').evaluate((el) => el.getBoundingClientRect().bottom);
    expect(bottom).toBeLessThanOrEqual(900);
    const video = await page.locator('[data-r1-recording-state]').boundingBox();
    const transcript = await page.getByRole('region', { name: 'Transcript', exact: true }).boundingBox();
    expect(video!.x + video!.width).toBeLessThan(transcript!.x);
  });

  test('draws talk from stored ends, and leaves a cut AI line a tick', async ({ app, page }) => {
    const { attempts } = app.db.r1.review;
    await app.goto(`${ADDRESS}?tab=recording`);
    await expect(page.locator('[data-talk-bar]')).toHaveCount(attempts[0].turns.length - 1);
    await expect(page.locator('[data-turn-tick]')).toHaveCount(1);
    expect(attempts[0].turns[R1_REVIEW_CUT_TURN].interrupted).toBe(true);
    await expect(page.locator(`[data-turn-row="${R1_REVIEW_CUT_TURN}"]`)).toContainText('Cut off');
  });

  test('an older interview has no stored ends, so every turn is a tick', async ({ app, page }) => {
    const { review } = app.db.r1;
    const turns = review.attempts[0].turns.map((turn) => ({ ...turn, turn_ended_at_ms: null, ai_voice: null }));
    app.db.r1.review = { ...review, attempts: [{ ...review.attempts[0], turns }] };
    await app.goto(`${ADDRESS}?tab=recording`);
    await expect(page.locator('[data-talk-bar]')).toHaveCount(0);
    await expect(page.locator('[data-turn-tick]')).toHaveCount(turns.length);
  });

  test('three attempts wrap inside the header, so a phone never scrolls sideways', async ({ app, page }) => {
    const { review } = app.db.r1;
    const [scored] = review.attempts;
    const start = (session: string, attempt: number, counted: boolean) => ({ ...scored, session_id: session, attempt_number: attempt, counted, turns: [] });
    app.db.r1.review = { ...review, attempts: [start('11111111-1111-4111-8111-111111111111', 1, false), { ...scored, counted: true }, start('22222222-2222-4222-8222-222222222222', 2, true)] };
    await page.setViewportSize({ width: 390, height: 844 });
    await app.goto(ADDRESS);
    await expect(page.getByRole('group', { name: 'Attempt' }).getByRole('button')).toHaveCount(3);
    await noSideways(app);
  });

  test('stacks the transcript under the strip below 1180 px', async ({ app, page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'set by width');
    await page.setViewportSize({ width: 1100, height: 800 });
    await app.goto(`${ADDRESS}?tab=recording`);
    const strip = await page.locator('[data-call-strip]').boundingBox();
    const transcript = await page.getByRole('region', { name: 'Transcript', exact: true }).boundingBox();
    expect(transcript!.y).toBeGreaterThanOrEqual(strip!.y + strip!.height);
    await noSideways(app);
  });
});

test.describe('forced colours', () => {
  test('the marks on the strip survive: they are fills, which forcing would drop', async ({ app, page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await app.goto(`${ADDRESS}?tab=recording`);
    const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    for (const selector of ['[data-playhead]', '[data-turn-tick]']) {
      const fill = await page.locator(selector).first().evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(fill, selector).not.toBe(canvas);
      expect(fill, selector).not.toBe('rgba(0, 0, 0, 0)');
    }
  });
});

test.describe('getting there', () => {
  test('opens from the R1 tab', async ({ app, page }) => {
    await app.goto(`/candidates/${R1_CANDIDATE_ID}?tab=r1`);
    await page.getByRole('link', { name: 'Open R1 review' }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sales Program Advisor role-play');
    // How many: the dev server runs StrictMode, which reads twice. The unit test pins exactly one.
    expect(reads(app).length).toBeGreaterThan(0);
    expect(app.unmocked).toEqual([]);
  });

  test('an address that opens nothing says so, in one plain state', async ({ app, page }) => {
    await app.goto('/interviews/99999999-9999-4999-8999-999999999999');
    await expect(page.getByText('This interview is not available.')).toBeVisible();
    await expect(page.getByRole('tablist')).toHaveCount(0);
  });
});

test.describe('playing', () => {
  test('mints on the first play, with no native controls', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    await expect(page.locator('video, audio')).toHaveCount(0);
    expect(mints(app)).toHaveLength(0);

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const video = page.locator('video');
    await expect(video).toHaveCount(1);
    await expect(video).toHaveAttribute('controlslist', 'nodownload');
    await expect(video).not.toHaveAttribute('controls', /.*/);
    await expect(page.getByRole('button', { name: 'Pause' })).toBeVisible();
    expect(mints(app)).toHaveLength(1);
    await expect(page.locator('body')).not.toContainText('data:audio');
    expect(app.external).toEqual([]);
  });

  test('the timecode seeks and lights its row, and the words stay selectable', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    const row = page.locator('[data-turn-row="3"]');
    await row.getByRole('button', { name: /^Play from 1:10/ }).click();
    await expect(row).toHaveAttribute('aria-current', 'true');
    const video = page.locator('video');
    await expect.poll(() => position(video)).toBeGreaterThanOrEqual(R1_REVIEW_SEEK_SEC - 0.5);
    await expect(lit(page)).toHaveCount(1);

    const words = row.getByText('I look after inbound enquiries');
    expect(await words.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe('none');
    expect(await words.evaluate((el) => el.closest('button'))).toBeNull();
  });

  test('the keys work inside the player, and speed reaches the media', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const video = page.locator('video');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState)).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Forward 15 seconds' }).focus();
    await page.keyboard.press('k');
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    const before = await position(video);
    await page.keyboard.press('l');
    await expect.poll(() => position(video)).toBeGreaterThanOrEqual(before + 14);

    await page.keyboard.press(']');
    expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(1.25);
    await page.getByRole('button', { name: /^Speed/ }).click();
    await page.getByRole('option', { name: '2x', exact: true }).click();
    expect(await video.evaluate((el: HTMLVideoElement) => el.playbackRate)).toBe(2);
  });

  test('leaving the tab pauses the recording and keeps the place', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    await page.getByRole('button', { name: 'Play', exact: true }).click();
    const video = page.locator('video');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused)).toBe(true);
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
    await page.getByRole('tab', { name: 'Recording' }).click();
    expect(mints(app)).toHaveLength(1);
  });
});

test.describe('bringing the keys in', () => {
  test('a press on the tab lets K start the recording', async ({ app, page }) => {
    await app.goto(ADDRESS);
    await page.getByRole('tab', { name: 'Recording' }).click();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeFocused();
    await page.keyboard.press('k');
    await expect(page.locator('video')).toHaveCount(1);
    expect(mints(app)).toHaveLength(1);
  });

  test('the arrow keys stay with the tabs', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=resume`);
    await page.getByRole('tab', { name: 'Resume' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Recording' })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Resume' })).toHaveAttribute('aria-selected', 'true');
  });

  test('a click on the picture plays and pauses, and the keys answer after it', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    const picture = page.locator('[data-r1-recording-state]');
    await picture.click();
    const video = page.locator('video');
    await expect(video).toHaveCount(1);
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused)).toBe(true);
    await picture.click();
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(true);
    await page.keyboard.press('k');
    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => !el.paused)).toBe(true);
  });
});

test.describe('the strip and the transcript answer the reader', () => {
  test('a phase and a role-play mark answer the pointer, so their tooltips can show', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    for (const selector of ['[data-phase]', '[data-marker]']) {
      // The widest, because on a phone the shortest phases are drawn wider than they last and overlap a
      // neighbour. What matters here is that the rail under them does not take the pointer.
      const onTop = await page.locator(selector).evaluateAll((els) => {
        const widest = els.reduce((a, b) => (b.getBoundingClientRect().width > a.getBoundingClientRect().width ? b : a));
        widest.scrollIntoView({ block: 'center' });
        const box = widest.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === widest;
      });
      expect(onTop, selector).toBe(true);
    }
    await expect(page.locator('[data-call-strip] figcaption')).toContainText('Phases: ');
  });

  test('a press on a phase seeks like a press on the rail', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    await page.locator('[data-phase]').last().click();
    await expect(page.getByTestId('position')).not.toHaveText('0:00');
  });

  test('a move of the panel\'s own keeps following: its `scroll` is not the reader', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    const rail = page.getByRole('slider', { name: 'Position in the recording' });
    await rail.focus();
    await page.keyboard.press('End');
    const scroller = page.getByRole('region', { name: 'Transcript turns' });
    await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    // The event lands after the frame that moved it.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect(page.getByRole('button', { name: 'Back to current' })).toHaveCount(0);
  });

  test('a scroll the reader makes stops following, and a row change no longer moves the panel', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording&t=${R1_REVIEW_SEEK_SEC}`);
    const scroller = page.getByRole('region', { name: 'Transcript turns' });
    await expect(page.getByRole('button', { name: 'Back to current' })).toHaveCount(0);
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByRole('button', { name: 'Back to current' })).toBeVisible();
    const parked = await scroller.evaluate((el) => el.scrollTop);
    await page.getByRole('button', { name: 'Back 15 seconds' }).click();
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(parked);
  });
});

test.describe('moving between the scorecard and the recording', () => {
  test('a quote opens Recording at its turn, and the first play starts there', async ({ app, page }) => {
    await app.goto(ADDRESS);
    await page.getByRole('button', { name: /What made you start looking at this now/ }).click();
    await expect(page.getByRole('tab', { name: 'Recording' })).toHaveAttribute('aria-selected', 'true');
    await expect(page).toHaveURL(/tab=recording/);
    await expect(page).toHaveURL(/t=318/);
    await expect(page.locator('[data-turn-row="9"]')).toHaveAttribute('aria-current', 'true');
    // In view inside its panel: on a phone the panel itself is below the video.
    const inPanel = await page.locator('[data-turn-row="9"]').evaluate((row) => {
      const panel = row.closest('[role="region"]')!.getBoundingClientRect();
      const box = row.getBoundingClientRect();
      return box.top >= panel.top && box.bottom <= panel.bottom;
    });
    expect(inPanel).toBe(true);
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeFocused();
    expect(mints(app)).toHaveLength(0);
  });

  test('searching narrows the transcript, and the filter keeps to the candidate', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording`);
    await page.getByRole('searchbox', { name: 'Search the transcript' }).fill('Thursday');
    await expect(page.getByText('3 of 27 turns')).toBeVisible();
    await page.getByRole('button', { name: 'Candidate only' }).click();
    await expect(page.getByText('1 of 27 turns')).toBeVisible();
  });
});

test.describe('the states', () => {
  test('an appeal withholds every score and keeps the interview', async ({ app, page }, testInfo) => {
    const { review } = app.db.r1;
    app.db.r1.review = { ...review, assessment: null, phone_screening: null, round: { ...review.round, recommendation: null, overall: null, scores_withheld: true } };
    await app.goto(ADDRESS);
    await expect(page.getByText('Decision use is paused — open appeal')).toBeVisible();
    await expect(page.getByRole('tabpanel', { name: 'Overview' })).toContainText('Scorecards are suppressed while an appeal is under review.');
    await expect(page.locator('[data-verdict-mark]')).toHaveCount(0);
    await look(page, 'state-appeal', testInfo.project.name);
    await auditA11y(page, testInfo, 'r1-review-appeal', { strict: true });
  });

  test('consent withdrawn disables Recording, with the reason', async ({ app, page }, testInfo) => {
    const { review } = app.db.r1;
    app.db.r1.review = {
      ...review,
      attempts: [{ ...review.attempts[0], consent_withdrawn: true, transcript_hidden: true, turns: [], recording: { state: 'deleted', reason: 'consent_withdrawn' } }],
      // The API drops the rationales and the quotes with the transcript.
      assessment: { ...review.assessment!, metric_results: review.assessment!.metric_results.map((metric) => ({ ...metric, evidence: [], rationale: null })) },
    };
    await app.goto(`${ADDRESS}?tab=recording`);
    await expect(page.getByRole('tab', { name: 'Recording' })).toBeDisabled();
    await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('This recording was deleted because consent was withdrawn.')).toBeVisible();
    await expect(page.getByText('The transcript is hidden.')).toBeVisible();
    await expect(page.getByText('Detail hidden with the transcript.').first()).toBeVisible();
    await look(page, 'state-consent-withdrawn', testInfo.project.name);
    await auditA11y(page, testInfo, 'r1-review-consent-withdrawn', { strict: true });
  });

  test('a round whose consent was withdrawn mid-interview says it ended, and never that a score is coming', async ({ app, page }) => {
    const { review } = app.db.r1;
    app.db.r1.review = {
      ...review,
      assessment: null,
      round: { ...review.round, recommendation: null, overall: null },
      attempts: [{ ...review.attempts[0], session_status: 'failed', outcome: 'candidate_left', consent_withdrawn: true, transcript_hidden: true, turns: [], recording: { state: 'deleted', reason: 'consent_withdrawn' } }],
    };
    await app.goto(ADDRESS);
    await expect(page.getByRole('tabpanel', { name: 'Overview' })).toContainText('This round ended without a scored interview.');
    await expect(page.getByText('Scoring in progress')).toHaveCount(0);
  });

  test('a staff dry run is marked', async ({ app, page }) => {
    app.db.r1.review = { ...app.db.r1.review, round: { ...app.db.r1.review.round, is_staff_dry_run: true } };
    await app.goto(ADDRESS);
    await expect(page.getByRole('note')).toHaveText('Not used for any decision');
    await expect(page.getByRole('list', { name: 'About this interview' })).toContainText('Staff dry run');
  });

  test('a pending rejection can be cancelled, after a confirmation', async ({ app, page }, testInfo) => {
    const { review } = app.db.r1;
    app.db.r1.review = { ...review, round: { ...review.round, recommendation: 'reject', status_write: 'pending_reject', pending_reject_until: review.round.expires_at } };
    await app.goto(ADDRESS);
    await page.getByRole('button', { name: 'Cancel rejection' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Cancel this pending rejection?');
    await auditA11y(page, testInfo, 'r1-review-cancel-rejection', { strict: true });
    await dialog.getByRole('button', { name: 'Cancel the rejection' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('list', { name: 'About this interview' })).not.toContainText('Rejection pending');
    expect(app.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/cancel-pending-reject'))).toHaveLength(1);
  });

  test('no recording: the sentence, no player, and the transcript still reads', async ({ app, page }, testInfo) => {
    const { review } = app.db.r1;
    app.db.r1.review = { ...review, attempts: [{ ...review.attempts[0], recording: { state: 'none' } }] };
    await app.goto(`${ADDRESS}?tab=recording`);
    await expect(page.getByText('No recording was made for this attempt.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
    await expect(page.getByText('Hello Naveen, I am Christy')).toBeVisible();
    await look(page, 'state-no-recording', testInfo.project.name);
    await auditA11y(page, testInfo, 'r1-review-no-recording', { strict: true });
  });

  test('an audio-only attempt says so, and bands the strip', async ({ app, page }) => {
    await app.goto(`${ADDRESS}?tab=recording&attempt=2`);
    const panel = page.getByRole('tabpanel', { name: 'Recording' });
    await expect(panel.getByText('The camera was not available, so this is an audio-only recording.')).toBeVisible();
    await expect(page.locator('[data-band]')).toContainText('Audio only');
  });

  test('a viewer reads the transcript, and is offered nothing to write', async ({ app, page }) => {
    app.db.me.role = 'viewer';
    const { review } = app.db.r1;
    app.db.r1.review = { ...review, round: { ...review.round, recommendation: 'reject', status_write: 'pending_reject', pending_reject_until: review.round.expires_at } };
    await app.goto(`${ADDRESS}?tab=recording`);
    await expect(page.getByText('Hello Naveen, I am Christy')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel rejection' })).toHaveCount(0);
  });
});
