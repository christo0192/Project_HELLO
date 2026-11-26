import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
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
  parseManage,
  parseMoved,
  type R1BookGrid,
  type R1BookManageView,
} from '../lib/r1/r1-book-api';
import { formatBookSlot, r1BookClock } from '../lib/r1/r1-book';
import { R1_BOOK_COPY, R1_BOOK_MANAGE_COPY } from '../components/candidate-r1/r1-book-copy';
import { R1BookManagePage } from './R1BookManagePage';

// ── Fixtures (parsed like server answers; tokens built at run time, never token-shaped literals) ──

/** The manage token of the invite: 43 base64url characters. */
const TOKEN = 'm'.repeat(43);

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

const CURRENT_START = at('2026-09-16', '10:00');
const CURRENT_END = at('2026-09-16', '10:45');
const TARGET_START = at('2026-09-16', '09:30');
const TARGET_END = at('2026-09-16', '10:15');

interface GridOptions {
  token?: string;
  fullyBooked?: boolean;
  /** Start times (HH:MM on day one) that are taken. */
  taken?: string[];
}

/** Two IST days: day one holds the booking's own time (10:00), a free 09:30 and a taken 09:00. */
function makeGrid(options: GridOptions = {}): R1BookGrid {
  const taken = new Set(options.taken ?? []);
  const open = (time: string, base: boolean): boolean => base && !taken.has(time);
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
      { date: '2026-09-17', slots: [slot('2026-09-17', '11:00', '11:45', open('11:00', true))] },
    ],
  });
}

const GRID = makeGrid();

function makeView(overrides: Partial<R1BookManageView> = {}): R1BookManageView {
  return parseManage({
    state: 'booked',
    start_at: CURRENT_START,
    end_at: CURRENT_END,
    can_move: true,
    can_cancel: true,
    moves_left: 2,
    consent_current: true,
    ...overrides,
  });
}

const VIEW = makeView();
const MOVED = parseMoved({ status: 'moved', start_at: TARGET_START, end_at: TARGET_END });
const TARGET_LABEL = formatIstTimeRange(TARGET_START, TARGET_END);

const copy = R1_BOOK_MANAGE_COPY;
const disabledError = () => new R1ApiError('booking_disabled', 503);
const unavailableError = () => new R1ApiError('temporarily_unavailable', 503);
const notFoundError = () => new R1ApiError('not_found', 404);
const networkError = () => new ApiError('network_unreachable', 0);

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

let nowSpy: MockInstance<() => number>;
let sleepSpy: MockInstance<(ms: number) => Promise<void>>;

type User = ReturnType<typeof userEvent.setup>;

/** A user without a pause between keystrokes. */
const setupUser = (): User => userEvent.setup({ delay: null });

function setUrl(hash: string): void {
  window.history.replaceState(null, '', `/book/manage${hash}`);
}

function renderPage(strict = false) {
  const page = <R1BookManagePage />;
  return render(strict ? <StrictMode>{page}</StrictMode> : page);
}

function openPage(hash = `#m=${TOKEN}`, strict = false) {
  setUrl(hash);
  return renderPage(strict);
}

const findH1 = (name: string) => screen.findByRole('heading', { level: 1, name });
const findView = () => findH1(copy.view.title);
const button = (name: string) => screen.getByRole('button', { name });
const queryButton = (name: string) => screen.queryByRole('button', { name });
const liveRegion = () => document.querySelector('p[aria-live="polite"]') as HTMLElement;
const timeRadio = (startAt: string) =>
  document.querySelector<HTMLInputElement>(`input[name="r1-manage-time"][value="${startAt}"]`);
const timeRadios = () =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="radio"][name="r1-manage-time"]'));
/** The visible copy of a line the live region also announces. */
const NOTICE = { selector: '.r1-book__notice' };
const field = (id: string) => document.getElementById(id) as HTMLInputElement;

const allCalls = (): number => Object.values(h).reduce((sum, fn) => sum + fn.mock.calls.length, 0);

/** Open the view, then the move panel, and wait for its grid. */
async function openMovePanel(user: User) {
  const view = openPage();
  await findView();
  await user.click(button(copy.view.move));
  await screen.findByRole('radio', { name: TARGET_LABEL });
  return view;
}

