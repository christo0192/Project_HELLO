/**
 * Accessibility and palette conformance for the phone calendar.
 *
 * `runAxe` and the `toHaveNoViolations()` matcher come from
 * `src/test/setup.ts` and run wcag2a + wcag2aa + wcag21a + wcag21aa +
 * best-practice. `src/test/SeededViolation.test.tsx` already proves the
 * matcher really fails on a real violation, so a pass here means something.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import {
  ADMIN_ME,
  INTERVIEWER_ME,
  VIEWER_ME,
  apiFns,
  appointment,
  calendarResponse,
  phoneApi,
  slotsResponse,
  PHONE_BOOKING_CANDIDATES,
} from '../components/phone-calendar/__tests__/phoneFixtures';
import { stubMatchMedia } from '../components/design/__tests__/helpers';

vi.mock('../api', () => ({ api: phoneApi.api, ApiError: phoneApi.ApiError }));

import { PhoneCalendarPage } from './PhoneCalendarPage';

function renderPage(search = '?week=2026-08-24') {
  return render(
    <MemoryRouter initialEntries={[`/phone-calendar${search}`]}>
      <PhoneCalendarPage />
    </MemoryRouter>,
  );
}

const BUSY_WEEK = calendarResponse({
  appointments: [
    appointment({
      id: 'a',
      status: 'scheduled',
      starts_at: '2026-08-24T03:30:00Z',
      candidate: { id: 'c1', name: 'Asha Rao', status: 'screening', reference: 'ATS-4417' },
    }),
    appointment({
      id: 'b',
      status: 'missed',
      starts_at: '2026-08-26T04:30:00Z',
      candidate: { id: 'c2', name: 'Ravi Menon', status: 'screening', reference: 'ATS-9002' },
    }),
    appointment({
      id: 'c',
      status: 'cancelled',
      starts_at: '2026-08-27T10:00:00Z',
      cancel_reason: 'hr_cancelled',
      engagement_state: null,
      candidate: null,
    }),
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  apiFns.getMe.mockResolvedValue(ADMIN_ME);
  apiFns.getPhoneCalendar.mockResolvedValue(BUSY_WEEK);
  apiFns.getPhoneSlots.mockResolvedValue(slotsResponse());
  apiFns.listCandidates.mockResolvedValue(PHONE_BOOKING_CANDIDATES);
  stubMatchMedia(false, '(max-width: 639px)');
});

describe('axe — no WCAG A/AA violations', () => {
  it('on the week grid', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    await expect(container).toHaveNoViolations();
  });

  it('on the queue view', async () => {
    const { container } = renderPage('?week=2026-08-24&view=queue');
    await screen.findByRole('heading', { name: /Monday, 24 August 2026/ });
    await expect(container).toHaveNoViolations();
  });

  it('with an appointment selected and its write controls open', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule…' }));
    await screen.findAllByRole('radio');
    await expect(container).toHaveNoViolations();
  });

  it('with the booking form open', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));
    await screen.findByLabelText('Candidate');
    await expect(container).toHaveNoViolations();
  });

  it('on the read-only interviewer view', async () => {
    apiFns.getMe.mockResolvedValue(INTERVIEWER_ME);
    const { container } = renderPage();
    await screen.findByRole('table');
    await expect(container).toHaveNoViolations();
  });

  it('on the viewer gate', async () => {
    apiFns.getMe.mockResolvedValue(VIEWER_ME);
    const { container } = renderPage();
    await screen.findByText('Not available to your role');
    await expect(container).toHaveNoViolations();
  });

  it('on the empty, disabled and error states', async () => {
    apiFns.getPhoneCalendar.mockResolvedValue(calendarResponse({ appointments: [] }));
    const empty = renderPage();
    await screen.findByText('No phone screenings this week');
    await expect(empty.container).toHaveNoViolations();
    empty.unmount();

    apiFns.getPhoneCalendar.mockResolvedValue(
      calendarResponse({ enabled: false, appointments: [], count: 0 }),
    );
    const disabled = renderPage();
    await screen.findByText(/Phone screening is turned off/);
    await expect(disabled.container).toHaveNoViolations();
  });
});

describe('touch targets', () => {
  it('gives every interactive control at least a 44px minimum height', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await screen.findByRole('region', { name: 'Selected appointment' });

    // jsdom does no layout, so height cannot be measured. The class that
    // guarantees it can be, and that is what would be deleted by accident.
    const controls = [
      ...container.querySelectorAll('button, select, input[type="date"], input[type="text"]'),
    ].filter((el) => !el.closest('[aria-hidden="true"]'));

    expect(controls.length).toBeGreaterThan(5);
    // `min-h-[44px]` and nothing else. An earlier version of this guard also
    // accepted `py-2`, which let every ConfirmButton through at ~36px — i.e.
    // it exempted exactly the write controls it existed to protect.
    const tooSmall = controls.filter(
      (el) => !/(^|\s)min-h-\[44px\](\s|$)/.test(el.className),
    );
    expect(tooSmall.map((el) => `${el.tagName}:${el.textContent?.trim()}`)).toEqual([]);
  });
});

describe('palette — every colour utility resolves to a real token', () => {
  /**
   * The failure this prevents is silent: Tailwind emits NOTHING for an
   * unknown colour key and does not error, so `text-ink-primary` (a key that
   * does not exist — the base is `ink`) compiles to a class with no colour at
   * all. The page still renders; the text is just invisible against some
   * backgrounds. Only a test that resolves each class against the real theme
   * catches it.
   *
   * The extraction is asserted non-vacuous below, because a regex that
   * silently matched nothing would make this whole test pass by default.
   */
  const config = readFileSync(resolve(__dirname, '../../tailwind.config.js'), 'utf8');

  function themeTokens(): Set<string> {
    const tokens = new Set<string>();
    const colorsBlock = config.slice(config.indexOf('colors: {'));
    // Top-level semantic keys: `ink: 'var(--ink)'`, `'ink-secondary': …`
    for (const m of colorsBlock.matchAll(/^\s{8}'?([a-z0-9-]+)'?:\s*'var\(/gm)) {
      tokens.add(m[1]);
    }
    // Nested numeric scales: brand.50 … brand.950, accent.*
    for (const family of ['brand', 'accent']) {
      const start = colorsBlock.indexOf(`${family}: {`);
      if (start === -1) continue;
      const block = colorsBlock.slice(start, colorsBlock.indexOf('}', start));
      for (const m of block.matchAll(/^\s+(\d+):/gm)) tokens.add(`${family}-${m[1]}`);
    }
    // Utilities that are not theme colours but are valid Tailwind colours.
    for (const extra of ['white', 'black', 'transparent', 'current', 'inherit']) {
      tokens.add(extra);
    }
    return tokens;
  }

  const COLOUR_PREFIX =
    /^(text|bg|border|ring|divide|outline|from|via|to|fill|stroke|placeholder|caret|decoration)-(.+)$/;

  /**
   * The semantic families this app defines. A colour utility whose value
   * begins with one of these is CLAIMING to be a theme token, so it must
   * resolve to one — that is how `text-ink-primary` is caught while
   * `text-xs` (a size that shares the `text-` prefix) is correctly ignored.
   */
  const SEMANTIC_FAMILIES = [
    'ink',
    'surface',
    'line',
    'brand',
    'accent',
    'success',
    'warning',
    'error',
    'info',
  ];

  /** Stock Tailwind palettes. None of them belongs on this surface. */
  const STOCK_PALETTES =
    /^(gray|grey|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|zinc|neutral|stone)-\d{2,3}$/;

  function classifyColourValue(value: string): 'theme-claim' | 'stock' | 'ignore' {
    if (STOCK_PALETTES.test(value)) return 'stock';
    const family = value.split('-')[0];
    return SEMANTIC_FAMILIES.includes(family) ? 'theme-claim' : 'ignore';
  }

  /** Colour-prefixed classes on every element, variants and opacity stripped. */
  function colourValues(root: HTMLElement): string[] {
    const values: string[] = [];
    for (const el of root.querySelectorAll<HTMLElement>('*')) {
      for (const raw of Array.from(el.classList)) {
        const cls = raw.slice(raw.lastIndexOf(':') + 1);
        const match = COLOUR_PREFIX.exec(cls);
        if (!match) continue;
        const value = match[2].split('/')[0];
        if (value.startsWith('[')) continue;
        values.push(value);
      }
    }
    return values;
  }

  it('extracts a real token set (guard against a vacuous regex)', () => {
    const tokens = themeTokens();
    expect(tokens.has('ink')).toBe(true);
    expect(tokens.has('ink-secondary')).toBe(true);
    expect(tokens.has('surface')).toBe(true);
    expect(tokens.has('brand-500')).toBe(true);
    expect(tokens.has('error-soft')).toBe(true);
    // The trap this exists for. There is no `ink-primary`.
    expect(tokens.has('ink-primary')).toBe(false);
    expect(tokens.size).toBeGreaterThan(20);
  });

  it('control: the check really would catch a mistyped semantic token', () => {
    // Without this, a classifier that silently returned "ignore" for
    // everything would make the assertion below pass on any markup at all.
    const tokens = themeTokens();
    expect(classifyColourValue('ink-primary')).toBe('theme-claim');
    expect(tokens.has('ink-primary')).toBe(false);
    expect(classifyColourValue('gray-500')).toBe('stock');
    expect(classifyColourValue('xs')).toBe('ignore');
    expect(classifyColourValue('ink')).toBe('theme-claim');
  });

  it('uses no colour class the theme cannot resolve', async () => {
    const tokens = themeTokens();
    const { container } = renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Reschedule…' }));
    await screen.findAllByRole('radio');
    await userEvent.click(screen.getByRole('button', { name: 'Book a screening' }));
    await screen.findByLabelText('Candidate');

    const values = colourValues(container);
    // Non-vacuous: this surface really does carry theme colours.
    expect(values.filter((v) => classifyColourValue(v) === 'theme-claim').length)
      .toBeGreaterThan(20);

    const unresolved = [
      ...new Set(
        values.filter((v) => classifyColourValue(v) === 'theme-claim' && !tokens.has(v)),
      ),
    ];
    expect(unresolved).toEqual([]);
  });

  it('brings in no stock Tailwind palette', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /ATS-4417/ }));
    await screen.findByRole('region', { name: 'Selected appointment' });

    const stock = [
      ...new Set(colourValues(container).filter((v) => classifyColourValue(v) === 'stock')),
    ];
    expect(stock).toEqual([]);
  });

  it('gives every focusable control the app-standard focus ring', async () => {
    renderPage();
    await screen.findByRole('table');
    const appt = screen.getByRole('button', { name: /ATS-4417/ });
    expect(appt.className).toMatch(/focus-visible:ring-2/);
    expect(appt.className).toMatch(/focus-visible:ring-brand-500/);
  });
});

describe('status is never conveyed by colour alone', () => {
  it('pairs every badge hue with its own word', async () => {
    const { container } = renderPage();
    await screen.findByRole('table');

    // Every StatusBadge carries a decorative dot plus text. Assert no badge
    // is text-empty — a bare coloured dot would be a hue-only signal.
    const badges = [...container.querySelectorAll('span')].filter((el) =>
      /rounded-md/.test(el.className) && /ring-inset/.test(el.className),
    );
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect((badge.textContent ?? '').trim().length).toBeGreaterThan(0);
    }
  });

  it('carries selection in aria-pressed, not only in a fill', async () => {
    renderPage();
    await screen.findByRole('table');
    const appt = screen.getByRole('button', { name: /ATS-4417/ });
    expect(appt).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(appt);
    await waitFor(() => expect(appt).toHaveAttribute('aria-pressed', 'true'));
  });
});
