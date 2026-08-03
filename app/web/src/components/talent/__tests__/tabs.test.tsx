/**
 * Accessible keyboard tabs (ARIA tabs pattern): focus + selection semantics,
 * roving tabindex, arrow/Home/End navigation, hidden inactive panels, and
 * axe compliance.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
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
