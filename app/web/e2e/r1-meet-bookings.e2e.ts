/**
 * The Meet staff surfaces in a real browser (M034 S10, dark), at both widths: the Meet bookings page and
 * the "Via Meet" marker on the queue, the candidate's R1 tab and the review.
 *
 * The router answers `GET /api/interview-rounds/meet-bookings` by the API's own rules (filters, order,
 * pages of 50, the opaque keyset cursor, the off body), so the page's wiring is seen end to end. The words,
 * the reader and every state are pinned in R1MeetBookingsPage.test.tsx and lib/r1-meet-bookings.test.ts.
 * No screenshot: the owner asked for none.
 *
 * The dev server runs React's StrictMode, which reads twice on mount. So a count of reads is a count of
 * distinct requests here; the unit test pins exactly one.
 */
import { auditA11y } from './fixtures/axe';
import {
  ABANDONED_CANDIDATE_ID,
  DIALED_CANDIDATE_ID,
  LEGACY_CANDIDATE_ID,
  R1_CANDIDATE_ID,
  R1_ROUND_ID,
  STAR_CANDIDATE_ID,
  istToUtcMs,
  r1MeetBooking,
} from './fixtures/data';
import { meetBookingsCursor } from './fixtures/api-router';
import { FROZEN_NOW_MS, MOCK_API_ORIGIN } from './fixtures/env';
import { expect, test, type AppHarness, type RecordedCall } from './fixtures/harness';
import { horizontalOverflow } from './fixtures/layout';

const ADDRESS = '/interviews/meet-bookings';
const MEET_PATH = '/api/interview-rounds/meet-bookings';
const HOUR = 3_600_000;

/** Today in India at the frozen "now", and the instant it starts: the page's default `from`. */
const TODAY = new Date(FROZEN_NOW_MS + 5.5 * HOUR).toISOString().slice(0, 10);
const TODAY_START = new Date(istToUtcMs(TODAY, '00:00')).toISOString();

const iso = (ms: number) => new Date(ms).toISOString();
const meetReads = (app: AppHarness) => app.calls.filter((c) => c.method === 'GET' && new URL(c.url).pathname === MEET_PATH);
const paramsOf = (call: RecordedCall) => Object.fromEntries(new URL(call.url).searchParams);
/** What the latest read asked for, or null before the first. Polled: a read lands after the address changes. */
const lastRead = (app: AppHarness) => {
  const reads = meetReads(app);
  return reads.length === 0 ? null : paramsOf(reads[reads.length - 1]);
};

async function noSideways(app: AppHarness) {
  expect(await horizontalOverflow(app.page), 'the page must not scroll sideways').toEqual({ overflowPx: 0, offenders: [] });
}

