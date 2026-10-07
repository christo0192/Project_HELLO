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
import { agree, heading, openLink, passDeviceCheck, reachLive } from './fixtures/candidate-flows';

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

    await r1.mock.setPhase('roleplay');
    await r1.mock.caption('c2', 'Hello? Yes, this is Meera speaking.', true);
    await expect(page.getByRole('region', { name: 'Your role-play' })).toBeVisible();
    await shoot(page, project, 'live-roleplay');

    await page.getByRole('button', { name: 'Turn camera off' }).click();
    await expect(page.getByText(/Your camera is off/)).toBeVisible();
    await shoot(page, project, 'live-camera-off');

    await r1.mock.setPhase('ended');
    await expect(heading(page, 'Your interview is complete.')).toBeVisible();
    await shoot(page, project, 'ended');
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
