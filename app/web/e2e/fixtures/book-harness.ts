/**
 * The `book` fixture: a real page of the real app, signed OUT like a candidate's browser, with
 * the public booking API (`/api/r1/book*`, M035 S07) answered by the fake in r1-book-api.ts.
 *
 * It reuses the recruiter harness's guards wholesale (request and WebSocket interception, the
 * frozen clock, console capture, unmocked and external requests failing the test at teardown),
 * the way candidate-harness.ts does, and differs in exactly three ways:
 *   1. no admin session is seeded: the pages are public and must not lean on one;
 *   2. the fake API is the booking router only, so a call to ANY other `/api/*` route (an R1
 *      link route, a recruiter route) is an unmocked endpoint and fails the test;
 *   3. it exposes `state`: what the fake server holds and every request it received.
 *
 * The helpers below are the things a candidate's browser must never do on these pages, asserted
 * on every flow.
 */

import { test as base, expect } from '@playwright/test';
import { installHarness, reportHarness, type AppHarness } from './harness';
import {
  MANAGE_TOKEN,
  R1_BOOK_FAKE_ROUTES,
  createR1BookState,
  r1BookRouter,
  type R1BookFakeRoute,
  type R1BookMockState,
} from './r1-book-api';

export interface BookHarness extends AppHarness {
  /** What the fake booking server holds and has received. */
  state: R1BookMockState;
}

export const test = base.extend<{ book: BookHarness }>({
  book: [
    async ({ page }, use, testInfo) => {
      const state = createR1BookState();
      const harness = await installHarness(page, testInfo, { signedIn: false, api: r1BookRouter(state) });
      await use(Object.assign(harness, { state }));
      await reportHarness(harness, testInfo);
    },
    { auto: true },
  ],
});

export { expect };

export const BOOK_PATH = '/book';
export const BOOK_MANAGE_PATH = '/book/manage';
/** The fragment of the manage link in Dex's invite (contracts section 6, "Tokens and digests"). */
export const MANAGE_HASH = `#m=${MANAGE_TOKEN}`;

/** Open `/book` and wait until its first answers have rendered. */
export async function openBook(book: BookHarness): Promise<void> {
  await book.goto(BOOK_PATH);
}

/** Open the manage link as the invite does: the token in the fragment. */
export async function openManage(book: BookHarness, hash: string = MANAGE_HASH): Promise<void> {
  await book.goto(`${BOOK_MANAGE_PATH}${hash}`);
}

/** `METHOD /path?query` of every booking request, in the order the fake received them. */
export function requestLines(book: BookHarness): string[] {
  return book.state.requests.map((request) => `${request.method} ${request.path}${request.query}`);
}

/** The JSON bodies the page sent to one route, in order. */
export function bodiesOf(book: BookHarness, route: R1BookFakeRoute): Array<Record<string, unknown> | null> {
  const path = R1_BOOK_FAKE_ROUTES[route];
  return book.state.requests.filter((request) => request.path === path).map((request) => request.body);
}

/**
 * The browser's network layer logs every non-2xx answer as a console error ("Failed to load
 * resource: the server responded with a status of 503"). A test that makes the fake refuse on
 * purpose drops exactly those lines, and nothing else, before `expectHealthy`.
 */
export function dropNetworkLogLines(book: BookHarness, ...statuses: number[]): void {
  const others = book.consoleErrors.filter(
    (message) => !statuses.some((status) => message.includes(`status of ${status}`)),
  );
  book.consoleErrors.splice(0, book.consoleErrors.length, ...others);
}

/**
 * What the booking pages must never do, whatever the flow: send a credential header, call
 * anything but the booking routes, put a typed value or the manage token in a URL, put the
 * token in the page, or leave a query or a fragment in the address bar.
 */
export async function expectBookHygiene(book: BookHarness, typed: readonly string[]): Promise<void> {
  expect(
    book.calls.filter((call) => call.hasAuthorization).map((call) => `${call.method} ${call.url}`),
    'booking requests must carry no Authorization header',
  ).toEqual([]);
  expect(
    book.calls
      .filter((call) => !new URL(call.url).pathname.startsWith('/api/r1/book'))
      .map((call) => `${call.method} ${call.url}`),
    'the booking pages call only the booking routes',
  ).toEqual([]);
  for (const secret of [MANAGE_TOKEN, ...typed]) {
    const encoded = encodeURIComponent(secret);
    expect(
      book.calls.filter((call) => call.url.includes(secret) || call.url.includes(encoded)).map((call) => call.url),
      'a typed value or the manage token must never appear in a URL',
    ).toEqual([]);
  }
  const markup = await book.page.evaluate(() => document.documentElement.outerHTML);
  expect(markup.includes(MANAGE_TOKEN), 'the manage token must never be in the page').toBe(false);
  const address = new URL(book.page.url());
  expect(
    { query: address.search, fragment: address.hash },
    'the address bar holds no query and no fragment',
  ).toEqual({ query: '', fragment: '' });
}

/**
 * Every value in this tab's web storage, keys included, as one string: the pages keep what a
 * person types in memory only, so none of it may show up here.
 */
export async function storedText(book: BookHarness): Promise<string> {
  return book.page.evaluate(() => {
    const parts: string[] = [];
    for (const storage of [window.localStorage, window.sessionStorage]) {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        parts.push(key, storage.getItem(key) ?? '');
      }
    }
    return parts.join('\n');
  });
}
