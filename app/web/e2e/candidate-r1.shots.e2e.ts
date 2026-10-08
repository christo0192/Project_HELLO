/**
 * Screenshot capture for the R1 candidate page, beside the recruiter shots.
 *
 * Tagged `@shots` so `npm run e2e` (checks) skips it and `npm run e2e:shots`
 * photographs every key candidate state, per project, into
 * `.artifacts/screenshots/<project>/r1-<state>.png`. Capture makes no
 * assertions beyond "the state was reached"; the candidate harness still fails
 * any test whose page made an unmocked or external request.
 */

import path from 'node:path';
import type { Page } from '@playwright/test';
import { ARTIFACTS_DIR } from './fixtures/axe';
import { expect, test } from './fixtures/candidate-harness';
import {
  LEARNER_NAME,
  LIVE_DESKTOP_SIZES,
  REALISTIC_WINDOWS,
  agree,
  backToBriefing,
  heading,
  openLink,
  passDeviceCheck,
  reachLive,
  reachLiveWithConversation,
} from './fixtures/candidate-flows';
import { liveLayout } from './fixtures/layout';

const shotPath = (project: string, name: string) =>
  path.join(ARTIFACTS_DIR, 'screenshots', project, `r1-${name}.png`);

async function shoot(page: Page, project: string, name: string): Promise<void> {
  await page.screenshot({ path: shotPath(project, name), fullPage: true, animations: 'disabled', caret: 'hide' });
}

