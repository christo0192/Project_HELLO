/**
 * Combobox — the searchable picker that replaced native selects.
 *
 * The contract under test is the one a keyboard or screen-reader user relies
 * on (WAI-ARIA APG, combobox with listbox popup), plus the two rules that
 * exist because the picker lives INSIDE modals: Escape closes the list and
 * not the dialog around it, and Enter never submits the surrounding form.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { Combobox } from '../Combobox';
import type { ComboboxOption } from '../Combobox';
import { Dialog } from '../Dialog';
import { pickOption } from './helpers';

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
    await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('1 job'));

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
    await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Nothing matches “zzz”.'));
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

  it('INSIDE A DIALOG, an Escape that ends an IME composition closes neither the list nor the dialog', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog open onClose={onClose} title="Add job mapping" idPrefix="t">
        <Harness />
      </Dialog>,
    );
    await user.click(trigger());
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape', isComposing: true });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
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

  it('while busy saving a choice, keeps the trigger focusable and says so, but opens nothing and picks nothing', async () => {
    // A disabled button drops keyboard focus to the page body (WCAG 2.4.3):
    // `busy` is for a picker that saves the choice just made in it.
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <Combobox id="x" aria-label="Stage" value="1" onChange={onChange} options={OPTIONS} placeholder="p" searchLabel="Search" listLabel="List" busy />,
    );
    const button = screen.getByRole('button', { name: 'Stage Sales Program Advisor' });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    button.focus();
    await user.click(button);
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    await user.keyboard('{ArrowDown}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    // Done saving: the same control, still focused, works again.
    rerender(<Combobox id="x" aria-label="Stage" value="1" onChange={onChange} options={OPTIONS} placeholder="p" searchLabel="Search" listLabel="List" />);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(button).not.toHaveAttribute('aria-busy');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});

describe('Combobox in a ruled row', () => {
  const picker = (compact: boolean) => (
    <Combobox id="row" aria-label="Screening" compact={compact} value="1" onChange={() => {}} options={OPTIONS} placeholder="Choose" searchLabel="Search" listLabel="Sessions" />
  );

  it('keeps the trigger to one line, and the description in the list', async () => {
    render(picker(true));
    const trigger = screen.getByRole('button', { name: /^Screening/ });
    expect(trigger).toHaveTextContent('Sales Program Advisor');
    expect(trigger).not.toHaveTextContent('Opened 1 Aug 2026');
    expect(trigger.className).toContain('min-h-6');
    await userEvent.click(trigger);
    expect(within(screen.getByRole('listbox')).getByRole('option', { name: /Sales Program Advisor/ })).toHaveTextContent('Opened 1 Aug 2026');
  });

  it('stays a full touch target on a phone', () => {
    render(picker(true));
    expect(screen.getByRole('button', { name: /^Screening/ }).className).toContain('[@media(pointer:coarse)]:min-h-11');
  });

  it('leaves every other trigger as it was', () => {
    render(picker(false));
    const trigger = screen.getByRole('button', { name: /^Screening/ });
    expect(trigger).toHaveTextContent('Opened 1 Aug 2026');
    expect(trigger.className).toContain('min-h-10');
  });
});

describe('Combobox on a toolbar or in a short list', () => {
  const SHORT: ComboboxOption[] = [
    { value: 'viewer', label: 'Viewer' },
    { value: 'interviewer', label: 'Interviewer' },
    { value: 'admin', label: 'Admin' },
  ];

  it('takes its name from aria-label, and keeps the value in it, where no label is printed', () => {
    render(
      <Combobox
        id="row-role"
        aria-label="Role for a.person@example.com"
        value="admin"
        onChange={() => {}}
        options={SHORT}
        placeholder="Role"
        searchLabel="Search roles"
        listLabel="Roles"
      />,
    );
    expect(screen.getByRole('button', { name: /^Role for a\.person@example\.com/ })).toHaveAccessibleName(
      'Role for a.person@example.com Admin',
    );
  });

  it('a short list hides the search box, and the keyboard contract still holds', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Combobox
        id="short"
        aria-label="Role"
        searchable={false}
        value="viewer"
        onChange={onChange}
        options={SHORT}
        placeholder="Role"
        searchLabel="Roles"
        listLabel="Roles"
      />,
    );
    const button = screen.getByRole('button', { name: /^Role/ });
    await user.click(button);
    const field = screen.getByRole('combobox', { name: 'Roles' });
    expect(field).toHaveFocus();
    // Off the screen, not gone: focus and `aria-activedescendant` still live on it.
    expect(field).toHaveClass('sr-only');
    expect(field).toHaveAttribute('readonly');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('interviewer');
    expect(button).toHaveFocus();
  });

  describe('what a native select did, on a short list', () => {
    const THREE = [
      { value: 'viewer', label: 'Viewer' },
      { value: 'interviewer', label: 'Interviewer' },
      { value: 'admin', label: 'Admin' },
      { value: 'intern', label: 'Intern', disabled: true },
      { value: 'inspector', label: 'Inspector' },
    ];

    function Short({ onChange, searchable = false }: { onChange: (value: string) => void; searchable?: boolean }) {
      return (
        <Combobox
          id="native"
          aria-label="Role"
          searchable={searchable}
          value="viewer"
          onChange={onChange}
          options={THREE}
          placeholder="Role"
          searchLabel="Roles"
          listLabel="Roles"
        />
      );
    }

    it('Space picks the active option', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Short onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: /^Role/ }));
      await user.keyboard('{ArrowDown} ');
      expect(onChange).toHaveBeenCalledWith('interviewer');
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    });

    it('a letter moves to the next option starting with it, past a disabled one, and wraps', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Short onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: /^Role/ }));
      await user.keyboard('i{Enter}');
      expect(onChange).toHaveBeenLastCalledWith('interviewer');
      await user.click(screen.getByRole('button', { name: /^Role/ }));
      await user.keyboard('ii{Enter}');
      expect(onChange).toHaveBeenLastCalledWith('inspector');
      await user.click(screen.getByRole('button', { name: /^Role/ }));
      await user.keyboard('iii{Enter}');
      expect(onChange).toHaveBeenLastCalledWith('interviewer');
    });

    it('a letter nothing starts with leaves the active option where it was', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Short onChange={onChange} />);
      await user.click(screen.getByRole('button', { name: /^Role/ }));
      await user.keyboard('z{Enter}');
      expect(onChange).toHaveBeenCalledWith('viewer');
    });

    it('with a search box, Space and letters are still typing', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(<Short onChange={onChange} searchable />);
      await user.click(screen.getByRole('button', { name: /^Role/ }));
      await user.keyboard('i n');
      expect(screen.getByRole('combobox', { name: 'Roles' })).toHaveValue('i n');
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('searches keywords and never prints them', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        id="kw"
        aria-label="Candidate"
        value=""
        onChange={() => {}}
        options={[
          { value: '1', label: 'Asha', keywords: 'asha@example.com' },
          { value: '2', label: 'Dev', keywords: 'dev@example.com' },
        ]}
        placeholder="Candidate"
        searchLabel="Search"
        listLabel="Candidates"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Candidate/ }));
    expect(document.body.textContent).not.toContain('example.com');
    await user.keyboard('dev@');
    expect(screen.getByRole('option', { name: /Dev/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Asha/ })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('example.com');
  });

  it('floats over the page on a toolbar, so opening it moves nothing', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        id="float"
        aria-label="Role"
        floating
        value=""
        onChange={() => {}}
        options={SHORT}
        placeholder="All roles"
        searchLabel="Search roles"
        listLabel="Roles"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Role/ }));
    const panel = screen.getByRole('listbox', { name: 'Roles' }).closest('.combobox-panel');
    expect(panel).toHaveClass('absolute');
    expect(panel).toHaveClass('top-full');
  });

  it('floats upward at the foot of a page', async () => {
    const user = userEvent.setup();
    render(
      <Combobox
        id="float-up"
        aria-label="Rows"
        floating="up"
        value="10"
        onChange={() => {}}
        options={[{ value: '10', label: '10' }, { value: '25', label: '25' }]}
        placeholder="Rows"
        searchLabel="Rows"
        listLabel="Rows"
      />,
    );
    await user.click(screen.getByRole('button', { name: /^Rows/ }));
    expect(screen.getByRole('listbox', { name: 'Rows' }).closest('.combobox-panel')).toHaveClass('bottom-full');
  });

  it('sets the control height the rest of the form uses', () => {
    const { rerender } = render(
      <Combobox id="h" aria-label="Role" size="md" value="" onChange={() => {}} options={SHORT} placeholder="Role" searchLabel="s" listLabel="l" />,
    );
    expect(screen.getByRole('button', { name: /^Role/ })).toHaveClass('min-h-9');
    rerender(
      <Combobox id="h" aria-label="Role" size="sm" value="" onChange={() => {}} options={SHORT} placeholder="Role" searchLabel="s" listLabel="l" />,
    );
    expect(screen.getByRole('button', { name: /^Role/ })).toHaveClass('min-h-7');
  });
});

describe('pickOption, the helper page tests drive the picker with', () => {
  it('opens the picker named by the label and chooses by the option name', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await pickOption(user, /Ashby job/, 'Career Coach');
    expect(onChange).toHaveBeenCalledWith('2');
  });
});