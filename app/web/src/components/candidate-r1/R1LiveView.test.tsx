import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocalVideoTrack } from 'livekit-client';
import { describe, expect, it, vi } from 'vitest';
import { R1_PHASES, R1_PHASE_LABELS, type R1Caption } from '../../lib/r1/r1-phase';
import { R1LiveView } from './R1LiveView';

function renderLive(overrides: Partial<Parameters<typeof R1LiveView>[0]> = {}) {
  const props = {
    roleTitle: 'Sales Program Advisor',
    phase: 'icebreaker' as const,
    agentPresent: true,
    leadVisible: false,
    lead: { name: 'Meera', city: 'Pune' },
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

describe('lead card', () => {
  it('is absent until the role-play is on screen', () => {
    renderLive({ leadVisible: false });
    expect(screen.queryByRole('heading', { name: 'Your role-play' })).toBeNull();
  });

  it('shows who the candidate is calling and why', () => {
    renderLive({ leadVisible: true, phase: 'roleplay' });
    const card = screen.getByRole('region', { name: 'Your role-play' });
    expect(within(card).getByText('Meera from Pune')).toBeVisible();
    expect(card).toHaveTextContent('Data Science course');
    expect(card).toHaveTextContent('Program Advisor');
    expect(card).toHaveTextContent('preparation guide');
  });

  it('degrades to a generic card when the server gave no lead', () => {
    renderLive({ leadVisible: true, lead: null });
    expect(screen.getByText('A prospective learner')).toBeVisible();
  });

  it('asserts no product facts of its own', () => {
    renderLive({ leadVisible: true });
    const card = screen.getByRole('region', { name: 'Your role-play' });
    expect(card.textContent).not.toMatch(/\$|\bprice\b|\bdiscount\b|\bmonths?\b|\bseats?\b/i);
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
  it('has no violations with the lead card, captions and banner showing', async () => {
    const { container } = renderLive({
      leadVisible: true,
      cameraOn: false,
      phase: 'roleplay',
      captions: [{ id: '1', text: 'Hello?', final: true, speaker: 'learner' }],
    });
    await expect(container).toHaveNoViolations();
  });
});
