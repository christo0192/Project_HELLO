import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useLayoutEffect, useState, type Ref } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { formatIstDayLabel, formatIstTimeRange } from '../../lib/ist-datetime';
import type { R1ConsentTemplate } from '../../lib/r1/r1-api';
import { parseBookSlots, type R1BookGrid } from '../../lib/r1/r1-book-api';
import { R1BookErrorSummary } from './R1BookErrorSummary';
import { R1BookNotice } from './R1BookNotice';
import { R1BookSlotPicker } from './R1BookSlotPicker';
import { R1BookStatusCard } from './R1BookStatusCard';
import { R1_BOOK_COPY } from './r1-book-copy';

vi.mock('../../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

// ── Fixtures ────────────────────────────────────────────────────────────────────────────────

const TEMPLATE: R1ConsentTemplate = {
  version: 'r1-candidate-2026-11',
  locale: 'en-IN',
  title: 'Notice and consent for your AI interview',
  body_md: [
    '# What we collect',
    'Camera video, voice, transcript and scores.',
    '',
    '# Who processes it',
    '- Sarvam AI (speech)',
    '- DeepSeek (language model)',
    '',
    '<script>window.__bookPwned = true</script>',
    'Withdraw any time: [withdraw](https://example.test/withdraw)',
  ].join('\n'),
  required_consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'],
  consent_items: [{ type: 'ai_evaluation', label: 'I agree to the AI evaluation of my interview.' }],
};

const at = (date: string, time: string): string => `${date}T${time}:00+05:30`;
const slot = (date: string, start: string, end: string, available: boolean) => ({
  start_at: at(date, start),
  end_at: at(date, end),
  available,
});

/** Three IST days: the first mixed, the second full, the third open. Parsed like a server answer. */
const GRID: R1BookGrid = parseBookSlots({
  timezone: 'Asia/Kolkata',
  slot_minutes: 45,
  generated_at: '2026-09-16T06:30:00Z',
  // Built at run time: never a token-shaped literal in source.
  grid_token: `g1.${Date.UTC(2026, 8, 16)}.${'g'.repeat(43)}`,
  fully_booked: false,
  days: [
    {
      date: '2026-09-16',
      slots: [
        slot('2026-09-16', '09:00', '09:45', false),
        slot('2026-09-16', '09:30', '10:15', true),
        slot('2026-09-16', '10:00', '10:45', true),
      ],
    },
    {
      date: '2026-09-17',
      slots: [slot('2026-09-17', '09:00', '09:45', false), slot('2026-09-17', '09:30', '10:15', false)],
    },
    { date: '2026-09-18', slots: [slot('2026-09-18', '11:00', '11:45', true)] },
  ],
});

const DAY_1 = GRID.days[0];
const DAY_3 = GRID.days[2];

/** A radio's chip: the label that paints it. */
const chipOf = (radio: HTMLElement): HTMLElement => radio.closest('label') as HTMLElement;

// ── R1BookStatusCard ────────────────────────────────────────────────────────────────────────

describe('R1BookStatusCard', () => {
  it('shows the label, the heading, the time, the body and the actions, and focuses its heading', () => {
    render(
      <R1BookStatusCard
        id="book-done-title"
        eyebrow={R1_BOOK_COPY.states.booked.eyebrow}
        title={R1_BOOK_COPY.states.booked.title}
        when="Wednesday, 16 September 2026, 09:30–10:15 IST"
        body={[R1_BOOK_COPY.states.booked.body, R1_BOOK_COPY.states.booked.spam]}
      >
        <button type="button">Next</button>
      </R1BookStatusCard>,
    );
    const heading = screen.getByRole('heading', { level: 1, name: 'Your interview is booked' });
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(heading).toHaveFocus();
    const card = screen.getByRole('region', { name: 'Your interview is booked' });
    expect(within(card).getByText('Interview booked')).toHaveClass('candidate-eyebrow');
    expect(within(card).getByText(/09:30–10:15 IST/)).toHaveClass('r1-book__when');
    expect(within(card).getByText(R1_BOOK_COPY.states.booked.body)).toBeVisible();
    expect(within(card).getByText(R1_BOOK_COPY.states.booked.spam)).toBeVisible();
    const next = within(card).getByRole('button', { name: 'Next' });
    expect(next.parentElement).toHaveClass('r1-book__actions');
  });

  it('leaves out the time line and the actions when it has none', () => {
    const { container } = render(
      <R1BookStatusCard
        id="book-closed-title"
        eyebrow={R1_BOOK_COPY.states.notOpen.eyebrow}
        title={R1_BOOK_COPY.states.notOpen.title}
        body={[R1_BOOK_COPY.states.notOpen.body]}
      />,
    );
    expect(container.querySelector('.r1-book__when')).toBeNull();
    expect(container.querySelector('.r1-book__actions')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('moves focus inside the commit that mounts it, so nothing sees the card unfocused', () => {
    // A sibling mounted after the card runs its layout effect in the same commit, after the
    // card's, and before any passive effect or DOM observer. A find* that saw the card before its
    // focus moved made a focus check fail on CI (PR #447); this pins the move into the commit.
    const seen: { inCommit: Element | null } = { inCommit: null };
    function CommitProbe() {
      useLayoutEffect(() => {
        seen.inCommit = document.activeElement;
      }, []);
      return null;
    }
    render(
      <>
        <R1BookStatusCard
          id="book-unavailable-title"
          eyebrow={R1_BOOK_COPY.states.unavailable.eyebrow}
          title={R1_BOOK_COPY.states.unavailable.title}
          body={[R1_BOOK_COPY.states.unavailable.body]}
        />
        <CommitProbe />
      </>,
    );
    expect(seen.inCommit).toBe(screen.getByRole('heading', { level: 1 }));
  });

  it('takes focus once, on mount: a re-render does not pull focus back from a control', async () => {
    const user = userEvent.setup();
    const props = {
      id: 'book-retry-title',
      eyebrow: R1_BOOK_COPY.states.retry.eyebrow,
      title: R1_BOOK_COPY.states.retry.title,
      body: [R1_BOOK_COPY.states.retry.body],
    };
    const { rerender } = render(
      <R1BookStatusCard {...props}>
        <button type="button">{R1_BOOK_COPY.states.retry.action}</button>
      </R1BookStatusCard>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    await user.tab();
    const retry = screen.getByRole('button', { name: 'Try again' });
    expect(retry).toHaveFocus();
    rerender(
      <R1BookStatusCard {...props}>
        <button type="button">{R1_BOOK_COPY.states.retry.action}</button>
      </R1BookStatusCard>,
    );
    expect(retry).toHaveFocus();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <R1BookStatusCard
        id="book-found-title"
        eyebrow={R1_BOOK_COPY.states.notFound.eyebrow}
        title={R1_BOOK_COPY.states.notFound.title}
        body={[R1_BOOK_COPY.states.notFound.body]}
      >
        <button type="button" className="r1-secondary-cta">
          {R1_BOOK_COPY.states.notFound.action}
        </button>
      </R1BookStatusCard>,
    );
    await expect(container).toHaveNoViolations();
  });
});

// ── R1BookNotice ────────────────────────────────────────────────────────────────────────────

function NoticeHarness({
  errors,
  onToggle = vi.fn(),
  onInIndia = vi.fn(),
  disabled = false,
  headingLevel,
}: {
  errors?: { consents?: string; in_india?: string };
  onToggle?: (type: string, value: boolean) => void;
  onInIndia?: (value: boolean) => void;
  disabled?: boolean;
  headingLevel?: 2 | 3;
}) {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [inIndia, setInIndia] = useState(false);
  return (
    <R1BookNotice
      template={TEMPLATE}
      checked={checked}
      inIndia={inIndia}
      onToggle={(type, value) => {
        onToggle(type, value);
        setChecked((previous) => ({ ...previous, [type]: value }));
      }}
      onInIndia={(value) => {
        onInIndia(value);
        setInIndia(value);
      }}
      disabled={disabled}
      errors={errors}
      idPrefix="r1-book"
      headingLevel={headingLevel}
    />
  );
}

describe('R1BookNotice', () => {
  it('shows the template title and the whole notice as plain text blocks in a focusable region', () => {
    render(<NoticeHarness />);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Notice and consent for your AI interview' }),
    ).toBeVisible();
    const region = screen.getByRole('region', { name: R1_BOOK_COPY.form.noticeRegionLabel });
    expect(region).toHaveAttribute('tabindex', '0');
    // The notice's own sections sit one level below its title.
    expect(within(region).getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual([
      'What we collect',
      'Who processes it',
    ]);
    expect(within(region).getAllByRole('listitem').map((node) => node.textContent)).toEqual([
      'Sarvam AI (speech)',
      'DeepSeek (language model)',
    ]);
    expect(within(region).getByText('Camera video, voice, transcript and scores.')).toBeVisible();
    expect(region.querySelector('script, a, img')).toBeNull();
    expect((window as unknown as { __bookPwned?: boolean }).__bookPwned).toBeUndefined();
    expect(region).toHaveTextContent('withdraw (https://example.test/withdraw)');
  });

  it('drops a level when it sits inside a panel with its own heading', () => {
    render(<NoticeHarness headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: TEMPLATE.title })).toBeVisible();
    const region = screen.getByRole('region', { name: R1_BOOK_COPY.form.noticeRegionLabel });
    expect(within(region).getAllByRole('heading', { level: 4 })).toHaveLength(2);
  });

  it('offers one box per required purpose and the India box, with no select-all', () => {
    render(<NoticeHarness />);
    const group = screen.getByRole('group', { name: 'Please agree to each purpose separately' });
    const purposes = within(group).getAllByRole('checkbox');
    expect(purposes.map((box) => box.id)).toEqual([
      'r1-book-consent-ai_interview',
      'r1-book-consent-video_audio_recording',
      'r1-book-consent-ai_evaluation',
      'r1-book-consent-data_processing',
    ]);
    // The template's own label wins; the others use the reviewed fallback wording.
    expect(screen.getByLabelText('I agree to the AI evaluation of my interview.')).toBe(purposes[2]);
    expect(screen.getByLabelText(/AI interviewer, including a sales role-play/)).toBe(purposes[0]);
    const india = screen.getByLabelText('I confirm I am located in India.');
    expect(india).toHaveAttribute('id', 'r1-book-in-india');
    expect(within(group).queryByLabelText('I confirm I am located in India.')).toBeNull();
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    expect(screen.queryByText(/select all|agree to all/i)).toBeNull();
    for (const box of screen.getAllByRole('checkbox')) expect(box).not.toBeChecked();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('reports every tick and untick to the page, which owns the boxes', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onInIndia = vi.fn();
    render(<NoticeHarness onToggle={onToggle} onInIndia={onInIndia} />);
    await user.click(screen.getByLabelText(/camera video and voice being recorded/));
    expect(onToggle).toHaveBeenLastCalledWith('video_audio_recording', true);
    expect(screen.getByLabelText(/camera video and voice being recorded/)).toBeChecked();
    await user.click(screen.getByLabelText(/camera video and voice being recorded/));
    expect(onToggle).toHaveBeenLastCalledWith('video_audio_recording', false);
    await user.click(screen.getByLabelText('I confirm I am located in India.'));
    expect(onInIndia).toHaveBeenLastCalledWith(true);
    expect(screen.getByLabelText('I confirm I am located in India.')).toBeChecked();
    // Space on a focused box ticks it too (keyboard only).
    screen.getByLabelText(/DeepSeek in the People's Republic of China/).focus();
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenLastCalledWith('data_processing', true);
  });

  it('ties each message to the boxes it is about', async () => {
    const user = userEvent.setup();
    render(
      <NoticeHarness
        errors={{
          consents: R1_BOOK_COPY.errors.consents_required,
          in_india: R1_BOOK_COPY.errors.in_india_required,
        }}
      />,
    );
    const consentsError = screen.getByText(R1_BOOK_COPY.errors.consents_required);
    expect(consentsError).toHaveAttribute('id', 'r1-book-consents-error');
    expect(consentsError).toHaveClass('r1-book__field-error');
    const group = screen.getByRole('group', { name: 'Please agree to each purpose separately' });
    for (const box of within(group).getAllByRole('checkbox')) {
      expect(box).toHaveAttribute('aria-invalid', 'true');
      expect(box).toHaveAttribute('aria-describedby', 'r1-book-consents-error');
      expect(box).toHaveAccessibleDescription(R1_BOOK_COPY.errors.consents_required);
    }
    const india = screen.getByLabelText('I confirm I am located in India.');
    expect(india).toHaveAttribute('aria-invalid', 'true');
    expect(india).toHaveAccessibleDescription(R1_BOOK_COPY.errors.in_india_required);
    // A ticked box is no longer the one in error.
    const first = within(group).getAllByRole('checkbox')[0];
    await user.click(first);
    expect(first).not.toHaveAttribute('aria-invalid');
    expect(first).not.toHaveAttribute('aria-describedby');
  });

  it('shows no message and marks nothing invalid without errors', () => {
    render(<NoticeHarness />);
    expect(document.querySelector('.r1-book__field-error')).toBeNull();
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).not.toHaveAttribute('aria-invalid');
      expect(box).not.toHaveAttribute('aria-describedby');
    }
  });

  it('freezes every box while a request is in flight', () => {
    render(<NoticeHarness disabled />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
  });

  it('has no accessibility violations, with and without errors', async () => {
    const { container, unmount } = render(<NoticeHarness />);
    await expect(container).toHaveNoViolations();
    unmount();
    const withErrors = render(
      <NoticeHarness
        errors={{
          consents: R1_BOOK_COPY.errors.consents_required,
          in_india: R1_BOOK_COPY.errors.in_india_required,
        }}
      />,
    );
    await expect(withErrors.container).toHaveNoViolations();
  });
});

// ── R1BookSlotPicker ────────────────────────────────────────────────────────────────────────

function PickerHarness({
  initialDay = DAY_1.date,
  initialValue = null,
  currentStart,
  disabled,
  error,
  notice,
  onDay = vi.fn(),
  onChange = vi.fn(),
}: {
  initialDay?: string | null;
  initialValue?: string | null;
  currentStart?: string | null;
  disabled?: boolean;
  error?: string;
  notice?: string;
  onDay?: (date: string) => void;
  onChange?: (startAt: string) => void;
}) {
  const [day, setDay] = useState<string | null>(initialDay);
  const [value, setValue] = useState<string | null>(initialValue);
  return (
    <R1BookSlotPicker
      grid={GRID}
      day={day}
      onDay={(date) => {
        onDay(date);
        setDay(date);
        setValue(null);
      }}
      value={value}
      onChange={(startAt) => {
        onChange(startAt);
        setValue(startAt);
      }}
      currentStart={currentStart}
      idPrefix="r1-book"
      disabled={disabled}
      error={error}
      notice={notice}
    />
  );
}

const dayGroup = () => screen.getByRole('group', { name: 'Day' });
const timeGroup = () => screen.getByRole('group', { name: 'Time' });

describe('R1BookSlotPicker', () => {
  it('shows every IST day, and says in words that a full day has no times left', () => {
    render(<PickerHarness />);
    const days = within(dayGroup()).getAllByRole('radio');
    expect(days).toHaveLength(3);
    expect(days.map((radio) => chipOf(radio).querySelector('span')?.textContent)).toEqual(
      GRID.days.map((day) => formatIstDayLabel(day.date)),
    );
    expect(days[0]).toBeChecked();
    expect(days[0]).toBeEnabled();
    expect(chipOf(days[0])).toHaveAttribute('data-checked', 'true');
    expect(days[1]).toBeDisabled();
    expect(chipOf(days[1])).toHaveAttribute('data-disabled', 'true');
    expect(chipOf(days[1])).toHaveTextContent(R1_BOOK_COPY.form.dayUnavailable);
    expect(days[2]).toBeEnabled();
    expect(chipOf(days[2])).not.toHaveTextContent(R1_BOOK_COPY.form.dayUnavailable);
    for (const radio of days) expect(radio).toHaveClass('sr-only');
  });

  it("shows the chosen day's times, and says in words that a taken time is not available", () => {
    render(<PickerHarness />);
    const times = within(timeGroup()).getAllByRole('radio');
    expect(times.map((radio) => chipOf(radio).querySelector('span')?.textContent)).toEqual(
      DAY_1.slots.map((s) => formatIstTimeRange(s.start_at, s.end_at)),
    );
    expect(times[0]).toBeDisabled();
    expect(chipOf(times[0])).toHaveTextContent(R1_BOOK_COPY.form.timeUnavailable);
    expect(chipOf(times[0])).toHaveAttribute('data-disabled', 'true');
    expect(times[1]).toBeEnabled();
    expect(times[2]).toBeEnabled();
    expect(chipOf(times[1])).toHaveAttribute('data-disabled', 'false');
    expect(chipOf(times[1])).not.toHaveTextContent(R1_BOOK_COPY.form.timeUnavailable);
    for (const radio of times) expect(radio).not.toBeChecked();
    // The radio's name is the time, read by a screen reader with its state word.
    expect(
      screen.getByRole('radio', {
        name: `${formatIstTimeRange(DAY_1.slots[0].start_at, DAY_1.slots[0].end_at)} Not available`,
      }),
    ).toBe(times[0]);
  });

  it('hands back the exact grid instant of the picked time, and the date of the picked day', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onDay = vi.fn();
    render(<PickerHarness onChange={onChange} onDay={onDay} />);
    const times = within(timeGroup()).getAllByRole('radio');
    await user.click(times[2]);
    expect(onChange).toHaveBeenLastCalledWith('2026-09-16T10:00:00+05:30');
    expect(times[2]).toBeChecked();
    expect(chipOf(times[2])).toHaveAttribute('data-checked', 'true');
    await user.click(within(dayGroup()).getAllByRole('radio')[2]);
    expect(onDay).toHaveBeenLastCalledWith('2026-09-18');
    const dayThree = within(timeGroup()).getAllByRole('radio');
    expect(dayThree).toHaveLength(1);
    expect(chipOf(dayThree[0])).toHaveTextContent(
      formatIstTimeRange(DAY_3.slots[0].start_at, DAY_3.slots[0].end_at),
    );
    // A disabled time cannot be picked.
    await user.click(within(dayGroup()).getAllByRole('radio')[0]);
    await user.click(within(timeGroup()).getAllByRole('radio')[0]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the booking\'s own time on show but unpickable when moving it', () => {
    render(<PickerHarness currentStart={DAY_1.slots[1].start_at} />);
    const times = within(timeGroup()).getAllByRole('radio');
    expect(times[1]).toBeDisabled();
    expect(chipOf(times[1])).toHaveTextContent(R1_BOOK_COPY.form.currentTime);
    expect(chipOf(times[1])).not.toHaveTextContent(R1_BOOK_COPY.form.timeUnavailable);
    expect(times[2]).toBeEnabled();
    expect(times[2]).toHaveAttribute('id', 'r1-book-slot-first');
  });

  it('puts the focus target on the first pickable time of the chosen day', () => {
    render(<PickerHarness />);
    const first = document.getElementById('r1-book-slot-first');
    expect(first).toBe(within(timeGroup()).getAllByRole('radio')[1]);
    expect(document.querySelectorAll('#r1-book-slot-first')).toHaveLength(1);
    expect(screen.queryByText(R1_BOOK_COPY.form.noTimesOnDay)).toBeNull();
  });

  it('puts it on the first open day when the chosen day has no time left, and says so', () => {
    render(<PickerHarness initialDay={GRID.days[1].date} />);
    expect(screen.getByText(R1_BOOK_COPY.form.noTimesOnDay)).toBeVisible();
    for (const radio of within(timeGroup()).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(document.getElementById('r1-book-slot-first')).toBe(
      within(dayGroup()).getAllByRole('radio')[0],
    );
  });

  it('puts it on the first open day when no day is chosen yet', () => {
    render(<PickerHarness initialDay={null} />);
    expect(within(timeGroup()).queryAllByRole('radio')).toHaveLength(0);
    expect(document.getElementById('r1-book-slot-first')).toBe(
      within(dayGroup()).getAllByRole('radio')[0],
    );
  });

  it('moves within a group with the arrow keys, skipping what cannot be picked', async () => {
    const user = userEvent.setup();
    const onDay = vi.fn();
    const onChange = vi.fn();
    render(<PickerHarness onDay={onDay} onChange={onChange} />);
    const times = within(timeGroup()).getAllByRole('radio');
    times[1].focus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(DAY_1.slots[1].start_at);
    await user.keyboard('{ArrowRight}');
    expect(times[2]).toHaveFocus();
    expect(times[2]).toBeChecked();
    expect(onChange).toHaveBeenLastCalledWith(DAY_1.slots[2].start_at);
    // The days: from the first, the full second day is skipped.
    const days = within(dayGroup()).getAllByRole('radio');
    days[0].focus();
    await user.keyboard('{ArrowRight}');
    expect(days[2]).toHaveFocus();
    expect(days[2]).toBeChecked();
    expect(onDay).toHaveBeenLastCalledWith(DAY_3.date);
    await user.keyboard('{ArrowLeft}');
    expect(days[0]).toHaveFocus();
    expect(onDay).toHaveBeenLastCalledWith(DAY_1.date);
  });

  it('never shows a count of seats, places or times left', () => {
    render(<PickerHarness currentStart={DAY_1.slots[2].start_at} />);
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\b\d+ (seats?|left|remaining|places?|spots?)\b/i);
    expect(text).not.toMatch(/\bseats?\b|\bcapacity\b/i);
  });

  it('shows a notice line and ties a message to the time group', () => {
    render(
      <PickerHarness notice={R1_BOOK_COPY.inline.slotTaken} error={R1_BOOK_COPY.errors.slot_required} />,
    );
    expect(screen.getByText(R1_BOOK_COPY.inline.slotTaken)).toHaveClass('r1-book__notice');
    const message = screen.getByText(R1_BOOK_COPY.errors.slot_required);
    expect(message).toHaveAttribute('id', 'r1-book-slot-error');
    expect(timeGroup()).toHaveAttribute('aria-describedby', 'r1-book-slot-error');
    expect(timeGroup()).toHaveAccessibleDescription(R1_BOOK_COPY.errors.slot_required);
  });

  it('freezes every choice while a request is in flight', () => {
    render(<PickerHarness disabled />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toBeDisabled();
  });

  it('has no accessibility violations: plain, with a message, and when moving', async () => {
    const plain = render(<PickerHarness />);
    await expect(plain.container).toHaveNoViolations();
    plain.unmount();
    const flagged = render(
      <PickerHarness notice={R1_BOOK_COPY.inline.slotTaken} error={R1_BOOK_COPY.errors.slot_required} />,
    );
    await expect(flagged.container).toHaveNoViolations();
    flagged.unmount();
    const moving = render(
      <PickerHarness currentStart={DAY_1.slots[1].start_at} initialValue={DAY_1.slots[2].start_at} />,
    );
    await expect(moving.container).toHaveNoViolations();
  });
});

// ── R1BookErrorSummary ──────────────────────────────────────────────────────────────────────

const ITEMS = [
  { focusId: 'field-name', message: R1_BOOK_COPY.errors.name_required },
  { focusId: 'field-email', message: R1_BOOK_COPY.errors.email_invalid },
];

function SummaryHarness({ summaryRef }: { summaryRef?: Ref<HTMLDivElement> }) {
  return (
    <form noValidate>
      <R1BookErrorSummary items={ITEMS} ref={summaryRef} />
      <label htmlFor="field-name">Full name</label>
      <input id="field-name" type="text" />
      <label htmlFor="field-email">Email address</label>
      <input id="field-email" type="email" />
    </form>
  );
}

describe('R1BookErrorSummary', () => {
  it('renders nothing when there is nothing to fix', () => {
    const { container } = render(<R1BookErrorSummary items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is a named, focusable group of buttons, not an alert and not links', () => {
    const summaryRef = createRef<HTMLDivElement>();
    render(<SummaryHarness summaryRef={summaryRef} />);
    const summary = screen.getByRole('group', { name: 'Please check the following' });
    expect(summary).toHaveClass('r1-book__summary');
    expect(summary).toHaveAttribute('tabindex', '-1');
    expect(summary).not.toHaveAttribute('role', 'alert');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(within(summary).getByRole('heading', { level: 2 })).toHaveTextContent(
      'Please check the following',
    );
    const buttons = within(summary).getAllByRole('button');
    expect(buttons.map((button) => button.textContent)).toEqual(ITEMS.map((item) => item.message));
    for (const button of buttons) expect(button).toHaveAttribute('type', 'button');
    expect(summary.querySelector('a, [href]')).toBeNull();
    // The page focuses it through the ref.
    expect(summaryRef.current).toBe(summary);
    summaryRef.current?.focus();
    expect(summary).toHaveFocus();
  });

  it('moves focus to the field each item is about, by click or by keyboard, without touching the URL', async () => {
    const user = userEvent.setup();
    const before = window.location.href;
    const submit = vi.fn((event: Event) => event.preventDefault());
    render(<SummaryHarness />);
    document.querySelector('form')?.addEventListener('submit', submit);
    await user.click(screen.getByRole('button', { name: R1_BOOK_COPY.errors.email_invalid }));
    expect(screen.getByLabelText('Email address')).toHaveFocus();
    screen.getByRole('button', { name: R1_BOOK_COPY.errors.name_required }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Full name')).toHaveFocus();
    expect(submit).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(window.location.hash).toBe('');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<SummaryHarness />);
    await expect(container).toHaveNoViolations();
  });
});
