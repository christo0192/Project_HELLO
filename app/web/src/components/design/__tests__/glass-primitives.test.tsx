/**
 * Glass design primitives: GlassPanel, SectionHeader, Button, Switch,
 * Field/TextField/SelectField/TextArea, SegmentedControl,
 * Pagination/usePagination, ScrollArea, InlineNotice/EmptyPanel/ErrorPanel/
 * LoadingPanel, Reveal wrappers and StatusBadge — semantics, keyboard,
 * state and axe.
 */
import { useMemo, useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  GlassPanel,
  SectionHeader,
  Button,
  buttonClass,
  Switch,
  Field,
  TextField,
  TextArea,
  SelectField,
  SegmentedControl,
  Pagination,
  usePagination,
  PAGE_SIZES,
  ScrollArea,
  InlineNotice,
  EmptyPanel,
  ErrorPanel,
  LoadingPanel,
  RevealGroup,
  RevealItem,
  PageTransition,
  StatusBadge,
} from '..';
import type { PageSize, SegmentedOption } from '..';
import { stubMatchMedia } from './helpers';

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── GlassPanel ──────────────────────────────────────────────────── */

describe('GlassPanel', () => {
  it('renders a raised panel by default with medium padding', () => {
    render(<GlassPanel data-testid="panel">body</GlassPanel>);
    const panel = screen.getByTestId('panel');
    expect(panel.tagName).toBe('DIV');
    expect(panel).toHaveClass('glass');
    expect(panel).toHaveClass('p-5');
    expect(panel).not.toHaveClass('glass-interactive');
    expect(panel).toHaveTextContent('body');
  });

  it('maps level and padding to the glass utilities', () => {
    const { rerender } = render(
      <GlassPanel data-testid="panel" level="sunken" padding="none">
        well
      </GlassPanel>,
    );
    let panel = screen.getByTestId('panel');
    expect(panel).toHaveClass('glass-sunken');
    expect(panel.className).not.toMatch(/\bp-\d/);

    rerender(
      <GlassPanel data-testid="panel" level="strong" padding="lg">
        strong
      </GlassPanel>,
    );
    panel = screen.getByTestId('panel');
    expect(panel).toHaveClass('glass-strong');
    expect(panel).toHaveClass('p-6');
  });

  it('renders as another element, adds the interactive lift and forwards props', () => {
    render(
      <GlassPanel as="section" interactive aria-label="Service state" className="mt-2">
        contents
      </GlassPanel>,
    );
    const panel = screen.getByRole('region', { name: 'Service state' });
    expect(panel.tagName).toBe('SECTION');
    expect(panel).toHaveClass('glass-interactive');
    expect(panel).toHaveClass('mt-2');
  });
});

/* ── SectionHeader ───────────────────────────────────────────────── */

