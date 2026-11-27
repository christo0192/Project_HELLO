/**
 * Offline checks for the public booking pages (M035 S07): `/book`, the one link the hiring team
 * sends every candidate to register and book a first-round interview with Lexy on Google Meet,
 * and `/book/manage#m=<token>`, the link in Lexy's invite to move, cancel or agree again.
 *
 * The app under test is the REAL app on the Vite dev server, signed OUT like a candidate's
 * browser. Only the booking API is faked (fixtures/r1-book-api.ts, the shapes and words of
 * contracts section 6); any other request fails the test. Every test asserts no console error,
 * no unmocked or external request, and (through `expectBookHygiene`) no Authorization header,
 * no typed value or token in a URL and a bare address bar. The key states run axe STRICTLY and,
 * on the phone project, fail on any sideways scroll.
 *
 * The suite is kept to eight tests (the web-e2e job has a 25-minute limit). Each submit waits
 * once for the grid's 3.5 s minimum age (D-S07-M5), so the booked and moved cards are awaited
 * with a longer timeout.
 *
 * The `.e2e.ts` suffix keeps this out of vitest (`src/**\/*.test.*`).
 */

import type { Locator, Page } from '@playwright/test';
import { auditA11y } from './fixtures/axe';
import {
  bodiesOf,
  dropNetworkLogLines,
  expect,
  expectBookHygiene,
  openBook,
  openManage,
  requestLines,
  storedText,
  test,
} from './fixtures/book-harness';
import { expectMobileFits, heading } from './fixtures/candidate-flows';
import {
  BOOK_GRID_TOKEN,
  MANAGE_TOKEN,
  R1_BOOK_FAKE_ROUTES as ROUTES,
  R1_BOOK_TEMPLATE,
  bookSlotStart,
} from './fixtures/r1-book-api';

const FORM_TITLE = 'Book your interview with Lexy';
const BOOKED_TITLE = 'Your interview is booked';
/** One submit waits up to 3.5 s for the grid's minimum age before it posts. */
const AFTER_SUBMIT = { timeout: 15_000 };