test.describe('R1 candidate screenshots @shots', () => {
  test.describe.configure({ timeout: 120_000 });

  test('notice, landing, device check', async ({ r1 }, testInfo) => {
    const { page } = r1;
    const project = testInfo.project.name;
    await openLink(r1);
    await expect(heading(page, 'Notice and consent for your AI interview')).toBeVisible();
    await shoot(page, project, 'notice');

    await agree(page);
    await expect(heading(page, 'Video interview')).toBeVisible();
    await shoot(page, project, 'landing');

    await passDeviceCheck(page);
    await shoot(page, project, 'device-check-passed');
  });

  test('live interview through the role-play, then the end', async ({ r1 }, testInfo) => {
    const { page } = r1;
    const project = testInfo.project.name;
    await reachLive(r1);
    await r1.mock.joinAgent();
    await r1.mock.setPhase('icebreaker');
    await r1.mock.speak(0.5);
    await r1.mock.caption('c1', 'Could you walk me through your background?', true);
    await expect(page.getByText('Getting to know you')).toBeVisible();
    await shoot(page, project, 'live-icebreaker');

    // The briefing: the interviewer has named the learner and is waiting for "ready".
    await r1.mock.setAgentAttributes({ phase: 'transition', leadname: LEARNER_NAME, awaiting: 'ready' });
    await expect(page.getByRole('button', { name: "I'm ready" })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Your role-play' }).getByText(LEARNER_NAME)).toBeVisible();
    await shoot(page, project, 'live-briefing');

    await page.getByRole('button', { name: "I'm ready" }).click();
    await expect(page.getByText('Sent — starting the role-play')).toBeVisible();
    await shoot(page, project, 'live-briefing-sent');

    // The role-play: the clock is up, the button is gone.
    await r1.mock.setAgentAttributes({ phase: 'roleplay', awaiting: '', rpleft: '780' });
    await r1.mock.caption('c2', 'Hello? Yes, this is Meera speaking.', true);
    await expect(page.getByRole('region', { name: 'Your role-play' })).toBeVisible();
    await expect(page.getByRole('timer')).toHaveText('Role-play · 13 min left');
    await expect(page.getByRole('button', { name: "I'm ready" })).toHaveCount(0);
    await shoot(page, project, 'live-roleplay');

    // The button failing: the candidate is told to say it instead.
    await r1.mock.setAgentAttributes({ phase: 'transition', awaiting: 'ready', rpleft: '' });
    r1.state.failures.ready = { status: 500, error: 'service_unavailable' };
    await page.getByRole('button', { name: "I'm ready" }).click();
    await expect(page.getByRole('alert')).toContainText("We couldn't send that");
    await shoot(page, project, 'live-briefing-failed');
    r1.consoleErrors.length = 0; // a 500 is logged by the browser's network layer
    await r1.mock.setAgentAttributes({ phase: 'roleplay', awaiting: '', rpleft: '700' });

    await page.getByRole('button', { name: 'Turn camera off' }).click();
    await expect(page.getByText(/Your camera is off/)).toBeVisible();
    await shoot(page, project, 'live-camera-off');

    await r1.mock.setPhase('ended');
    await expect(heading(page, 'Your interview is complete.')).toBeVisible();
    await shoot(page, project, 'ended');
  });

  /**
   * The live view after a long interview (40 caption lines, role-play on): the window fills at
   * every desktop size and the captions list is the scroller; on a phone the page scrolls and the
   * captions card is bounded. The same assertions run in candidate-r1.e2e.ts; here they only
   * guard that the photograph shows the state it is named for.
   */
  for (const size of LIVE_DESKTOP_SIZES) {
    test(`live view, 40 captions, ${size.width}x${size.height}`, async ({ r1 }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop sizes run on the desktop project');
      const { page } = r1;
      await page.setViewportSize(size);
      await reachLiveWithConversation(r1);
      const layout = await liveLayout(page);
      expect(layout.pageScrollHeight).toBeLessThanOrEqual(size.height + 1);
      expect(layout.list!.scrollHeight).toBeGreaterThan(layout.list!.clientHeight);
      await page.screenshot({
        path: shotPath(testInfo.project.name, `live-40-captions-${size.width}x${size.height}`),
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
      });
    });
  }

  /**
   * The windows a candidate really has (the screen minus the taskbar and the browser's bars):
   * the role-play with its facts strip, the briefing with the full card, and the briefing after a
   * failed press with the camera off, which is the tallest the stage ever gets.
   */
  for (const size of REALISTIC_WINDOWS) {
    test(`live view, realistic window, ${size.width}x${size.height}`, async ({ r1 }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop', 'desktop windows run on the desktop project');
      const { page } = r1;
      const project = testInfo.project.name;
      await page.setViewportSize(size);
      await reachLiveWithConversation(r1);
      const view = (name: string) => page.screenshot({
        path: shotPath(project, `live-realistic-${size.width}x${size.height}-${name}`),
        fullPage: false,
        animations: 'disabled',
        caret: 'hide',
      });
      expect((await liveLayout(page)).pageScrollHeight).toBeLessThanOrEqual(size.height + 1);
      await view('roleplay');

      await backToBriefing(r1);
      await view('briefing');

      r1.state.failures.ready = { status: 503, error: 'service_unavailable' };
      await page.getByRole('button', { name: "I'm ready" }).click();
      await expect(page.getByRole('alert')).toContainText("We couldn't send that");
      r1.consoleErrors.length = 0; // a 503 is logged by the browser's network layer
      await page.getByRole('button', { name: 'Turn camera off' }).click();
      await expect(page.getByText(/Your camera is off/)).toBeVisible();
      await view('briefing-failed-camera-off');
    });
  }

  test('live view, 40 captions, 390x844', async ({ r1 }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'the phone layout runs on the mobile project');
    const { page } = r1;
    await reachLiveWithConversation(r1);
    const layout = await liveLayout(page);
    expect(layout.list!.scrollHeight).toBeGreaterThan(layout.list!.clientHeight);
    await shoot(page, testInfo.project.name, 'live-40-captions-390x844');
  });

  test('declined and busy states', async ({ r1 }, testInfo) => {
    const { page } = r1;
    const project = testInfo.project.name;
    await openLink(r1);
    await page.getByRole('button', { name: 'I do not agree' }).click();
    await expect(heading(page, 'This interview cannot start without your consent')).toBeVisible();
    await shoot(page, project, 'declined');
  });
});