/** Open the move panel, pick 09:30 on day one and confirm. */
async function moveToTarget(user: User) {
  const view = await openMovePanel(user);
  await user.click(screen.getByRole('radio', { name: TARGET_LABEL }));
  await user.click(button(copy.movePanel.confirm));
  return view;
}

async function openCancelPanel(user: User) {
  const view = openPage();
  await findView();
  await user.click(button(copy.view.cancel));
  await screen.findByRole('heading', { level: 2, name: copy.cancelPanel.title });
  return view;
}

async function openReconsent() {
  h.manage.mockResolvedValueOnce(makeView({ consent_current: false }));
  openPage();
  await findView();
  await screen.findByRole('heading', { level: 2, name: copy.reconsent.title });
}

async function tickEverything(user: User) {
  for (const type of TEMPLATE.required_consents) await user.click(field(`r1-manage-consent-${type}`));
  await user.click(field('r1-manage-in-india'));
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.manage.mockResolvedValue(VIEW);
  h.consentTemplate.mockResolvedValue(TEMPLATE);
  h.slots.mockResolvedValue(GRID);
  h.move.mockResolvedValue(MOVED);
  h.cancel.mockResolvedValue('cancelled');
  h.consent.mockResolvedValue('consented');
  nowSpy = vi.spyOn(r1BookClock, 'now').mockReturnValue(100_000);
  sleepSpy = vi.spyOn(r1BookClock, 'sleep').mockResolvedValue(undefined);
});

// ── 1-2: the token ─────────────────────────────────────────────────────────────────────────

describe('R1BookManagePage token', () => {
  it.each([
    ['no fragment', ''],
    ['an empty m', '#m='],
    ['42 characters', `#m=${'m'.repeat(42)}`],
    ['44 characters', `#m=${'m'.repeat(44)}`],
    ['a dot', `#m=${'m'.repeat(42)}.`],
    ['a token without m=', `#${'m'.repeat(43)}`],
  ])('reads %s as "no longer active" and calls nothing', async (_, hash) => {
    openPage(hash);
    expect(await findH1(copy.inactive.title)).toHaveFocus();
    expect(screen.getByText(copy.inactive.body)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(allCalls()).toBe(0);
    expect(window.location.pathname).toBe('/book/manage');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
  });

  it('strips the address bar before the first call, then reads the booking once with the token', async () => {
    const seen: string[] = [];
    h.manage.mockImplementation(async () => {
      seen.push(`${window.location.pathname}${window.location.search}${window.location.hash}`);
      return VIEW;
    });
    openPage();
    await findView();
    expect(seen).toEqual(['/book/manage']);
    expect(h.manage).toHaveBeenCalledTimes(1);
    expect(h.manage.mock.calls[0]).toEqual([TOKEN]);
    expect(allCalls()).toBe(1);
  });

  it('reads the booking once under StrictMode', async () => {
    openPage(`#m=${TOKEN}`, true);
    await findView();
    expect(h.manage).toHaveBeenCalledTimes(1);
    expect(h.manage.mock.calls[0]).toEqual([TOKEN]);
    expect(h.consentTemplate).not.toHaveBeenCalled();
  });

  it('never puts the token in the page or in storage', async () => {
    const user = setupUser();
    const storage = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
    ];
    await openCancelPanel(user);
    expect(document.documentElement.innerHTML).not.toContain(TOKEN);
    await user.click(button(copy.cancelPanel.confirm));
    await findH1(copy.cancelled.title);
    expect(h.cancel.mock.calls[0]).toEqual([TOKEN, false]);
    expect(document.documentElement.innerHTML).not.toContain(TOKEN);
    for (const spy of storage) expect(spy).not.toHaveBeenCalled();
  });
});

// ── 3: errors of the first read ────────────────────────────────────────────────────────────