const TYPED = Object.freeze({ name: 'Asha Rao', email: 'asha.rao@example.com', phone: '+91 98765 43210' });
const TYPED_VALUES = [TYPED.name, TYPED.email, TYPED.phone, '98765'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLOT_TAKEN = 'That time was just taken. Please pick another time.';
const GETS_ON_LOAD = [`GET ${ROUTES.consentTemplate}`, `GET ${ROUTES.slots}`];
const BOOK_KEYS = ['consent', 'email', 'grid_token', 'name', 'phone', 'request_id', 'slot_start', 'website'];

/** The consent every booking and re-consent sends: the template's purposes, in order, and India. */
const CONSENT = {
  template_version: R1_BOOK_TEMPLATE.version,
  consents: [...R1_BOOK_TEMPLATE.required_consents],
  in_india: true,
};

function radioGroup(page: Page, name: 'Day' | 'Time'): Locator {
  return page.getByRole('group', { name, exact: true });
}

function dayRadio(page: Page, day: RegExp): Locator {
  return radioGroup(page, 'Day').getByRole('radio', { name: day });
}

/** A time by its start, `HH:MM` IST: the radio's name is `HH:MM–HH:MM IST`, then any reason. */
function timeRadio(page: Page, start: string): Locator {
  return radioGroup(page, 'Time').getByRole('radio', { name: new RegExp(`^${start}–`) });
}

/** Pick a chip with the pointer: the radio is visually hidden inside its label, the chip. */
async function pick(radio: Locator): Promise<void> {
  await radio.locator('..').click();
  await expect(radio).toBeChecked();
}

/** Tick every purpose of the notice and the India box. */
async function agreeToNotice(scope: Page | Locator): Promise<void> {
  const purposes = scope
    .getByRole('group', { name: 'Please agree to each purpose separately' })
    .getByRole('checkbox');
  await expect(purposes).toHaveCount(R1_BOOK_TEMPLATE.required_consents.length);
  for (const box of await purposes.all()) await box.check();
  await scope.getByRole('checkbox', { name: 'I confirm I am located in India.' }).check();
}

/** Fill the whole form with the pointer: the details, Thursday at `time` IST, every box. */
async function fillForm(page: Page, time = '10:00'): Promise<void> {
  await page.getByLabel('Full name', { exact: true }).fill(TYPED.name);
  await page.getByLabel('Email address', { exact: true }).fill(TYPED.email);
  await page.getByLabel('Mobile number', { exact: true }).fill(TYPED.phone);
  await pick(dayRadio(page, /^Thu\b/));
  await pick(timeRadio(page, time));
  await agreeToNotice(page);
}

async function expectDetailsKept(page: Page): Promise<void> {
  await expect(page.getByLabel('Full name', { exact: true })).toHaveValue(TYPED.name);
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue(TYPED.email);
  await expect(page.getByLabel('Mobile number', { exact: true })).toHaveValue(TYPED.phone);
}

/** Press Tab until `target` has focus: the keyboard's way to the first field. */
async function tabTo(page: Page, target: Locator, max = 8): Promise<void> {
  for (let press = 0; press < max; press += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(target).toBeFocused();
}

async function tabExpect(page: Page, target: Locator): Promise<void> {
  await page.keyboard.press('Tab');
  await expect(target).toBeFocused();
}

test.describe('the booking page (/book)', () => {
  test('booking not open yet: the two reads only, nothing to press', async ({ book }, testInfo) => {
    book.state.disabled = true;
    const { page } = book;
    await openBook(book);
    await expect(heading(page, 'Booking is not open yet')).toBeVisible();
    await expect(page.getByText('Please try the link from the hiring team again later.')).toBeVisible();
    // Dark by construction: the notice and the grid were asked for, and nothing else.
    expect([...requestLines(book)].sort()).toEqual(GETS_ON_LOAD);
    await expect(page.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expectBookHygiene(book, []);
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-book-not-open', { strict: true });
    dropNetworkLogLines(book, 503);
    book.expectHealthy();
  });

  test('a person books with the keyboard alone, and exactly the declared body is sent', async ({ book }, testInfo) => {
    const { page } = book;
    await openBook(book);
    await expect(heading(page, FORM_TITLE)).toBeVisible();
    expect([...requestLines(book)].sort()).toEqual(GETS_ON_LOAD);
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-book-form', { strict: true });

    // From here on, the keyboard only. The details, padded with spaces the page must trim.
    const name = page.getByLabel('Full name', { exact: true });
    await tabTo(page, name);
    await page.keyboard.type(`  ${TYPED.name}  `);
    await tabExpect(page, page.getByLabel('Email address', { exact: true }));
    await page.keyboard.type(` ${TYPED.email} `);
    await tabExpect(page, page.getByLabel('Mobile number', { exact: true }));
    await page.keyboard.type(TYPED.phone);

    // The day group: Tab lands on the day shown (today, Wednesday), an arrow key picks Thursday.
    await tabExpect(page, dayRadio(page, /^Wed\b/));
    await page.keyboard.press('ArrowRight');
    const thursday = dayRadio(page, /^Thu\b/);
    await expect(thursday).toBeChecked();
    await expect(thursday).toBeFocused();
    // The time group: Tab lands on Thursday's first open time (09:00 is full), an arrow picks 10:00.
    await expect(timeRadio(page, '09:00')).toBeDisabled();
    await tabExpect(page, timeRadio(page, '09:30'));
    await page.keyboard.press('ArrowRight');
    const ten = timeRadio(page, '10:00');
    await expect(ten).toBeChecked();
    await expect(ten).toBeFocused();

    // The notice is a focusable region; then one box per purpose and the India box: Space ticks each.
    await tabExpect(page, page.getByRole('region', { name: 'Full notice' }));
    const boxes = [
      ...(await page
        .getByRole('group', { name: 'Please agree to each purpose separately' })
        .getByRole('checkbox')
        .all()),
      page.getByRole('checkbox', { name: 'I confirm I am located in India.' }),
    ];
    expect(boxes).toHaveLength(R1_BOOK_TEMPLATE.required_consents.length + 1);
    for (const box of boxes) {
      await tabExpect(page, box);
      await page.keyboard.press('Space');
      await expect(box).toBeChecked();
    }
    // The honeypot is out of the Tab order: the next stop is the submit button.
    await tabExpect(page, page.getByRole('button', { name: 'Book my interview' }));
    await page.keyboard.press('Enter');

    await expect(heading(page, BOOKED_TITLE)).toBeVisible(AFTER_SUBMIT);
    await expect(heading(page, BOOKED_TITLE)).toBeFocused();
    await expect(page.locator('.r1-book__when')).toContainText('10:00–10:45 IST');
    await expect(
      page.getByText(
        "Lexy's calendar invite is on its way to the email address on your application. It has the Google Meet link for your interview.",
      ),
    ).toBeVisible();
    await expect(page.getByText('If you do not see it soon, check your spam or junk folder.')).toBeVisible();

    // One POST, with exactly the eight declared keys.
    const posts = book.state.requests.filter((request) => request.method === 'POST');
    expect(posts.map((request) => `${request.path}${request.query}`)).toEqual([ROUTES.book]);
    const body = posts[0]?.body ?? {};
    expect(Object.keys(body).sort()).toEqual(BOOK_KEYS);
    expect(body).toEqual({
      request_id: expect.stringMatching(UUID_V4),
      name: TYPED.name,
      email: TYPED.email,
      phone: TYPED.phone,
      slot_start: bookSlotStart(1, 10, 0),
      grid_token: BOOK_GRID_TOKEN,
      consent: CONSENT,
      website: '',
    });

    // Nothing typed is shown back or kept: not in the page, not in web storage.
    await expect(page.locator('input')).toHaveCount(0);
    for (const value of [TYPED.name, TYPED.email]) {
      await expect(page.locator('body')).not.toContainText(value);
    }
    const stored = await storedText(book);
    for (const value of TYPED_VALUES) expect(stored.includes(value), `${value} in web storage`).toBe(false);
    await expectBookHygiene(book, TYPED_VALUES);
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-book-booked', { strict: true });
    book.expectHealthy();
  });

  test('no application found: the one neutral answer, and the typed details are kept', async ({ book }) => {
    book.state.bookOutcome = 'not_found';
    const { page } = book;
    await openBook(book);
    await fillForm(page);
    await page.getByRole('button', { name: 'Book my interview' }).click();
    await expect(heading(page, "We couldn't find your application")).toBeVisible(AFTER_SUBMIT);
    await expect(
      page.getByText(
        "We couldn't find an application you can book with. Check the email and phone number you used when you applied, or reply to the email from the hiring team.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(bodiesOf(book, 'book')).toHaveLength(1);

    await page.getByRole('button', { name: 'Check my details' }).click();
    await expect(heading(page, FORM_TITLE)).toBeVisible();
    await expectDetailsKept(page);
    await expect(timeRadio(page, '10:00')).toBeChecked();
    await expect(page.getByLabel('Full name', { exact: true })).toBeFocused();
    await expectBookHygiene(book, TYPED_VALUES);
    dropNetworkLogLines(book, 404);
    book.expectHealthy();
  });

  test('a time taken just before: the grid is read again, the details kept, another time books', async ({ book }) => {
    book.state.bookOutcome = 'slot_unavailable_once';
    const { page } = book;
    await openBook(book);
    await fillForm(page);
    await page.getByRole('button', { name: 'Book my interview' }).click();

    await expect(page.locator('p.r1-book__notice')).toHaveText(SLOT_TAKEN, AFTER_SUBMIT);
    await expect(page.locator('[aria-live="polite"]')).toHaveText(SLOT_TAKEN);
    // The refusal, then a second read of the grid.
    expect(requestLines(book).slice(2)).toEqual([`POST ${ROUTES.book}`, `GET ${ROUTES.slots}`]);
    await expectDetailsKept(page);
    // The time is gone from the new grid and nothing is picked.
    await expect(timeRadio(page, '10:00')).toBeDisabled();
    await expect(timeRadio(page, '10:00')).toHaveAccessibleName(/Not available/);
    await expect(radioGroup(page, 'Time').getByRole('radio', { checked: true })).toHaveCount(0);

    await pick(timeRadio(page, '10:30'));
    await page.getByRole('button', { name: 'Book my interview' }).click();
    await expect(heading(page, BOOKED_TITLE)).toBeVisible(AFTER_SUBMIT);
    const [first, second] = bodiesOf(book, 'book');
    expect(second).toMatchObject({ slot_start: bookSlotStart(1, 10, 30), email: TYPED.email });
    // A definite refusal never lends its request_id to the next attempt.
    expect(second?.request_id).not.toBe(first?.request_id);
    await expectBookHygiene(book, TYPED_VALUES);
    dropNetworkLogLines(book, 409);
    book.expectHealthy();
  });
});

test.describe('the manage page (/book/manage)', () => {
  test('the link opens the booking, strips itself, and cancels with the consent withdrawn', async ({ book }, testInfo) => {
    const { page } = book;
    await openManage(book);
    await expect(heading(page, 'Your interview with Lexy')).toBeVisible();
    // The token left the address bar at once and travelled in one body only.
    expect(page.url()).toMatch(/\/book\/manage$/);
    expect(requestLines(book)).toEqual([`POST ${ROUTES.manage}`]);
    expect(bodiesOf(book, 'manage')).toEqual([{ token: MANAGE_TOKEN }]);
    await expect(page.locator('.r1-book__when')).toContainText('17 September 2026');
    await expect(page.locator('.r1-book__when')).toContainText('12:00–12:45 IST');
    await expect(page.getByText('Join from the Google Meet link in your calendar invite.')).toBeVisible();
    await expect(page.getByText('You can change the time 2 more times.')).toBeVisible();
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-book-manage-view', { strict: true });

    await page.getByRole('button', { name: 'Cancel my interview' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Cancel your interview?' })).toBeFocused();
    const withdraw = page.getByRole('checkbox', { name: 'Also withdraw the consent I gave for this interview' });
    await expect(withdraw).not.toBeChecked();
    await withdraw.check();
    await page.getByRole('button', { name: 'Yes, cancel my interview' }).click();

    await expect(heading(page, 'Your interview is cancelled')).toBeVisible();
    await expect(page.getByText('We have also recorded that you withdrew your consent.')).toBeVisible();
    expect(bodiesOf(book, 'cancel')).toEqual([{ token: MANAGE_TOKEN, withdraw_consent: true }]);
    expect(book.state.withdrawn).toBe(true);
    // A spent link offers nothing more.
    await expect(page.getByRole('button')).toHaveCount(0);
    await expectBookHygiene(book, []);
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-book-manage-cancelled', { strict: true });
    book.expectHealthy();
  });

  test('a move picks a new time from the grid, never the current one, and ends the link', async ({ book }) => {
    const { page } = book;
    await openManage(book);
    await page.getByRole('button', { name: 'Change the time' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Pick a new time (India Standard Time)' })).toBeVisible();
    await pick(dayRadio(page, /^Thu\b/));
    // The booking's own time is shown, and cannot be picked.
    const current = timeRadio(page, '12:00');
    await expect(current).toBeDisabled();
    await expect(current).toHaveAccessibleName(/Your current time/);
    await pick(timeRadio(page, '14:00'));
    await page.getByRole('button', { name: 'Move my interview' }).click();

    await expect(heading(page, 'Your interview has moved')).toBeVisible(AFTER_SUBMIT);
    await expect(page.locator('.r1-book__when')).toContainText('14:00–14:45 IST');
    await expect(page.getByText('Use the link in that invite if you need to make another change.')).toBeVisible();
    expect(requestLines(book)).toEqual([`POST ${ROUTES.manage}`, `GET ${ROUTES.slots}`, `POST ${ROUTES.move}`]);
    expect(bodiesOf(book, 'move')).toEqual([
      { token: MANAGE_TOKEN, slot_start: bookSlotStart(1, 14, 0), grid_token: BOOK_GRID_TOKEN },
    ]);
    // The updated invite carries a new link: this page offers no further action.
    await expect(page.getByRole('button')).toHaveCount(0);
    await expectBookHygiene(book, []);
    book.expectHealthy();
  });

  test('a changed notice is asked for first, and agreeing again reads the booking once more', async ({ book }, testInfo) => {
    if (book.state.manage) book.state.manage.consentCurrent = false;
    const { page } = book;
    await openManage(book);
    const panel = page.getByRole('region', { name: 'Please review the updated interview notice' });
    await expect(panel).toBeVisible();
    expect(requestLines(book)).toEqual([`POST ${ROUTES.manage}`, `GET ${ROUTES.consentTemplate}`]);
    await auditA11y(page, testInfo, 'r1-book-manage-reconsent', { strict: true });

    await agreeToNotice(panel);
    await panel.getByRole('button', { name: 'Agree and keep my interview' }).click();

    await expect(page.locator('p.r1-book__notice')).toHaveText('Thank you. Your consent is recorded.');
    await expect(panel).toHaveCount(0);
    expect(bodiesOf(book, 'consent')).toEqual([{ token: MANAGE_TOKEN, consent: CONSENT }]);
    // One read after agreeing (no new link was sent): never a poll.
    expect(bodiesOf(book, 'manage')).toEqual([{ token: MANAGE_TOKEN }, { token: MANAGE_TOKEN }]);
    await expect(page.getByRole('button', { name: 'Change the time' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel my interview' })).toBeVisible();
    await expectBookHygiene(book, []);
    book.expectHealthy();
  });

  test('without a usable token the link is inactive and nothing is called', async ({ book }, testInfo) => {
    const { page } = book;
    await openManage(book, '#m=short');
    await expect(heading(page, 'This link is no longer active')).toBeVisible();
    expect(page.url()).toMatch(/\/book\/manage$/);

    // A fresh load of the bare path (not a same-page fragment change): the marker must be gone.
    await page.evaluate(() => {
      (window as unknown as { __bookMarker?: number }).__bookMarker = 1;
    });
    await openManage(book, '');
    expect(await page.evaluate(() => (window as unknown as { __bookMarker?: number }).__bookMarker)).toBeUndefined();
    await expect(heading(page, 'This link is no longer active')).toBeVisible();

    expect(book.state.requests).toEqual([]);
    expect(book.calls).toEqual([]);
    await expect(page.getByRole('button')).toHaveCount(0);
    await expectBookHygiene(book, []);
    await expectMobileFits(page, testInfo);
    await auditA11y(page, testInfo, 'r1-book-manage-inactive', { strict: true });
    book.expectHealthy();
  });
});
