import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocalVideoTrack } from 'livekit-client';
import { describe, expect, it, vi } from 'vitest';
import {
  R1_PHASES,
  R1_PHASE_LABELS,
  R1_READY_DETAIL,
  type R1Caption,
  type R1Phase,
} from '../../lib/r1/r1-phase';
import { R1LiveView } from './R1LiveView';

function renderLive(overrides: Partial<Parameters<typeof R1LiveView>[0]> = {}) {
  const props = {
    roleTitle: 'Sales Program Advisor',
    phase: 'icebreaker' as R1Phase | null,
    agentPresent: true,
    leadVisible: false,
    leadName: 'Meera Iyer' as string | null,
    level: 0,
    captions: [] as R1Caption[],
    micMuted: false,
    cameraOn: true,
    video: null,
    error: null,
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    onLeave: vi.fn(),
    ...overrides,
  };
  const view = render(<R1LiveView {...props} />);
  return { ...view, props };
}

describe('phase label', () => {
  it('renders the fixed label for the current phase in a polite live region', () => {
    renderLive({ phase: 'roleplay' });
    const label = screen.getByRole('status', { name: '' });
    expect(label).toHaveAttribute('aria-live', 'polite');
    expect(label).toHaveAttribute('data-phase', 'roleplay');
    expect(within(label).getByText(R1_PHASE_LABELS.roleplay.label)).toBeVisible();
    expect(within(label).getByText(R1_PHASE_LABELS.roleplay.detail)).toBeVisible();
  });

  it('has a label for every phase and never echoes raw attribute text', () => {
    for (const phase of R1_PHASES) {
      const { unmount } = renderLive({ phase });
      expect(screen.getByText(R1_PHASE_LABELS[phase].label)).toBeInTheDocument();
      unmount();
    }
  });

  it('says it is connecting while no interviewer is in the room', () => {
    renderLive({ phase: null, agentPresent: false });
    expect(screen.getByText('Connecting')).toBeVisible();
    expect(screen.getByText('Waiting for your interviewer to join.')).toBeVisible();
    expect(screen.getByRole('status', { name: '' })).toHaveAttribute('data-phase', 'none');
  });

  it('does not claim to be waiting for an interviewer who is already in the room', () => {
    renderLive({ phase: null, agentPresent: true });
    expect(screen.getByText('Interview in progress')).toBeVisible();
    expect(screen.queryByText(/Waiting for your interviewer/)).toBeNull();
    expect(screen.queryByText('Connecting')).toBeNull();
    expect(screen.getByRole('status', { name: '' })).toHaveAttribute('data-phase', 'unannounced');
  });

  it('prefers the announced phase over presence', () => {
    renderLive({ phase: 'wrapup', agentPresent: true });
    expect(screen.getByText(R1_PHASE_LABELS.wrapup.label)).toBeVisible();
    expect(screen.queryByText('Interview in progress')).toBeNull();
  });
});

describe('scenario card', () => {
  it('is absent until the role-play is on screen', () => {
    renderLive({ leadVisible: false });
    expect(screen.queryByRole('heading', { name: 'Your role-play' })).toBeNull();
  });

  it('shows who the candidate is calling, why, and the three course facts', () => {
    renderLive({ leadVisible: true, phase: 'roleplay' });
    const card = screen.getByRole('region', { name: 'Your role-play' });
    expect(within(card).getByText('Meera Iyer')).toBeVisible();
    expect(card).toHaveTextContent('Data Science course');
    expect(card).toHaveTextContent('Program Advisor');
    expect(card).toHaveTextContent('$9,000');
    expect(card).toHaveTextContent('6 months');
    expect(card).toHaveTextContent('$500, $1,000 or $1,500, depending on the payment plan');
  });

  it('degrades to a generic card when the interviewer has not published a name', () => {
    renderLive({ leadVisible: true, leadName: null });
    expect(screen.getByText('A prospective learner')).toBeVisible();
    // The facts are static, so they do not wait for the name.
    expect(screen.getByRole('region', { name: 'Your role-play' })).toHaveTextContent('$9,000');
  });

  it('states the advisor goal and keeps the in-character line', () => {
    renderLive({ leadVisible: true });
    const card = screen.getByRole('region', { name: 'Your role-play' });
    expect(card).toHaveTextContent('understand their needs');
    expect(card).toHaveTextContent('agree a clear next step');
    expect(card).toHaveTextContent('stays in character');
  });
});