test.describe('the Meet bookings page', () => {
  test('opens from R1 interviews, says Meet is on, lists today on, earliest first, and fits and passes axe', async ({ app, page }, testInfo) => {
    await app.goto('/interviews');
    await page.getByRole('link', { name: 'Meet bookings', exact: true }).click();
    await expect(page).toHaveURL(/\/interviews\/meet-bookings$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Meet bookings' })).toBeVisible();
    await expect(page.getByTestId('meet-status')).toHaveText('Google Meet interviews are on.');

    const rows = page.getByRole('table', { name: 'Meet bookings' }).locator('tbody tr');
    // The cancelled booking of last week is before today, so it is not asked for.
    await expect(rows).toHaveText([/Completed/, /Not completed/, /Booked/, /No matching candidate/, /Scheduler not matched/, /Blocked/]);
    await expect(page.getByText('Showing 6 bookings, earliest first.', { exact: true })).toBeVisible();
    await expect(rows.nth(1)).toContainText('No one joined the meeting in time.');
    await expect(rows.nth(3)).toContainText('No candidate matched');
    await expect(rows.nth(3)).toContainText('The Ashby application is not linked to a candidate in HELLO yet.');
    await expect(rows.nth(3).getByRole('link')).toHaveCount(0);
    await expect(rows.nth(4)).toContainText('The person who scheduled it in Ashby has no HELLO account.');
    await expect(rows.nth(5)).toContainText('The slot is too far ahead to set up yet.');
    // A booking with nothing in the way says nothing more than its status.
    await expect(rows.nth(2).getByRole('link', { name: /^Open candidate for / })).toHaveAttribute('href', `/candidates/${STAR_CANDIDATE_ID}?tab=r1`);
    await expect(rows.nth(2).getByRole('link', { name: /^Open R1 review/ })).toHaveCount(0);

    // Every read asks for today on, and nothing else.
    for (const call of meetReads(app)) expect(paramsOf(call)).toEqual({ from: TODAY_START });

    await noSideways(app);
    await auditA11y(page, testInfo, 'r1-meet-bookings', { strict: true });

    // The booking that was held opens its candidate and its review, each link named by its own slot.
    const held = rows.first();
    await expect(held.getByRole('link', { name: /^Open candidate for Wed 16 Sep 2026, / })).toHaveAttribute('href', `/candidates/${R1_CANDIDATE_ID}?tab=r1`);
    await held.getByRole('link', { name: /^Open R1 review for Wed 16 Sep 2026, / }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/${R1_ROUND_ID}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sales Program Advisor role-play');
    app.expectHealthy();
  });

  test('never shows what the API must not send, even when an answer carries it', async ({ app, page }) => {
    for (const row of app.db.r1.meet.bookings) {
      Object.assign(row, {
        meet_url: 'https://meet.google.com/e2e-poison-meet',
        recall_bot_id: 'e2e-poison-bot',
        ticket_digest: 'e2e-poison-ticket',
      });
    }
    await app.goto(ADDRESS);
    await expect(page.getByText('No matching candidate')).toBeVisible();
    await app.settle();

    const html = await page.content();
    expect(html).not.toContain('e2e-poison');
    expect(html).not.toContain('meet.google');
    await expect(page.locator('a[href*="meet.google"]')).toHaveCount(0);
    // Nor an id, a version or a code: the page prints words.
    const text = await page.getByRole('main').innerText();
    for (const booking of app.db.r1.meet.bookings) expect(text).not.toContain(booking.id);
    for (const code of ['unmatched_application', 'unmapped_scheduler', 'scheduler_unmapped', 'application_unknown', 'slot_too_far', 'no_show', 'attempt_settled']) {
      expect(text).not.toContain(code);
    }
    app.expectHealthy();
  });

  test('the filters ask the API, live in the address, and Reset brings the page back', async ({ app, page }) => {
    await app.goto(ADDRESS);
    const rows = page.getByRole('table', { name: 'Meet bookings' }).locator('tbody tr');
    await expect(rows).toHaveCount(6);

    await page.getByRole('button', { name: 'Status Any status' }).click();
    await page.getByRole('option', { name: 'Cancelled', exact: true }).click();
    await expect(page).toHaveURL(/[?&]status=cancelled(&|$)/);
    await expect.poll(() => lastRead(app)).toEqual({ status: 'cancelled', from: TODAY_START });
    await expect(page.getByText('No booking matches these filters.')).toBeVisible();

    // Emptied, From is no lower bound, and the address says so.
    await page.getByLabel('From (IST)').fill('');
    await expect(page).toHaveURL(/[?&]from=(&|$)/);
    await expect.poll(() => lastRead(app)).toEqual({ status: 'cancelled' });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Cancelled in Ashby.');

    // To counts its own day: the request runs to the start of the next India day.
    await page.getByLabel('To (IST)').fill('2026-09-11');
    await expect(page).toHaveURL(/[?&]to=2026-09-11(&|$)/);
    await expect.poll(() => lastRead(app)).toEqual({ status: 'cancelled', to: new Date(istToUtcMs('2026-09-12', '00:00')).toISOString() });
    await expect(rows).toHaveCount(1);

    await page.getByRole('group', { name: 'Bookings to show' }).getByRole('button', { name: 'Reset filters' }).click();
    await expect(page).toHaveURL(/\/interviews\/meet-bookings$/);
    await expect.poll(() => lastRead(app)).toEqual({ from: TODAY_START });
    await expect(rows).toHaveCount(6);
    await expect(page.getByRole('button', { name: 'Status Any status' })).toBeVisible();
    await expect(page.getByLabel('From (IST)')).toHaveValue(TODAY);
    await expect(page.getByLabel('To (IST)')).toHaveValue('');
    app.expectHealthy();
  });

  test('a long list comes 50 at a time, and Load more asks for the rest with the same filters', async ({ app, page }) => {
    const pending = Array.from({ length: 60 }, (_, i) => r1MeetBooking(100 + i, {
      start_at: iso(FROZEN_NOW_MS + (i + 1) * HOUR),
      end_at: iso(FROZEN_NOW_MS + (i + 1.5) * HOUR),
      candidate_id: STAR_CANDIDATE_ID,
    }));
    // Two that the status filter leaves out, among them.
    const blocked = [r1MeetBooking(200, { start_at: iso(FROZEN_NOW_MS + 2.2 * HOUR), end_at: iso(FROZEN_NOW_MS + 2.7 * HOUR), status: 'blocked', reason: 'round_active' }),
      r1MeetBooking(201, { start_at: iso(FROZEN_NOW_MS + 40.2 * HOUR), end_at: iso(FROZEN_NOW_MS + 40.7 * HOUR), status: 'blocked', reason: 'round_active' })];
    app.db.r1.meet.bookings = [...blocked, ...pending];

    await app.goto(`${ADDRESS}?status=pending`);
    const rows = page.getByRole('table', { name: 'Meet bookings' }).locator('tbody tr');
    await expect(page.getByText('Showing 50 bookings, earliest first. More are available.', { exact: true })).toBeVisible();
    await expect(rows).toHaveCount(50);
    for (const call of meetReads(app)) expect(paramsOf(call)).toEqual({ status: 'pending', from: TODAY_START });

    await page.getByRole('button', { name: 'Load more' }).click();
    const count = page.getByText('Showing 60 bookings, earliest first.', { exact: true });
    await expect(count).toBeVisible();
    await expect(rows).toHaveCount(60);
    await expect(page.getByText('The candidate already has an R1 round open.')).toHaveCount(0);
    // The last page is in: the button goes, and focus waits on the count.
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    await expect(count).toBeFocused();

    const paged = meetReads(app).filter((call) => new URL(call.url).searchParams.has('cursor'));
    expect(paged).toHaveLength(1);
    expect(paramsOf(paged[0])).toEqual({ status: 'pending', from: TODAY_START, cursor: meetBookingsCursor(pending[49]) });
    await noSideways(app);
    app.expectHealthy();
  });

  test('a server with Meet off says so, reads once, offers no filter, and passes axe', async ({ app, page }, testInfo) => {
    app.db.r1.meet.enabled = false;
    await app.goto(ADDRESS);
    await expect(page.getByTestId('meet-status')).toHaveText('Google Meet interviews are off.');
    await expect(page.getByText('This page lists bookings only while they are on.')).toBeVisible();
    await expect(page.getByText('It is a server setting; R1 settings cannot change it.')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Bookings to show' })).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Meet bookings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
    await app.settle();
    // One request, and no other: no next page, no second filter, no poll.
    expect(new Set(meetReads(app).map((call) => call.url)).size).toBe(1);
    expect(lastRead(app)).toEqual({ from: TODAY_START });

    await noSideways(app);
    await auditA11y(page, testInfo, 'r1-meet-bookings-off', { strict: true });
    app.expectHealthy();
  });

  test('a viewer reaches it from R1 interviews and reads the same list', async ({ app, page }) => {
    app.db.me.role = 'viewer';
    await app.goto('/interviews');
    await page.getByRole('link', { name: 'Meet bookings', exact: true }).click();
    await expect(page).toHaveURL(/\/interviews\/meet-bookings$/);
    await expect(page.getByText('No matching candidate')).toBeVisible();
    await expect(page.getByRole('table', { name: 'Meet bookings' }).locator('tbody tr')).toHaveCount(6);
    app.expectHealthy();
  });

  // M035 S08: the public booking link next to Ashby. Own rows, so the shared list and its counts stay as they are.
  test('says where each booking came from, at both widths, and passes axe', async ({ app, page }, testInfo) => {
    const slot = (hours: number) => ({ start_at: iso(FROZEN_NOW_MS + hours * HOUR), end_at: iso(FROZEN_NOW_MS + (hours + 0.5) * HOUR) });
    app.db.r1.meet.bookings = [
      r1MeetBooking(400, { ...slot(2), source: 'ashby', status: 'pending', reason: 'eligible', candidate_id: STAR_CANDIDATE_ID }),
      // A public booking always has its candidate: the booking page imports them before it books.
      r1MeetBooking(401, { ...slot(4), source: 'public_page', status: 'pending', reason: 'eligible', candidate_id: LEGACY_CANDIDATE_ID }),
      r1MeetBooking(402, { ...slot(6), source: 'public_page', status: 'failed', reason: 'invite_undeliverable', candidate_id: DIALED_CANDIDATE_ID }),
      r1MeetBooking(403, { ...slot(8), source: 'public_page', status: 'cancelled', reason: 'candidate_cancelled', candidate_id: ABANDONED_CANDIDATE_ID }),
    ];
    await app.goto(ADDRESS);

    const table = page.getByRole('table', { name: 'Meet bookings' });
    const rows = table.locator('tbody tr');
    await expect(rows).toHaveText([/Booked/, /Booked/, /Not completed/, /Cancelled/]);
    await expect(rows.nth(2)).toContainText('Lexy’s calendar invite could not be sent to the candidate.');
    await expect(rows.nth(3)).toContainText('The candidate cancelled it with the link in their calendar invite.');

    const sourceHeader = table.locator('thead th').filter({ hasText: /^Source$/ });
    await expect(sourceHeader).toHaveCount(1);
    const words = ['Ashby', 'Public link', 'Public link', 'Public link'];
    if (page.viewportSize()!.width >= 768) {
      // A column of its own, in words.
      await expect(table.getByRole('columnheader', { name: 'Source', exact: true })).toBeVisible();
      for (const [i, word] of words.entries()) {
        await expect(rows.nth(i).locator('td').nth(3)).toHaveText(word);
        // The narrow-width line is there, out of sight.
        await expect(rows.nth(i).getByText(`Source: ${word}`, { exact: true })).toHaveCount(1);
        await expect(rows.nth(i).getByText(`Source: ${word}`, { exact: true })).toBeHidden();
      }
    } else {
      // No room for the column: the slot says it, as a line of its own.
      await expect(sourceHeader).toBeHidden();
      for (const [i, word] of words.entries()) {
        await expect(rows.nth(i).locator('td')).toHaveCount(5);
        await expect(rows.nth(i).locator('td').nth(3)).toBeHidden();
        await expect(rows.nth(i).getByText(`Source: ${word}`, { exact: true })).toBeVisible();
      }
    }

    const text = await page.getByRole('main').innerText();
    for (const code of ['public_page', 'candidate_cancelled', 'invite_undeliverable']) expect(text).not.toContain(code);

    await noSideways(app);
    await auditA11y(page, testInfo, 'r1-meet-bookings-sources', { strict: true });
    app.expectHealthy();
  });

  test('the public booking link card shows this site\'s /book and copies it', async ({ app, page }, testInfo) => {
    // A clipboard that only records, so no browser permission is asked for.
    await page.addInitScript(() => {
      const copied: string[] = [];
      (window as unknown as { __copied: string[] }).__copied = copied;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText(text: string) {
            copied.push(text);
            return Promise.resolve();
          },
        },
      });
    });
    const asked = (calls: readonly RecordedCall[]) => [...new Set(calls.map((call) => `${call.method} ${call.url.split('?')[0]}`))].sort();

    // What the page asks for with no card: the same page on a server with Meet off.
    app.db.r1.meet.enabled = false;
    await app.goto(ADDRESS);
    await expect(page.getByTestId('meet-status')).toHaveText('Google Meet interviews are off.');
    const withoutCard = asked(app.calls);
    expect(withoutCard).toContain(`GET ${MOCK_API_ORIGIN}${MEET_PATH}`);

    app.db.r1.meet.enabled = true;
    const from = app.calls.length;
    await app.goto(ADDRESS);

    const url = `${new URL(page.url()).origin}/book`;
    await expect(page.getByRole('heading', { level: 2, name: 'Public booking link' })).toBeVisible();
    const field = page.getByLabel('Link for candidates');
    await expect(field).toHaveValue(url);
    await expect(field).toHaveJSProperty('readOnly', true);
    await expect(field).not.toBeEditable();

    const before = app.calls.length;
    await page.getByRole('button', { name: 'Copy link' }).click();
    await expect(page.getByText('Link copied to the clipboard.', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual([url]);
    await app.settle();

    // The card is static: the copy sends nothing, and the page asks for nothing beyond the Meet bookings
    // reads and the shell's own, exactly what it asks for without the card (so no public booking API).
    expect(app.calls.slice(before)).toEqual([]);
    expect(asked(app.calls.slice(from))).toEqual(withoutCard);
    expect(await page.content()).not.toContain('/book/manage');

    await noSideways(app);
    await auditA11y(page, testInfo, 'r1-meet-bookings-public-link', { strict: true });
    app.expectHealthy();
  });

  test('a server with Meet off shows no public booking link', async ({ app, page }) => {
    app.db.r1.meet.enabled = false;
    await app.goto(ADDRESS);
    await expect(page.getByTestId('meet-status')).toHaveText('Google Meet interviews are off.');
    await app.settle();
    await expect(page.getByRole('heading', { name: 'Public booking link' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(0);
    await expect(page.getByLabel('Link for candidates')).toHaveCount(0);
    app.expectHealthy();
  });
});

test.describe('the Via Meet marker', () => {
  test('is on no round while the API sends no channel', async ({ app, page }) => {
    await app.goto('/interviews');
    await expect(page.getByRole('link', { name: 'Naveen Kapoor' })).toBeVisible();
    await expect(page.getByText('Via Meet')).toHaveCount(0);

    await app.goto(`/candidates/${R1_CANDIDATE_ID}?tab=r1`);
    await expect(page.getByRole('link', { name: 'Open R1 review' }).first()).toBeVisible();
    await expect(page.getByText('Via Meet')).toHaveCount(0);

    await app.goto(`/interviews/${R1_ROUND_ID}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sales Program Advisor role-play');
    await expect(page.getByText('Via Meet')).toHaveCount(0);
    app.expectHealthy();
  });

  test('marks a Meet round on the queue, the R1 tab and the review, in words', async ({ app, page }, testInfo) => {
    app.db.r1.queue[0].channel = 'meet';
    app.db.r1.rounds[0].channel = 'meet';
    app.db.r1.review.round.channel = 'meet';

    await app.goto('/interviews');
    const row = page.getByRole('row').filter({ hasText: 'Naveen Kapoor' });
    await expect(row.getByText('Via Meet')).toHaveText(/^Interview:\s*Via Meet$/);
    // Only that round: the other rows say nothing of Meet.
    await expect(page.getByText('Via Meet')).toHaveCount(1);
    await auditA11y(page, testInfo, 'r1-interviews-via-meet', { strict: true });

    await app.goto(`/candidates/${R1_CANDIDATE_ID}?tab=r1`);
    await expect(page.getByRole('link', { name: 'Open R1 review' }).first()).toBeVisible();
    await expect(page.getByText('Via Meet')).toHaveCount(1);
    await expect(page.getByText('Via Meet')).toHaveText(/^Interview:\s*Via Meet$/);

    await app.goto(`/interviews/${R1_ROUND_ID}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Sales Program Advisor role-play');
    await expect(page.getByText('Via Meet')).toHaveCount(1);
    await expect(page.getByText('Via Meet')).toHaveText(/^Interview:\s*Via Meet$/);
    app.expectHealthy();
  });
});
