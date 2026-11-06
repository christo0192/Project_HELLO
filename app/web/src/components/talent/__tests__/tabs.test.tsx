/**
 * Accessible keyboard tabs (ARIA tabs pattern): focus + selection semantics,
 * roving tabindex, arrow/Home/End navigation, hidden inactive panels, and
 * axe compliance.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Tabs } from '../Tabs';

const items = [
  { id: 'overview', label: 'Overview', panel: <p>Overview content</p> },
  { id: 'sessions', label: 'Sessions', panel: <p>Sessions content</p> },
  { id: 'recordings', label: 'Recordings', panel: <p>Recordings content</p> },
];

function renderTabs(defaultIndex?: number) {
  return render(
    <Tabs items={items} ariaLabel="Candidate sections" defaultIndex={defaultIndex} />,
  );
}

describe('Tabs', () => {
  it('renders a tablist with tab buttons and tab panels', () => {
    renderTabs();
    const tablist = screen.getByRole('tablist', { name: 'Candidate sections' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('selects the first tab by default and hides inactive panels', () => {
    renderTabs();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const overviewPanel = screen.getByRole('tabpanel', { name: 'Overview' });
    expect(overviewPanel).not.toHaveAttribute('hidden');
    // The hidden panel is referenced by aria-controls (its accessible name
    // resolves only while visible — query it by id instead).
    const sessionsTab = screen.getByRole('tab', { name: 'Sessions' });
    const sessionsPanel = document.getElementById(
      sessionsTab.getAttribute('aria-controls') as string,
    );
    expect(sessionsPanel).toHaveAttribute('hidden');
    // Text inside hidden panels is still mounted (state preserved).
    expect(screen.getByText('Sessions content')).toBeInTheDocument();
  });

  it('wires aria-controls / aria-labelledby pairs', () => {
    renderTabs();
    const tab = screen.getByRole('tab', { name: 'Overview' });
    const panel = screen.getByRole('tabpanel', { name: 'Overview' });
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(tab).toHaveAttribute('aria-controls', panel.id);
  });

  it('activates and focuses the next tab on ArrowRight with wrap-around', async () => {
    const user = userEvent.setup();
    renderTabs();
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    await user.keyboard('{ArrowRight}');
    const sessions = screen.getByRole('tab', { name: 'Sessions' });
    expect(sessions).toHaveFocus();
    expect(sessions).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Sessions' })).not.toHaveAttribute(
      'hidden',
    );
    // Wrap from the last tab back to the first.
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
  });

  it('moves to the previous tab on ArrowLeft', async () => {
    const user = userEvent.setup();
    renderTabs(2); // start on Recordings
    const recordings = screen.getByRole('tab', { name: 'Recordings' });
    recordings.focus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('jumps to first/last tab on Home/End', async () => {
    const user = userEvent.setup();
    renderTabs(1); // start on Sessions
    const sessions = screen.getByRole('tab', { name: 'Sessions' });
    sessions.focus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Recordings' })).toHaveFocus();
  });

  it('keeps roving tabindex: only the selected tab is in the tab order', () => {
    renderTabs();
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[2]).toHaveAttribute('tabindex', '-1');
    fireEvent.click(tabs[1]);
    expect(tabs[1]).toHaveAttribute('tabindex', '0');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
  });

  it('is axe-clean', async () => {
    const { container } = renderTabs();
    await expect(container).toHaveNoViolations();
  });
});

describe('Tabs (controlled)', () => {
  it('reports a press through onTabClick, and not a move of the arrow keys', async () => {
    const user = userEvent.setup();
    const onTabClick = vi.fn();
    render(<Tabs items={items} ariaLabel="Candidate sections" onTabClick={onTabClick} />);
    await user.click(screen.getByRole('tab', { name: items[1].label }));
    expect(onTabClick).toHaveBeenCalledTimes(1);
    expect(onTabClick).toHaveBeenCalledWith(items[1].id);
    await user.keyboard('{ArrowRight}');
    expect(onTabClick).toHaveBeenCalledTimes(1);
  });

  it('follows selectedId and reports user selection through onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { rerender } = render(
      <Tabs items={items} ariaLabel="Candidate sections" selectedId="sessions" onSelect={onSelect} />,
    );
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');

    await user.click(screen.getByRole('tab', { name: 'Recordings' }));
    expect(onSelect).toHaveBeenCalledWith('recordings');

    // The host owns the selection: until it passes the new id, it stands.
    rerender(
      <Tabs items={items} ariaLabel="Candidate sections" selectedId="recordings" onSelect={onSelect} />,
    );
    expect(screen.getByRole('tab', { name: 'Recordings' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Recordings' })).not.toHaveAttribute('hidden');
  });

  it('falls back to its own state for an id that matches no tab', () => {
    render(<Tabs items={items} ariaLabel="Candidate sections" selectedId="nope" />);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('a disabled tab', () => {
  const withDisabled = [
    { id: 'overview', label: 'Overview', panel: <p>Overview content</p> },
    { id: 'recording', label: 'Recording', panel: <p>Recording content</p>, disabled: true },
    { id: 'resume', label: 'Resume', panel: <p>Resume content</p> },
  ];

  it('cannot be selected by a click', () => {
    const onSelect = vi.fn();
    render(<Tabs items={withDisabled} ariaLabel="Sections" onSelect={onSelect} />);
    const tab = screen.getByRole('tab', { name: 'Recording' });
    expect(tab).toBeDisabled();
    fireEvent.click(tab);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('is stepped over by the arrow keys, in both directions', () => {
    render(<Tabs items={withDisabled} ariaLabel="Sections" />);
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Resume' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Resume' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('is stepped over by Home and End', () => {
    const items = [withDisabled[1], withDisabled[0], { ...withDisabled[2], disabled: true }];
    render(<Tabs items={items} ariaLabel="Sections" defaultIndex={1} />);
    const overview = screen.getByRole('tab', { name: 'Overview' });
    fireEvent.keyDown(overview, { key: 'Home' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(overview, { key: 'End' });
    expect(overview).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Tabs inside a tighter box', () => {
  it('keeps the page spacing unless a host sets its own', () => {
    render(<Tabs items={items} ariaLabel="Sections" />);
    expect(screen.getByRole('tabpanel', { name: 'Overview' })).toHaveClass('pt-6');
  });

  it('takes the host\'s classes for the row and the panels', () => {
    render(<Tabs items={items} ariaLabel="Sections" listClassName="px-4" panelClassName="relative flex-1" />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toHaveClass('px-4');
    const panel = screen.getByRole('tabpanel', { name: 'Overview' });
    expect(panel).toHaveClass('relative', 'flex-1');
    expect(panel).not.toHaveClass('pt-6');
  });

  it('still hides an inactive panel: a host class must not put it back on screen', () => {
    const { container } = render(<Tabs items={items} ariaLabel="Sections" panelClassName="relative flex-1" />);
    const hidden = [...container.querySelectorAll('[role="tabpanel"]')].filter((panel) => panel.hasAttribute('hidden'));
    expect(hidden).toHaveLength(2);
  });
});
