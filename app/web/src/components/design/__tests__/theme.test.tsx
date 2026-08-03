/**
 * ThemeProvider: class strategy, system mode, persistence, live OS following.
 */
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Component, type ReactNode } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ThemeProvider,
  useTheme,
  THEME_STORAGE_KEY,
} from '../../../lib/theme';
import { stubMatchMedia } from './helpers';

function ThemeProbe() {
  const { theme, mode } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <span data-testid="mode">{mode}</span>
    </div>
  );
}

function ToggleButton() {
  const { toggle } = useTheme();
  return (
    <button type="button" onClick={toggle}>
      toggle
    </button>
  );
}

function ModeButtons() {
  const { setMode } = useTheme();
  return (
    <>
      <button type="button" onClick={() => setMode('light')}>
        light
      </button>
      <button type="button" onClick={() => setMode('dark')}>
        dark
      </button>
      <button type="button" onClick={() => setMode('system')}>
        system
      </button>
    </>
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.classList.remove('dark');
    document.documentElement.style.colorScheme = '';
  });

  it('resolves system preference and applies the .dark class', () => {
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('mode')).toHaveTextContent('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('resolves to light when OS prefers light', () => {
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('reads a persisted explicit mode from localStorage', () => {
    stubMatchMedia(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('persists setMode and applies the class', async () => {
    const user = userEvent.setup();
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <ThemeProbe />
        <ToggleButton />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('setMode persists explicit choices and can return to system', async () => {
    const user = userEvent.setup();
    stubMatchMedia(false);
    render(
      <ThemeProvider>
        <ThemeProbe />
        <ModeButtons />
      </ThemeProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'dark' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');

    await user.click(screen.getByRole('button', { name: 'system' }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('system');
    // System mode with light OS preference → light.
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('follows OS preference changes in system mode', () => {
    const stub = stubMatchMedia(false);
    render(
      <ThemeProvider>
        <ThemeProbe />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    act(() => {
      stub.setMatches(true);
    });
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('toggle flips dark → light', async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    render(
      <ThemeProvider>
        <ThemeProbe />
        <ToggleButton />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('theme')).toHaveTextContent('dark');
    await user.click(screen.getByRole('button', { name: 'toggle' }));
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('useTheme throws outside ThemeProvider', () => {
    (globalThis as any).__allowConsole(/occurred in the <.*> component/);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    class Boundary extends Component<{ children: ReactNode }, { error: string | null }> {
      state: { error: string | null } = { error: null };
      static getDerivedStateFromError(error: Error) {
        return { error: error.message };
      }
      render() {
        if (this.state.error) return <div>{this.state.error}</div>;
        return this.props.children;
      }
    }
    render(
      <Boundary>
        <ThemeProbe />
      </Boundary>,
    );
    expect(document.body.textContent).toContain('useTheme must be used within <ThemeProvider>');
    spy.mockRestore();
  });
});
