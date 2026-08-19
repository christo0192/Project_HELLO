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
  completeCandidateScreening,
  uploadCandidateRecording,
  roomHandlers,
  disconnect,
} = vi.hoisted(() => ({
  candidateConsentStatus: vi.fn(),
  getCandidateConsentTemplate: vi.fn(),
  submitCandidateConsent: vi.fn(),
  exchangeCandidateInvite: vi.fn(),
  connect: vi.fn(),
  publishTrack: vi.fn(),
  createLocalAudioTrack: vi.fn().mockResolvedValue({ stop: vi.fn() }),
  completeCandidateScreening: vi.fn(),
  uploadCandidateRecording: vi.fn(),
  roomHandlers: new Map<string, (...args: any[]) => void>(),
  disconnect: vi.fn(() => roomHandlers.get('disconnected')?.()),
}));

vi.mock('../api', () => ({
  api: {
    candidateConsentStatus,
    getCandidateConsentTemplate,
    submitCandidateConsent,
    exchangeCandidateInvite,
    completeCandidateScreening,
    uploadCandidateRecording,
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
    localParticipant = { publishTrack, identity: 'candidate-local' };
    on = vi.fn((event: string, handler: (...args: any[]) => void) => {
      roomHandlers.set(event, handler);
    });
    connect = connect;
    disconnect = disconnect;
  },
  RoomEvent: {
    TrackSubscribed: 'trackSubscribed',
    TranscriptionReceived: 'transcriptionReceived',
    Disconnected: 'disconnected',
  },
  Track: { Kind: { Audio: 'audio' } },
  LocalAudioTrack: class {
    mediaStreamTrack: unknown;
    stop = vi.fn();
    constructor(mediaStreamTrack?: unknown) {
      this.mediaStreamTrack = mediaStreamTrack;
    }
  },
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
      session_id: '00000000-0000-4000-8000-000000000001',
      grant_token: 'b'.repeat(64),
    });
    completeCandidateScreening.mockResolvedValue({
      status: 'completed',
      recording_status: 'ready',
    });
    uploadCandidateRecording.mockResolvedValue({ ok: true });
    roomHandlers.clear();
    createLocalAudioTrack.mockResolvedValue({ stop: vi.fn() });
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: undefined,
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

  it('streams and updates LiveKit transcript segments during the call', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));
    await screen.findByRole('region', { name: 'Live transcript' });

    const receive = roomHandlers.get('transcriptionReceived');
    expect(receive).toBeDefined();
    receive?.(
      [{ id: 'seg-1', text: 'Hel', final: false }],
      { identity: 'agent-worker' },
    );
    expect(await screen.findByText('Hel')).toHaveClass('italic');
    expect(screen.getByText('Christy')).toBeInTheDocument();

    receive?.(
      [{ id: 'seg-1', text: 'Hello there', final: true }],
      { identity: 'agent-worker' },
    );
    await waitFor(() => expect(screen.queryByText('Hel')).not.toBeInTheDocument());
    expect(screen.getByText('Hello there')).not.toHaveClass('italic');

    receive?.(
      [{ id: 'seg-2', text: 'Thank you', final: true }],
      { identity: 'candidate-local' },
    );
    expect(await screen.findByText('Thank you')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getAllByText('Hello there')).toHaveLength(1);
  });

  it('manual Leave finalizes exactly once and prefers authoritative Egress', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Leave screening' }));

    await waitFor(() => expect(completeCandidateScreening).toHaveBeenCalledTimes(1));
    expect(uploadCandidateRecording).not.toHaveBeenCalled();
    expect(await screen.findByText('The screening has ended.')).toBeInTheDocument();
  });

  it('server-forced disconnect finalizes once and uploads captured bytes only on Egress failure', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    completeCandidateScreening.mockResolvedValue({
      status: 'completed',
      recording_status: 'fallback_required',
    });

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['synthetic audio']) } as BlobEvent);
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaStream', class MediaStream {
      constructor(_tracks: unknown[]) {}
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    createLocalAudioTrack.mockResolvedValue({
      stop: vi.fn(),
      mediaStreamTrack: { kind: 'audio' },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));
    await waitFor(() => expect(roomHandlers.has('disconnected')).toBe(true));
    roomHandlers.get('disconnected')?.();

    await waitFor(() => expect(uploadCandidateRecording).toHaveBeenCalledTimes(1));
    expect(completeCandidateScreening).toHaveBeenCalledTimes(1);
    expect(uploadCandidateRecording.mock.calls[0]?.[2]).toBeInstanceOf(Blob);
  });

  it('does not report microphone failure when invite exchange fails after mic access succeeds', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    exchangeCandidateInvite.mockRejectedValueOnce(new Error('exchange failed'));
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith(SYNTHETIC_INVITE));
    expect(screen.queryByText(/Microphone access is required before this invite can be used/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Unable to join this screening/i)).toBeInTheDocument();
  });

  it('surfaces retryable copy when just-in-time room provisioning is unavailable', async () => {
    // The server leaves the one-time invite UNCONSUMED on a 503
    // screening_room_unavailable, so the candidate must be told to retry and
    // the Join button must remain usable.
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    const ApiError = (await import('../api')).ApiError;
    exchangeCandidateInvite.mockRejectedValueOnce(
      new ApiError('screening_room_unavailable', 503),
    );
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith(SYNTHETIC_INVITE));
    expect(screen.getByText(/your invite is still valid/i)).toBeInTheDocument();
    // Raw server codes are never shown to the candidate.
    expect(screen.queryByText(/screening_room_unavailable/)).not.toBeInTheDocument();
    // Retry is possible.
    expect(screen.getByRole('button', { name: 'Join screening' })).toBeEnabled();
  });

  it('surfaces consent copy (not a raw code) when the exchange consent gate fails', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    const ApiError = (await import('../api')).ApiError;
    exchangeCandidateInvite.mockRejectedValueOnce(new ApiError('consent_required', 409));
    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith(SYNTHETIC_INVITE));
    expect(screen.getByText(/consent is missing or no longer valid/i)).toBeInTheDocument();
    expect(screen.queryByText(/consent_required/)).not.toBeInTheDocument();
  });

  it('falls back to browser getUserMedia before exchanging when LiveKit audio creation fails', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    createLocalAudioTrack.mockRejectedValueOnce(new DOMException('primary failed', 'AbortError'));
    const browserTrack = { kind: 'audio' };
    const getUserMedia = vi.fn().mockResolvedValue({ getAudioTracks: () => [browserTrack] });
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith(SYNTHETIC_INVITE));
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(connect).toHaveBeenCalledWith('wss://livekit.example.invalid', 'synthetic-livekit-token');
  });

  it('falls back to plain audio capture when preferred browser constraints fail', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    createLocalAudioTrack.mockRejectedValueOnce(new DOMException('primary failed', 'AbortError'));
    const browserTrack = { kind: 'audio' };
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('constraints failed', 'AbortError'))
      .mockResolvedValueOnce({ getAudioTracks: () => [browserTrack] });
    Object.defineProperty(window.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Join screening' })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(exchangeCandidateInvite).toHaveBeenCalledWith(SYNTHETIC_INVITE));
    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, { audio: true });
    expect(connect).toHaveBeenCalledWith('wss://livekit.example.invalid', 'synthetic-livekit-token');
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

  // ── T12: all attempts pending → uploadCandidateRecording never called ─
  it('T12: never uploads when /complete returns pending on every attempt', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    // Always returns pending — never ready, never fallback_required
    completeCandidateScreening.mockResolvedValue({
      status: 'completed',
      recording_status: 'pending',
    });

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['synthetic audio']) } as BlobEvent);
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaStream', class MediaStream {
      constructor(_tracks: unknown[]) {}
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    createLocalAudioTrack.mockResolvedValue({
      stop: vi.fn(),
      mediaStreamTrack: { kind: 'audio' },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));

    // Force disconnect → triggers finalizeCandidateCall
    await waitFor(() => expect(roomHandlers.has('disconnected')).toBe(true));
    roomHandlers.get('disconnected')?.();

    await waitFor(() => expect(completeCandidateScreening).toHaveBeenCalled());
    // T12 passes: uploadCandidateRecording was never called
    expect(uploadCandidateRecording).not.toHaveBeenCalled();
  });

  // ── T13: fallback_required → uploaded exactly once ─
  it('T13: uploads exactly once when /complete returns fallback_required', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    completeCandidateScreening.mockResolvedValue({
      status: 'completed',
      recording_status: 'fallback_required',
    });

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['synthetic audio']) } as BlobEvent);
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaStream', class MediaStream {
      constructor(_tracks: unknown[]) {}
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    createLocalAudioTrack.mockResolvedValue({
      stop: vi.fn(),
      mediaStreamTrack: { kind: 'audio' },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(roomHandlers.has('disconnected')).toBe(true));
    roomHandlers.get('disconnected')?.();

    await waitFor(() => expect(uploadCandidateRecording).toHaveBeenCalledTimes(1));
    expect(uploadCandidateRecording.mock.calls[0]?.[2]).toBeInstanceOf(Blob);
  });

  // ── T14: ready → not called ─
  it('T14: never uploads when /complete returns ready', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    completeCandidateScreening.mockResolvedValue({
      status: 'completed',
      recording_status: 'ready',
    });
    uploadCandidateRecording.mockClear();

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['synthetic audio']) } as BlobEvent);
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaStream', class MediaStream {
      constructor(_tracks: unknown[]) {}
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    createLocalAudioTrack.mockResolvedValue({
      stop: vi.fn(),
      mediaStreamTrack: { kind: 'audio' },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(roomHandlers.has('disconnected')).toBe(true));
    roomHandlers.get('disconnected')?.();

    await waitFor(() => expect(completeCandidateScreening).toHaveBeenCalled());
    expect(uploadCandidateRecording).not.toHaveBeenCalled();
  });

  // ── T15: upload 409 → no retry loop, terminal ─
  it('T15: treats 409 as terminal in uploadBrowserFallback (no retry loop)', async () => {
    candidateConsentStatus.mockResolvedValue({
      has_consent: true,
      template_version: '1.0',
      locale: 'en-IN',
      required_consents: ['ai_interview', 'recording'],
    });
    completeCandidateScreening.mockResolvedValue({
      status: 'completed',
      recording_status: 'fallback_required',
    });
    // Upload returns 409 — egress is authoritative
    const ApiError = (await import('../api')).ApiError;
    uploadCandidateRecording.mockRejectedValue(new ApiError('authoritative_recording_pending', 409));

    class FakeMediaRecorder {
      static isTypeSupported = vi.fn(() => true);
      state: RecordingState = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: ((event: Event) => void) | null = null;
      start() {
        this.state = 'recording';
        this.ondataavailable?.({ data: new Blob(['synthetic audio']) } as BlobEvent);
      }
      stop() {
        this.state = 'inactive';
        this.onstop?.(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaStream', class MediaStream {
      constructor(_tracks: unknown[]) {}
    });
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    createLocalAudioTrack.mockResolvedValue({
      stop: vi.fn(),
      mediaStreamTrack: { kind: 'audio' },
    });

    window.history.replaceState(null, '', `/candidate/join#${SYNTHETIC_INVITE}`);
    renderPage([`/candidate/join#${SYNTHETIC_INVITE}`]);
    await userEvent.click(await screen.findByRole('button', { name: 'Join screening' }));

    await waitFor(() => expect(roomHandlers.has('disconnected')).toBe(true));
    roomHandlers.get('disconnected')?.();

    // T15 passes: upload was attempted exactly once and did NOT retry
    await waitFor(() => expect(uploadCandidateRecording).toHaveBeenCalledTimes(1));
  });
});
