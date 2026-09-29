/**
 * Navigation primitives tests (integration lane).
 *
 * - SkipLink: sr-only until focused, targets #main-content
 * - NavLinkItem: link, icon, active state (aria-current) + onNavigate
 * - NavGroup: labelled group for sectioned navigation
 * - Brand: logo plate + wordmark, never inverted
 * - IntegrationIcon (Ashby Mission Control): same SVG contract as its siblings
 *   (Layout.test.tsx covers where the link sits and who sees it)
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { Brand, NavGroup, NavLinkItem, SkipLink } from '../index';
import { DashboardIcon, IntegrationIcon, ShieldIcon } from '../icons';

describe('SkipLink', () => {
  it('targets #main-content and is sr-only until focused', () => {
    render(<SkipLink />);
    const link = screen.getByRole('link', { name: 'Skip to main content' });
    expect(link).toHaveAttribute('href', '#main-content');
    expect(link.className).toContain('sr-only');
    expect(link.className).toContain('focus:not-sr-only');
  });
});

describe('Brand', () => {
  it('renders the IK logo on a neutral plate with the HELLO wordmark', () => {
    render(<Brand />);
    const img = document.querySelector('img[src="/ik-logo.png"]');
    expect(img).toBeInTheDocument();
    expect(img?.getAttribute('class')).not.toMatch(/invert/i);
    expect(screen.getByText('HELLO')).toBeInTheDocument();
    expect(screen.getByText(/Talent Workspace & Mission Control/i)).toBeInTheDocument();
  });
});

describe('NavGroup', () => {
  it('renders a labelled group', () => {
    render(
      <NavGroup label="Operations">
        <span>child</span>
      </NavGroup>,
    );
    const group = screen.getByRole('group', { name: 'Operations' });
    expect(group).toContainElement(screen.getByText('child'));
  });
});

describe('NavLinkItem', () => {
  function renderItem(path = '/dashboard') {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <nav>
          <NavLinkItem
            to="/dashboard"
            label="Dashboard"
            end
            icon={<DashboardIcon className="h-4 w-4" />}
          />
          <NavLinkItem to="/candidates" label="Candidates" icon={<DashboardIcon className="h-4 w-4" />} />
        </nav>
      </MemoryRouter>,
    );
  }

  it('renders a link with its label and icon', () => {
    renderItem();
    const link = screen.getByRole('link', { name: 'Dashboard' });
    expect(link).toHaveAttribute('href', '/dashboard');
    expect(link.querySelector('svg')).toBeInTheDocument();
  });

  it('marks the active route with aria-current="page"', () => {
    renderItem();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Candidates' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('invokes onNavigate when clicked', async () => {
    const onNavigate = vi.fn();
    render(
      <MemoryRouter>
        <NavLinkItem
          to="/candidates"
          label="Candidates"
          icon={<DashboardIcon className="h-4 w-4" />}
          onNavigate={onNavigate}
        />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('link', { name: 'Candidates' }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});

describe('IntegrationIcon', () => {
  /** The presentational attributes every icon in the set shares. */
  const CONTRACT = [
    'viewBox',
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'aria-hidden',
    'focusable',
  ] as const;

  it('follows the icon set conventions exactly, attribute for attribute', () => {
    const { container } = render(
      <>
        <IntegrationIcon className="h-4 w-4" />
        <ShieldIcon className="h-4 w-4" />
      </>,
    );
    const [integration, shield] = Array.from(container.querySelectorAll('svg'));
    for (const attr of CONTRACT) {
      expect(integration.getAttribute(attr), attr).toBe(shield.getAttribute(attr));
    }
    // And the values themselves, so the comparison cannot pass by both
    // icons drifting together.
    expect(integration).toHaveAttribute('viewBox', '0 0 24 24');
    expect(integration).toHaveAttribute('stroke', 'currentColor');
    expect(integration).toHaveAttribute('stroke-width', '2');
    expect(integration).toHaveAttribute('aria-hidden', 'true');
    expect(integration).toHaveAttribute('class', 'h-4 w-4');
  });

  it('draws linked nodes: three nodes and two connectors', () => {
    const { container } = render(<IntegrationIcon />);
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(container.querySelectorAll('path')).toHaveLength(2);
  });
});
