/**
 * Shared steps for the R1 candidate specs (checks and screenshots).
 *
 * Roles and accessible names only, like fixtures/flows.ts: the page may restyle
 * every element, but a heading must stay a heading and a button must keep its
 * name. Each helper leaves the page in the state its name describes.
 */

import type { Page, TestInfo } from '@playwright/test';
import { expect, type R1Harness } from './candidate-harness';
import { horizontalOverflow } from './layout';
import { R1_ATTEMPT_TOKEN, R1_LINK_TOKEN } from './r1-candidate-api';

export const TOKEN_HASH = `#${R1_LINK_TOKEN}`;
export const NONCE_KEY = 'r1.attempt.nonce';

/**
 * The rejoin nonce the page holds for this tab, or null. It is stored as
 * `{"l": <short digest of the link>, "n": <nonce>}`, so tests read the nonce out of it.
 */
export async function storedNonce(page: Page): Promise<string | null> {
  const raw = await page.evaluate((key) => window.sessionStorage.getItem(key), NONCE_KEY);
  return raw === null ? null : (JSON.parse(raw) as { n: string }).n;
}

/** The stored entry as the page wrote it, for tests that check what is (not) in storage. */
export async function storedNonceRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.sessionStorage.getItem(key), NONCE_KEY);
}

export function heading(page: Page, name: string | RegExp) {
  return page.getByRole('heading', { level: 1, name });
}

export async function openLink(r1: R1Harness, hash: string = TOKEN_HASH): Promise<void> {
  await r1.page.goto(`/candidate/r1${hash}`);
}

/** Tick every purpose on the notice and agree. */
export async function agree(page: Page): Promise<void> {
  // The notice renders once the template has loaded; `.all()` does not wait.
  await expect(page.getByRole('checkbox')).toHaveCount(4);
  for (const box of await page.getByRole('checkbox').all()) await box.check();
  await page.getByRole('button', { name: 'I agree and continue' }).click();
}

/** Landing -> device check -> a passed check, ready to continue. */
export async function passDeviceCheck(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check my camera and microphone' }).click();
  await page.getByRole('button', { name: /Test camera, microphone and connection/ }).click();
  await expect(page.getByRole('button', { name: 'Continue to interview' })).toBeVisible({ timeout: 25_000 });
}

/** Consent already on file: straight from the link to the live view. */
export async function reachLive(r1: R1Harness): Promise<void> {
  r1.state.consentRequired = false;
  await openLink(r1);
  await expect(heading(r1.page, 'Video interview')).toBeVisible();
  await passDeviceCheck(r1.page);
  await r1.page.getByRole('button', { name: 'Continue to interview' }).click();
  await expect(r1.page.getByRole('region', { name: 'Live video interview' })).toBeVisible();
}

export async function expectMobileFits(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.project.name !== 'mobile') return;
  expect(await horizontalOverflow(page), 'the page must not scroll sideways at 390 px').toEqual({
    overflowPx: 0,
    offenders: [],
  });
}

/** What a candidate's browser must never do, asserted on every flow. */
export function expectCandidateHygiene(r1: R1Harness): void {
  expect(
    r1.calls.filter((call) => call.hasAuthorization).map((call) => `${call.method} ${call.url}`),
    'candidate requests must carry no Authorization header',
  ).toEqual([]);
  expect(
    r1.calls.filter((call) => call.url.includes(R1_LINK_TOKEN) || call.url.includes(R1_ATTEMPT_TOKEN)),
    'a token must never appear in a URL',
  ).toEqual([]);
  expect(
    r1.calls.filter((call) => !new URL(call.url).pathname.startsWith('/api/r1/')),
    'a candidate calls only R1 routes',
  ).toEqual([]);
  expect(
    r1.calls.filter((call) => /complete|recording|upload|invite|exchange-legacy|livekit/.test(new URL(call.url).pathname)),
    'no completion, recording, upload or legacy call',
  ).toEqual([]);
}

export function bodiesOf(r1: R1Harness, path: string): Array<Record<string, unknown> | null> {
  return r1.state.requests.filter((request) => request.path === path).map((request) => request.body);
}

/** The window sizes the live view must fit: three laptop/desktop sizes and a phone. */
export const LIVE_DESKTOP_SIZES = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
] as const;

const LONG_CAPTION =
  'Honestly I am not sure yet, the price feels high for me right now and I would need to talk it over at home first.';

/**
 * Consent already on file, straight to the live view, with an interview that has run for a
 * while: `count` finished caption lines (the last ten in the role-play, so the lead card is on
 * screen too). Leaves the page in the role-play with the newest line at the end of the log.
 */
export async function reachLiveWithConversation(r1: R1Harness, count = 40): Promise<void> {
  await reachLive(r1);
  await r1.mock.joinAgent();
  await r1.mock.setPhase('icebreaker');
  for (let index = 1; index <= count; index += 1) {
    if (index === count - 9) await r1.mock.setPhase('roleplay');
    await r1.mock.caption(`c${index}`, `Line ${index}. ${LONG_CAPTION}`, true);
  }
  await expect(r1.page.locator('.candidate-caption', { hasText: `Line ${count}.` })).toBeAttached();
  await expect(r1.page.getByRole('region', { name: 'Your role-play' })).toBeVisible();
}
