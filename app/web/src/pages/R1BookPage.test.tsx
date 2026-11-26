import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

const h = vi.hoisted(() => ({
  consentTemplate: vi.fn(),
  slots: vi.fn(),
  book: vi.fn(),
  manage: vi.fn(),
  move: vi.fn(),
  cancel: vi.fn(),
  consent: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
// The real parsers and `classifyBookFailure` stay; only the calls are replaced.
vi.mock('../lib/r1/r1-book-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r1/r1-book-api')>()),
  r1BookApi: {
    consentTemplate: h.consentTemplate,
    slots: h.slots,
    book: h.book,
    manage: h.manage,
    move: h.move,
    cancel: h.cancel,
    consent: h.consent,
  },
}));

import { ApiError } from '../lib/api-client';
import { formatIstTimeRange } from '../lib/ist-datetime';
import { R1ApiError } from '../lib/r1/r1-api';
import {
  parseBookConsentTemplate,
  parseBookSlots,
  parseBooked,
  type R1BookGrid,
  type R1BookSubmission,
} from '../lib/r1/r1-book-api';
import { BOOK_REQUEST_ID_RE, formatBookSlot, r1BookClock } from '../lib/r1/r1-book';
import { R1_BOOK_COPY } from '../components/candidate-r1/r1-book-copy';
import { R1BookPage } from './R1BookPage';

// ── Fixtures (parsed like server answers; tokens built at run time, never token-shaped literals) ──

const TEMPLATE = parseBookConsentTemplate({
  version: 'r1-candidate-2026-11',
  locale: 'en-IN',
  title: 'Notice and consent for your AI interview',
  body_md: [
    '# What we collect',
    'Camera video, voice, transcript and scores.',
    '',
    '# Who processes it',
    '- Sarvam AI (speech)',
  ].join('\n'),
  required_consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'],
  consent_items: [{ type: 'ai_evaluation', label: 'I agree to the AI evaluation of my interview.' }],
});

const TEMPLATE_NEXT = parseBookConsentTemplate({
  ...TEMPLATE,
  version: 'r1-candidate-2026-12',
  consent_items: TEMPLATE.consent_items,
});

const at = (date: string, time: string): string => `${date}T${time}:00+05:30`;
const slot = (date: string, start: string, end: string, available: boolean) => ({
  start_at: at(date, start),
  end_at: at(date, end),
  available,
});
const gridToken = (n: number, fill: string): string =>
  `g1.${Date.UTC(2026, 8, 16) + n}.${fill.repeat(43)}`;

interface GridOptions {
  token?: string;
  fullyBooked?: boolean;
  /** Start times (HH:MM on day one) that are taken. */
  taken?: string[];
  allTaken?: boolean;
}

/** Three IST days: day one mixed, day two full, day three open. */
function makeGrid(options: GridOptions = {}): R1BookGrid {
  const taken = new Set(options.taken ?? []);
  const open = (time: string, base: boolean): boolean =>
    options.allTaken ? false : base && !taken.has(time);
  return parseBookSlots({
    timezone: 'Asia/Kolkata',
    slot_minutes: 45,
    generated_at: '2026-09-16T06:30:00Z',
    grid_token: options.token ?? gridToken(0, 'g'),
    fully_booked: options.fullyBooked ?? false,
    days: [
      {
        date: '2026-09-16',
        slots: [
          slot('2026-09-16', '09:00', '09:45', open('09:00', false)),
          slot('2026-09-16', '09:30', '10:15', open('09:30', true)),
          slot('2026-09-16', '10:00', '10:45', open('10:00', true)),
        ],
      },
      {
        date: '2026-09-17',
        slots: [slot('2026-09-17', '09:00', '09:45', false), slot('2026-09-17', '09:30', '10:15', false)],
      },
      { date: '2026-09-18', slots: [slot('2026-09-18', '11:00', '11:45', open('11:00', true))] },
    ],
  });
}

const GRID = makeGrid();
const FIRST_START = at('2026-09-16', '09:30');
const FIRST_END = at('2026-09-16', '10:15');
const BOOKED = parseBooked({ status: 'booked', start_at: FIRST_START, end_at: FIRST_END });

const NAME = 'Asha Rao';
const EMAIL = 'asha.rao@example.test';
const PHONE = '+91 98765 43210';
const TIME_LABEL = formatIstTimeRange(FIRST_START, FIRST_END);

const disabledError = () => new R1ApiError('booking_disabled', 503);
const unavailableError = () => new R1ApiError('temporarily_unavailable', 503);
const networkError = () => new ApiError('network_unreachable', 0);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

let nowSpy: MockInstance<() => number>;
let wallSpy: MockInstance<() => number>;
let sleepSpy: MockInstance<(ms: number) => Promise<void>>;

/** The wall clock the tests start from (the monotonic clock starts at 100 000). */
const WALL_MS = 1_700_000_000_000;

function renderPage(strict = false) {
  window.history.replaceState(null, '', '/book');
  const page = (
    <MemoryRouter initialEntries={['/book']}>
      <R1BookPage />
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{page}</StrictMode> : page);
}