describe('role-play clock', () => {
  const clock = { seconds: 480, at: performance.now() };

  it('shows the minutes left beside the scenario card, outside the phase status region', () => {
    renderLive({ phase: 'roleplay', leadVisible: true, roleplayClock: clock });
    const timer = screen.getByRole('timer');
    expect(timer).toHaveTextContent('Role-play · 8 min left');
    expect(screen.getByRole('status', { name: '' })).not.toContainElement(timer);
    expect(timer.closest('[aria-live]')).toBeNull();
  });

  it('is hidden when the interviewer publishes no clock', () => {
    renderLive({ phase: 'roleplay', leadVisible: true, roleplayClock: null });
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('is hidden when the scenario card is, whatever the clock holds', () => {
    renderLive({ phase: 'roleplay_exit', leadVisible: false, roleplayClock: clock });
    expect(screen.queryByRole('timer')).toBeNull();
    renderLive({ phase: 'icebreaker', leadVisible: false, roleplayClock: clock });
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('holds its value outside the role-play itself', () => {
    const stale = { seconds: 480, at: performance.now() - 120_000 };
    renderLive({ phase: 'aside', leadVisible: true, roleplayClock: stale });
    // Two minutes have passed since it arrived, but the role-play was paused: still 8 minutes.
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 8 min left');
  });

  it('counts down while the role-play is on', () => {
    const running = { seconds: 480, at: performance.now() - 120_000 };
    renderLive({ phase: 'roleplay', leadVisible: true, roleplayClock: running });
    expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 6 min left');
  });
});

describe('"I\'m ready" button', () => {
  const READY = { phase: 'transition' as const, awaitingReady: true, leadVisible: true };

  it('is shown only in the briefing while the interviewer is waiting', () => {
    const onReady = vi.fn().mockResolvedValue(undefined);
    renderLive({ ...READY, onReady });
    expect(screen.getByRole('button', { name: "I'm ready" })).toBeVisible();
  });

  it.each(R1_PHASES.filter((phase) => phase !== 'transition'))(
    'is not shown in %s, even if the interviewer still says it is waiting',
    (phase) => {
      renderLive({ ...READY, phase, onReady: vi.fn() });
      expect(screen.queryByRole('button', { name: "I'm ready" })).toBeNull();
    },
  );

  it('is not shown when the interviewer is not waiting for it', () => {
    renderLive({ ...READY, awaitingReady: false, onReady: vi.fn() });
    expect(screen.queryByRole('button', { name: "I'm ready" })).toBeNull();
  });

  it('is not shown when the page wires no way to send it', () => {
    renderLive({ ...READY });
    expect(screen.queryByRole('button', { name: "I'm ready" })).toBeNull();
  });

  it('is not shown before the interviewer has announced a phase', () => {
    renderLive({ ...READY, phase: null, onReady: vi.fn() });
    expect(screen.queryByRole('button', { name: "I'm ready" })).toBeNull();
  });

  it('goes away when the interviewer moves on to the role-play', () => {
    const onReady = vi.fn().mockResolvedValue(undefined);
    const { rerender, props } = renderLive({ ...READY, onReady });
    expect(screen.getByRole('button', { name: "I'm ready" })).toBeVisible();
    rerender(<R1LiveView {...props} phase="roleplay" awaitingReady={false} />);
    expect(screen.queryByRole('button', { name: "I'm ready" })).toBeNull();
  });

  it('tells the phase region about it, so a screen reader hears it arrive', () => {
    const { rerender, props } = renderLive({ ...READY, awaitingReady: false, onReady: vi.fn() });
    const status = screen.getByRole('status', { name: '' });
    expect(status).toHaveTextContent(R1_PHASE_LABELS.transition.detail);
    rerender(<R1LiveView {...props} awaitingReady />);
    expect(status).toHaveTextContent(R1_READY_DETAIL);
    expect(R1_READY_DETAIL).toMatch(/say .*ready/);
  });

  it('sends once, locks while sending, and confirms', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onReady = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    renderLive({ ...READY, onReady });
    const button = screen.getByRole('button', { name: "I'm ready" });
    await user.click(button);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Sending…' })).toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(onReady).toHaveBeenCalledTimes(1);
    await act(async () => finish());
    expect(screen.getByText('Sent — starting the role-play')).toBeVisible();
    await user.click(screen.getByRole('button', { name: "I'm ready" }));
    expect(onReady).toHaveBeenCalledTimes(1);
  });
});

describe('camera banner', () => {
  it('appears only when the camera is off', () => {
    const { rerender, props } = renderLive({ cameraOn: false });
    expect(screen.getByText(/Your camera is off/)).toBeVisible();
    rerender(<R1LiveView {...props} cameraOn />);
    expect(screen.queryByText(/Your camera is off/)).toBeNull();
  });
});

describe('captions', () => {
  it('labels the learner and the interviewer differently and hides nothing', () => {
    renderLive({
      captions: [
        { id: '1', text: 'Tell me about yourself.', final: true, speaker: 'interviewer' },
        { id: '2', text: 'Hello? Yes, this is Meera.', final: true, speaker: 'learner' },
      ],
    });
    const region = screen.getByRole('region', { name: 'Live captions' });
    expect(within(region).getByText('Interviewer')).toBeVisible();
    expect(within(region).getByText('Learner (simulated by the AI)')).toBeVisible();
    expect(within(region).getByText('Hello? Yes, this is Meera.')).toBeVisible();
  });

  it('waits quietly before the first line', () => {
    renderLive();
    expect(screen.getByText('Listening for the interviewer…')).toBeVisible();
  });

  it('keeps a long interview in one focusable log inside the captions card', () => {
    const captions: R1Caption[] = Array.from({ length: 50 }, (_, index) => ({
      id: `c${index}`,
      text: `Line ${index} of the interview.`,
      final: true,
      speaker: 'interviewer',
    }));
    renderLive({ captions, leadVisible: true, phase: 'roleplay' });
    const region = screen.getByRole('region', { name: 'Live captions' });
    const log = within(region).getByRole('log', { name: 'Transcript' });
    expect(log).toHaveAttribute('tabindex', '0');
    expect(log.querySelectorAll('.candidate-caption')).toHaveLength(50);
    // The lead card sits above the captions card in the same column, not inside the log.
    expect(screen.getByRole('region', { name: 'Your role-play' })).not.toContainElement(log);
    expect(document.querySelectorAll('[role="log"]')).toHaveLength(1);
  });
});

describe('controls', () => {
  it('toggles the microphone and the camera with pressed state', async () => {
    const user = userEvent.setup();
    const { props, rerender } = renderLive();
    await user.click(screen.getByRole('button', { name: 'Mute microphone' }));
    await user.click(screen.getByRole('button', { name: 'Turn camera off' }));
    expect(props.onToggleMic).toHaveBeenCalledTimes(1);
    expect(props.onToggleCamera).toHaveBeenCalledTimes(1);

    rerender(<R1LiveView {...props} micMuted cameraOn={false} />);
    expect(screen.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Turn camera on' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('asks before leaving, and only leaves on confirmation', async () => {
    const user = userEvent.setup();
    const { props } = renderLive();
    await user.click(screen.getByRole('button', { name: 'Leave interview' }));
    expect(props.onLeave).not.toHaveBeenCalled();
    expect(screen.getByText(/rejoin within 90 seconds/)).toBeVisible();
    // The way back is a button on the next screen, never "open your link again".
    expect(screen.queryByText(/your link/i)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Stay in the interview' }));
    expect(screen.queryByText(/rejoin within 90 seconds/)).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Leave interview' }));
    await user.click(screen.getByRole('button', { name: 'Yes, leave' }));
    expect(props.onLeave).toHaveBeenCalledTimes(1);
  });

  it('announces a control failure', () => {
    renderLive({ error: 'We could not change your camera. Please try again.' });
    expect(screen.getByRole('alert')).toHaveTextContent('We could not change your camera');
  });
});

describe('withdrawing consent from the room', () => {
  it('offers nothing unless the page wires it up', () => {
    renderLive();
    expect(screen.queryByRole('button', { name: 'Withdraw my consent' })).toBeNull();
  });

  it('asks first, says it ends the interview for good, and only then withdraws', async () => {
    const user = userEvent.setup();
    const onWithdraw = vi.fn();
    const { props } = renderLive({ onWithdraw });
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    expect(onWithdraw).not.toHaveBeenCalled();
    expect(screen.getByText(/ends your interview now and it cannot be rejoined/)).toBeVisible();
    // It is not Leave: leaving stays rejoinable and is not touched.
    expect(props.onLeave).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Keep my consent' }));
    expect(onWithdraw).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    await user.click(within(group).getByRole('button', { name: 'Withdraw my consent' }));
    expect(onWithdraw).toHaveBeenCalledTimes(1);
    expect(props.onLeave).not.toHaveBeenCalled();
  });

  it('shows why a withdrawal failed, and disables the choice while it is being recorded', async () => {
    const user = userEvent.setup();
    const { rerender, props } = renderLive({
      onWithdraw: vi.fn(),
      withdrawError: 'We could not record your withdrawal. Please try again.',
    });
    expect(screen.getByRole('alert')).toHaveTextContent('could not record your withdrawal');
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    rerender(<R1LiveView {...props} onWithdraw={vi.fn()} withdrawBusy />);
    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    expect(within(group).getByRole('button', { name: 'Withdraw my consent' })).toBeDisabled();
  });

  it('has no accessibility violations with the confirmation open', async () => {
    const user = userEvent.setup();
    const { container } = renderLive({ onWithdraw: vi.fn() });
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    await expect(container).toHaveNoViolations();
  });
});

describe('self-view', () => {
  it('attaches the local camera to a muted inline video and detaches on unmount', () => {
    const video = { attach: vi.fn(), detach: vi.fn() } as unknown as LocalVideoTrack;
    const { unmount } = renderLive({ video });
    const element = screen.getByLabelText('Your camera');
    expect(element.tagName).toBe('VIDEO');
    expect((element as HTMLVideoElement).muted).toBe(true);
    expect(element).toHaveAttribute('playsinline');
    expect(video.attach).toHaveBeenCalledWith(element);
    unmount();
    expect(video.detach).toHaveBeenCalledWith(element);
  });
});

describe('accessibility', () => {
  it('has no violations with the scenario card, clock, captions and banner showing', async () => {
    const { container } = renderLive({
      leadVisible: true,
      cameraOn: false,
      phase: 'roleplay',
      roleplayClock: { seconds: 300, at: performance.now() },
      captions: [{ id: '1', text: 'Hello?', final: true, speaker: 'learner' }],
    });
    await expect(container).toHaveNoViolations();
  });

  it('has no violations in the briefing, with the ready button waiting', async () => {
    const { container } = renderLive({
      leadVisible: true,
      phase: 'transition',
      awaitingReady: true,
      onReady: vi.fn().mockResolvedValue(undefined),
    });
    await expect(container).toHaveNoViolations();
  });

  it('has no violations after the ready button failed and its alert shows', async () => {
    const user = userEvent.setup();
    const { container } = renderLive({
      leadVisible: true,
      phase: 'transition',
      awaitingReady: true,
      onReady: vi.fn().mockRejectedValue(new Error('refused')),
    });
    await user.click(screen.getByRole('button', { name: "I'm ready" }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't send that. Just say “I'm ready”.",
    );
    await expect(container).toHaveNoViolations();
  });
});