describe('R1BookManagePage first read', () => {
  it('shows loading while the booking is read', async () => {
    let resolve!: (value: R1BookManageView) => void;
    h.manage.mockReturnValue(
      new Promise<R1BookManageView>((yes) => {
        resolve = yes;
      }),
    );
    openPage();
    expect(screen.getByRole('status')).toHaveTextContent(copy.loading);
    await act(async () => {
      resolve(VIEW);
    });
    await findView();
  });

  it('reads 404 not_found as "no longer active"', async () => {
    h.manage.mockRejectedValue(notFoundError());
    openPage();
    expect(await findH1(copy.inactive.title)).toHaveFocus();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reads 503 booking_disabled as "online changes are not available"', async () => {
    h.manage.mockRejectedValue(disabledError());
    openPage();
    expect(await findH1(copy.disabled.title)).toHaveFocus();
    expect(screen.getByText(copy.disabled.body)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['503 temporarily_unavailable', unavailableError],
    ['a dropped request', networkError],
    ['a 404 with another word', () => new R1ApiError('http_404', 404)],
    ['a 429 from the limiter', () => new R1ApiError('rate_limited', 429)],
    ['a 401 while the route is not deployed', () => new R1ApiError('unauthorized', 401)],
    ['a malformed answer', () => new ApiError('r1_malformed_response', 500)],
  ])('reads %s as unavailable, and "Try again" reads the booking again', async (_, error) => {
    const user = setupUser();
    h.manage.mockRejectedValueOnce(error());
    openPage();
    expect(await findH1(copy.unavailable.title)).toHaveFocus();
    await user.click(button(copy.unavailable.action));
    expect(await findView()).toHaveFocus();
    expect(h.manage).toHaveBeenCalledTimes(2);
    expect(h.manage.mock.calls[1]).toEqual([TOKEN]);
  });
});

// ── 4: the view ────────────────────────────────────────────────────────────────────────────

describe('R1BookManagePage view', () => {
  it('shows the time in IST, the join line and both changes', async () => {
    openPage();
    expect(await findView()).toHaveFocus();
    expect(screen.getByText(formatBookSlot(CURRENT_START, CURRENT_END))).toBeVisible();
    expect(screen.getByText(copy.view.join)).toBeVisible();
    const move = button(copy.view.move);
    expect(move).toHaveAttribute('type', 'button');
    expect(screen.getByText(copy.view.movesLeft(2))).toBeVisible();
    expect(move.getAttribute('aria-describedby')).toBe('r1-manage-moves-left');
    expect(button(copy.view.cancel)).toHaveAttribute('type', 'button');
    expect(screen.queryByText(copy.view.noChanges)).toBeNull();
    expect(h.consentTemplate).not.toHaveBeenCalled();
    expect(h.slots).not.toHaveBeenCalled();
  });

  it('says "1 more time" for the last change', async () => {
    h.manage.mockResolvedValue(makeView({ moves_left: 1 }));
    openPage();
    await findView();
    expect(screen.getByText(copy.view.movesLeft(1))).toBeVisible();
    expect(copy.view.movesLeft(1)).toContain('1 more time.');
  });

  it('hides "Change the time" when the server does not allow a move', async () => {
    h.manage.mockResolvedValue(makeView({ can_move: false }));
    openPage();
    await findView();
    expect(queryButton(copy.view.move)).toBeNull();
    expect(screen.queryByText(copy.view.movesLeft(2))).toBeNull();
    expect(button(copy.view.cancel)).toBeVisible();
  });

  it('hides "Cancel my interview" when the server does not allow a cancel', async () => {
    h.manage.mockResolvedValue(makeView({ can_cancel: false }));
    openPage();
    await findView();
    expect(queryButton(copy.view.cancel)).toBeNull();
    expect(button(copy.view.move)).toBeVisible();
  });

  it('says no online change is possible when neither is allowed', async () => {
    h.manage.mockResolvedValue(makeView({ can_move: false, can_cancel: false }));
    openPage();
    await findView();
    expect(screen.getByText(copy.view.noChanges)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows the starting copy and no action while the interview is in progress', async () => {
    h.manage.mockResolvedValue(makeView({ state: 'in_progress', consent_current: false }));
    openPage();
    expect(await findH1(copy.inProgress.title)).toHaveFocus();
    expect(screen.getByText(formatBookSlot(CURRENT_START, CURRENT_END))).toBeVisible();
    expect(screen.getByText(copy.inProgress.body)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(copy.view.noChanges)).toBeNull();
    expect(h.consentTemplate).not.toHaveBeenCalled();
  });
});

// ── 5: move ────────────────────────────────────────────────────────────────────────────────

describe('R1BookManagePage move', () => {
  it('reads the grid on open, never offers the current time, and focuses the panel heading', async () => {
    const user = setupUser();
    await openMovePanel(user);
    expect(h.slots).toHaveBeenCalledTimes(1);
    expect(h.slots.mock.calls[0]).toEqual([]);
    expect(screen.getByRole('heading', { level: 2, name: copy.movePanel.title })).toHaveFocus();
    const current = timeRadio(CURRENT_START)!;
    expect(current).toBeDisabled();
    expect(current.closest('label')).toHaveTextContent(R1_BOOK_COPY.form.currentTime);
    expect(timeRadio(TARGET_START)).toBeEnabled();
    // The two buttons that opened the panels make way for it.
    expect(queryButton(copy.view.move)).toBeNull();
    expect(queryButton(copy.view.cancel)).toBeNull();
  });

  it('moves after one wait for a young grid, then offers nothing further', async () => {
    const user = setupUser();
    await moveToTarget(user);
    expect(await findH1(copy.moved.title)).toHaveFocus();
    expect(h.move).toHaveBeenCalledTimes(1);
    expect(h.move.mock.calls[0]).toEqual([TOKEN, TARGET_START, GRID.grid_token]);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(3_500);
    expect(sleepSpy.mock.invocationCallOrder[0]).toBeLessThan(h.move.mock.invocationCallOrder[0]);
    expect(screen.getByText(formatBookSlot(TARGET_START, TARGET_END))).toBeVisible();
    expect(screen.getByText(copy.moved.body)).toBeVisible();
    expect(screen.getByText(copy.moved.next)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not wait for a grid older than 3.5 s', async () => {
    const user = setupUser();
    await openMovePanel(user);
    nowSpy.mockReturnValue(100_000 + 5_000);
    await user.click(screen.getByRole('radio', { name: TARGET_LABEL }));
    await user.click(button(copy.movePanel.confirm));
    await findH1(copy.moved.title);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('asks for a time before moving, and sends nothing', async () => {
    const user = setupUser();
    await openMovePanel(user);
    await user.click(button(copy.movePanel.confirm));
    expect(screen.getByText(R1_BOOK_COPY.errors.slot_required)).toBeVisible();
    expect(document.getElementById('r1-manage-slot-first')).toHaveFocus();
    expect(h.move).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('reads a grid older than 25 minutes again before moving, and sends the new token', async () => {
    const user = setupUser();
    const fresh = makeGrid({ token: gridToken(1, 'h') });
    await openMovePanel(user);
    h.slots.mockResolvedValue(fresh);
    nowSpy.mockReturnValue(100_000 + 26 * 60_000);
    await user.click(screen.getByRole('radio', { name: TARGET_LABEL }));
    await user.click(button(copy.movePanel.confirm));
    await findH1(copy.moved.title);
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(h.slots.mock.invocationCallOrder[1]).toBeLessThan(h.move.mock.invocationCallOrder[0]);
    expect(h.move.mock.calls[0]).toEqual([TOKEN, TARGET_START, fresh.grid_token]);
  });

  it('does not move when the grid read again no longer offers the chosen time', async () => {
    const user = setupUser();
    await openMovePanel(user);
    h.slots.mockResolvedValue(makeGrid({ token: gridToken(1, 'h'), taken: ['09:30'] }));
    nowSpy.mockReturnValue(100_000 + 26 * 60_000);
    await user.click(screen.getByRole('radio', { name: TARGET_LABEL }));
    await user.click(button(copy.movePanel.confirm));
    expect(await screen.findByText(R1_BOOK_COPY.inline.slotTaken, NOTICE)).toBeVisible();
    expect(h.move).not.toHaveBeenCalled();
    expect(timeRadios().some((radio) => radio.checked)).toBe(false);
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.inline.slotTaken);
  });

  it('reads the grid again on slot_unavailable, clears the time and says so', async () => {
    const user = setupUser();
    h.move.mockRejectedValue(new R1ApiError('slot_unavailable', 409));
    h.slots
      .mockResolvedValueOnce(GRID)
      .mockResolvedValueOnce(makeGrid({ token: gridToken(1, 'h'), taken: ['09:30'] }));
    await moveToTarget(user);
    expect(await screen.findByText(R1_BOOK_COPY.inline.slotTaken, NOTICE)).toBeVisible();
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { level: 2, name: copy.movePanel.title })).toBeVisible();
    expect(timeRadios().some((radio) => radio.checked)).toBe(false);
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.inline.slotTaken);
    expect(document.activeElement).toBe(document.getElementById('r1-manage-slot-first'));
  });

  it('reads 409 move_not_allowed as "no longer possible"', async () => {
    const user = setupUser();
    h.move.mockRejectedValue(new R1ApiError('move_not_allowed', 409));
    await moveToTarget(user);
    expect(await findH1(copy.notAllowed.title)).toHaveFocus();
    expect(screen.getByText(copy.notAllowed.body)).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reads 404 not_found as "no longer active"', async () => {
    const user = setupUser();
    h.move.mockRejectedValue(notFoundError());
    await moveToTarget(user);
    expect(await findH1(copy.inactive.title)).toHaveFocus();
  });

  it('reads 503 booking_disabled as "online changes are not available"', async () => {
    const user = setupUser();
    h.move.mockRejectedValue(disabledError());
    await moveToTarget(user);
    expect(await findH1(copy.disabled.title)).toHaveFocus();
  });

  it('cannot confirm a dropped move, and "Try again" repeats the same move', async () => {
    const user = setupUser();
    h.move.mockRejectedValueOnce(networkError());
    await moveToTarget(user);
    expect(await findH1(copy.uncertain.title)).toHaveFocus();
    expect(screen.getByText(copy.uncertain.body)).toBeVisible();
    await user.click(button(copy.uncertain.action));
    await findH1(copy.moved.title);
    expect(h.move).toHaveBeenCalledTimes(2);
    expect(h.move.mock.calls[1]).toEqual(h.move.mock.calls[0]);
  });

  it('shows "temporarily unavailable" on 503, and "Try again" repeats the same move', async () => {
    const user = setupUser();
    h.move.mockRejectedValueOnce(unavailableError());
    await moveToTarget(user);
    expect(await findH1(copy.unavailable.title)).toHaveFocus();
    await user.click(button(copy.unavailable.action));
    await findH1(copy.moved.title);
    expect(h.move.mock.calls).toEqual([
      [TOKEN, TARGET_START, GRID.grid_token],
      [TOKEN, TARGET_START, GRID.grid_token],
    ]);
  });

  it('reads booking_disabled on the grid as "online changes are not available"', async () => {
    const user = setupUser();
    h.slots.mockRejectedValue(disabledError());
    openPage();
    await findView();
    await user.click(button(copy.view.move));
    expect(await findH1(copy.disabled.title)).toHaveFocus();
  });

  it('reads an unavailable grid as unavailable, and "Try again" opens the panel again', async () => {
    const user = setupUser();
    h.slots.mockRejectedValueOnce(unavailableError());
    openPage();
    await findView();
    await user.click(button(copy.view.move));
    await findH1(copy.unavailable.title);
    await user.click(button(copy.unavailable.action));
    expect(await screen.findByRole('radio', { name: TARGET_LABEL })).toBeEnabled();
    expect(h.slots).toHaveBeenCalledTimes(2);
    expect(h.manage).toHaveBeenCalledTimes(1);
  });

  it('"Keep the current time" closes the panel and returns to "Change the time"', async () => {
    const user = setupUser();
    await openMovePanel(user);
    await user.click(button(copy.movePanel.keep));
    expect(screen.queryByRole('heading', { level: 2, name: copy.movePanel.title })).toBeNull();
    expect(button(copy.view.move)).toHaveFocus();
    expect(h.move).not.toHaveBeenCalled();
  });
});

// ── 6: cancel ──────────────────────────────────────────────────────────────────────────────

describe('R1BookManagePage cancel', () => {
  it('asks first, with the withdraw box unticked, and "Keep my interview" closes the panel', async () => {
    const user = setupUser();
    await openCancelPanel(user);
    expect(screen.getByRole('heading', { level: 2, name: copy.cancelPanel.title })).toHaveFocus();
    expect(screen.getByText(copy.cancelPanel.body)).toBeVisible();
    expect(screen.getByRole('checkbox', { name: copy.cancelPanel.withdraw })).not.toBeChecked();
    await user.click(button(copy.cancelPanel.keep));
    expect(button(copy.view.cancel)).toHaveFocus();
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it('cancels without withdrawing when the box is left unticked', async () => {
    const user = setupUser();
    await openCancelPanel(user);
    await user.click(button(copy.cancelPanel.confirm));
    expect(await findH1(copy.cancelled.title)).toHaveFocus();
    expect(h.cancel.mock.calls).toEqual([[TOKEN, false]]);
    expect(screen.getByText(copy.cancelled.body)).toBeVisible();
    expect(screen.queryByText(copy.cancelled.withdrawn)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('cancels and withdraws when the box is ticked', async () => {
    const user = setupUser();
    await openCancelPanel(user);
    await user.click(screen.getByRole('checkbox', { name: copy.cancelPanel.withdraw }));
    await user.click(button(copy.cancelPanel.confirm));
    await findH1(copy.cancelled.title);
    expect(h.cancel.mock.calls).toEqual([[TOKEN, true]]);
    expect(screen.getByText(copy.cancelled.withdrawn)).toBeVisible();
  });

  it('reads already_cancelled as cancelled', async () => {
    const user = setupUser();
    h.cancel.mockResolvedValue('already_cancelled');
    await openCancelPanel(user);
    await user.click(button(copy.cancelPanel.confirm));
    expect(await findH1(copy.cancelled.title)).toHaveFocus();
    expect(screen.queryByText(copy.cancelled.withdrawn)).toBeNull();
  });

  it('reads 409 cancel_not_allowed as "no longer possible"', async () => {
    const user = setupUser();
    h.cancel.mockRejectedValue(new R1ApiError('cancel_not_allowed', 409));
    await openCancelPanel(user);
    await user.click(button(copy.cancelPanel.confirm));
    expect(await findH1(copy.notAllowed.title)).toHaveFocus();
  });

  it('reads 404 not_found as "no longer active"', async () => {
    const user = setupUser();
    h.cancel.mockRejectedValue(notFoundError());
    await openCancelPanel(user);
    await user.click(button(copy.cancelPanel.confirm));
    expect(await findH1(copy.inactive.title)).toHaveFocus();
  });

  it('cannot confirm a dropped cancel, and "Try again" repeats it with the same arguments', async () => {
    const user = setupUser();
    h.cancel.mockRejectedValueOnce(networkError());
    await openCancelPanel(user);
    await user.click(screen.getByRole('checkbox', { name: copy.cancelPanel.withdraw }));
    await user.click(button(copy.cancelPanel.confirm));
    expect(await findH1(copy.uncertain.title)).toHaveFocus();
    await user.click(button(copy.uncertain.action));
    await findH1(copy.cancelled.title);
    expect(h.cancel.mock.calls).toEqual([
      [TOKEN, true],
      [TOKEN, true],
    ]);
    expect(screen.getByText(copy.cancelled.withdrawn)).toBeVisible();
  });
});

// ── 7: re-consent ──────────────────────────────────────────────────────────────────────────

describe('R1BookManagePage re-consent', () => {
  it('reads the notice and puts it first, with every purpose its own box and the India box', async () => {
    await openReconsent();
    expect(h.consentTemplate).toHaveBeenCalledTimes(1);
    expect(h.manage.mock.invocationCallOrder[0]).toBeLessThan(h.consentTemplate.mock.invocationCallOrder[0]);
    expect(screen.getByText(copy.reconsent.body)).toBeVisible();
    expect(screen.getByRole('heading', { level: 3, name: TEMPLATE.title })).toBeVisible();
    for (const type of TEMPLATE.required_consents) {
      expect(field(`r1-manage-consent-${type}`)).not.toBeChecked();
    }
    expect(field('r1-manage-in-india')).not.toBeChecked();
    expect(screen.getAllByRole('checkbox')).toHaveLength(TEMPLATE.required_consents.length + 1);
    const panel = screen.getByRole('heading', { level: 2, name: copy.reconsent.title });
    // Re-consent first; move and cancel stay available below it.
    expect(panel.compareDocumentPosition(button(copy.view.move)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button(copy.view.cancel)).toBeVisible();
  });

  it('lists what is missing in a focused summary, and sends nothing', async () => {
    const user = setupUser();
    await openReconsent();
    await user.click(button(copy.reconsent.submit));
    const summary = screen.getByRole('group', { name: R1_BOOK_COPY.errors.summaryTitle });
    expect(summary).toHaveFocus();
    const items = within(summary).getAllByRole('button');
    expect(items.map((item) => item.textContent)).toEqual([
      R1_BOOK_COPY.errors.consents_required,
      R1_BOOK_COPY.errors.in_india_required,
    ]);
    await user.click(items[0]);
    expect(field(`r1-manage-consent-${TEMPLATE.required_consents[0]}`)).toHaveFocus();
    await user.click(within(summary).getAllByRole('button')[1]);
    expect(field('r1-manage-in-india')).toHaveFocus();
    expect(field('r1-manage-in-india')).toHaveAttribute('aria-invalid', 'true');
    expect(h.consent).not.toHaveBeenCalled();
  });

  it('records the consent, reads the booking once more, and the panel goes away', async () => {
    const user = setupUser();
    await openReconsent();
    await tickEverything(user);
    await user.click(button(copy.reconsent.submit));
    await waitFor(() => expect(liveRegion()).toHaveTextContent(copy.reconsent.done));
    expect(h.consent.mock.calls).toEqual([
      [
        TOKEN,
        {
          template_version: TEMPLATE.version,
          consents: TEMPLATE.required_consents,
          in_india: true,
        },
      ],
    ]);
    expect(h.manage).toHaveBeenCalledTimes(2);
    expect(h.manage.mock.calls[1]).toEqual([TOKEN]);
    expect(screen.queryByRole('heading', { level: 2, name: copy.reconsent.title })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByText(copy.reconsent.done, NOTICE)).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: copy.view.title })).toHaveFocus();
    expect(button(copy.view.move)).toBeVisible();
  });

  it('reads the notice again on consent_stale and clears every box, India included', async () => {
    const user = setupUser();
    h.consent.mockRejectedValueOnce(new R1ApiError('consent_stale', 409));
    await openReconsent();
    h.consentTemplate.mockResolvedValue(TEMPLATE_NEXT);
    await tickEverything(user);
    await user.click(button(copy.reconsent.submit));
    const notice = await screen.findByText(R1_BOOK_COPY.inline.noticeChanged, NOTICE);
    expect(notice).toHaveFocus();
    expect(h.consentTemplate).toHaveBeenCalledTimes(2);
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(liveRegion()).toHaveTextContent(R1_BOOK_COPY.inline.noticeChanged);
    expect(h.manage).toHaveBeenCalledTimes(1);

    await tickEverything(user);
    await user.click(button(copy.reconsent.submit));
    await waitFor(() => expect(h.consent).toHaveBeenCalledTimes(2));
    expect(h.consent.mock.calls[1][1]).toEqual({
      template_version: TEMPLATE_NEXT.version,
      consents: TEMPLATE_NEXT.required_consents,
      in_india: true,
    });
  });

  it('reads 409 cancel_not_allowed as "no longer possible"', async () => {
    const user = setupUser();
    h.consent.mockRejectedValue(new R1ApiError('cancel_not_allowed', 409));
    await openReconsent();
    await tickEverything(user);
    await user.click(button(copy.reconsent.submit));
    expect(await findH1(copy.notAllowed.title)).toHaveFocus();
  });

  it('reads 404 not_found as "no longer active"', async () => {
    const user = setupUser();
    h.consent.mockRejectedValue(notFoundError());
    await openReconsent();
    await tickEverything(user);
    await user.click(button(copy.reconsent.submit));
    expect(await findH1(copy.inactive.title)).toHaveFocus();
  });

  it('cannot confirm a dropped consent, and "Try again" sends the same one', async () => {
    const user = setupUser();
    h.consent.mockRejectedValueOnce(networkError());
    await openReconsent();
    await tickEverything(user);
    await user.click(button(copy.reconsent.submit));
    expect(await findH1(copy.uncertain.title)).toHaveFocus();
    await user.click(button(copy.uncertain.action));
    await waitFor(() => expect(liveRegion()).toHaveTextContent(copy.reconsent.done));
    expect(h.consent.mock.calls[1]).toEqual(h.consent.mock.calls[0]);
    expect(h.manage).toHaveBeenCalledTimes(2);
  });

  it('reads booking_disabled on the notice as "online changes are not available"', async () => {
    h.manage.mockResolvedValue(makeView({ consent_current: false }));
    h.consentTemplate.mockRejectedValue(disabledError());
    openPage();
    expect(await findH1(copy.disabled.title)).toHaveFocus();
  });

  it('reads an unavailable notice as unavailable, and "Try again" reads only the notice', async () => {
    const user = setupUser();
    h.manage.mockResolvedValue(makeView({ consent_current: false }));
    h.consentTemplate.mockRejectedValueOnce(unavailableError());
    openPage();
    await findH1(copy.unavailable.title);
    await user.click(button(copy.unavailable.action));
    expect(await screen.findByRole('heading', { level: 2, name: copy.reconsent.title })).toHaveFocus();
    expect(h.consentTemplate).toHaveBeenCalledTimes(2);
    expect(h.manage).toHaveBeenCalledTimes(1);
  });
});

// ── 8-9: privacy and referrer ──────────────────────────────────────────────────────────────

describe('R1BookManagePage privacy', () => {
  it('never touches storage, and writes the address bar only to strip the fragment', async () => {
    const user = setupUser();
    setUrl(`#m=${TOKEN}`);
    const storage = [
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
    ];
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    renderPage();
    await findView();
    await user.click(button(copy.view.move));
    await user.click(await screen.findByRole('radio', { name: TARGET_LABEL }));
    await user.click(button(copy.movePanel.confirm));
    await findH1(copy.moved.title);
    for (const spy of storage) expect(spy).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace.mock.calls).toEqual([[null, '', '/book/manage']]);
    expect(window.location.pathname).toBe('/book/manage');
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('');
  });

  it('declares a no-referrer policy while it is open, and only then', async () => {
    const view = openPage();
    await findView();
    const meta = document.head.querySelector('meta[name="referrer"]');
    expect(meta).not.toBeNull();
    expect(meta).toHaveAttribute('content', 'no-referrer');
    view.unmount();
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
  });
});

// ── 10: axe ────────────────────────────────────────────────────────────────────────────────

describe('R1BookManagePage accessibility', () => {
  it('passes axe on the inactive card', async () => {
    const { container } = openPage('');
    await findH1(copy.inactive.title);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the view', async () => {
    const { container } = openPage();
    await findView();
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the view with the re-consent panel and its summary', async () => {
    const user = setupUser();
    h.manage.mockResolvedValueOnce(makeView({ consent_current: false }));
    const { container } = openPage();
    await screen.findByRole('heading', { level: 2, name: copy.reconsent.title });
    await expect(container).toHaveNoViolations();
    await user.click(button(copy.reconsent.submit));
    screen.getByRole('group', { name: R1_BOOK_COPY.errors.summaryTitle });
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the move panel', async () => {
    const user = setupUser();
    const { container } = await openMovePanel(user);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the cancel panel', async () => {
    const user = setupUser();
    const { container } = await openCancelPanel(user);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the moved card', async () => {
    const user = setupUser();
    const { container } = await moveToTarget(user);
    await findH1(copy.moved.title);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the cancelled card', async () => {
    const user = setupUser();
    const { container } = await openCancelPanel(user);
    await user.click(screen.getByRole('checkbox', { name: copy.cancelPanel.withdraw }));
    await user.click(button(copy.cancelPanel.confirm));
    await findH1(copy.cancelled.title);
    await expect(container).toHaveNoViolations();
  });

  it('passes axe on the not-allowed card', async () => {
    const user = setupUser();
    h.cancel.mockRejectedValue(new R1ApiError('cancel_not_allowed', 409));
    const { container } = await openCancelPanel(user);
    await user.click(button(copy.cancelPanel.confirm));
    await findH1(copy.notAllowed.title);
    await expect(container).toHaveNoViolations();
  });
});