const findForm = () => screen.findByRole('heading', { level: 1, name: R1_BOOK_COPY.form.title });
const findH1 = (name: string) => screen.findByRole('heading', { level: 1, name });
const field = (id: string) => document.getElementById(id) as HTMLInputElement;
const nameInput = () => screen.getByLabelText(R1_BOOK_COPY.form.nameLabel) as HTMLInputElement;
const emailInput = () => screen.getByLabelText(R1_BOOK_COPY.form.emailLabel) as HTMLInputElement;
const phoneInput = () => screen.getByLabelText(R1_BOOK_COPY.form.phoneLabel) as HTMLInputElement;
const submitButton = () => screen.getByRole('button', { name: R1_BOOK_COPY.form.submit });
const timeRadios = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="r1-book-time"]'));
const liveRegion = () => document.querySelector('p[aria-live="polite"]') as HTMLElement;
const submissions = (): R1BookSubmission[] =>
  h.book.mock.calls.map((call) => call[0] as R1BookSubmission);

type User = ReturnType<typeof userEvent.setup>;

/** A user without a pause between keystrokes: the form re-renders on every key. */
const setupUser = (): User => userEvent.setup({ delay: null });

async function fillDetails(user: User, values = { name: NAME, email: EMAIL, phone: PHONE }) {
  await user.type(nameInput(), values.name);
  await user.type(emailInput(), values.email);
  await user.type(phoneInput(), values.phone);
}

async function tickEverything(user: User) {
  for (const type of TEMPLATE.required_consents) await user.click(field(`r1-book-consent-${type}`));
  await user.click(field('r1-book-in-india'));
}

/** Type the details, pick 09:30 on the first day, tick every box: a form ready to send. */
async function fillForm(user: User) {
  await fillDetails(user);
  await user.click(screen.getByRole('radio', { name: TIME_LABEL }));
  await tickEverything(user);
}

async function openAndFill(user: User) {
  renderPage();
  await findForm();
  await fillForm(user);
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.consentTemplate.mockResolvedValue(TEMPLATE);
  h.slots.mockResolvedValue(GRID);
  h.book.mockResolvedValue(BOOKED);
  nowSpy = vi.spyOn(r1BookClock, 'now').mockReturnValue(100_000);
  wallSpy = vi.spyOn(r1BookClock, 'wallNow').mockReturnValue(WALL_MS);
  sleepSpy = vi.spyOn(r1BookClock, 'sleep').mockResolvedValue(undefined);
});

// ── 1-4: loading and the closed states ─────────────────────────────────────────────────────

describe('R1BookPage loading', () => {
  it('shows loading, then the form, after one read of the notice and one of the grid', async () => {
    const template = deferred<typeof TEMPLATE>();
    h.consentTemplate.mockReturnValue(template.promise);
    renderPage();
    expect(screen.getByRole('status')).toHaveTextContent(R1_BOOK_COPY.states.loading);
    await act(async () => {
      template.resolve(TEMPLATE);
    });
    await findForm();
    expect(h.consentTemplate).toHaveBeenCalledTimes(1);
    expect(h.slots).toHaveBeenCalledTimes(1);
    expect(h.consentTemplate.mock.calls[0]).toEqual([]);
    expect(h.slots.mock.calls[0]).toEqual([]);
    expect(h.book).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('reads once under StrictMode', async () => {
    renderPage(true);
    await findForm();
    expect(h.consentTemplate).toHaveBeenCalledTimes(1);
    expect(h.slots).toHaveBeenCalledTimes(1);
    expect(h.book).not.toHaveBeenCalled();
  });

  it('opens on the first day with a free time, nothing picked and nothing ticked', async () => {
    renderPage();
    await findForm();
    const days = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="r1-book-day"]'));
    expect(days.find((radio) => radio.checked)?.value).toBe('2026-09-16');
    expect(timeRadios().some((radio) => radio.checked)).toBe(false);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
  });

  it.each([
    ['the notice', 'consentTemplate'],
    ['the grid', 'slots'],
  ] as const)('shows "not open yet" when %s answers booking_disabled, and never posts', async (_, route) => {
    h[route].mockRejectedValue(disabledError());
    renderPage();
    expect(await findH1(R1_BOOK_COPY.states.notOpen.title)).toHaveFocus();
    expect(screen.getByText(R1_BOOK_COPY.states.notOpen.body)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(h.book).not.toHaveBeenCalled();
  });

  it('reads "not open" when one read is disabled and the other merely unavailable', async () => {
    h.consentTemplate.mockRejectedValue(unavailableError());
    h.slots.mockRejectedValue(disabledError());
    renderPage();
    await findH1(R1_BOOK_COPY.states.notOpen.title);
  });

  it.each([
    ['the notice', 'consentTemplate'],
    ['the grid', 'slots'],
  ] as const)('shows "not open yet" when %s answers 401 (the routes are not served yet), and never posts', async (_, route) => {
    h[route].mockRejectedValue(new R1ApiError('unauthorized', 401));
    renderPage();
    expect(await findH1(R1_BOOK_COPY.states.notOpen.title)).toHaveFocus();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(R1_BOOK_COPY.states.unavailable.title)).toBeNull();
    expect(h.book).not.toHaveBeenCalled();
  });

  it.each([
    ['temporarily_unavailable', unavailableError],
    ['a dropped request', networkError],
    ['a 429 from the limiter', () => new R1ApiError('rate_limited', 429)],
    ['a malformed answer', () => new ApiError('r1_malformed_response', 500)],
  ])('shows "temporarily unavailable" for %s, and "Try again" reads both again', async (_, error) => {
    const user = setupUser();
    h.slots.mockRejectedValueOnce(error());
    renderPage();
    expect(await findH1(R1_BOOK_COPY.states.unavailable.title)).toHaveFocus();
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.unavailable.action }));
    expect(await findForm()).toHaveFocus();
    expect(h.consentTemplate).toHaveBeenCalledTimes(2);
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.live.updated);
    expect(h.book).not.toHaveBeenCalled();
  });

  it.each([
    ['the grid says fully booked', () => makeGrid({ fullyBooked: true })],
    ['no time is available', () => makeGrid({ allTaken: true })],
  ])('shows "all times are taken" when %s, and "Check again" reads again', async (_, grid) => {
    const user = setupUser();
    h.slots.mockResolvedValueOnce(grid());
    renderPage();
    expect(await findH1(R1_BOOK_COPY.states.fullyBooked.title)).toHaveFocus();
    expect(screen.getByText(R1_BOOK_COPY.states.fullyBooked.body)).toBeVisible();
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.fullyBooked.action }));
    await findForm();
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(h.book).not.toHaveBeenCalled();
  });
});

