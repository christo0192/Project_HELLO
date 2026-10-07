import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { R1Landing } from './R1Landing';
import { R1_CLOSED_COPY, R1_ENDED_COPY, type R1ClosedKind, type R1EndedKind } from './r1-copy';
import { R1ClosedCard, R1EndedCard, R1Shell } from './R1Screens';

const CLOSED_KINDS = Object.keys(R1_CLOSED_COPY) as R1ClosedKind[];

describe('R1ClosedCard', () => {
  it.each(CLOSED_KINDS)('explains the %s state with a heading and no controls', (kind) => {
    render(<R1ClosedCard kind={kind} />);
    const title = R1_CLOSED_COPY[kind].title;
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('announces only the states the candidate must act on as alerts', () => {
    const { rerender } = render(<R1ClosedCard kind="invalid" />);
    expect(screen.getByRole('alert')).toBeVisible();
    rerender(<R1ClosedCard kind="unsupported" />);
    expect(screen.getByRole('alert')).toBeVisible();
    rerender(<R1ClosedCard kind="completed" />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers a retry for a temporary state', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<R1ClosedCard kind="paused" onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('tells a declining candidate that a person will follow up', () => {
    render(<R1ClosedCard kind="declined" />);
    expect(screen.getByText(/conversation with a person instead/)).toBeVisible();
  });

  it('keeps the link valid on a temporary outage', () => {
    render(<R1ClosedCard kind="unavailable" />);
    expect(screen.getByText(/Your link stays valid/)).toBeVisible();
  });
});

describe('R1EndedCard', () => {
  const kinds = Object.keys(R1_ENDED_COPY) as R1EndedKind[];
  const REJOINABLE: R1EndedKind[] = ['left', 'disconnected'];
  const FINAL: R1EndedKind[] = ['agent_ended', 'aborted'];

  it('covers every ending the room can report', () => {
    expect([...kinds].sort()).toEqual(['aborted', 'agent_ended', 'disconnected', 'left']);
  });

  it.each(kinds)('renders a heading for %s', (kind) => {
    render(<R1EndedCard kind={kind} />);
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
  });

  it.each(REJOINABLE)('offers a Rejoin interview button after %s, and it rejoins', async (kind) => {
    const user = userEvent.setup();
    const onRejoin = vi.fn();
    render(<R1EndedCard kind={kind} onRejoin={onRejoin} />);
    await user.click(screen.getByRole('button', { name: 'Rejoin interview' }));
    expect(onRejoin).toHaveBeenCalledTimes(1);
  });

  it.each(FINAL)('never offers a rejoin after %s, even if one is wired', (kind) => {
    render(<R1EndedCard kind={kind} onRejoin={vi.fn()} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/rejoin/i)).toBeNull();
  });

  it('shows no rejoin button when nothing can rejoin', () => {
    render(<R1EndedCard kind="left" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each(REJOINABLE)('tells the candidate to select Rejoin and keep the tab open (%s)', (kind) => {
    render(<R1EndedCard kind={kind} onRejoin={vi.fn()} />);
    const keepOpen = /select Rejoin within 90 seconds and keep this tab open/;
    expect(screen.getByText(keepOpen)).toBeVisible();
  });

  it.each(kinds)('never tells the candidate to open the link again (%s)', (kind) => {
    const { container } = render(<R1EndedCard kind={kind} onRejoin={vi.fn()} />);
    expect(container.textContent).not.toMatch(/open your link|link again|reopen|your link/i);
  });

  it.each(['agent_ended', 'left', 'disconnected'] as const)(
    'explains how to contest the result without a dead /appeal link (%s)',
    (kind) => {
      const { container } = render(<R1EndedCard kind={kind} onRejoin={vi.fn()} />);
      const contest = /To contest the result, reply to the hiring team.s email/;
      expect(screen.getByText(contest)).toBeVisible();
      expect(screen.getByText(/they will send you an appeal link/)).toBeVisible();
      expect(screen.queryByRole('link')).toBeNull();
      expect(container.querySelector('a[href]')).toBeNull();
      expect(container.innerHTML).not.toContain('/appeal');
    },
  );

  it('tells a candidate whose interview was stopped by a fault that it does not count', () => {
    const { container } = render(<R1EndedCard kind="aborted" />);
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Your interview was stopped because of a technical problem.',
      }),
    ).toBeVisible();
    expect(screen.getByText(/will not count against you/)).toBeVisible();
    expect(screen.getByText(/will send you a new link/)).toBeVisible();
    expect(container.textContent).not.toMatch(/contest|appeal|evaluate|review it/i);
    expect(screen.queryByText(/Your interview is complete/)).toBeNull();
  });
});

describe('R1Shell', () => {
  it('wraps content in the candidate palette scope under a branded header', () => {
    const { container } = render(
      <R1Shell>
        <p>inside</p>
      </R1Shell>,
    );
    expect(container.querySelector('main.candidate-scope')).not.toBeNull();
    expect(screen.getByRole('banner', { name: 'Interview Kickstart' })).toBeVisible();
    expect(screen.getByText('inside')).toBeVisible();
  });
});

describe('R1Landing', () => {
  function renderLanding(overrides: Partial<Parameters<typeof R1Landing>[0]> = {}) {
    const props = {
      roleTitle: 'Sales Program Advisor',
      pills: ['About 20 minutes', 'Camera and microphone on'],
      attemptsLeft: 2,
      error: null,
      busy: false,
      onContinue: vi.fn(),
      onWithdraw: vi.fn(),
      ...overrides,
    };
    return { ...render(<R1Landing {...props} />), props };
  }

  it('describes the format and starts the device check', async () => {
    const user = userEvent.setup();
    const { props } = renderLanding();
    expect(screen.getByRole('heading', { level: 1, name: 'Video interview' })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Sales Program Advisor' })).toBeVisible();
    expect(screen.getByText('About 20 minutes')).toBeVisible();
    expect(screen.getByText('You have 2 attempts left.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    expect(props.onContinue).toHaveBeenCalledTimes(1);
  });

  it('uses the singular for one attempt', () => {
    renderLanding({ attemptsLeft: 1 });
    expect(screen.getByText('You have 1 attempt left.')).toBeVisible();
  });

  it('requires a confirmation before withdrawing consent', async () => {
    const user = userEvent.setup();
    const { props } = renderLanding();
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    expect(props.onWithdraw).not.toHaveBeenCalled();
    expect(screen.getByText(/cannot go ahead without it/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Keep my consent' }));
    expect(screen.queryByText(/cannot go ahead without it/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    await user.click(within(group).getByRole('button', { name: 'Withdraw my consent' }));
    expect(props.onWithdraw).toHaveBeenCalledTimes(1);
  });

  it('announces a join failure and keeps the link usable', () => {
    renderLanding({ error: 'Another interview is finishing. Please try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('Another interview is finishing');
    expect(screen.getByRole('button', { name: 'Check my camera and microphone' })).toBeEnabled();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderLanding({ error: 'Something failed' });
    await expect(container).toHaveNoViolations();
  });
});
