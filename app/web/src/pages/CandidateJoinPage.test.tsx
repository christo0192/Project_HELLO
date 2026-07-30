import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateJoinPage } from './CandidateJoinPage';

const { exchangeCandidateInvite, connect, publishTrack, disconnect } = vi.hoisted(() => ({
  exchangeCandidateInvite: vi.fn(),
  connect: vi.fn(),
  publishTrack: vi.fn(),
  disconnect: vi.fn(),
}));

vi.mock('../api', () => ({
  api: { exchangeCandidateInvite },
  ApiError: class ApiError extends Error {},
}));

vi.mock('livekit-client', () => ({
  Room: class {
    localParticipant = { publishTrack };
    on = vi.fn();
    connect = connect;
    disconnect = disconnect;
  },
  RoomEvent: { TrackSubscribed: 'trackSubscribed', Disconnected: 'disconnected' },
  Track: { Kind: { Audio: 'audio' } },
  LocalAudioTrack: class {},
  createLocalAudioTrack: vi.fn().mockResolvedValue({ stop: vi.fn() }),
}));

describe('CandidateJoinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', '/candidate/join#synthetic-invite');
    exchangeCandidateInvite.mockResolvedValue({
      url: 'wss://livekit.example.invalid',
      livekit_token: 'synthetic-livekit-token',
    });
  });

  it('removes the invite fragment from browser history on mount', async () => {
    render(<CandidateJoinPage />);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
  });

  it('exchanges the captured invite once before joining LiveKit', async () => {
    render(<CandidateJoinPage />);
    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));
    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith('synthetic-invite'));
    expect(connect).toHaveBeenCalledWith(
      'wss://livekit.example.invalid',
      'synthetic-livekit-token',
    );
  });
});