// ── 5: client checks ───────────────────────────────────────────────────────────────────────

describe('R1BookPage form checks', () => {
  it('lists every problem in a focused summary whose buttons focus their fields, and sends nothing', async () => {
    const user = setupUser();
    renderPage();
    await findForm();
    await user.click(submitButton());

    const summary = screen.getByRole('group', { name: R1_BOOK_COPY.errors.summaryTitle });
    expect(summary).toHaveFocus();
    const items = within(summary).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      R1_BOOK_COPY.errors.name_required,
      R1_BOOK_COPY.errors.email_required,
      R1_BOOK_COPY.errors.phone_required,
      R1_BOOK_COPY.errors.slot_required,
      R1_BOOK_COPY.errors.consents_required,
      R1_BOOK_COPY.errors.in_india_required,
    ]);
    const targets = [
      'r1-book-name',
      'r1-book-email',
      'r1-book-phone',
      'r1-book-slot-first',
      `r1-book-consent-${TEMPLATE.required_consents[0]}`,
      'r1-book-in-india',
    ];
    for (const [index, item] of items.entries()) {
      await user.click(item);
      expect(document.activeElement?.id).toBe(targets[index]);
    }
    expect(summary.querySelector('a')).toBeNull();

    expect(nameInput()).toHaveAttribute('aria-invalid', 'true');
    expect(nameInput().getAttribute('aria-describedby')).toBe('r1-book-name-error');
    expect(nameInput()).toHaveAccessibleDescription(R1_BOOK_COPY.errors.name_required);
    expect(emailInput()).toHaveAttribute('aria-invalid', 'true');
    expect(emailInput().getAttribute('aria-describedby')).toBe('r1-book-email-hint r1-book-email-error');
    expect(phoneInput()).toHaveAttribute('aria-invalid', 'true');
    expect(phoneInput().getAttribute('aria-describedby')).toBe('r1-book-phone-hint r1-book-phone-error');
    expect(field('r1-book-in-india')).toHaveAttribute('aria-invalid', 'true');
    expect(field(`r1-book-consent-${TEMPLATE.required_consents[0]}`)).toHaveAttribute(
      'aria-describedby',
      'r1-book-consents-error',
    );
    expect(h.book).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(h.slots).toHaveBeenCalledTimes(1);
  });

  it('names only what is still wrong, and points the consent item at the first unticked box', async () => {
    const user = setupUser();
    renderPage();
    await findForm();
    await fillDetails(user, { name: NAME, email: 'not-an-email', phone: '12345' });
    await user.click(screen.getByRole('radio', { name: TIME_LABEL }));
    await user.click(field(`r1-book-consent-${TEMPLATE.required_consents[0]}`));
    await user.click(field('r1-book-in-india'));
    await user.click(submitButton());
    const summary = screen.getByRole('group', { name: R1_BOOK_COPY.errors.summaryTitle });
    const items = within(summary).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      R1_BOOK_COPY.errors.email_invalid,
      R1_BOOK_COPY.errors.phone_invalid,
      R1_BOOK_COPY.errors.consents_required,
    ]);
    await user.click(items[2]);
    expect(document.activeElement?.id).toBe(`r1-book-consent-${TEMPLATE.required_consents[1]}`);
    expect(nameInput()).not.toHaveAttribute('aria-invalid');
    expect(h.book).not.toHaveBeenCalled();
  });
});

// ── 6-7: the booking and what it sends ─────────────────────────────────────────────────────

