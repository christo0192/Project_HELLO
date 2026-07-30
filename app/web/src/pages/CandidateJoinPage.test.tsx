import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
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

function renderPage(initialEntries?: string[]) {
  return render(
    <MemoryRouter initialEntries={initialEntries ?? ['/candidate/join']}>
      <CandidateJoinPage />
    </MemoryRouter>
  );
}

describe('CandidateJoinPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    exchangeCandidateInvite.mockResolvedValue({
      url: 'wss://livekit.example.invalid',
      livekit_token: 'synthetic-livekit-token',
    });
  });

  it('shows consent banner when consent status is unknown (GOV-03)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/You must review and accept/i)).toBeInTheDocument();
    });
    // No join button when consent is unknown
    expect(screen.queryByRole('button', { name: 'Join screening' })).not.toBeInTheDocument();
  });

  it('shows review privacy notice link when consent is unknown (GOV-03)', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /review privacy notice/i })).toBeInTheDocument();
    });
  });

  it('shows join button when consent is granted', async () => {
    renderPage(['/candidate/join?consent=true']);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
  });

  it('shows consent declined message when consent is declined (GOV-09)', async () => {
    renderPage(['/candidate/join?consent=declined']);
    await waitFor(() => {
      expect(screen.getByText(/Consent declined/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: 'Join screening' })).not.toBeInTheDocument();
  });

  it('refuses to join without consent evidence (GOV-09)', async () => {
    window.history.replaceState(null, '', '/candidate/join#synthetic-invite');
    renderPage(['/candidate/join#synthetic-invite']);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /review privacy notice/i })).toBeInTheDocument();
    });
    // No join button since consent is unknown
    expect(screen.queryByRole('button', { name: 'Join screening' })).not.toBeInTheDocument();
  });

  it('removes the invite fragment from browser history on mount', async () => {
    window.history.replaceState(null, '', '/candidate/join#synthetic-invite');
    renderPage(['/candidate/join#synthetic-invite']);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(screen.getByText(/You must review and accept/i)).toBeInTheDocument();
  });

  it('exchanges the captured invite once before joining LiveKit when consent granted', async () => {
    window.history.replaceState(null, '', '/candidate/join#synthetic-invite');
    renderPage(['/candidate/join?consent=true']);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));
    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith('synthetic-invite'));
    expect(connect).toHaveBeenCalledWith(
      'wss://livekit.example.invalid',
      'synthetic-livekit-token',
    );
  });
});
