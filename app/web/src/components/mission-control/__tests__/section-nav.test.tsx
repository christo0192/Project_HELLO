/**
 * MissionControlSections — keyboard subnav semantics, lazy keep-alive
 * mounting, mobile scroll surface, and axe compliance.
 */
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MissionControlSections } from '../SectionNav';

const renderFn = vi.fn(() => <p>Overview content</p>);
const renderFn2 = vi.fn(() => <p>Access content</p>);
const renderFn3 = vi.fn(() => <p>Sessions content</p>);

const sections = [
  { id: 'overview', label: 'Overview', render: renderFn },
  { id: 'access', label: 'Access', render: renderFn2 },
  { id: 'sessions', label: 'Sessions', render: renderFn3 },
];

function renderNav(defaultId?: string) {
  return render(
    <MissionControlSections
      sections={sections}
      ariaLabel="Mission Control sections"
      defaultId={defaultId}
    />,
  );
}

describe('MissionControlSections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a tablist with all tabs, tabpanel and placeholder panels for aria-controls targets', () => {
    renderNav();
    expect(
      screen.getByRole('tablist', { name: 'Mission Control sections' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    // Unvisited panels exist as hidden placeholders so aria-controls resolves.
    const accessTab = screen.getByRole('tab', { name: 'Access' });
    const accessPanel = document.getElementById(
      accessTab.getAttribute('aria-controls') as string,
    );
    expect(accessPanel).toHaveAttribute('hidden');
    expect(screen.queryByText('Access content')).not.toBeInTheDocument();
  });

  it('mounts only the default section initially (lazy data load)', () => {
    renderNav('access');
    expect(renderFn).not.toHaveBeenCalled();
    expect(renderFn2).toHaveBeenCalledTimes(1);
    expect(renderFn3).not.toHaveBeenCalled();
  });

  it('mounts a section on activation and keeps it alive when switching away', () => {
    renderNav();
    expect(renderFn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(renderFn2).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    // keep-alive: content already mounted, render() is NOT called again
    expect(renderFn).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(renderFn2).toHaveBeenCalledTimes(1);
  });

  it('moves selection AND focus with arrow keys, wrapping at the edges', () => {
    renderNav();
    const overview = screen.getByRole('tab', { name: 'Overview' });
    overview.focus();
    fireEvent.keyDown(overview, { key: 'ArrowRight' });
    const access = screen.getByRole('tab', { name: 'Access' });
    expect(access).toHaveAttribute('aria-selected', 'true');
    expect(access).toHaveFocus();
    fireEvent.keyDown(access, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // wrap right from last tab
    const sessions = screen.getByRole('tab', { name: 'Sessions' });
    fireEvent.click(sessions);
    fireEvent.keyDown(sessions, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveFocus();
  });

  it('supports Home and End navigation', () => {
    renderNav();
    const access = screen.getByRole('tab', { name: 'Access' });
    fireEvent.click(access);
    fireEvent.keyDown(access, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Sessions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Sessions' }), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('uses a roving tabindex — only the selected tab is in the tab order', () => {
    renderNav();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute('tabindex', '-1');
    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    expect(screen.getByRole('tab', { name: 'Access' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('tabindex', '-1');
  });

  it('exposes a horizontally scrollable tablist for narrow viewports', () => {
    const { container } = renderNav();
    const tablist = screen.getByRole('tablist', {
      name: 'Mission Control sections',
    });
    expect(tablist.className).toContain('overflow-x-auto');
    expect(container.querySelectorAll('[role="tab"]').length).toBe(3);
  });

  it('renders nothing when there are no sections', () => {
    const { container } = render(
      <MissionControlSections sections={[]} ariaLabel="empty" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('has no axe violations across all mounted states', async () => {
    const { container } = renderNav();
    fireEvent.click(screen.getByRole('tab', { name: 'Access' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Sessions' }));
    await expect(container).toHaveNoViolations();
  });
});