describe('R1BookPage booking', () => {
  it('sends exactly the declared fields, trimmed, and shows the booked time without any typed value', async () => {
    const user = setupUser();
    renderPage();
    await findForm();
    await fillDetails(user, { name: `  ${NAME}  `, email: ` ${EMAIL} `, phone: ` ${PHONE} ` });
    await user.click(screen.getByRole('radio', { name: TIME_LABEL }));
    await tickEverything(user);
    await user.click(submitButton());

    const heading = await findH1(R1_BOOK_COPY.states.booked.title);
    expect(heading).toHaveFocus();
    expect(h.book).toHaveBeenCalledTimes(1);
    const [sent] = submissions();
    expect(Object.keys(sent).sort()).toEqual(
      ['consent', 'email', 'grid_token', 'name', 'phone', 'request_id', 'slot_start', 'website'],
    );
    expect(sent.name).toBe(NAME);
    expect(sent.email).toBe(EMAIL);
    expect(sent.phone).toBe(PHONE);
    expect(sent.slot_start).toBe(GRID.days[0].slots[1].start_at);
    expect(sent.grid_token).toBe(GRID.grid_token);
    expect(sent.consent).toEqual({
      template_version: TEMPLATE.version,
      consents: TEMPLATE.required_consents,
      in_india: true,
    });
    expect(Object.keys(sent.consent).sort()).toEqual(['consents', 'in_india', 'template_version']);
    expect(sent.website).toBe('');
    expect(sent.request_id).toMatch(BOOK_REQUEST_ID_RE);

    const card = screen.getByRole('region', { name: R1_BOOK_COPY.states.booked.title });
    expect(within(card).getByText(formatBookSlot(BOOKED.start_at, BOOKED.end_at))).toBeVisible();
    expect(within(card).getByText(R1_BOOK_COPY.states.booked.body)).toBeVisible();
    expect(within(card).getByText(R1_BOOK_COPY.states.booked.spam)).toBeVisible();
    expect(within(card).getByText(R1_BOOK_COPY.states.booked.change)).toBeVisible();
    const text = document.body.textContent ?? '';
    for (const typed of [NAME, EMAIL, PHONE]) expect(text).not.toContain(typed);
    for (const input of Array.from(document.querySelectorAll('input'))) {
      for (const typed of [NAME, EMAIL, PHONE]) expect(input.value).not.toContain(typed);
    }
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('shows the time the server confirmed, not the one that was picked', async () => {
    const user = setupUser();
    const start = at('2026-09-16', '10:00');
    const end = at('2026-09-16', '10:45');
    h.book.mockResolvedValue(parseBooked({ status: 'booked', start_at: start, end_at: end }));
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(screen.getByText(formatBookSlot(start, end))).toBeVisible();
    expect(screen.queryByText(formatBookSlot(FIRST_START, FIRST_END))).toBeNull();
  });

  it('has a honeypot: aria-hidden, out of the Tab order, named website, empty for people', async () => {
    renderPage();
    await findForm();
    const trap = field('r1-book-website');
    expect(trap).toHaveAttribute('name', 'website');
    expect(trap).toHaveAttribute('type', 'text');
    expect(trap).toHaveAttribute('tabindex', '-1');
    expect(trap).toHaveAttribute('autocomplete', 'off');
    expect(trap.value).toBe('');
    const wrapper = trap.closest('[aria-hidden="true"]') as HTMLElement;
    expect(wrapper).toHaveClass('r1-book__trap');
    expect(within(wrapper).getByText(R1_BOOK_COPY.form.trapLabel)).toBeInTheDocument();
    // It is the one control with a name: nothing a person types can reach a native submit.
    const named = Array.from(document.querySelectorAll('input[name], textarea[name], select[name]'))
      .filter((element) => (element as HTMLInputElement).type !== 'radio');
    expect(named).toEqual([trap]);
    const form = trap.closest('form') as HTMLFormElement;
    expect(form).toHaveAttribute('novalidate');
    expect(form.getAttribute('method')).toBe('post');
    expect(form).not.toHaveAttribute('action');
  });

  it('sends what a form filler put in the honeypot, as it is', async () => {
    const user = setupUser();
    await openAndFill(user);
    fireEvent.change(field('r1-book-website'), { target: { value: 'filled by a bot' } });
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(submissions()[0].website).toBe('filled by a bot');
  });

  it('never puts a filled honeypot back when the form comes back, so an autofill cannot trap a person', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('not_found', 404));
    await openAndFill(user);
    // An identity autofill (or a password manager) filled the hidden field.
    fireEvent.change(field('r1-book-website'), { target: { value: 'https://example.test' } });
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.notFound.title);
    expect(submissions()[0].website).toBe('https://example.test');

    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.notFound.action }));
    await findForm();
    expect(field('r1-book-website').value).toBe('');
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(submissions()[1].website).toBe('');
  });

  it('asks password managers to leave the honeypot alone', async () => {
    renderPage();
    await findForm();
    const trap = field('r1-book-website');
    expect(trap).toHaveAttribute('data-1p-ignore', 'true');
    expect(trap).toHaveAttribute('data-lpignore', 'true');
    expect(trap).toHaveAttribute('data-bwignore', 'true');
  });

  it('keeps the typed details read-only while a booking is on its way, so they match what was sent', async () => {
    const user = setupUser();
    const pending = deferred<typeof BOOKED>();
    h.book.mockReturnValueOnce(pending.promise);
    await openAndFill(user);
    await user.click(submitButton());
    await waitFor(() => expect(h.book).toHaveBeenCalledTimes(1));
    for (const input of [nameInput(), emailInput(), phoneInput()]) {
      expect(input).toHaveAttribute('readonly');
      expect(input).not.toBeDisabled();
    }
    await user.type(emailInput(), 'x');
    fireEvent.change(nameInput(), { target: { value: 'Someone Else' } });
    expect(emailInput().value).toBe(EMAIL);
    expect(nameInput().value).toBe(NAME);
    await act(async () => {
      pending.resolve(BOOKED);
    });
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(submissions()[0].email).toBe(EMAIL);
  });

  it('makes the typed details editable again once the answer is in', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('not_found', 404));
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.notFound.title);
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.notFound.action }));
    await findForm();
    for (const input of [nameInput(), emailInput(), phoneInput()]) {
      expect(input).not.toHaveAttribute('readonly');
    }
    await user.type(emailInput(), 'x');
    expect(emailInput().value).toBe(`${EMAIL}x`);
  });

  it('ignores a second submit while the first is on its way', async () => {
    const user = setupUser();
    const pending = deferred<typeof BOOKED>();
    h.book.mockReturnValue(pending.promise);
    await openAndFill(user);
    await user.click(submitButton());
    await waitFor(() => expect(h.book).toHaveBeenCalledTimes(1));
    // The button is busy (disabled, its spinner named "Loading"); a submit still reaches the form.
    const busy = document.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(busy).toBeDisabled();
    fireEvent.submit(busy.closest('form') as HTMLFormElement);
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.live.booking);
    await act(async () => {
      pending.resolve(BOOKED);
    });
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(h.book).toHaveBeenCalledTimes(1);
  });
});