describe('SectionHeader', () => {
  it('renders an h2 with description, meta and actions', () => {
    render(
      <SectionHeader
        title="Recent sessions"
        description="Last 24 hours."
        meta={<StatusBadge tone="info">Live</StatusBadge>}
        actions={<Button>Refresh</Button>}
      />,
    );
    expect(
      screen.getByRole('heading', { name: 'Recent sessions', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByText('Last 24 hours.')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeInTheDocument();
  });

  it('renders an h3 with an id and omits the description when absent', () => {
    render(<SectionHeader title="Inside a panel" level={3} id="panel-title" />);
    const heading = screen.getByRole('heading', { name: 'Inside a panel', level: 3 });
    expect(heading).toHaveAttribute('id', 'panel-title');
    expect(heading.parentElement?.parentElement?.querySelector('p')).toBeNull();
  });
});

/* ── Button ──────────────────────────────────────────────────────── */

describe('buttonClass', () => {
  it('defaults to the secondary variant at medium size', () => {
    const cls = buttonClass();
    expect(cls).toContain('rounded-control');
    expect(cls).toContain('bg-white/70');
    expect(cls).toContain('h-9');
  });

  it('emits the WCAG 2.5.5 target-size class for the lg size', () => {
    expect(buttonClass('primary', 'lg')).toContain('min-h-[44px]');
    expect(buttonClass('primary', 'sm')).not.toContain('min-h-[44px]');
  });

  it('appends extra classes and honours each variant', () => {
    expect(buttonClass('danger', 'sm', 'w-full')).toContain('w-full');
    expect(buttonClass('primary')).toContain('bg-info');
    expect(buttonClass('ghost')).toContain('text-ink-secondary');
    expect(buttonClass('danger')).toContain('bg-error');
  });
});

describe('Button', () => {
  it('defaults to type=button and fires onClick', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button).toHaveAttribute('type', 'button');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the lg size with the literal min-h-[44px] class', () => {
    render(
      <Button size="lg" variant="primary">
        Book a slot
      </Button>,
    );
    expect(screen.getByRole('button', { name: 'Book a slot' })).toHaveClass('min-h-[44px]');
  });

  it('marks itself busy, disables and swallows clicks while loading', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button loading onClick={onClick}>
        Sending
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Sending' });
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button).toBeDisabled();
    expect(button.querySelector('svg')).toHaveClass('animate-spin');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('renders a decorative icon and no aria-busy when idle', () => {
    render(<Button icon={<span>★</span>}>Star</Button>);
    const button = screen.getByRole('button', { name: 'Star' });
    expect(button).not.toHaveAttribute('aria-busy');
    expect(button.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('stays inert when explicitly disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Nope
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Nope' }));
    expect(onClick).not.toHaveBeenCalled();
  });
});

/* ── Switch ──────────────────────────────────────────────────────── */

function SwitchHarness({
  onChange,
  disabled,
  initial = false,
}: {
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  initial?: boolean;
}) {
  const [checked, setChecked] = useState(initial);
  return (
    <Switch
      checked={checked}
      onCheckedChange={(next) => {
        setChecked(next);
        onChange?.(next);
      }}
      label="Auto-invite"
      description="Send invites as soon as a résumé passes."
      disabled={disabled}
    />
  );
}

describe('Switch', () => {
  it('exposes role=switch wired to its label and description', () => {
    render(<SwitchHarness />);
    const control = screen.getByRole('switch', { name: 'Auto-invite' });
    expect(control).toHaveAttribute('aria-checked', 'false');

    const labelId = control.getAttribute('aria-labelledby');
    const descId = control.getAttribute('aria-describedby');
    expect(labelId).toBeTruthy();
    expect(descId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent('Auto-invite');
    expect(document.getElementById(descId!)).toHaveTextContent(
      'Send invites as soon as a résumé passes.',
    );
  });

  it('toggles aria-checked on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SwitchHarness onChange={onChange} />);
    const control = screen.getByRole('switch');
    await user.click(control);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(control).toHaveAttribute('aria-checked', 'true');
    await user.click(control);
    expect(onChange).toHaveBeenLastCalledWith(false);
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('toggles from the keyboard with Enter and Space', async () => {
    const user = userEvent.setup();
    render(<SwitchHarness />);
    const control = screen.getByRole('switch');
    await user.tab();
    expect(control).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(control).toHaveAttribute('aria-checked', 'true');

    await user.keyboard('[Space]');
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('does not toggle while disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SwitchHarness onChange={onChange} disabled />);
    const control = screen.getByRole('switch');
    expect(control).toBeDisabled();
    await user.click(control);
    expect(onChange).not.toHaveBeenCalled();
    expect(control).toHaveAttribute('aria-checked', 'false');
  });

  it('renders bare (no wrapper, no aria-labelledby) when no label is given', () => {
    render(
      <Switch checked aria-label="Mute" onCheckedChange={() => {}} className="ml-2" size="sm" />,
    );
    const control = screen.getByRole('switch', { name: 'Mute' });
    expect(control).not.toHaveAttribute('aria-labelledby');
    expect(control).not.toHaveAttribute('aria-describedby');
    expect(control).toHaveClass('ml-2');
    expect(control).toHaveAttribute('aria-checked', 'true');
  });
});

/* ── Field family ────────────────────────────────────────────────── */

describe('Field / TextField / SelectField / TextArea', () => {
  it('wires the label to the control and exposes the hint via aria-describedby', () => {
    render(
      <Field label="Work email" hint="We never share this.">
        {(ids) => (
          <TextField
            id={ids.id}
            aria-describedby={ids.describedBy}
            aria-invalid={ids.invalid}
            defaultValue="a@b.com"
          />
        )}
      </Field>,
    );
    const input = screen.getByLabelText('Work email');
    expect(input.tagName).toBe('INPUT');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('We never share this.');
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders the error with role=alert, replaces the hint and marks the control invalid', () => {
    render(
      <Field label="Work email" hint="We never share this." error="Enter a valid address.">
        {(ids) => (
          <TextField id={ids.id} aria-describedby={ids.describedBy} aria-invalid={ids.invalid} />
        )}
      </Field>,
    );
    const input = screen.getByLabelText('Work email');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Enter a valid address.');
    expect(input.getAttribute('aria-describedby')).toContain(alert.id);
    expect(screen.queryByText('We never share this.')).not.toBeInTheDocument();
  });

  it('lists both hint and error ids in aria-describedby when both are set', () => {
    render(
      <Field label="Slot" hint="IST." error="Outside the window.">
        {(ids) => <TextField id={ids.id} aria-describedby={ids.describedBy} />}
      </Field>,
    );
    const ids = screen.getByLabelText('Slot').getAttribute('aria-describedby')!.split(' ');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/-hint$/);
    expect(ids[1]).toMatch(/-error$/);
  });

  it('honours an explicit id and the inline layout', () => {
    render(
      <Field label="Notes" id="notes-field" inline>
        {(ids) => <TextField id={ids.id} />}
      </Field>,
    );
    const input = screen.getByLabelText('Notes');
    expect(input).toHaveAttribute('id', 'notes-field');
    expect(input.parentElement).toHaveClass('flex', 'items-center');
  });

  it('renders a labelled select whose value changes', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Decision">
        {(ids) => (
          <SelectField id={ids.id} defaultValue="advance">
            <option value="advance">Advance</option>
            <option value="reject">Reject</option>
          </SelectField>
        )}
      </Field>,
    );
    const select = screen.getByLabelText<HTMLSelectElement>('Decision');
    expect(select.tagName).toBe('SELECT');
    expect(select).toHaveClass('control-select');
    await user.selectOptions(select, 'reject');
    expect(select.value).toBe('reject');
  });

  it('renders a labelled textarea that accepts typing', async () => {
    const user = userEvent.setup();
    render(
      <Field label="Reason">
        {(ids) => <TextArea id={ids.id} aria-describedby={ids.describedBy} />}
      </Field>,
    );
    const textarea = screen.getByLabelText<HTMLTextAreaElement>('Reason');
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveClass('resize-y');
    await user.type(textarea, 'Conflicting dates');
    expect(textarea.value).toBe('Conflicting dates');
  });

  it('renders the small size variants', () => {
    render(
      <>
        <Field label="Small text">{(ids) => <TextField id={ids.id} size="sm" />}</Field>
        <Field label="Small select">
          {(ids) => (
            <SelectField id={ids.id} size="sm">
              <option value="a">A</option>
            </SelectField>
          )}
        </Field>
      </>,
    );
    expect(screen.getByLabelText('Small text')).toHaveClass('h-8');
    expect(screen.getByLabelText('Small select')).toHaveClass('h-8');
  });
});

/* ── SegmentedControl ────────────────────────────────────────────── */

const SEGMENTS: ReadonlyArray<SegmentedOption<'all' | 'passed' | 'archived'>> = [
  { value: 'all', label: 'All', count: 34 },
  { value: 'passed', label: 'Passed', count: 12 },
  { value: 'archived', label: 'Archived', disabled: true },
];

function SegmentedHarness({ onChange }: { onChange?: (next: string) => void }) {
  const [value, setValue] = useState<'all' | 'passed' | 'archived'>('all');
  return (
    <SegmentedControl
      options={SEGMENTS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      ariaLabel="Candidate filter"
    />
  );
}

describe('SegmentedControl', () => {
  it('renders a labelled group with exactly one pressed option', () => {
    render(<SegmentedHarness />);
    const group = screen.getByRole('group', { name: 'Candidate filter' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons).toHaveLength(3);
    expect(buttons.filter((b) => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders the option counts', () => {
    render(<SegmentedHarness />);
    const group = screen.getByRole('group', { name: 'Candidate filter' });
    expect(within(group).getByText('34')).toBeInTheDocument();
    expect(within(group).getByText('12')).toBeInTheDocument();
  });

  it('calls onChange with the option value and moves the pressed state', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SegmentedHarness onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Candidate filter' });
    await user.click(within(group).getByRole('button', { name: /Passed/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('passed');
    expect(within(group).getByRole('button', { name: /Passed/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: /All/ })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('does not fire for a disabled option', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<SegmentedHarness onChange={onChange} />);
    const archived = screen.getByRole('button', { name: 'Archived' });
    expect(archived).toBeDisabled();
    await user.click(archived);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('supports the small size', () => {
    render(
      <SegmentedControl
        options={[{ value: 'a', label: 'A' }]}
        value="a"
        onChange={() => {}}
        ariaLabel="Size probe"
        size="sm"
        className="w-full"
      />,
    );
    const group = screen.getByRole('group', { name: 'Size probe' });
    expect(group).toHaveClass('w-full');
    expect(within(group).getByRole('button', { name: 'A' })).toHaveClass('h-7');
  });
});

/* ── Pagination + usePagination ──────────────────────────────────── */

function PaginationHarness({
  count = 34,
  initialSize,
  hidePageSize = false,
}: {
  count?: number;
  initialSize?: PageSize;
  hidePageSize?: boolean;
}) {
  const [size, setSize] = useState(count);
  const rows = useMemo(() => Array.from({ length: size }, (_, i) => `row-${i + 1}`), [size]);
  const state = usePagination(rows, initialSize);
  return (
    <div>
      <button type="button" onClick={() => setSize(5)}>
        Shrink rows
      </button>
      <span data-testid="page">{state.page}</span>
      <span data-testid="page-count">{state.pageCount}</span>
      <span data-testid="page-size">{state.pageSize}</span>
      <span data-testid="range">{`${state.from}-${state.to}/${state.total}`}</span>
      <ul>
        {state.items.map((row) => (
          <li key={row}>{row}</li>
        ))}
      </ul>
      <Pagination state={state} noun="sessions" hidePageSize={hidePageSize} />
    </div>
  );
}

describe('usePagination + Pagination', () => {
  it('slices 34 rows into 4 pages of 10 and reports the visible range', () => {
    render(<PaginationHarness />);
    expect(screen.getByTestId('page')).toHaveTextContent('1');
    expect(screen.getByTestId('page-count')).toHaveTextContent('4');
    expect(screen.getByTestId('page-size')).toHaveTextContent('10');
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('row-1')).toBeInTheDocument();
    expect(screen.queryByText('row-11')).not.toBeInTheDocument();

    const nav = screen.getByRole('navigation', { name: 'sessions pagination' });
    expect(within(nav).getByRole('status')).toHaveTextContent(/Showing\s*1–10\s*of\s*34\s*sessions/);
  });

  it('steps forward and back, disabling the controls at the edges', async () => {
    const user = userEvent.setup();
    render(<PaginationHarness />);
    const next = screen.getByRole('button', { name: 'Next page' });
    const previous = screen.getByRole('button', { name: 'Previous page' });
    const status = within(
      screen.getByRole('navigation', { name: 'sessions pagination' }),
    ).getByRole('status');

    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();

    await user.click(next);
    expect(screen.getByTestId('page')).toHaveTextContent('2');
    expect(status).toHaveTextContent(/Showing\s*11–20\s*of\s*34\s*sessions/);
    expect(previous).toBeEnabled();

    await user.click(next);
    await user.click(next);
    expect(screen.getByTestId('page')).toHaveTextContent('4');
    // Last page carries the 4 remaining rows.
    expect(status).toHaveTextContent(/Showing\s*31–34\s*of\s*34\s*sessions/);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(next).toBeDisabled();

    await user.click(previous);
    expect(screen.getByTestId('page')).toHaveTextContent('3');
  });

  it('resets to page 1 and recomputes the page count when the page size changes', async () => {
    const user = userEvent.setup();
    render(<PaginationHarness />);
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByTestId('page')).toHaveTextContent('2');

    await user.selectOptions(screen.getByLabelText('Rows per page'), '25');
    expect(screen.getByTestId('page-size')).toHaveTextContent('25');
    expect(screen.getByTestId('page')).toHaveTextContent('1');
    expect(screen.getByTestId('page-count')).toHaveTextContent('2');
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
  });

  it('offers every documented page size', () => {
    render(<PaginationHarness />);
    const select = screen.getByLabelText<HTMLSelectElement>('Rows per page');
    expect(Array.from(select.options).map((o) => Number(o.value))).toEqual([...PAGE_SIZES]);
  });

  it('clamps the current page when the row set shrinks', async () => {
    const user = userEvent.setup();
    render(<PaginationHarness />);
    const next = screen.getByRole('button', { name: 'Next page' });
    await user.click(next);
    await user.click(next);
    await user.click(next);
    expect(screen.getByTestId('page')).toHaveTextContent('4');

    await user.click(screen.getByRole('button', { name: 'Shrink rows' }));
    expect(screen.getByTestId('page-count')).toHaveTextContent('1');
    expect(screen.getByTestId('page')).toHaveTextContent('1');
    expect(screen.getByTestId('range')).toHaveTextContent('1-5/5');
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
  });

  it('accepts a non-default initial page size', () => {
    render(<PaginationHarness initialSize={50} />);
    expect(screen.getByTestId('page-size')).toHaveTextContent('50');
    expect(screen.getByTestId('page-count')).toHaveTextContent('1');
  });

  it('hides the page-size select when asked (server-side paging)', () => {
    render(<PaginationHarness hidePageSize />);
    expect(screen.queryByLabelText('Rows per page')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeInTheDocument();
  });

  it('renders nothing when there is nothing to page', () => {
    render(<PaginationHarness count={0} />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByTestId('range')).toHaveTextContent('0-0/0');
    expect(screen.getByTestId('page-count')).toHaveTextContent('1');
  });
});

/* ── ScrollArea ──────────────────────────────────────────────────── */

describe('ScrollArea', () => {
  it('is a focusable, labelled region bounded by max-height', () => {
    render(
      <ScrollArea maxHeight="24rem" label="Transcript" className="mt-2">
        <p>turn one</p>
      </ScrollArea>,
    );
    const region = screen.getByRole('region', { name: 'Transcript' });
    expect(region).toHaveAttribute('tabindex', '0');
    expect(region).toHaveStyle({ maxHeight: '24rem' });
    expect(region).toHaveClass('overflow-y-auto', 'mt-2');
    expect(screen.getByText('turn one')).toBeInTheDocument();
  });
});

/* ── Notices ─────────────────────────────────────────────────────── */

describe('InlineNotice', () => {
  it('announces politely by default with a decorative tone dot', () => {
    render(<InlineNotice tone="success">Invite sent.</InlineNotice>);
    const notice = screen.getByRole('status');
    expect(notice).toHaveTextContent('Invite sent.');
    expect(notice).toHaveClass('bg-success-soft');
    expect(notice.querySelector('[aria-hidden="true"]')).toHaveClass('bg-success');
  });

  it('escalates to role=alert on request and renders an action', () => {
    render(
      <InlineNotice tone="danger" role="alert" action={<Button size="sm">Retry</Button>}>
        Ingestion failed.
      </InlineNotice>,
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Ingestion failed.');
    expect(within(alert).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('defaults to the info tint', () => {
    render(<InlineNotice>Heads up.</InlineNotice>);
    expect(screen.getByRole('status')).toHaveClass('bg-info-soft');
  });
});

describe('EmptyPanel', () => {
  it('renders title, hint, decorative icon and action inside a sunken well', () => {
    render(
      <EmptyPanel
        title="No sessions yet"
        hint="Invites appear here once a résumé passes."
        icon={<span>◎</span>}
        action={<Button size="sm">Invite</Button>}
      />,
    );
    expect(screen.getByText('No sessions yet')).toBeInTheDocument();
    expect(screen.getByText('Invites appear here once a résumé passes.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
    const panel = screen.getByText('No sessions yet').parentElement!;
    expect(panel).toHaveClass('glass-sunken', 'py-14');
    expect(panel.querySelector('[aria-hidden="true"]')).toHaveTextContent('◎');
  });

  it('supports the compact padding', () => {
    render(<EmptyPanel title="Nothing here" compact />);
    expect(screen.getByText('Nothing here').parentElement).toHaveClass('py-8');
  });
});

describe('ErrorPanel', () => {
  it('is an alert and calls the retry callback', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorPanel message="Could not load candidates." onRetry={onRetry} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load candidates.');
    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('omits the retry control when no callback is given and honours a custom label', () => {
    const { rerender } = render(<ErrorPanel message="Broken." />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<ErrorPanel message="Broken." onRetry={() => {}} retryLabel="Reload" compact />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveClass('py-8');
  });
});

describe('LoadingPanel', () => {
  it('exposes a status with the default label', () => {
    render(<LoadingPanel />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Loading…');
    expect(status).toHaveClass('py-16');
  });

  it('accepts a custom label and compact padding', () => {
    render(<LoadingPanel label="Fetching transcript…" compact />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Fetching transcript…');
    expect(status).toHaveClass('py-8');
  });
});

/* ── Reveal wrappers ─────────────────────────────────────────────── */

describe('Reveal wrappers', () => {
  function Tree() {
    return (
      <PageTransition className="page">
        <RevealGroup as="ul" className="group">
          <RevealItem as="li">first</RevealItem>
          <RevealItem as="li">second</RevealItem>
        </RevealGroup>
      </PageTransition>
    );
  }

  it('renders children with the requested elements', () => {
    render(<Tree />);
    const list = screen.getByRole('list');
    expect(list).toHaveClass('group');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('still renders every child under reduced motion', () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    render(<Tree />);
    expect(within(screen.getByRole('list')).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('defaults RevealGroup/RevealItem to div wrappers', () => {
    render(
      <RevealGroup className="grid">
        <RevealItem className="cell">cell</RevealItem>
      </RevealGroup>,
    );
    const cell = screen.getByText('cell');
    expect(cell.tagName).toBe('DIV');
    expect(cell.parentElement).toHaveClass('grid');
  });
});

/* ── StatusBadge ─────────────────────────────────────────────────── */

describe('StatusBadge', () => {
  it('stamps the tone on data-status-badge and renders a decorative dot', () => {
    render(<StatusBadge tone="danger">Failed</StatusBadge>);
    const badge = screen.getByText('Failed').closest('[data-status-badge]')!;
    expect(badge).toHaveAttribute('data-status-badge', 'danger');
    expect(badge).toHaveClass('bg-error-soft', 'text-error-text');
    expect(badge.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('renders no dot when dot={false}', () => {
    render(
      <StatusBadge tone="success" dot={false}>
        Advanced
      </StatusBadge>,
    );
    const badge = screen.getByText('Advanced').closest('[data-status-badge]')!;
    expect(badge).toHaveAttribute('data-status-badge', 'success');
    expect(badge.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(badge.querySelectorAll('span')).toHaveLength(0);
  });

  it('defaults to the neutral tone', () => {
    render(<StatusBadge className="ml-1">Queued</StatusBadge>);
    const badge = screen.getByText('Queued').closest('[data-status-badge]')!;
    expect(badge).toHaveAttribute('data-status-badge', 'neutral');
    expect(badge).toHaveClass('ml-1');
  });
});

/* ── Composite accessibility sweep ───────────────────────────────── */

function Composite() {
  const [on, setOn] = useState(false);
  const [filter, setFilter] = useState<'all' | 'passed'>('all');
  const rows = useMemo(() => Array.from({ length: 34 }, (_, i) => `row-${i + 1}`), []);
  const pagination = usePagination(rows);
  return (
    <main>
      <GlassPanel as="section" aria-labelledby="composite-title">
        <SectionHeader
          id="composite-title"
          title="Screening controls"
          description="Every control below carries a name."
          meta={<StatusBadge tone="info">Live</StatusBadge>}
          actions={<Button variant="primary">Refresh</Button>}
        />
        <Switch
          checked={on}
          onCheckedChange={setOn}
          label="Auto-invite"
          description="Send invites automatically."
        />
        <SegmentedControl
          options={[
            { value: 'all', label: 'All', count: 34 },
            { value: 'passed', label: 'Passed', count: 12 },
          ]}
          value={filter}
          onChange={setFilter}
          ariaLabel="Candidate filter"
        />
        <Field label="Search" hint="Matches name and role.">
          {(ids) => (
            <TextField id={ids.id} aria-describedby={ids.describedBy} aria-invalid={ids.invalid} />
          )}
        </Field>
        <Field label="Decision" error="Pick one.">
          {(ids) => (
            <SelectField id={ids.id} aria-describedby={ids.describedBy} aria-invalid={ids.invalid}>
              <option value="advance">Advance</option>
              <option value="reject">Reject</option>
            </SelectField>
          )}
        </Field>
        <Field label="Notes">{(ids) => <TextArea id={ids.id} />}</Field>
        <InlineNotice tone="success">Invite sent.</InlineNotice>
        <ErrorPanel message="One résumé failed to parse." onRetry={() => {}} compact />
        <LoadingPanel compact />
        <GlassPanel level="sunken" padding="none">
          <ScrollArea maxHeight="12rem" label="Recent activity">
            <RevealGroup as="ul">
              <RevealItem as="li">Ada advanced</RevealItem>
              <RevealItem as="li">Grace scheduled</RevealItem>
            </RevealGroup>
          </ScrollArea>
        </GlassPanel>
        <EmptyPanel title="No archived candidates" hint="They will appear here." compact />
        <Pagination state={pagination} noun="sessions" />
      </GlassPanel>
    </main>
  );
}

describe('composite accessibility', () => {
  it('mounts one of each primitive with no axe violations', async () => {
    const { container } = render(<Composite />);
    expect(screen.getByRole('switch', { name: 'Auto-invite' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Candidate filter' })).toBeInTheDocument();
    expect(screen.getByLabelText('Search')).toBeInTheDocument();
    expect(screen.getByLabelText('Rows per page')).toBeInTheDocument();
    await expect(container).toHaveNoViolations();
  });

  it('mounts the same tree under reduced motion with no axe violations', async () => {
    stubMatchMedia(true, '(prefers-reduced-motion: reduce)');
    const { container } = render(<Composite />);
    await expect(container).toHaveNoViolations();
  });
});
