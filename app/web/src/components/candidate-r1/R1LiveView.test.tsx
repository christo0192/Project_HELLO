import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocalVideoTrack } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('shows, in the briefing, who the candidate is calling, why, and the three course facts', () => {
    renderLive({ leadVisible: true, phase: 'transition' });
    const card = screen.getByRole('region', { name: 'Your role-play' });
    expect(within(card).getByText('Meera Iyer')).toBeVisible();
    expect(card).toHaveTextContent('Data Science course');
    expect(card).toHaveTextContent('Program Advisor');
    expect(card).toHaveTextContent('$9,000');
    expect(card).toHaveTextContent('6 months');
    expect(card).toHaveTextContent('$500, $1,000 or $1,500, depending on the payment plan');
    expect(card).not.toHaveClass('r1-scenario--compact');
  });

  it('degrades to a generic card when the interviewer has not published a name', () => {
    renderLive({ leadVisible: true, leadName: null, phase: 'transition' });
    expect(screen.getByText('A prospective learner')).toBeVisible();
    // The facts are static, so they do not wait for the name.
    expect(screen.getByRole('region', { name: 'Your role-play' })).toHaveTextContent('$9,000');
  });

  it('states the advisor goal and keeps the in-character line in the briefing', () => {
    renderLive({ leadVisible: true, phase: 'transition' });
    const card = screen.getByRole('region', { name: 'Your role-play' });
    expect(card).toHaveTextContent('understand their needs');
    expect(card).toHaveTextContent('agree a clear next step');
    expect(card).toHaveTextContent('stays in character');
  });

  // The role-play is where the captions are read: a full card would take a third of a laptop's
  // column (276 of 700 px), so after the briefing it shrinks to the name and the three facts.
  it.each(['roleplay', 'aside'] as const)(
    'shrinks to a facts strip in the %s: the name and the three facts, nothing else',
    (phase) => {
      renderLive({ leadVisible: true, phase });
      const card = screen.getByRole('region', { name: 'Your role-play' });
      expect(card).toHaveClass('r1-scenario--compact');
      expect(within(card).getByText('Meera Iyer')).toBeVisible();
      expect(card).toHaveTextContent('$9,000');
      expect(card).toHaveTextContent('6 months');
      expect(card).toHaveTextContent('$500, $1,000 or $1,500, depending on the payment plan');
      expect(card).not.toHaveTextContent('understand their needs');
      expect(card).not.toHaveTextContent('stays in character');
      expect(card).not.toHaveTextContent('Filled in a form');
    },
  );

  it('grows back to the full card when the interviewer returns to the briefing', () => {
    const { rerender, props } = renderLive({ leadVisible: true, phase: 'roleplay' });
    expect(screen.getByRole('region', { name: 'Your role-play' })).toHaveClass('r1-scenario--compact');
    rerender(<R1LiveView {...props} leadVisible phase="transition" />);
    expect(screen.getByRole('region', { name: 'Your role-play' })).not.toHaveClass(
      'r1-scenario--compact',
    );
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

describe('keyboard focus when the view changes under it', () => {
  const READY = { phase: 'transition' as const, awaitingReady: true, leadVisible: true };
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    scrollIntoView.mockClear();
    (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView = scrollIntoView;
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  const phasePanel = (container: HTMLElement) =>
    container.querySelector<HTMLElement>('.r1-phase') as HTMLElement;

  it('parks the focus on the phase panel when the ready button it was on goes away', async () => {
    const user = userEvent.setup();
    const onReady = vi.fn().mockResolvedValue(undefined);
    const { container, rerender, props } = renderLive({ ...READY, onReady });
    // Pressed from the keyboard: it has the focus, and keeps it while the request goes out.
    screen.getByRole('button', { name: "I'm ready" }).focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Sent — starting the role-play')).toBeVisible();
    expect(screen.getByRole('button', { name: "I'm ready" })).toHaveFocus();

    // The interviewer picks up the role-play: the button unmounts, and the focus must not fall to
    // the page (WCAG 2.4.3). It lands on the panel that announces the change.
    rerender(<R1LiveView {...props} phase="roleplay" awaitingReady={false} />);
    expect(screen.queryByRole('button', { name: "I'm ready" })).toBeNull();
    expect(phasePanel(container)).toHaveFocus();
    expect(document.body).not.toHaveFocus();
  });

  it('leaves the focus alone when the candidate was somewhere else', () => {
    const { container, rerender, props } = renderLive({ ...READY, onReady: vi.fn() });
    screen.getByRole('button', { name: 'Mute microphone' }).focus();
    rerender(<R1LiveView {...props} phase="roleplay" awaitingReady={false} />);
    expect(screen.getByRole('button', { name: 'Mute microphone' })).toHaveFocus();
    expect(phasePanel(container)).not.toHaveFocus();
  });

  it('does not take the focus when the button goes away unfocused (the candidate said "ready")', () => {
    const { container, rerender, props } = renderLive({ ...READY, onReady: vi.fn() });
    expect(document.body).toHaveFocus();
    rerender(<R1LiveView {...props} phase="roleplay" awaitingReady={false} />);
    expect(phasePanel(container)).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  it('can be focused by script but is not a Tab stop', () => {
    const { container } = renderLive();
    expect(phasePanel(container)).toHaveAttribute('tabindex', '-1');
  });

  it('brings the leave question into view and puts the keyboard on the safe choice', async () => {
    const user = userEvent.setup();
    renderLive();
    await user.click(screen.getByRole('button', { name: 'Leave interview' }));
    const group = screen.getByRole('group', { name: 'Leave the interview' });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(group);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(screen.getByRole('button', { name: 'Stay in the interview' })).toHaveFocus();

    // Closing it goes back to the button that opened it, not to the page.
    await user.click(screen.getByRole('button', { name: 'Stay in the interview' }));
    expect(screen.getByRole('button', { name: 'Leave interview' })).toHaveFocus();
  });

  it('does the same for the withdrawal question, which replaces the button that opened it', async () => {
    const user = userEvent.setup();
    renderLive({ onWithdraw: vi.fn() });
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    expect(scrollIntoView.mock.contexts).toContain(group);
    const keep = screen.getByRole('button', { name: 'Keep my consent' });
    expect(keep).toHaveFocus();
    // The question is read with the button: it is what the button is a choice about.
    expect(keep).toHaveAccessibleDescription(/ends your interview now and it cannot be rejoined/);

    await user.click(keep);
    expect(screen.getByRole('button', { name: 'Withdraw my consent' })).toHaveFocus();
  });

  it('brings a failed withdrawal into view', () => {
    const { rerender, props } = renderLive({ onWithdraw: vi.fn() });
    scrollIntoView.mockClear();
    rerender(
      <R1LiveView
        {...props}
        onWithdraw={vi.fn()}
        withdrawError="We could not record your withdrawal. Please try again."
      />,
    );
    expect(scrollIntoView.mock.contexts).toContain(screen.getByRole('alert'));
  });
});

describe('the aura and the camera', () => {
  it('puts the self-view beside the aura in one row that wraps, so it costs no height', () => {
    const { container } = renderLive();
    const row = container.querySelector('.r1-live__media') as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.children).toHaveLength(2);
    expect(row.children[0]).toHaveClass('candidate-aura');
    expect(row.children[1]).toHaveClass('r1-live__selfview');
    expect(within(row as HTMLElement).getByLabelText('Your camera')).toBeInTheDocument();
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