// ── 8: request_id ──────────────────────────────────────────────────────────────────────────

describe('R1BookPage request_id', () => {
  const retryTitle = R1_BOOK_COPY.states.retry.title;
  const uncertainTitle = R1_BOOK_COPY.states.uncertain.title;
  const tryAgain = () => screen.getByRole('button', { name: R1_BOOK_COPY.states.retry.action });

  it('mints a new id after a definite refusal (503 temporarily_unavailable)', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(unavailableError());
    await openAndFill(user);
    await user.click(submitButton());
    expect(await findH1(retryTitle)).toHaveFocus();
    expect(screen.queryByText(uncertainTitle)).toBeNull();
    await user.click(tryAgain());
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(first.request_id).toMatch(BOOK_REQUEST_ID_RE);
    expect(second.request_id).toMatch(BOOK_REQUEST_ID_RE);
    expect(second.request_id).not.toBe(first.request_id);
  });

  it('never says a booking failed when it may have gone through: a dropped request is "not confirmed"', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(networkError());
    await openAndFill(user);
    await user.click(submitButton());
    expect(await findH1(uncertainTitle)).toHaveFocus();
    expect(screen.getByText(R1_BOOK_COPY.states.uncertain.body)).toBeVisible();
    expect(screen.queryByText(retryTitle)).toBeNull();
    expect(screen.queryByText(R1_BOOK_COPY.states.retry.body)).toBeNull();
    expect(tryAgain()).toBeEnabled();
    expect(screen.getByRole('button', { name: R1_BOOK_COPY.states.uncertain.back })).toBeEnabled();
  });

  it('reuses the id to retry the same details after a dropped request', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(networkError());
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(uncertainTitle);
    await user.click(tryAgain());
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(second.request_id).toBe(first.request_id);
    expect(second).toEqual(first);
  });

  it('mints a new id when the details change after a dropped request', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(networkError());
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(uncertainTitle);
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.uncertain.back }));
    expect(await findForm()).toBeInTheDocument();
    expect(nameInput()).toHaveFocus();
    expect(nameInput().value).toBe(NAME);
    await user.type(emailInput(), 'x');
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(second.email).toBe(`${EMAIL}x`);
    expect(second.request_id).not.toBe(first.request_id);
  });

  it('reuses the id to retry after a malformed 2xx', async () => {
    const user = setupUser();
    // The real parser rejects the answer: the server may have booked.
    h.book.mockImplementationOnce(async () => parseBooked({ status: 'ok' }));
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(uncertainTitle);
    await user.click(tryAgain());
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(second.request_id).toBe(first.request_id);
  });

  it.each([
    ['a 500', () => new R1ApiError('internal_error', 500)],
    ['a 502', () => new R1ApiError('http_502', 502)],
    ['a 504', () => new R1ApiError('http_504', 504)],
  ])('treats %s as uncertain and reuses the id', async (_, error) => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(error());
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(uncertainTitle);
    await user.click(tryAgain());
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(second.request_id).toBe(first.request_id);
  });

  it('reads an unexpected word or a 429 as a definite refusal: a new id', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('rate_limited', 429));
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(retryTitle);
    await user.click(tryAgain());
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(second.request_id).not.toBe(first.request_id);
  });

  // §6 order: the throttles (step 5) and the /api/r1 limiter answer BEFORE the replay check
  // (step 6), so such an answer to a replay says nothing about the first attempt. Its id must
  // survive, or the next retry could never reach the replay of a booking that was made.
  it.each([
    ['503 temporarily_unavailable', unavailableError],
    ['a 429 from the limiter', () => new R1ApiError('rate_limited', 429)],
    ['an unknown word', () => new R1ApiError('http_418', 418)],
  ])('keeps the id of an unconfirmed booking when its retry is refused with %s', async (_, error) => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(networkError()).mockRejectedValueOnce(error());
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(uncertainTitle);

    await user.click(tryAgain());
    await waitFor(() => expect(h.book).toHaveBeenCalledTimes(2));
    // Still not confirmed: the first attempt may have booked.
    const again = await screen.findByRole('button', { name: R1_BOOK_COPY.states.uncertain.action });
    expect(screen.getByRole('heading', { level: 1, name: uncertainTitle })).toHaveFocus();
    expect(screen.queryByText(retryTitle)).toBeNull();

    await user.click(again);
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second, third] = submissions();
    expect(second.request_id).toBe(first.request_id);
    expect(third.request_id).toBe(first.request_id);
    expect(third).toEqual(first);
  });

  it('keeps the id of an unconfirmed booking when the grid read before its retry fails', async () => {
    const user = setupUser();
    nowSpy.mockReturnValue(0);
    h.book.mockRejectedValueOnce(networkError());
    h.slots.mockResolvedValueOnce(GRID).mockRejectedValueOnce(unavailableError());
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(uncertainTitle);

    nowSpy.mockReturnValue(26 * 60_000);
    await user.click(tryAgain());
    await waitFor(() => expect(h.slots).toHaveBeenCalledTimes(2));
    const again = await screen.findByRole('button', { name: R1_BOOK_COPY.states.uncertain.action });
    expect(screen.getByRole('heading', { level: 1, name: uncertainTitle })).toBeInTheDocument();
    expect(h.book).toHaveBeenCalledTimes(1);

    await user.click(again);
    await findH1(R1_BOOK_COPY.states.booked.title);
    const [first, second] = submissions();
    expect(second.request_id).toBe(first.request_id);
  });
});

