/**
 * Transcript click-to-seek on the Review tab (M014).
 *
 * The recruiter clicks a timed turn; the recording loads on demand and the
 * audio element's playhead moves to that turn. A turn on a call whose
 * recording FAILED shows its time and the reason instead of "no timing data"
 * and never seeks another call's file.
 */
import { expect, test } from './fixtures/harness';
import {
  SEEK_CANDIDATE_ID,
  SEEK_FAILED_SESSION_ID,
  SEEK_LEG1_LATER_TURN_SEC,
  SEEK_LEG1_TURN_SEC,
  SEEK_NORMAL_SESSION_ID,
} from './fixtures/data';

async function openReview(app: import('./fixtures/harness').AppHarness, sessionId: string) {
  await app.goto(`/candidates/${SEEK_CANDIDATE_ID}`);
  await app.page.getByRole('tab', { name: 'Review' }).click();
  const panel = app.page.getByRole('tabpanel', { name: 'Review' });
  await panel.getByRole('combobox').selectOption(sessionId);
  await expect(panel.getByRole('list', { name: 'Calls in this session' }).getByRole('listitem')).toHaveCount(2);
  return panel;
}

test.describe('transcript click-to-seek', () => {
  test('a timed turn loads its call recording and moves the playhead to the turn', async ({ app, page }) => {
    const panel = await openReview(app, SEEK_NORMAL_SESSION_ID);
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

    // An earlier turn seeks backwards in the same, already loaded, file.
    await first.getByRole('button', { name: /Turn 1:/ }).click();
    await expect
      .poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime), { timeout: 10_000 })
      .toBeLessThan(SEEK_LEG1_TURN_SEC + 15);

    // The legacy reconnect's times are estimates and say so.
    const second = panel.getByRole('group', { name: 'Call 2 of 2 · reconnect' });
    await expect(second.getByRole('button', { name: /Turn 3:/ })).toContainText('≈0:03');
    app.expectHealthy();
  });

  test('turns on a call whose recording failed show their time and the reason, not "no timing data"', async ({ app, page }) => {
    const panel = await openReview(app, SEEK_FAILED_SESSION_ID);
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
