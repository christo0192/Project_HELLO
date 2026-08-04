import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CandidateJoinPage } from './CandidateJoinPage';

const { useCapabilitySupport } = vi.hoisted(() => ({ useCapabilitySupport: vi.fn() }));
vi.mock('../lib/capability-check', () => ({ useCapabilitySupport }));

const {
  candidateConsentStatus,
  getCandidateConsentTemplate,
  submitCandidateConsent,
  exchangeCandidateInvite,
  connect,
  publishTrack,
  createLocalAudioTrack,
} = vi.hoisted(() => ({
  candidateConsentStatus: vi.fn(),
  getCandidateConsentTemplate: vi.fn(),
  submitCandidateConsent: vi.fn(),
  exchangeCandidateInvite: vi.fn(),
  connect: vi.fn(),
  publishTrack: vi.fn(),
  createLocalAudioTrack: vi.fn().mockResolvedValue({ stop: vi.fn() }),
}));

vi.mock('../api', () => ({
  api: {
    candidateConsentStatus,
    getCandidateConsentTemplate,
    submitCandidateConsent,
    exchangeCandidateInvite,
  },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
    }
  },
}));

vi.mock('livekit-client', () => ({
  Room: class {
    localParticipant = { publishTrack };
    on = vi.fn();
    connect = connect;
    disconnect = vi.fn();
  },
  RoomEvent: { TrackSubscribed: 'trackSubscribed', Disconnected: 'disconnected' },
  Track: { Kind: { Audio: 'audio' } },
  LocalAudioTrack: class {},
  createLocalAudioTrack,
}));

const SYNTHETIC_INVITE = 'a'.repeat(64);

const TEMPLATE = {
  version: '1.0',
  locale: 'en-IN',
  title: 'Screening consent',
  body_md: 'We record and use **your** interview for hiring.',
  required_consents: ['ai_interview', 'recording'],
};

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
    useCapabilitySupport.mockReturnValue('supported');
    candidateConsentStatus.mockResolvedValue({
      has_consent: false,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    getCandidateConsentTemplate.mockResolvedValue(TEMPLATE);
    submitCandidateConsent.mockResolvedValue({ id: 'c1', status: 'granted' });
    exchangeCandidateInvite.mockResolvedValue({
      url: 'wss://livekit.example.invalid',
      livekit_token: 'synthetic-livekit-token',
    });
  });

  it('missing fragment → no consent API call, fragment removed, error shown', async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(candidateConsentStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /join screening/i })).not.toBeInTheDocument();
  });

  it('removes the invite fragment from browser history on mount (even when malformed)', async () => {
    window.history.replaceState(null, '', '/candidate/join#malformed');
    renderPage(['/candidate/join#malformed']);
    await waitFor(() => expect(window.location.hash).toBe(''));
    // Malformed invite → fail closed, no consent call.
    expect(candidateConsentStatus).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('renders the consent form from the active template when no consent exists', async () => {
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByText('Screening consent')).toBeInTheDocument();
    });
    expect(candidateConsentStatus).toHaveBeenCalledWith({ invite_token: SYNTHETIC_INVITE });
    expect(getCandidateConsentTemplate).toHaveBeenCalledWith('en-IN');
    // Template body rendered as plain text (markdown stripped, not executed).
    expect(screen.getByText(/We record and use your interview for hiring/)).toBeInTheDocument();
    // Exact checkboxes per required type.
    expect(screen.getByLabelText('ai interview')).toBeInTheDocument();
    expect(screen.getByLabelText('recording')).toBeInTheDocument();
    // Join button absent until all required boxes are checked.
    expect(screen.queryByRole('button', { name: /join screening/i })).not.toBeInTheDocument();
    // Decline is always available.
    expect(screen.getByRole('button', { name: 'Decline' })).toBeInTheDocument();
  });

  it('accept button stays disabled until ALL required boxes are checked', async () => {
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    const accept = await screen.findByRole('button', { name: 'Accept and continue' });
    expect(accept).toBeDisabled();

    await userEvent.click(screen.getByLabelText('ai interview'));
    expect(accept).toBeDisabled();

    await userEvent.click(screen.getByLabelText('recording'));
    expect(accept).toBeEnabled();
  });

  it('grant submits granted consent with exactly the checked types, then enables join', async () => {
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await screen.findByText('Screening consent');
    await userEvent.click(screen.getByLabelText('ai interview'));
    await userEvent.click(screen.getByLabelText('recording'));
    await userEvent.click(screen.getByRole('button', { name: 'Accept and continue' }));

    await waitFor(() => {
      expect(submitCandidateConsent).toHaveBeenCalledWith({
        invite_token: SYNTHETIC_INVITE,
        template_version: '1.0',
        locale: 'en-IN',
        consents: ['ai_interview', 'recording'],
        status: 'granted',
      });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
  });

  it('decline persists: no join button, no exchange, no media creation', async () => {
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await screen.findByText('Screening consent');
    await userEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(submitCandidateConsent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'declined', consents: [] }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText('Consent declined')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /join screening/i })).not.toBeInTheDocument();
    expect(exchangeCandidateInvite).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it('skips the consent form and enables join when server says has_consent', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
    expect(getCandidateConsentTemplate).not.toHaveBeenCalled();
  });

  it('creates the local audio track before exchanging the one-time invite', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));
    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith(SYNTHETIC_INVITE));
    expect(createLocalAudioTrack.mock.invocationCallOrder[0]).toBeLessThan(
      exchangeCandidateInvite.mock.invocationCallOrder[0],
    );
    expect(connect).toHaveBeenCalledWith(
      'wss://livekit.example.invalid',
      'synthetic-livekit-token',
    );
  });

  it('blocks joining and shows a generic unsupported message when capabilities are missing', async () => {
    useCapabilitySupport.mockReturnValue('unsupported');
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/does not support the microphone and WebRTC/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Join screening' })).not.toBeInTheDocument();
    expect(exchangeCandidateInvite).not.toHaveBeenCalled();
  });

  it('invite fragment is never persisted in query/path after mount', async () => {
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.search).toBe('');
    expect(window.location.pathname).toBe('/candidate/join');
  });
});