// ── 9-10: grid age ─────────────────────────────────────────────────────────────────────────

describe('R1BookPage grid age', () => {
  const STALE_MS = 26 * 60_000;

  it('reads a grid older than 25 minutes again before booking, and sends the new token', async () => {
    const user = setupUser();
    const fresh = makeGrid({ token: gridToken(1, 'h') });
    nowSpy.mockReturnValue(0);
    h.slots.mockResolvedValueOnce(GRID).mockResolvedValueOnce(fresh);
    await openAndFill(user);
    nowSpy.mockReturnValue(STALE_MS);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(h.slots.mock.invocationCallOrder[1]).toBeLessThan(h.book.mock.invocationCallOrder[0]);
    expect(submissions()[0].grid_token).toBe(fresh.grid_token);
    // The new grid is brand new: one wait for its minimum age, then the booking.
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(3_500);
  });

  it('reads the grid again after the phone slept: the wall clock moved 40 minutes, the monotonic one did not', async () => {
    const user = setupUser();
    const fresh = makeGrid({ token: gridToken(1, 'h') });
    h.slots.mockResolvedValueOnce(GRID).mockResolvedValueOnce(fresh);
    await openAndFill(user);
    // `performance.now()` may pause while a device sleeps; the server's 30-minute token limit
    // runs on its wall clock, so the page must not trust the monotonic clock alone.
    wallSpy.mockReturnValue(WALL_MS + 40 * 60_000);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(h.slots.mock.invocationCallOrder[1]).toBeLessThan(h.book.mock.invocationCallOrder[0]);
    expect(submissions()[0].grid_token).toBe(fresh.grid_token);
  });

  it('never makes a grid younger when the wall clock is set back', async () => {
    const user = setupUser();
    nowSpy.mockReturnValue(0);
    await openAndFill(user);
    nowSpy.mockReturnValue(1_000);
    wallSpy.mockReturnValue(WALL_MS - 60 * 60_000);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(sleepSpy).toHaveBeenCalledWith(2_500);
    expect(h.slots).toHaveBeenCalledTimes(1);
  });

  it('does not post when the reloaded grid no longer offers the chosen time', async () => {
    const user = setupUser();
    nowSpy.mockReturnValue(0);
    h.slots
      .mockResolvedValueOnce(GRID)
      .mockResolvedValueOnce(makeGrid({ token: gridToken(1, 'h'), taken: ['09:30'] }));
    await openAndFill(user);
    nowSpy.mockReturnValue(STALE_MS);
    await user.click(submitButton());
    expect(await screen.findByText(R1_BOOK_COPY.inline.slotTaken, { selector: '.r1-book__notice' })).toBeVisible();
    expect(h.book).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(timeRadios().some((radio) => radio.checked)).toBe(false);
    expect(screen.getByRole('radio', { name: `${TIME_LABEL} ${R1_BOOK_COPY.form.timeUnavailable}` })).toBeDisabled();
    expect(nameInput().value).toBe(NAME);
  });

  it('still posts the retry of an uncertain attempt when the reloaded grid shows the time taken', async () => {
    const user = setupUser();
    const taken = makeGrid({ token: gridToken(1, 'h'), taken: ['09:30'] });
    nowSpy.mockReturnValue(0);
    h.slots.mockResolvedValueOnce(GRID).mockResolvedValueOnce(taken);
    h.book.mockRejectedValueOnce(networkError());
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.uncertain.title);
    nowSpy.mockReturnValue(STALE_MS);
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.uncertain.action }));
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(h.book).toHaveBeenCalledTimes(2);
    const [first, second] = submissions();
    expect(second.request_id).toBe(first.request_id);
    expect(second.slot_start).toBe(first.slot_start);
    expect(second.grid_token).toBe(taken.grid_token);
  });

  it('shows the retry card when the reload before booking fails, and "not open" when it is disabled', async () => {
    const user = setupUser();
    nowSpy.mockReturnValue(0);
    h.slots.mockResolvedValueOnce(GRID).mockRejectedValueOnce(unavailableError());
    await openAndFill(user);
    nowSpy.mockReturnValue(STALE_MS);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.retry.title);
    expect(h.book).not.toHaveBeenCalled();

    h.slots.mockRejectedValueOnce(disabledError());
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.retry.action }));
    await findH1(R1_BOOK_COPY.states.notOpen.title);
    expect(h.book).not.toHaveBeenCalled();
  });

  it('waits once for the rest of 3.5 s when the grid is younger, before booking', async () => {
    const user = setupUser();
    nowSpy.mockReturnValue(0);
    await openAndFill(user);
    nowSpy.mockReturnValue(1_000);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(2_500);
    expect(sleepSpy.mock.invocationCallOrder[0]).toBeLessThan(h.book.mock.invocationCallOrder[0]);
    expect(h.slots).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a grid older than 3.5 s', async () => {
    const user = setupUser();
    nowSpy.mockReturnValue(0);
    await openAndFill(user);
    nowSpy.mockReturnValue(5_000);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(h.slots).toHaveBeenCalledTimes(1);
  });
});

