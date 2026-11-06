/**
 * Transcript click-to-seek on the Review tab (M014).
 *
 * The recruiter presses a turn's timecode; the recording loads on demand and
 * the audio element's playhead moves to that turn. A turn on a call whose
 * recording FAILED shows its time and the reason instead of "no timing data"
 * and never seeks another call's file.
 *
 * A seek leaves keyboard focus where it was, and a file that runs out hands Play to the next call. Both
 * are real-browser facts: jsdom cannot focus an <audio>, and only a browser orders the events of an end.
 */
import { expect, test } from './fixtures/harness';
import { pickSession } from './fixtures/flows';
import { SEEK_CANDIDATE_ID, SEEK_LEG1_LATER_TURN_SEC, SEEK_LEG1_TURN_SEC } from './fixtures/data';

/** The two seek sessions share a start, so the picker tells them apart by what was recorded. */
const NORMAL_SESSION = /Recorded 2m 0s/;
const FAILED_SESSION = /Recorded 1m 30s/;

async function openReview(app: import('./fixtures/harness').AppHarness, session: RegExp) {
  await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
  await app.page.getByRole('tab', { name: 'Phone screening' }).click();
  const panel = app.page.getByRole('tabpanel', { name: 'Phone screening' });
  await pickSession(panel, session);
  await expect(panel.getByRole('list', { name: 'Calls in this session' }).getByRole('listitem')).toHaveCount(2);
  return panel;
}

test.describe('transcript click-to-seek', () => {
  test('a timed turn loads its call recording and moves the playhead to the turn', async ({ app, page }) => {
    const panel = await openReview(app, NORMAL_SESSION);
    const first = panel.getByRole('group', { name: 'Call 1 of 2 · first call' });
    // Exact (stamped) leg: no estimate marker on its turns.
    const later = first.getByRole('button', { name: /Turn 2:/ });
    await expect(later).toContainText('0:40');
    await expect(later).not.toContainText('≈');

    await later.click();
    const audio = page.locator('audio[aria-label="Call 1 of 2 recording player"]');
    await expect(audio).toHaveCount(1);
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(SEEK_LEG1_LATER_TURN_SEC - 1);
    const t = await audio.evaluate((el: HTMLAudioElement) => el.currentTime);
    expect(t).toBeLessThan(SEEK_LEG1_LATER_TURN_SEC + 15);
    // Focusing the audio would scroll the pane away from the moment.
    await expect(later).toBeFocused();

    // An earlier turn seeks backwards in the same, already loaded, file.
    await first.getByRole('button', { name: /Turn 1:/ }).click();
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
      .toBeLessThan(SEEK_LEG1_TURN_SEC + 15);

    // The legacy reconnect's times are estimates and say so. The clock runs on across the drop.
    const second = panel.getByRole('group', { name: 'Call 2 of 2 · reconnect' });
    await expect(second.getByRole('button', { name: /Turn 3:/ })).toContainText('≈02:13');
    app.expectHealthy();
  });

  test('when a call runs out, Play moves on to the next call and plays it', async ({ app, page }) => {
    const panel = await openReview(app, NORMAL_SESSION);
    await panel.getByRole('group', { name: 'Call 1 of 2 · first call' }).getByRole('button', { name: /Turn 2:/ }).click();
    const callOne = page.locator('audio[aria-label="Call 1 of 2 recording player"]');
    await expect(callOne).toHaveCount(1);
    await expect.poll(() => callOne.evaluate((el: HTMLAudioElement) => el.duration), { timeout: 10_000 }).toBeGreaterThan(1);

    await callOne.evaluate((el: HTMLAudioElement) => {
      el.currentTime = el.duration - 0.2;
      return el.play();
    });
    await expect.poll(() => callOne.evaluate((el: HTMLAudioElement) => el.ended), { timeout: 10_000 }).toBe(true);

    const play = panel.getByRole('button', { name: /^Play from/ });
    await expect(play).toHaveText('Play from 02:10');
    await play.click();
    const callTwo = page.locator('audio[aria-label="Call 2 of 2 recording player"]');
    await expect(callTwo).toHaveCount(1);
    await expect.poll(() => callTwo.evaluate((el: HTMLAudioElement) => el.paused), { timeout: 10_000 }).toBe(false);
    expect(await callTwo.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeLessThan(5);
    app.expectHealthy();
  });

  test('turns on a call whose recording failed show their time and the reason, not "no timing data"', async ({ app, page }) => {
    const panel = await openReview(app, FAILED_SESSION);
    const first = panel.getByRole('group', { name: 'Call 1 of 2 · first call' });
    await expect(first.getByText(/Recording failed for this call, so its turns cannot start playback\./)).toBeVisible();
    await expect(first.getByText('0:02')).toBeVisible();
    await expect(first.getByText('1:05')).toBeVisible();
    await expect(first.getByRole('button')).toHaveCount(0);
    await expect(page.getByText(/no timing data/i)).toHaveCount(0);
    // Nothing was minted: a failed call has no file, and leg 2's file is not used.
    expect(app.calls.filter((c) => /\/api\/recordings\//.test(c.url))).toEqual([]);
    app.expectHealthy();
  });
});
