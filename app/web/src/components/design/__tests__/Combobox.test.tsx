/**
 * Combobox — the searchable picker that replaced native selects.
 *
 * The contract under test is the one a keyboard or screen-reader user relies
 * on (WAI-ARIA APG, combobox with listbox popup), plus the two rules that
 * exist because the picker lives INSIDE modals: Escape closes the list and
 * not the dialog around it, and Enter never submits the surrounding form.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { Combobox } from '../Combobox';
import type { ComboboxOption } from '../Combobox';
import { Dialog } from '../Dialog';

const OPTIONS: ComboboxOption[] = [
  { value: '0', label: 'Account Executive', description: 'Opened 2 Jul 2026' },
  { value: '1', label: 'Sales Program Advisor', description: 'Opened 1 Aug 2026' },
  { value: '2', label: 'Career Coach', description: 'Opened 3 Sep 2026' },
  { value: '3', label: 'Customer Success Associate', disabled: true, tag: 'Mapped', group: 'Already mapped' },
];

function Harness({
  onChange = () => {},
  initial = '',
  options = OPTIONS,
}: {
  onChange?: (v: string) => void;
  initial?: string;
  options?: ComboboxOption[];
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <label id="job-label" htmlFor="job">
        Ashby job
      </label>
      <Combobox
        id="job"
        labelId="job-label"
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        options={options}
        placeholder="Choose a job"
        searchLabel="Search open jobs"
        listLabel="Open Ashby jobs"
        noun={['job', 'jobs']}
      />
      <button type="button">After</button>
    </>
  );
}

const trigger = () => screen.getByRole('button', { name: /Ashby job/ });

describe('Combobox', () => {
  it('is a button named by its label AND its current value, closed by default', () => {
    render(<Harness initial="1" />);
    expect(trigger()).toHaveAccessibleName('Ashby job Sales Program Advisor Opened 1 Aug 2026');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('opens on click, moves focus into the search field, and lists every option', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    const search = screen.getByRole('combobox', { name: 'Search open jobs' });
    expect(search).toHaveFocus();
    const list = screen.getByRole('listbox', { name: 'Open Ashby jobs' });
    expect(within(list).getAllByRole('option')).toHaveLength(4);
  });

  it('opens from the keyboard with ArrowDown', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('filters by label AND description, case- and accent-insensitively, and says the count', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard('CÔACH');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent('Career Coach');
    // The count is announced once typing settles (debounced), not per key.
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('1 job'));

    await user.clear(screen.getByRole('combobox'));
    await user.keyboard('aug 2026'); // matches the description only
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('Sales Program Advisor'),
    ]);
  });

  it('says so when nothing matches — OUTSIDE the listbox, which may only own options', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard('zzz');
    const list = screen.getByRole('listbox');
    expect(within(list).queryAllByRole('option')).toHaveLength(0);
    // axe `aria-required-children`: no stray paragraph inside the listbox.
    expect(list).toBeEmptyDOMElement();
    expect(screen.getByText('Nothing matches “zzz”.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Nothing matches “zzz”.'));
  });

  it('a click on the list itself (not an option) keeps it open', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByRole('group', { name: 'Already mapped' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('a click on the control BELOW an open list lands there (the list closes after it)', async () => {
    // The list is in flow: closing on the press used to collapse it and move
    // the target out from under the pointer, swallowing the click.
    const user = userEvent.setup();
    const after = vi.fn();
    render(
      <>
        <Harness />
        <button type="button" onClick={after}>
          Below
        </button>
      </>,
    );
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'Below' }));
    expect(after).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('marks the match on the ORIGINAL text, even where lowercasing changes length', async () => {
    const user = userEvent.setup();
    render(<Harness options={[{ value: 'x', label: 'İzmir Engineer' }]} />);
    await user.click(trigger());
    await user.keyboard('engineer');
    expect(screen.getByRole('option').querySelector('mark')).toHaveTextContent(/^Engineer$/);
  });

  it('moves the ACTIVE option with the arrows (never focus), skipping disabled ones, and picks with Enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    const search = screen.getByRole('combobox');
    const options = screen.getAllByRole('option');
    // Starts on the first choosable option.
    expect(search).toHaveAttribute('aria-activedescendant', options[0].id);
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    // Three downs from 0 stop at 2 — option 3 is disabled and never active.
    expect(search).toHaveAttribute('aria-activedescendant', options[2].id);
    expect(search).toHaveFocus();
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onChange).toHaveBeenCalledWith('1');
    // Closed, focus back on the trigger, which now names the choice.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName(/Sales Program Advisor/);
  });

  it('marks the chosen option selected and reopens on it', async () => {
    const user = userEvent.setup();
    render(<Harness initial="2" />);
    await user.click(trigger());
    const chosen = screen.getByRole('option', { name: /Career Coach/ });
    expect(chosen).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('combobox')).toHaveAttribute('aria-activedescendant', chosen.id);
  });

  it('lists a disabled option under its group, tagged, and ignores a click on it', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    const group = screen.getByRole('group', { name: 'Already mapped' });
    const mapped = within(group).getByRole('option', { name: /Customer Success Associate/ });
    expect(mapped).toHaveAttribute('aria-disabled', 'true');
    expect(mapped).toHaveTextContent('Mapped');
    await user.click(mapped);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('picks with a click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: /Account Executive/ }));
    expect(onChange).toHaveBeenCalledWith('0');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('never renders an option VALUE — a caller can keep ids out of the DOM', async () => {
    const user = userEvent.setup();
    const secret = [{ value: 'job_7f3a9c-secret-id', label: 'Account Executive' }];
    render(<Harness options={secret} initial="job_7f3a9c-secret-id" />);
    await user.click(trigger());
    expect(document.body.innerHTML).not.toContain('job_7f3a9c-secret-id');
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes when focus leaves it, without pulling focus back', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('INSIDE A DIALOG, Escape closes the list and the dialog stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Add job mapping" idPrefix="t">
        <Harness />
      </Dialog>,
    );
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    // A SECOND Escape, with the list closed, is the dialog's again.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('INSIDE A FORM, Enter picks the option and never submits', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Harness />
        <button type="submit">Save</button>
      </form>,
    );
    await user.click(trigger());
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(trigger()).toHaveAccessibleName(/Account Executive/);
  });

  it('is inert while loading or disabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <Combobox
        id="x"
        value=""
        onChange={() => {}}
        options={OPTIONS}
        placeholder="Loading jobs from Ashby…"
        searchLabel="Search"
        listLabel="List"
        loading
      />,
    );
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    rerender(
      <Combobox id="x" value="" onChange={() => {}} options={OPTIONS} placeholder="p" searchLabel="Search" listLabel="List" disabled />,
    );
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