// ── 11-16: refusals ────────────────────────────────────────────────────────────────────────

describe('R1BookPage refusals', () => {
  it('reads the grid again on slot_unavailable, keeps the details, clears the time and says so', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('slot_unavailable', 409));
    h.slots.mockResolvedValueOnce(GRID).mockResolvedValueOnce(makeGrid({ taken: ['09:30'] }));
    await openAndFill(user);
    await user.click(submitButton());
    expect(await screen.findByText(R1_BOOK_COPY.inline.slotTaken, { selector: '.r1-book__notice' })).toBeVisible();
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(nameInput().value).toBe(NAME);
    expect(emailInput().value).toBe(EMAIL);
    expect(phoneInput().value).toBe(PHONE);
    expect(timeRadios().some((radio) => radio.checked)).toBe(false);
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.inline.slotTaken);
    expect(document.activeElement?.id).toBe('r1-book-slot-first');
    // The boxes stay ticked: only the time was refused.
    expect(field('r1-book-in-india')).toBeChecked();
  });

  it('shows "all times are taken" when the grid read after slot_unavailable has nothing left', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('slot_unavailable', 409));
    h.slots.mockResolvedValueOnce(GRID).mockResolvedValueOnce(makeGrid({ allTaken: true }));
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.fullyBooked.title);
  });

  it('reads the notice again on consent_stale and clears every box, India included', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('consent_stale', 409));
    h.consentTemplate.mockResolvedValueOnce(TEMPLATE).mockResolvedValueOnce(TEMPLATE_NEXT);
    await openAndFill(user);
    await user.click(submitButton());
    const notice = await screen.findByText(R1_BOOK_COPY.inline.noticeChanged, { selector: '.r1-book__notice' });
    expect(notice).toHaveFocus();
    expect(h.consentTemplate).toHaveBeenCalledTimes(2);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(nameInput().value).toBe(NAME);
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.inline.noticeChanged);

    await tickEverything(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    expect(submissions()[1].consent.template_version).toBe(TEMPLATE_NEXT.version);
  });

  it('shows one not-found text, and "Check my details" brings back what was typed', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('not_found', 404));
    await openAndFill(user);
    await user.click(submitButton());
    expect(await findH1(R1_BOOK_COPY.states.notFound.title)).toHaveFocus();
    expect(screen.getByText(R1_BOOK_COPY.states.notFound.body)).toBeVisible();
    expect(document.body.textContent).not.toContain(EMAIL);
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.states.notFound.action }));
    await findForm();
    expect(nameInput()).toHaveFocus();
    expect(nameInput().value).toBe(NAME);
    expect(emailInput().value).toBe(EMAIL);
    expect(phoneInput().value).toBe(PHONE);
    expect(screen.getByRole('radio', { name: TIME_LABEL })).toBeChecked();
  });

  it('never reads a 404 with another word as not found', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('http_404', 404));
    await openAndFill(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.retry.title);
  });

  it('shows "already booked" with no time and no typed value, and forgets the details', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('already_booked', 409));
    await openAndFill(user);
    await user.click(submitButton());
    expect(await findH1(R1_BOOK_COPY.states.alreadyBooked.title)).toHaveFocus();
    expect(screen.getByText(R1_BOOK_COPY.states.alreadyBooked.body)).toBeVisible();
    expect(document.querySelector('.r1-book__when')).toBeNull();
    const text = document.body.textContent ?? '';
    for (const typed of [NAME, EMAIL, PHONE, TIME_LABEL]) expect(text).not.toContain(typed);
    expect(document.querySelectorAll('input')).toHaveLength(0);
  });

  it('puts the server refusal of invalid_request in the summary', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(new R1ApiError('invalid_request', 400));
    await openAndFill(user);
    await user.click(submitButton());
    const summary = await screen.findByRole('group', { name: R1_BOOK_COPY.errors.summaryTitle });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(within(summary).getByRole('button', { name: R1_BOOK_COPY.errors.serverInvalid })).toBeVisible();
    expect(nameInput().value).toBe(NAME);
  });

  it('shows "not open yet" when the booking answers booking_disabled', async () => {
    const user = setupUser();
    h.book.mockRejectedValueOnce(disabledError());
    await openAndFill(user);
    await user.click(submitButton());
    expect(await findH1(R1_BOOK_COPY.states.notOpen.title)).toHaveFocus();
  });
});

