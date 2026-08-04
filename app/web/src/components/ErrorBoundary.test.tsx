import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function BrokenRoute(): ReactElement {
  throw new Error('chunk failed');
}

describe('ErrorBoundary', () => {
  it('renders a safe retry fallback when routed content throws', () => {
    (globalThis as any).__allowConsole?.(/chunk failed|The above error occurred/);

    render(
      <ErrorBoundary resetKey="/mission-control">
        <BrokenRoute />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong loading this page.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('chunk failed')).not.toBeInTheDocument();
  });
});
