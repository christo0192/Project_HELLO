/**
 * UI components accessibility tests.
 *
 * Covers: Button, Card, Input, Select, Textarea, Label, Chip,
 * LoadingState, ErrorState, EmptyState, PageHeader, Spinner
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import {
  Button,
  Card,
  Input,
  Select,
  Textarea,
  Label,
  Chip,
  Spinner,
  LoadingState,
  ErrorState,
  EmptyState,
  PageHeader,
} from './ui';

describe('Button', () => {
  it('renders with accessible name', () => {
    render(<Button>Submit</Button>);
    const btn = screen.getByRole('button', { name: 'Submit' });
    expect(btn).toBeInTheDocument();
  });

  it('supports disabled state', () => {
    render(<Button disabled>Disabled</Button>);
    const btn = screen.getByRole('button', { name: 'Disabled' });
    expect(btn).toBeDisabled();
  });

  it('shows loading spinner and disables when loading', () => {
    render(<Button loading>Saving</Button>);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    // Spinner should be rendered as a status indicator
    const spinner = document.querySelector('[role="status"][aria-label="Loading"]');
    expect(spinner).toBeInTheDocument();
  });

  it('supports click handler', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Click' }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('activates on Enter key', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Enter me</Button>);
    const btn = screen.getByRole('button', { name: 'Enter me' });
    btn.focus();
    await userEvent.keyboard('{Enter}');
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('activates on Space key', async () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Space me</Button>);
    const btn = screen.getByRole('button', { name: 'Space me' });
    btn.focus();
    await userEvent.keyboard('{ }');
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        <Button>Primary</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="danger">Danger</Button>
      </div>,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('Card', () => {
  it('renders children', () => {
    render(<Card><p>Content</p></Card>);
    expect(screen.getByText('Content')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <Card>
        <h2>Card title</h2>
        <p>Card content here.</p>
      </Card>,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('Input', () => {
  it('renders with placeholder', () => {
    render(<Input placeholder="Enter name" />);
    const input = screen.getByPlaceholderText('Enter name');
    expect(input).toBeInTheDocument();
  });

  it('supports disabled state', () => {
    render(<Input disabled />);
    expect(screen.getByRole('textbox')).toBeDisabled();
  });

  it('has no axe violations when labelled', async () => {
    const { container } = render(
      <div>
        <label htmlFor="test-input">Test</label>
        <Input id="test-input" />
      </div>,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('Select', () => {
  it('renders options', () => {
    render(
      <Select aria-label="Choose option">
        <option value="">All</option>
        <option value="a">Option A</option>
      </Select>,
    );
    const select = screen.getByRole('combobox', { name: 'Choose option' });
    expect(select).toBeInTheDocument();
  });

  it('has no axe violations when labelled', async () => {
    const { container } = render(
      <div>
        <label htmlFor="test-select">Filter</label>
        <Select id="test-select">
          <option value="">All</option>
        </Select>
      </div>,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('Textarea', () => {
  it('renders with placeholder', () => {
    render(<Textarea placeholder="Write here" />);
    expect(screen.getByPlaceholderText('Write here')).toBeInTheDocument();
  });
});

describe('Label', () => {
  it('renders with htmlFor', () => {
    render(
      <>
        <Label htmlFor="name">Name</Label>
        <Input id="name" />
      </>,
    );
    expect(screen.getByText('Name')).toBeInTheDocument();
  });
});

describe('Chip', () => {
  it('renders text', () => {
    render(<Chip>Active</Chip>);
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <div>
        <Chip>Default</Chip>
        <Chip tone="green">Green</Chip>
        <Chip tone="amber">Amber</Chip>
        <Chip tone="red">Red</Chip>
        <Chip tone="accent">Accent</Chip>
      </div>,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('Spinner', () => {
  it('has role="status" and aria-label="Loading"', () => {
    render(<Spinner />);
    const spinner = screen.getByRole('status');
    expect(spinner).toHaveAttribute('aria-label', 'Loading');
  });
});

describe('LoadingState', () => {
  it('renders loading text and spinner', () => {
    render(<LoadingState label="Fetching data…" />);
    expect(screen.getByText('Fetching data…')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(<LoadingState label="Loading…" />);
    await expect(container).toHaveNoViolations();
  });
});

describe('ErrorState', () => {
  it('renders error message', () => {
    render(<ErrorState message="Something went wrong." />);
    expect(screen.getByText('Something went wrong.')).toBeInTheDocument();
  });

  it('renders retry button when onRetry provided', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Error" onRetry={onRetry} />);
    const btn = screen.getByRole('button', { name: 'Try again' });
    expect(btn).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <ErrorState message="An error occurred." onRetry={() => {}} />,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('EmptyState', () => {
  it('renders title and hint', () => {
    render(<EmptyState title="No data" hint="Add some data to get started." />);
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(screen.getByText('Add some data to get started.')).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <EmptyState title="Nothing here" hint="Try a different filter." />,
    );
    await expect(container).toHaveNoViolations();
  });
});

describe('PageHeader', () => {
  it('renders title and description', () => {
    render(
      <PageHeader
        title="Dashboard"
        description="Overview of everything."
        action={<button>Action</button>}
      />,
    );
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Overview of everything.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { container } = render(
      <PageHeader title="Page title" description="Page description." />,
    );
    await expect(container).toHaveNoViolations();
  });
});