// ── 17-19: privacy, keyboard, referrer ─────────────────────────────────────────────────────

describe('R1BookPage privacy and access', () => {
  it('never touches storage or the address bar', async () => {
    const user = setupUser();
    window.history.replaceState(null, '', '/book');
    const storage = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    render(
      <MemoryRouter initialEntries={['/book']}>
        <R1BookPage />
      </MemoryRouter>,
    );
    await findForm();
    await user.click(submitButton());
    await fillForm(user);
    await user.click(submitButton());
    await findH1(R1_BOOK_COPY.states.booked.title);
    for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/book');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });

  it('books with the keyboard alone', async () => {
    const user = setupUser();
    const pointer = vi.fn();
    document.addEventListener('pointerdown', pointer);
    try {
      renderPage();
      await findForm();
      await user.tab();
      expect(nameInput()).toHaveFocus();
      await user.keyboard(NAME);
      await user.tab();
      expect(emailInput()).toHaveFocus();
      await user.keyboard(EMAIL);
      await user.tab();
      expect(phoneInput()).toHaveFocus();
      await user.keyboard(PHONE);

      await user.tab();
      const firstDay = document.querySelector<HTMLInputElement>('input[name="r1-book-day"]:checked');
      expect(firstDay).toHaveFocus();
      // The second day has no free time, so the arrow skips it.
      await user.keyboard('{ArrowRight}');
      const thirdDay = document.querySelector<HTMLInputElement>('input[name="r1-book-day"][value="2026-09-18"]');
      expect(thirdDay).toHaveFocus();
      expect(thirdDay).toBeChecked();

      await user.tab();
      const third = GRID.days[2].slots[0];
      const time = screen.getByRole('radio', { name: formatIstTimeRange(third.start_at, third.end_at) });
      expect(time).toHaveFocus();
      await user.keyboard(' ');
      expect(time).toBeChecked();

      await user.tab();
      expect(screen.getByRole('region', { name: R1_BOOK_COPY.form.noticeRegionLabel })).toHaveFocus();
      for (const type of TEMPLATE.required_consents) {
        await user.tab();
        expect(field(`r1-book-consent-${type}`)).toHaveFocus();
        await user.keyboard(' ');
      }
      await user.tab();
      expect(field('r1-book-in-india')).toHaveFocus();
      await user.keyboard(' ');

      await user.tab();
      expect(submitButton()).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(await findH1(R1_BOOK_COPY.states.booked.title)).toHaveFocus();
      expect(submissions()[0].slot_start).toBe(third.start_at);
      expect(submissions()[0].consent.consents).toEqual(TEMPLATE.required_consents);
      expect(pointer).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('pointerdown', pointer);
    }
  });

  it('declares a no-referrer policy while it is open, and only then', async () => {
    const view = renderPage();
    await findForm();
    const meta = document.head.querySelector('meta[name="referrer"]');
    expect(meta).not.toBeNull();
    expect(meta).toHaveAttribute('content', 'no-referrer');
    view.unmount();
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
  });

  it('names the browser tab after the page (WCAG 2.4.2), and puts the old title back on leaving', async () => {
    document.title = 'HELLO — Talent Workspace & Mission Control';
    const view = renderPage(true);
    await findForm();
    expect(document.title).toBe(R1_BOOK_COPY.pageTitle);
    view.unmount();
    expect(document.title).toBe('HELLO — Talent Workspace & Mission Control');
  });
});

// ── 20: axe ────────────────────────────────────────────────────────────────────────────────

describe('R1BookPage accessibility', () => {
  it('passes axe on the form with its notice', async () => {
    const { container } = renderPage();
    await findForm();
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the form with the error summary', async () => {
    const user = setupUser();
    const { container } = renderPage();
    await findForm();
    await user.click(submitButton());
    screen.getByRole('group', { name: R1_BOOK_COPY.errors.summaryTitle });
    await expect(container).toHaveNoViolations();
  });

  it.each([
    ['booked', () => h.book.mockResolvedValue(BOOKED), R1_BOOK_COPY.states.booked.title],
    ['not found', () => h.book.mockRejectedValue(new R1ApiError('not_found', 404)), R1_BOOK_COPY.states.notFound.title],
    [
      'already booked',
      () => h.book.mockRejectedValue(new R1ApiError('already_booked', 409)),
      R1_BOOK_COPY.states.alreadyBooked.title,
    ],
    ['retry', () => h.book.mockRejectedValue(unavailableError()), R1_BOOK_COPY.states.retry.title],
    ['not confirmed', () => h.book.mockRejectedValue(networkError()), R1_BOOK_COPY.states.uncertain.title],
  ])('passes axe on the %s card', async (_, arrange, title) => {
    const user = setupUser();
    arrange();
    const { container } = renderPage();
    await findForm();
    await fillForm(user);
    await user.click(submitButton());
    await findH1(title);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the not-open card', async () => {
    h.slots.mockRejectedValue(disabledError());
    const { container } = renderPage();
    await findH1(R1_BOOK_COPY.states.notOpen.title);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the fully-booked card', async () => {
    h.slots.mockResolvedValue(makeGrid({ fullyBooked: true }));
    const { container } = renderPage();
    await findH1(R1_BOOK_COPY.states.fullyBooked.title);
    await expect(container).toHaveNoViolations();
  });
});
