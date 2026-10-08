import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  useCapabilitySupport: vi.fn(),
  status: vi.fn(),
  consentTemplate: vi.fn(),
  submitConsent: vi.fn(),
  withdrawConsent: vi.fn(),
  createAttempt: vi.fn(),
  exchange: vi.fn(),
  ready: vi.fn(),
  created: [] as Array<{
    handlers: {
      onPhase: (phase: string) => void;
      onLeadName: (name: string | null) => void;
      onRoleplayLeft: (seconds: number | null) => void;
      onAwaitingReady: (awaiting: boolean) => void;
      onAgentPresent: (present: boolean) => void;
      onAgentLevel: (level: number) => void;
      onCaptions: (segments: unknown[], phase: string | null) => void;
      onCameraOn: (on: boolean) => void;
      onEnded: (reason: string) => void;
    };
    controller: Record<string, ReturnType<typeof vi.fn>>;
  }>,
  media: null as null | {
    audio: { stop: ReturnType<typeof vi.fn> };
    video: {
      stop: ReturnType<typeof vi.fn>;
      attach: ReturnType<typeof vi.fn>;
      detach: ReturnType<typeof vi.fn>;
    };
  },
  connectError: null as null | Error,
  duringConnect: null as null | ((handlers: { onEnded: (reason: string) => void }) => void),
}));

vi.mock('../lib/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }));
vi.mock('../lib/capability-check', () => ({ useCapabilitySupport: h.useCapabilitySupport }));
vi.mock('../lib/r1/r1-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/r1/r1-api')>()),
  r1Api: {
    status: h.status,
    consentTemplate: h.consentTemplate,
    submitConsent: h.submitConsent,
    withdrawConsent: h.withdrawConsent,
    createAttempt: h.createAttempt,
    exchange: h.exchange,
    ready: h.ready,
  },
}));
vi.mock('../lib/r1/r1-room', () => ({
  createR1Room: vi.fn((handlers) => {
    const controller = {
      connect: vi.fn(async () => {
        h.duringConnect?.(handlers);
        if (h.connectError) throw h.connectError;
      }),
      setMicMuted: vi.fn(async (muted: boolean) => muted),
      setCameraOn: vi.fn(async (on: boolean) => on),
      leave: vi.fn(async () => handlers.onEnded('left')),
      dispose: vi.fn(),
    };
    h.created.push({ handlers, controller });
    return controller;
  }),
}));
vi.mock('../components/candidate-r1/R1ReadinessStep', () => ({
  R1ReadinessStep: (props: {
    linkToken: string;
    onReady: (media: unknown) => void;
    onBack: () => void;
    onConsentRequired: () => void;
  }) => (
    <section aria-label="device check" data-link={props.linkToken}>
      <button type="button" onClick={() => props.onReady(h.media)}>
        Pass device check
      </button>
      <button type="button" onClick={props.onBack}>
        Back to landing
      </button>
      <button type="button" onClick={props.onConsentRequired}>
        Consent lapsed
      </button>
    </section>
  ),
}));

import { ApiError } from '../lib/api-client';
import { readNonce, saveNonce } from '../lib/r1/r1-link';
import { R1JoinPage } from './R1JoinPage';

const LINK = 'd1'.repeat(32);
const OTHER_LINK = 'e2'.repeat(32);
const NONCE = 'rejoin-nonce-0123456789abcdef';
const TEMPLATE = {
  version: 'r1-2026-10',
  locale: 'en-IN',
  title: 'Notice and consent',
  body_md: '# Data\nCamera video and voice.',
  required_consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'],
  consent_items: [],
};
const STATUS = {
  state: 'invited',
  attempts_left: 2,
  attempts_allowed: 2,
  starts_left: 3,
  can_start: true,
  live_attempt: false,
  consent_state: 'granted',
  role_title: 'Sales Program Advisor',
  format: { duration_minutes: 20 },
  availability: 'open',
  audience: 'candidate',
};
/** The same link before its person has agreed to anything. */
const NEEDS_CONSENT = { ...STATUS, consent_state: 'required', can_start: false };
const ATTEMPT = {
  attempt_token: 'attempt-token',
  nonce: NONCE,
  attempt_id: null,
  rejoin: false,
  lead: { name: 'Meera', city: 'Pune' },
};
const ROOM = {
  status: 'ready',
  url: 'wss://r1.invalid',
  livekit_token: 'room-token',
  expires_at: null,
  attempt_id: null,
};

let view: ReturnType<typeof render>;

const findH1 = (name: string) => screen.findByRole('heading', { level: 1, name });

function openPage(hash: string = `#${LINK}`, strict = false) {
  window.history.replaceState(null, '', `/candidate/r1${hash}`);
  const page = (
    <MemoryRouter>
      <R1JoinPage />
    </MemoryRouter>
  );
  view = render(strict ? <StrictMode>{page}</StrictMode> : page);
  return view;
}

async function toLanding() {
  openPage();
  return findH1('Video interview');
}

async function toLive() {
  await toLanding();
  fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
  await screen.findByRole('region', { name: 'Live video interview' });
  return h.created[h.created.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.created.length = 0;
  h.connectError = null;
  h.duringConnect = null;
  h.media = {
    audio: { stop: vi.fn() },
    video: { stop: vi.fn(), attach: vi.fn(), detach: vi.fn() },
  };
  h.useCapabilitySupport.mockReturnValue('supported');
  h.status.mockResolvedValue(STATUS);
  h.consentTemplate.mockResolvedValue(TEMPLATE);
  h.submitConsent.mockResolvedValue(undefined);
  h.withdrawConsent.mockResolvedValue(undefined);
  h.createAttempt.mockResolvedValue(ATTEMPT);
  h.exchange.mockResolvedValue(ROOM);
  h.ready.mockResolvedValue(undefined);
});

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('link handling', () => {
  it('makes no API call for a missing or malformed fragment', async () => {
    openPage('');
    const title = await findH1('We could not open this link');
    expect(title).toBeVisible();
    expect(h.status).not.toHaveBeenCalled();
  });

  it('strips the fragment and sends the token only to the status call', async () => {
    await toLanding();
    expect(window.location.href).not.toContain(LINK);
    expect(window.location.pathname).toBe('/candidate/r1');
    expect(h.status).toHaveBeenCalledWith(LINK);
    expect(document.body.innerHTML).not.toContain(LINK);
  });

  it('survives StrictMode double effects without losing the link', async () => {
    openPage(`#${LINK}`, true);
    expect(await findH1('Video interview')).toBeVisible();
    expect(h.status).toHaveBeenCalledWith(LINK);
  });

  it('makes no API call in a browser without camera or WebRTC support', async () => {
    h.useCapabilitySupport.mockReturnValue('unsupported');
    openPage();
    expect(await screen.findByRole('heading', { name: /cannot run the interview/ })).toBeVisible();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
    expect(h.status).not.toHaveBeenCalled();
    expect(h.consentTemplate).not.toHaveBeenCalled();
    expect(h.createAttempt).not.toHaveBeenCalled();
  });

  it('still strips the fragment at once in a browser that cannot run the interview', async () => {
    h.useCapabilitySupport.mockReturnValue('unsupported');
    openPage();
    await screen.findByRole('heading', { name: /cannot run the interview/ });
    expect(window.location.href).not.toContain(LINK);
    expect(window.location.pathname).toBe('/candidate/r1');
  });

  it('sends the link token only once the browser is known to support the interview', async () => {
    h.useCapabilitySupport.mockReturnValue('checking');
    openPage();
    expect(window.location.href).not.toContain(LINK);
    expect(screen.getByRole('status')).toHaveTextContent('Checking your interview link');
    expect(h.status).not.toHaveBeenCalled();

    h.useCapabilitySupport.mockReturnValue('supported');
    view.rerender(
      <MemoryRouter>
        <R1JoinPage />
      </MemoryRouter>,
    );
    expect(await findH1('Video interview')).toBeVisible();
    expect(h.status).toHaveBeenCalledTimes(1);
    expect(h.status).toHaveBeenCalledWith(LINK);
  });
});

describe('link states', () => {
  it.each([
    ['expired', { ...STATUS, state: 'expired' }, 'This interview link has expired'],
    ['cancelled', { ...STATUS, state: 'cancelled' }, 'This interview link was cancelled'],
    ['completed', { ...STATUS, state: 'completed' }, 'Your interview is already complete'],
    ['out of attempts', { ...STATUS, attempts_left: 0 }, 'Your interview is already complete'],
  ])('closes the page for a link that is %s', async (_name, status, title) => {
    h.status.mockResolvedValue(status);
    openPage();
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
  });

  it('still lets a candidate rejoin an in-progress attempt that used the last try', async () => {
    h.status.mockResolvedValue({ ...STATUS, state: 'in_progress', attempts_left: 0 });
    openPage();
    expect(await findH1('Video interview')).toBeVisible();
  });

  it('says the link stays valid while the budget guard has paused R1', async () => {
    h.status.mockResolvedValueOnce({ ...STATUS, availability: 'paused' });
    openPage();
    const paused = await findH1('We cannot start interviews right now');
    expect(paused).toBeVisible();
    expect(screen.getByText(/Your link stays valid/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await findH1('Video interview')).toBeVisible();
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('waits the same way while R1 is switched off, and still starts nothing', async () => {
    h.status.mockResolvedValueOnce({ ...STATUS, availability: 'disabled' });
    openPage();
    expect(await findH1('We cannot start interviews right now')).toBeVisible();
    expect(h.consentTemplate).not.toHaveBeenCalled();
    expect(h.createAttempt).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown link', new ApiError('http_404', 404), 'We could not open this link'],
    ['an expired link', new ApiError('http_410', 410), 'This interview link has expired'],
    ['an outage', new ApiError('http_503', 503), 'The interview service is unavailable'],
  ])('maps %s from the status call', async (_name, error, title) => {
    h.status.mockRejectedValue(error);
    openPage();
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeVisible();
  });
});

describe('notice and consent', () => {
  async function toNotice() {
    h.status.mockResolvedValue(NEEDS_CONSENT);
    openPage();
    return findH1('Notice and consent');
  }

  it('shows the notice first and lets nothing proceed without every purpose', async () => {
    await toNotice();
    // No locale: the server picks the notice this link's audience is owed.
    expect(h.consentTemplate).toHaveBeenCalledWith(LINK);
    expect(screen.getByRole('button', { name: 'I agree and continue' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
  });

  it('records a grant against the template version, then reaches the landing page', async () => {
    const user = userEvent.setup();
    await toNotice();
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    await user.click(screen.getByRole('button', { name: 'I agree and continue' }));
    expect(h.submitConsent).toHaveBeenCalledWith(LINK, {
      template_version: 'r1-2026-10',
      consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'],
      status: 'granted',
    });
    expect(await findH1('Video interview')).toBeVisible();
  });

  it('records a decline, offers a person instead, and never reaches the device check', async () => {
    const user = userEvent.setup();
    await toNotice();
    await user.click(screen.getByRole('button', { name: 'I do not agree' }));
    expect(h.submitConsent).toHaveBeenCalledWith(LINK, {
      template_version: 'r1-2026-10',
      consents: [],
      status: 'declined',
    });
    const declined = await screen.findByRole('heading', {
      name: 'This interview cannot start without your consent',
    });
    expect(declined).toBeVisible();
    expect(screen.getByText(/conversation with a person instead/)).toBeVisible();
    expect(screen.queryByRole('region', { name: 'device check' })).toBeNull();
    expect(h.createAttempt).not.toHaveBeenCalled();
  });

  it('stays on the notice and says so when recording the choice fails', async () => {
    const user = userEvent.setup();
    h.submitConsent.mockRejectedValue(new ApiError('http_500', 500));
    await toNotice();
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    await user.click(screen.getByRole('button', { name: 'I agree and continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not record your choice/);
    expect(screen.getByRole('heading', { level: 1, name: 'Notice and consent' })).toBeVisible();
  });

  it('reads the current notice again when the one on screen was superseded', async () => {
    const user = userEvent.setup();
    h.submitConsent.mockRejectedValueOnce(new ApiError('consent_template_stale', 409));
    await toNotice();
    h.consentTemplate.mockResolvedValue({ ...TEMPLATE, version: 'r1-2026-11' });
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    await user.click(screen.getByRole('button', { name: 'I agree and continue' }));
    await waitFor(() => expect(h.consentTemplate).toHaveBeenCalledTimes(2));
    expect(await findH1('Notice and consent')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    // Asked again, against the new version, from unticked boxes.
    const agree = await screen.findByRole('button', { name: 'I agree and continue' });
    expect(agree).toBeDisabled();
    for (const box of screen.getAllByRole('checkbox')) await user.click(box);
    await user.click(agree);
    expect(h.submitConsent).toHaveBeenLastCalledWith(LINK, {
      template_version: 'r1-2026-11',
      consents: ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'],
      status: 'granted',
    });
  });

  it('withdraws consent only after confirmation and closes the link', async () => {
    const user = userEvent.setup();
    saveNonce(LINK, NONCE);
    await toLanding();
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    expect(h.withdrawConsent).not.toHaveBeenCalled();
    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    await user.click(within(group).getByRole('button', { name: 'Withdraw my consent' }));
    expect(h.withdrawConsent).toHaveBeenCalledWith(LINK);
    expect(await findH1('We have recorded your withdrawal')).toBeVisible();
    expect(readNonce(LINK)).toBeNull();
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('joining', () => {
  it('runs the device check, then attempt, exchange and connect in order', async () => {
    const live = await toLive();
    expect(h.createAttempt).toHaveBeenCalledWith(LINK, null);
    expect(h.exchange).toHaveBeenCalledWith('attempt-token', NONCE);
    expect(live.controller.connect).toHaveBeenCalledWith('wss://r1.invalid', 'room-token', h.media);
    expect(h.createAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      h.exchange.mock.invocationCallOrder[0],
    );
    expect(readNonce(LINK)).toBe(NONCE);
  });

  it('presents the device check with the link token and a way back', async () => {
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    const check = await screen.findByRole('region', { name: 'device check' });
    expect(check).toHaveAttribute('data-link', LINK);
    fireEvent.click(screen.getByRole('button', { name: 'Back to landing' }));
    expect(await findH1('Video interview')).toBeVisible();
  });

  it('sends the stored nonce to rejoin', async () => {
    saveNonce(LINK, NONCE);
    await toLive();
    expect(h.createAttempt).toHaveBeenCalledWith(LINK, NONCE);
  });

  it('says that starting again is a NEW interview before it admits one', async () => {
    saveNonce(LINK, NONCE);
    h.createAttempt.mockRejectedValueOnce(new ApiError('r1_attempt_not_live', 409));
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));

    // Nothing was admitted behind the person's back: one rejoin, refused, and the camera is off.
    const note = await screen.findByText(/Your previous interview has ended and cannot be rejoined/);
    expect(note).toHaveTextContent('Starting again begins attempt 1 of 2.');
    expect(h.createAttempt).toHaveBeenCalledTimes(1);
    expect(h.createAttempt).toHaveBeenCalledWith(LINK, NONCE);
    expect(h.exchange).not.toHaveBeenCalled();
    expect(h.media?.video.stop).toHaveBeenCalled();
    expect(readNonce(LINK)).toBeNull();
    // The counts on screen are re-read from the server, not carried over.
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(await findH1('Video interview')).toBeVisible();

    // Only a second, deliberate go ahead asks for the new attempt, with no nonce to spend.
    h.createAttempt.mockResolvedValueOnce({ ...ATTEMPT, nonce: 'fresh-nonce-second' });
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await screen.findByRole('region', { name: 'Live video interview' });
    expect(h.createAttempt).toHaveBeenCalledTimes(2);
    expect(h.createAttempt).toHaveBeenLastCalledWith(LINK, null);
    expect(h.exchange).toHaveBeenCalledWith('attempt-token', 'fresh-nonce-second');
    expect(readNonce(LINK)).toBe('fresh-nonce-second');
  });

  it('counts the attempt against what the server reports now, and never past the last', async () => {
    saveNonce(LINK, NONCE);
    h.createAttempt.mockRejectedValueOnce(new ApiError('r1_attempt_not_live', 409));
    h.status
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValue({ ...STATUS, attempts_left: 1 });
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await screen.findByText(/Starting again begins attempt 2 of 2/)).toBeVisible();
  });

  it('closes the link instead when the ended interview turns out to have used the last attempt', async () => {
    saveNonce(LINK, NONCE);
    h.createAttempt.mockRejectedValueOnce(new ApiError('r1_attempt_not_live', 409));
    h.status
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValue({ ...STATUS, state: 'completed', attempts_left: 0 });
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await findH1('Your interview is already complete')).toBeVisible();
    expect(screen.queryByText(/Starting again begins/)).toBeNull();
  });

  it('does not retry a refused first attempt, which had no nonce to spend', async () => {
    h.createAttempt.mockRejectedValue(new ApiError('r1_attempt_not_live', 409));
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not start your interview/);
    expect(h.createAttempt).toHaveBeenCalledTimes(1);
  });

  it('never sends a nonce that belongs to another link, and discards it', async () => {
    // A staff dry run: link A ended abnormally, then link B is opened in the same tab.
    saveNonce(OTHER_LINK, NONCE);
    await toLive();
    expect(h.createAttempt).toHaveBeenCalledTimes(1);
    expect(h.createAttempt).toHaveBeenCalledWith(LINK, null);
    expect(readNonce(OTHER_LINK)).toBeNull();
    expect(readNonce(LINK)).toBe(NONCE);
  });

  it('waits while the worker boots, polling the same exchange', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.exchange
        .mockResolvedValueOnce({ status: 'preparing' })
        .mockResolvedValueOnce({ status: 'preparing' })
        .mockResolvedValue(ROOM);
      openPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
      fireEvent.click(screen.getByRole('button', { name: 'Pass device check' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('heading', { name: 'Preparing your interview…' })).toBeVisible();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_500);
      });
      expect(screen.getByRole('region', { name: 'Live video interview' })).toBeVisible();
      expect(h.exchange).toHaveBeenCalledTimes(3);
      expect(h.createAttempt).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the preparing bound and keeps the link valid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      h.exchange.mockResolvedValue({ status: 'preparing' });
      openPage();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
      fireEvent.click(screen.getByRole('button', { name: 'Pass device check' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByRole('alert')).toHaveTextContent(/Your link stays valid|try again/);
      expect(screen.getByRole('button', { name: 'Check my camera and microphone' })).toBeEnabled();
      expect(h.media?.video.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('explains r1_busy, stops the camera and microphone, and keeps the link valid', async () => {
    h.createAttempt.mockRejectedValue(new ApiError('r1_busy', 409));
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Another interview is finishing');
    expect(alert).toHaveTextContent('Your link stays valid');
    expect(h.media?.audio.stop).toHaveBeenCalled();
    expect(h.media?.video.stop).toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Check my camera and microphone' })).toBeEnabled();
  });

  it('keeps the stored nonce through a busy answer but drops it on a refusal', async () => {
    saveNonce(LINK, NONCE);
    h.createAttempt.mockRejectedValueOnce(new ApiError('r1_busy', 409));
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await screen.findByRole('alert');
    expect(readNonce(LINK)).toBe(NONCE);

    h.createAttempt.mockRejectedValueOnce(new ApiError('http_403', 403));
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await waitFor(() => expect(readNonce(LINK)).toBeNull());
  });

  describe('the rejoin nonce survives every failure except a refusal', () => {
    async function failJoin(): Promise<void> {
      await toLanding();
      fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
      await screen.findByRole('alert');
    }

    it('keeps it when the worker takes longer than the preparing bound', async () => {
      // The attempt is admitted and dispatched: the session is live on the server.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        h.exchange.mockResolvedValue({ status: 'preparing' });
        openPage();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
        fireEvent.click(screen.getByRole('button', { name: 'Pass device check' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(screen.getByRole('alert')).toBeVisible();
        expect(readNonce(LINK)).toBe(NONCE);

        // The retry presents it, so the candidate is let back into their own session.
        h.exchange.mockResolvedValue(ROOM);
        fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
        fireEvent.click(screen.getByRole('button', { name: 'Pass device check' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(h.createAttempt).toHaveBeenLastCalledWith(LINK, NONCE);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps it when the room will not connect (ICE or TCP blocked)', async () => {
      h.connectError = new Error('could not establish pc connection');
      await failJoin();
      expect(readNonce(LINK)).toBe(NONCE);
    });

    it.each([
      ['a 500 from the exchange', new ApiError('http_500', 500)],
      ['a 502 from the exchange', new ApiError('http_502', 502)],
      ['an unreachable network', new ApiError('network_unreachable', 0)],
      ['a rate limit', new ApiError('http_429', 429)],
      ['an unrecognised answer', new ApiError('http_418', 418)],
    ])('keeps it after %s', async (_name, error) => {
      h.exchange.mockRejectedValue(error);
      await failJoin();
      expect(readNonce(LINK)).toBe(NONCE);
    });

    it.each([
      ['a 401', new ApiError('http_401', 401)],
      ['a 403', new ApiError('http_403', 403)],
      ['a 404', new ApiError('http_404', 404)],
      ['a 410', new ApiError('http_410', 410)],
    ])('drops it only when the exchange answers %s (the nonce was refused)', async (_n, e) => {
      h.exchange.mockRejectedValue(e);
      await failJoin();
      expect(readNonce(LINK)).toBeNull();
    });

    it('drops it when the attempt itself is refused as an expired link', async () => {
      saveNonce(LINK, NONCE);
      h.createAttempt.mockRejectedValue(new ApiError('http_410', 410));
      await failJoin();
      expect(readNonce(LINK)).toBeNull();
    });
  });

  it('tears the room down and stops the tracks when connecting fails', async () => {
    h.connectError = new Error('signal failed');
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not start your interview/);
    expect(h.created[0].controller.dispose).toHaveBeenCalled();
    expect(h.media?.video.stop).toHaveBeenCalled();
  });

  it('connects nothing if the page is closed while the interviewer is being prepared', async () => {
    let release: (value: unknown) => void = () => undefined;
    h.exchange.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await waitFor(() => expect(h.exchange).toHaveBeenCalled());
    view.unmount();
    expect(h.media?.video.stop).toHaveBeenCalled();
    await act(async () => {
      release(ROOM);
    });
    expect(h.created).toHaveLength(0);
  });

  it('never replaces an ending with a live view when the room ends while connecting', async () => {
    h.duringConnect = (handlers) => handlers.onEnded('disconnected');
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await findH1('The connection to your interview ended.')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Live video interview' })).toBeNull();
  });

  it('returns to the notice when the server says consent is no longer valid', async () => {
    h.createAttempt.mockRejectedValue(new ApiError('consent_required', 409));
    h.status
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValue(NEEDS_CONSENT);
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await findH1('Notice and consent')).toBeVisible();
  });

  it('returns to the notice when the device check reports lapsed consent', async () => {
    h.status
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValue(NEEDS_CONSENT);
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Consent lapsed' }));
    expect(await findH1('Notice and consent')).toBeVisible();
  });
});

describe('live interview', () => {
  it('follows the phase label and shows the lead card only during the role-play', async () => {
    const live = await toLive();
    expect(screen.getByText('Connecting')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Your role-play' })).toBeNull();

    act(() => live.handlers.onPhase('icebreaker'));
    expect(screen.getByText('Getting to know you')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Your role-play' })).toBeNull();

    act(() => live.handlers.onPhase('transition'));
    const card = screen.getByRole('region', { name: 'Your role-play' });
    // The server never names the learner; until the interviewer does, the card is generic.
    expect(within(card).getByText('A prospective learner')).toBeVisible();
    act(() => live.handlers.onLeadName('Meera Iyer'));
    expect(within(card).getByText('Meera Iyer')).toBeVisible();
    expect(within(card).queryByText('A prospective learner')).toBeNull();

    act(() => live.handlers.onPhase('roleplay'));
    expect(screen.getByText('Role-play')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Your role-play' })).toBeVisible();

    act(() => live.handlers.onPhase('paused_disconnected'));
    expect(screen.getByRole('region', { name: 'Your role-play' })).toBeVisible();

    act(() => live.handlers.onPhase('roleplay_exit'));
    expect(screen.queryByRole('region', { name: 'Your role-play' })).toBeNull();
  });

  it('fits the live interview to the window, and no other screen', async () => {
    await toLanding();
    expect(document.querySelector('main.candidate-shell--fill')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await screen.findByRole('region', { name: 'Live video interview' });
    expect(document.querySelector('main.candidate-shell--fill')).not.toBeNull();
  });

  it('hides the card again if the interview paused outside the role-play', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('icebreaker'));
    act(() => live.handlers.onPhase('paused_disconnected'));
    expect(screen.queryByRole('region', { name: 'Your role-play' })).toBeNull();
  });

  it('labels bot captions as the learner only while the role-play is on', async () => {
    const live = await toLive();
    const line = (id: string, text: string) => [{ id, text, final: true }];
    act(() => live.handlers.onCaptions(line('a', 'Tell me more.'), 'icebreaker'));
    act(() => live.handlers.onCaptions(line('b', 'Hello? Yes.'), 'roleplay'));
    expect(screen.getByText('Interviewer')).toBeVisible();
    expect(screen.getByText('Learner (simulated by the AI)')).toBeVisible();
  });

  it('shows the camera-off banner from the room and clears it on return', async () => {
    const live = await toLive();
    act(() => live.handlers.onCameraOn(false));
    expect(screen.getByText(/Your camera is off/)).toBeVisible();
    act(() => live.handlers.onCameraOn(true));
    expect(screen.queryByText(/Your camera is off/)).toBeNull();
  });

  it('toggles the microphone and camera through the controller', async () => {
    const live = await toLive();
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    await waitFor(() => expect(live.controller.setMicMuted).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Turn camera off' }));
    await waitFor(() => expect(live.controller.setCameraOn).toHaveBeenCalledWith(false));
    expect(await screen.findByRole('button', { name: 'Turn camera on' })).toBeVisible();
  });

  it('says so when a control fails', async () => {
    const live = await toLive();
    live.controller.setMicMuted.mockRejectedValueOnce(new Error('device busy'));
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not change your microphone/);
  });
});

describe('the role-play briefing, clock and "I\'m ready"', () => {
  const READY = { name: "I'm ready" };

  it('shows no button, and no clock, from an interviewer that publishes neither', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    expect(screen.queryByRole('button', READY)).toBeNull();
    act(() => live.handlers.onPhase('roleplay'));
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('shows the button only while the interviewer is waiting in the briefing', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onAwaitingReady(true));
    expect(screen.getByRole('button', READY)).toBeVisible();
    act(() => live.handlers.onAwaitingReady(false));
    expect(screen.queryByRole('button', READY)).toBeNull();
    act(() => live.handlers.onAwaitingReady(true));
    act(() => live.handlers.onPhase('roleplay'));
    expect(screen.queryByRole('button', READY)).toBeNull();
  });

  it('sends the signal with a freshly minted attempt token and the attempt\'s own nonce', async () => {
    const live = await toLive();
    h.createAttempt.mockClear();
    h.createAttempt.mockResolvedValue({ ...ATTEMPT, attempt_token: 'fresh-token', rejoin: true });
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onAwaitingReady(true));
    fireEvent.click(screen.getByRole('button', READY));
    expect(await screen.findByText('Sent — starting the role-play')).toBeVisible();
    // The token from joining lasts five minutes and the briefing is later: a current one is minted
    // for the same attempt with the stored nonce, and that is what the server is shown.
    expect(h.createAttempt).toHaveBeenCalledTimes(1);
    expect(h.createAttempt).toHaveBeenCalledWith(LINK, NONCE);
    expect(h.ready).toHaveBeenCalledTimes(1);
    expect(h.ready).toHaveBeenCalledWith('fresh-token', NONCE);
  });

  it('says what to do instead when the signal could not be sent, and lets the candidate try again', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onAwaitingReady(true));
    h.ready.mockRejectedValueOnce(new ApiError('http_429', 429));
    fireEvent.click(screen.getByRole('button', READY));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "We couldn't send that. Just say “I'm ready”.",
    );
    fireEvent.click(screen.getByRole('button', READY));
    expect(await screen.findByText('Sent — starting the role-play')).toBeVisible();
    expect(h.ready).toHaveBeenCalledTimes(2);
  });

  it('reports a failure to mint the attempt token the same way, and sends nothing', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onAwaitingReady(true));
    h.createAttempt.mockRejectedValueOnce(new ApiError('r1_attempt_not_live', 409));
    fireEvent.click(screen.getByRole('button', READY));
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn't send that/);
    expect(h.ready).not.toHaveBeenCalled();
  });

  it('keeps the interview going, and the nonce, when "I\'m ready" fails', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onAwaitingReady(true));
    h.ready.mockRejectedValueOnce(new ApiError('not_live', 409));
    fireEvent.click(screen.getByRole('button', READY));
    await screen.findByRole('alert');
    expect(screen.getByRole('region', { name: 'Live video interview' })).toBeVisible();
    expect(readNonce(LINK)).toBe(NONCE);
    expect(live.controller.dispose).not.toHaveBeenCalled();
  });

  it('shows the clock from the interviewer, counted down only while the role-play runs', async () => {
    const live = await toLive();
    // Faked only now: the waits above use real timers, and the page measures with performance.now().
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    try {
      act(() => live.handlers.onPhase('transition'));
      act(() => live.handlers.onRoleplayLeft(480));
      // In the briefing the role-play has not begun: it holds at the full budget.
      act(() => {
        vi.advanceTimersByTime(120_000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 8 min left');

      act(() => live.handlers.onPhase('roleplay'));
      act(() => {
        vi.advanceTimersByTime(65_000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 7 min left');

      // An aside pauses it at the value it had counted down to, however long the aside is.
      act(() => live.handlers.onPhase('aside'));
      act(() => {
        vi.advanceTimersByTime(300_000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 7 min left');

      // A fresh number from the interviewer wins over the local count.
      act(() => live.handlers.onRoleplayLeft(200));
      expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 4 min left');
      act(() => live.handlers.onPhase('roleplay'));
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 3 min left');

      // The interviewer clears it when the role-play is over.
      act(() => live.handlers.onRoleplayLeft(null));
      expect(screen.queryByRole('timer')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the number that arrives with a phase change after freezing the old count', async () => {
    const live = await toLive();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    try {
      act(() => live.handlers.onPhase('roleplay'));
      act(() => live.handlers.onRoleplayLeft(300));
      act(() => {
        vi.advanceTimersByTime(40_000);
      });
      // The room reports the phase first, then the clock that came with it.
      act(() => {
        live.handlers.onPhase('aside');
        live.handlers.onRoleplayLeft(255);
      });
      act(() => {
        vi.advanceTimersByTime(600_000);
      });
      expect(screen.getByRole('timer')).toHaveTextContent('Role-play · 5 min left');
    } finally {
      vi.useRealTimers();
    }
  });

  it('forgets the name, the clock and the wait when the candidate rejoins', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onLeadName('Meera Iyer'));
    act(() => live.handlers.onRoleplayLeft(480));
    act(() => live.handlers.onAwaitingReady(true));
    expect(screen.getByRole('button', READY)).toBeVisible();
    act(() => live.handlers.onEnded('disconnected'));
    await findH1('The connection to your interview ended.');
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin interview' }));
    await findH1('Video interview');
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await screen.findByRole('region', { name: 'Live video interview' });
    // The new room starts blank; what the interviewer still publishes arrives from the room.
    expect(screen.queryByRole('button', READY)).toBeNull();
    expect(screen.queryByRole('timer')).toBeNull();
    const again = h.created[h.created.length - 1];
    act(() => again.handlers.onPhase('transition'));
    expect(screen.getByText('A prospective learner')).toBeVisible();
    expect(screen.queryByText('Meera Iyer')).toBeNull();
  });

  it('sends nothing to the server about "ready" unless the candidate presses the button', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('transition'));
    act(() => live.handlers.onAwaitingReady(true));
    act(() => live.handlers.onPhase('roleplay'));
    act(() => live.handlers.onAwaitingReady(false));
    expect(h.ready).not.toHaveBeenCalled();
  });
});

describe('ending', () => {
  it('shows the end card when the agent ends the interview, and forgets the nonce', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('ended'));
    act(() => live.handlers.onEnded('agent_ended'));
    expect(await findH1('Your interview is complete.')).toBeVisible();
    expect(readNonce(LINK)).toBeNull();
    expect(h.media).not.toBeNull();
    expect(h.media?.audio.stop).toHaveBeenCalled();
    expect(h.media?.video.stop).toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Live video interview' })).toBeNull();
  });

  it('leaves through the controller after a confirmation, keeping the nonce', async () => {
    const live = await toLive();
    fireEvent.click(screen.getByRole('button', { name: 'Leave interview' }));
    expect(live.controller.leave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, leave' }));
    expect(await findH1('You left the interview.')).toBeVisible();
    expect(live.controller.leave).toHaveBeenCalledTimes(1);
    expect(readNonce(LINK)).toBe(NONCE);
  });

  it('shows a dropped-connection card without forgetting the nonce', async () => {
    const live = await toLive();
    act(() => live.handlers.onEnded('disconnected'));
    expect(
      await findH1('The connection to your interview ended.'),
    ).toBeVisible();
    expect(readNonce(LINK)).toBe(NONCE);
  });

  it('makes no completion, upload or recording call of any kind', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const live = await toLive();
    act(() => live.handlers.onEnded('agent_ended'));
    await findH1('Your interview is complete.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('disposes the room and stops the tracks if the page unmounts mid-interview', async () => {
    const live = await toLive();
    view.unmount();
    expect(live.controller.dispose).toHaveBeenCalledTimes(1);
    expect(h.media?.audio.stop).toHaveBeenCalled();
    expect(h.media?.video.stop).toHaveBeenCalled();
  });

  it('shows a distinct card, and forgets the nonce, when the worker aborted', async () => {
    const live = await toLive();
    act(() => live.handlers.onEnded('aborted'));
    expect(
      await findH1('Your interview was stopped because of a technical problem.'),
    ).toBeVisible();
    expect(screen.getByText(/will not count against you/)).toBeVisible();
    expect(screen.queryByText('Your interview is complete.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rejoin interview' })).toBeNull();
    expect(readNonce(LINK)).toBeNull();
    expect(h.media?.video.stop).toHaveBeenCalled();
  });

  it('shows the completed card for an interview the agent ended', async () => {
    const live = await toLive();
    act(() => live.handlers.onEnded('agent_ended'));
    expect(await findH1('Your interview is complete.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Rejoin interview' })).toBeNull();
  });

  it('does not link to /appeal, which answers a grant-less visit with "invalid link"', async () => {
    const live = await toLive();
    act(() => live.handlers.onEnded('agent_ended'));
    await findH1('Your interview is complete.');
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.innerHTML).not.toContain('/appeal');
    expect(screen.getByText(/reply to the hiring team.s email/)).toBeVisible();
  });
});

describe('rejoining within the grace window', () => {
  it.each(['disconnected', 'left'] as const)(
    'offers a Rejoin interview button after %s and rejoins with the stored nonce',
    async (reason) => {
      // The nonce was stored by the first attempt itself: nothing is seeded by hand.
      const live = await toLive();
      expect(h.createAttempt).toHaveBeenLastCalledWith(LINK, null);
      act(() => live.handlers.onEnded(reason));
      expect(await screen.findByText(/select Rejoin within 90 seconds/)).toBeVisible();
      expect(window.location.href).not.toContain(LINK);

      fireEvent.click(screen.getByRole('button', { name: 'Rejoin interview' }));
      // The same checks as a first visit: status, then the device check.
      expect(await findH1('Video interview')).toBeVisible();
      expect(h.status).toHaveBeenCalledTimes(2);
      fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
      await screen.findByRole('region', { name: 'Live video interview' });

      expect(h.createAttempt).toHaveBeenCalledTimes(2);
      expect(h.createAttempt).toHaveBeenLastCalledWith(LINK, NONCE);
      expect(h.created).toHaveLength(2);
      expect(h.created[1].controller.connect).toHaveBeenCalledWith(
        'wss://r1.invalid',
        'room-token',
        h.media,
      );
    },
  );

  it('rejoins from a dropped connection even though the page was never reloaded', async () => {
    const live = await toLive();
    act(() => live.handlers.onEnded('disconnected'));
    await findH1('The connection to your interview ended.');
    expect(readNonce(LINK)).toBe(NONCE);
    expect(window.location.hash).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin interview' }));
    expect(await findH1('Video interview')).toBeVisible();
    expect(h.status).toHaveBeenLastCalledWith(LINK);
  });

  it('starts from a clean live view after rejoining', async () => {
    const live = await toLive();
    act(() => live.handlers.onPhase('roleplay'));
    act(() => live.handlers.onAgentPresent(true));
    act(() => live.handlers.onEnded('disconnected'));
    await findH1('The connection to your interview ended.');
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin interview' }));
    await findH1('Video interview');
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    await screen.findByRole('region', { name: 'Live video interview' });
    expect(screen.getByText('Connecting')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Your role-play' })).toBeNull();
  });

  it('closes the link instead when the status check says the interview is over', async () => {
    const live = await toLive();
    act(() => live.handlers.onEnded('disconnected'));
    await findH1('The connection to your interview ended.');
    h.status.mockResolvedValue({ ...STATUS, state: 'completed' });
    fireEvent.click(screen.getByRole('button', { name: 'Rejoin interview' }));
    expect(await findH1('Your interview is already complete')).toBeVisible();
  });
});

describe('the phase label and the interviewer', () => {
  it('does not claim to be waiting for an interviewer who is already in the room', async () => {
    const live = await toLive();
    expect(screen.getByText('Connecting')).toBeVisible();
    act(() => live.handlers.onAgentPresent(true));
    expect(screen.getByText('Interview in progress')).toBeVisible();
    expect(screen.queryByText(/Waiting for your interviewer/)).toBeNull();
    act(() => live.handlers.onPhase('icebreaker'));
    expect(screen.getByText('Getting to know you')).toBeVisible();
    expect(screen.queryByText('Interview in progress')).toBeNull();
  });

  it('goes back to waiting if the interviewer leaves before announcing a phase', async () => {
    const live = await toLive();
    act(() => live.handlers.onAgentPresent(true));
    act(() => live.handlers.onAgentPresent(false));
    expect(screen.getByText('Connecting')).toBeVisible();
  });
});

async function confirmWithdraw(user = userEvent.setup()): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
  const group = screen.getByRole('group', { name: 'Withdraw consent' });
  await user.click(within(group).getByRole('button', { name: 'Withdraw my consent' }));
}

describe('a declined or withdrawn consent is the person’s final answer on this page', () => {
  it.each([
    ['declined', 'This interview cannot start without your consent'],
    ['withdrawn', 'We have recorded your withdrawal'],
  ])('shows the %s card on reopening, never the notice and never a new grant', async (state, title) => {
    h.status.mockResolvedValue({ ...STATUS, consent_state: state, can_start: false });
    openPage();
    expect(await findH1(title)).toBeVisible();
    expect(h.consentTemplate).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Notice and consent' })).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /camera|agree/i })).toBeNull();
    expect(h.submitConsent).not.toHaveBeenCalled();
    expect(h.createAttempt).not.toHaveBeenCalled();
  });

  it('says what the person was told when they chose, for both choices', async () => {
    h.status.mockResolvedValue({ ...STATUS, consent_state: 'withdrawn', can_start: false });
    openPage();
    await findH1('We have recorded your withdrawal');
    expect(screen.getByText(/No interview will be held with this link/)).toBeVisible();
    view.unmount();

    h.status.mockResolvedValue({ ...STATUS, consent_state: 'declined', can_start: false });
    openPage();
    await findH1('This interview cannot start without your consent');
    expect(screen.getByText(/conversation with a person instead/)).toBeVisible();
  });

  it.each([
    ['paused', { availability: 'paused' }],
    ['switched off', { availability: 'disabled' }],
    ['expired', { state: 'expired' }],
    ['out of attempts', { attempts_left: 0 }],
    ['completed', { state: 'completed' }],
  ])('puts the person’s own choice before a link that is %s', async (_name, over) => {
    h.status.mockResolvedValue({ ...STATUS, consent_state: 'withdrawn', can_start: false, ...over });
    openPage();
    expect(await findH1('We have recorded your withdrawal')).toBeVisible();
  });

  it('keeps showing the withdrawal after a reload, which is a fresh status read', async () => {
    const user = userEvent.setup();
    await toLanding();
    await confirmWithdraw(user);
    expect(await findH1('We have recorded your withdrawal')).toBeVisible();
    view.unmount();

    h.status.mockResolvedValue({ ...STATUS, consent_state: 'withdrawn', can_start: false });
    openPage();
    expect(await findH1('We have recorded your withdrawal')).toBeVisible();
    expect(h.consentTemplate).not.toHaveBeenCalled();
  });
});

describe('a consent can always be ended from the page', () => {
  it.each([
    ['R1 is paused', { availability: 'paused' }, 'We cannot start interviews right now'],
    ['R1 is switched off', { availability: 'disabled' }, 'We cannot start interviews right now'],
    ['the interview is complete', { state: 'completed' }, 'Your interview is already complete'],
    ['every attempt is used', { attempts_left: 0 }, 'Your interview is already complete'],
    ['the link has expired', { state: 'expired' }, 'This interview link has expired'],
    ['the link was cancelled', { state: 'cancelled' }, 'This interview link was cancelled'],
    [
      'no start is left',
      { can_start: false, starts_left: 0, live_attempt: false },
      'This link cannot start another interview',
    ],
  ])('offers withdrawal on a card shown when %s', async (_name, over, title) => {
    saveNonce(LINK, NONCE);
    h.status.mockResolvedValue({ ...STATUS, ...over });
    openPage();
    expect(await findH1(title)).toBeVisible();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();

    await confirmWithdraw();
    expect(h.withdrawConsent).toHaveBeenCalledTimes(1);
    expect(h.withdrawConsent).toHaveBeenCalledWith(LINK);
    expect(await findH1('We have recorded your withdrawal')).toBeVisible();
    expect(readNonce(LINK)).toBeNull();
    // The consent is gone: no way left to withdraw it again, and none to start.
    expect(screen.queryByRole('button', { name: 'Withdraw my consent' })).toBeNull();
  });

  it('asks before it withdraws, and a card that is not a consent card offers nothing', async () => {
    const user = userEvent.setup();
    h.status.mockResolvedValue({ ...STATUS, availability: 'disabled' });
    openPage();
    await findH1('We cannot start interviews right now');
    await user.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
    expect(h.withdrawConsent).not.toHaveBeenCalled();
    expect(screen.getByText(/this cannot be undone from this page/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Keep my consent' }));
    expect(h.withdrawConsent).not.toHaveBeenCalled();
    expect(screen.queryByRole('group', { name: 'Withdraw consent' })).toBeNull();

    // An unknown link, an outage and an unsupported browser have no consent to take back.
    view.unmount();
    h.status.mockRejectedValue(new ApiError('http_404', 404));
    openPage();
    await findH1('We could not open this link');
    expect(screen.queryByRole('button', { name: 'Withdraw my consent' })).toBeNull();
  });

  it('offers no withdrawal where no consent is on file', async () => {
    h.status.mockResolvedValue({ ...NEEDS_CONSENT, state: 'completed' });
    openPage();
    await findH1('Your interview is already complete');
    expect(screen.queryByRole('button', { name: 'Withdraw my consent' })).toBeNull();
  });

  it('says so when the withdrawal could not be recorded, and lets the person try again', async () => {
    h.withdrawConsent.mockRejectedValueOnce(new ApiError('http_503', 503));
    h.status.mockResolvedValue({ ...STATUS, availability: 'disabled' });
    openPage();
    await findH1('We cannot start interviews right now');
    await confirmWithdraw();
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not record your withdrawal/);
    expect(screen.getByRole('heading', { level: 1, name: /cannot start interviews/ })).toBeVisible();

    const group = screen.getByRole('group', { name: 'Withdraw consent' });
    fireEvent.click(within(group).getByRole('button', { name: 'Withdraw my consent' }));
    expect(await findH1('We have recorded your withdrawal')).toBeVisible();
    expect(h.withdrawConsent).toHaveBeenCalledTimes(2);
  });

  it.each(['paused', 'disabled'])(
    'offers a decline while R1 is %s, from the notice the server still serves',
    async (availability) => {
      const user = userEvent.setup();
      h.status.mockResolvedValue({ ...NEEDS_CONSENT, availability });
      openPage();
      expect(await findH1('We cannot start interviews right now')).toBeVisible();
      // The notice is read for its version only: it is not shown, and nothing is ticked.
      expect(h.consentTemplate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('heading', { name: 'Notice and consent' })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Withdraw my consent' })).toBeNull();

      await user.click(screen.getByRole('button', { name: 'I do not want to take this interview' }));
      expect(h.submitConsent).not.toHaveBeenCalled();
      const group = screen.getByRole('group', { name: 'Decline the interview' });
      await user.click(within(group).getByRole('button', { name: 'Decline the interview' }));
      expect(h.submitConsent).toHaveBeenCalledWith(LINK, {
        template_version: 'r1-2026-10',
        consents: [],
        status: 'declined',
      });
      expect(
        await screen.findByRole('heading', {
          level: 1,
          name: 'This interview cannot start without your consent',
        }),
      ).toBeVisible();
      expect(h.createAttempt).not.toHaveBeenCalled();
    },
  );

  it('says so when a decline from the paused card could not be recorded, and keeps the card', async () => {
    const user = userEvent.setup();
    h.submitConsent.mockRejectedValueOnce(new ApiError('http_500', 500));
    h.status.mockResolvedValue({ ...NEEDS_CONSENT, availability: 'paused' });
    openPage();
    await findH1('We cannot start interviews right now');
    await user.click(screen.getByRole('button', { name: 'I do not want to take this interview' }));
    const group = screen.getByRole('group', { name: 'Decline the interview' });
    await user.click(within(group).getByRole('button', { name: 'Decline the interview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not record your choice/);
    expect(screen.getByRole('heading', { level: 1, name: /cannot start interviews/ })).toBeVisible();
  });

  it('offers no decline when the notice cannot be read, and still shows the paused card', async () => {
    h.consentTemplate.mockRejectedValue(new ApiError('consent_template_unavailable', 503));
    h.status.mockResolvedValue({ ...NEEDS_CONSENT, availability: 'paused' });
    openPage();
    expect(await findH1('We cannot start interviews right now')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'I do not want to take this interview' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  it('does not read the notice for a person who has already agreed', async () => {
    h.status.mockResolvedValue({ ...STATUS, availability: 'paused' });
    openPage();
    await findH1('We cannot start interviews right now');
    expect(h.consentTemplate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'I do not want to take this interview' })).toBeNull();
  });

  describe('inside the live room', () => {
    it('withdraws, leaves the room, stops the camera and forgets the interview', async () => {
      const live = await toLive();
      expect(readNonce(LINK)).toBe(NONCE);
      await confirmWithdraw();

      expect(h.withdrawConsent).toHaveBeenCalledWith(LINK);
      expect(await findH1('We have recorded your withdrawal')).toBeVisible();
      expect(live.controller.dispose).toHaveBeenCalledTimes(1);
      expect(h.media?.audio.stop).toHaveBeenCalled();
      expect(h.media?.video.stop).toHaveBeenCalled();
      expect(readNonce(LINK)).toBeNull();
      expect(screen.queryByRole('region', { name: 'Live video interview' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Rejoin interview' })).toBeNull();
    });

    it('is a different control from Leave, which can be rejoined', async () => {
      const live = await toLive();
      fireEvent.click(screen.getByRole('button', { name: 'Leave interview' }));
      expect(screen.getByRole('group', { name: 'Leave the interview' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Withdraw my consent' })).toBeVisible();
      expect(h.withdrawConsent).not.toHaveBeenCalled();
      expect(live.controller.leave).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Withdraw my consent' }));
      expect(screen.getByText(/ends your interview now and it cannot be rejoined/)).toBeVisible();
    });

    it('does not show the room ending as a lost connection while the withdrawal is in flight', async () => {
      let release: () => void = () => undefined;
      h.withdrawConsent.mockReturnValue(new Promise<void>((resolve) => { release = resolve; }));
      const live = await toLive();
      await confirmWithdraw();

      // The server cuts the room as part of the withdrawal; that must not offer a rejoin.
      act(() => live.handlers.onEnded('disconnected'));
      expect(screen.queryByRole('heading', { name: 'The connection to your interview ended.' })).toBeNull();
      expect(screen.getByRole('region', { name: 'Live video interview' })).toBeVisible();

      await act(async () => {
        release();
      });
      expect(await findH1('We have recorded your withdrawal')).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Rejoin interview' })).toBeNull();
      expect(readNonce(LINK)).toBeNull();
    });

    it('stays in the interview, and says so, when the withdrawal could not be recorded', async () => {
      h.withdrawConsent.mockRejectedValueOnce(new ApiError('r1_withdraw_incomplete', 503));
      const live = await toLive();
      await confirmWithdraw();
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not record your withdrawal/);
      expect(screen.getByRole('region', { name: 'Live video interview' })).toBeVisible();
      expect(live.controller.dispose).not.toHaveBeenCalled();
      expect(h.media?.video.stop).not.toHaveBeenCalled();
      expect(readNonce(LINK)).toBe(NONCE);
    });

    it('shows the ending after all when the room ended and the withdrawal then failed', async () => {
      let fail: (error: Error) => void = () => undefined;
      h.withdrawConsent.mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject; }));
      const live = await toLive();
      await confirmWithdraw();
      act(() => live.handlers.onEnded('disconnected'));
      await act(async () => {
        fail(new ApiError('http_503', 503));
      });
      expect(await findH1('The connection to your interview ended.')).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent(/could not record your withdrawal/);
      expect(screen.getByRole('button', { name: 'Rejoin interview' })).toBeVisible();
      expect(readNonce(LINK)).toBe(NONCE);
    });
  });

  describe('after the interview', () => {
    it.each(['agent_ended', 'left', 'disconnected', 'aborted'] as const)(
      'offers withdrawal on the closing screen (%s) and takes it',
      async (reason) => {
        const live = await toLive();
        act(() => live.handlers.onEnded(reason));
        await screen.findByRole('heading', { level: 1 });
        await confirmWithdraw();
        expect(h.withdrawConsent).toHaveBeenCalledWith(LINK);
        expect(await findH1('We have recorded your withdrawal')).toBeVisible();
        expect(readNonce(LINK)).toBeNull();
      },
    );

    it('keeps the closing screen, with an error, when the withdrawal could not be recorded', async () => {
      h.withdrawConsent.mockRejectedValueOnce(new ApiError('http_503', 503));
      const live = await toLive();
      act(() => live.handlers.onEnded('agent_ended'));
      await findH1('Your interview is complete.');
      await confirmWithdraw();
      expect(await screen.findByRole('alert')).toHaveTextContent(/could not record your withdrawal/);
      expect(screen.getByRole('heading', { level: 1, name: 'Your interview is complete.' })).toBeVisible();
    });
  });
});

describe('a link with nothing left to start', () => {
  const NO_STARTS = { ...STATUS, can_start: false, starts_left: 0, live_attempt: false };

  it('closes with a contact-the-team card instead of running a device check that cannot succeed', async () => {
    h.status.mockResolvedValue(NO_STARTS);
    openPage();
    const title = await findH1('This link cannot start another interview');
    expect(title).toBeVisible();
    expect(screen.getByText(/Please contact the hiring team/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
    expect(h.createAttempt).not.toHaveBeenCalled();
  });

  it('does not ask for consent a link that can never start', async () => {
    h.status.mockResolvedValue({ ...NO_STARTS, consent_state: 'required' });
    openPage();
    await findH1('This link cannot start another interview');
    expect(h.consentTemplate).not.toHaveBeenCalled();
  });

  it('still lets the person back into the interview that is live, even with no start left', async () => {
    saveNonce(LINK, NONCE);
    h.status.mockResolvedValue({ ...NO_STARTS, live_attempt: true, state: 'in_progress' });
    openPage();
    expect(await findH1('Video interview')).toBeVisible();
  });

  it('does not close a link on a server that does not report the counts', async () => {
    h.status.mockResolvedValue({ ...STATUS, starts_left: null, can_start: null, live_attempt: null });
    openPage();
    expect(await findH1('Video interview')).toBeVisible();
  });

  it.each([
    ['starts_exhausted', 'This link cannot start another interview'],
    ['attempts_exhausted', 'Your interview is already complete'],
  ])('answers %s from admission with its own card, the camera off and no retry loop', async (code, title) => {
    h.createAttempt.mockRejectedValue(new ApiError(code, 409));
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await findH1(title)).toBeVisible();
    expect(h.media?.video.stop).toHaveBeenCalled();
    expect(h.exchange).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /camera/i })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  describe('an interview of this link that is live elsewhere', () => {
    const ELSEWHERE = { ...STATUS, can_start: false, live_attempt: true, state: 'in_progress' };

    it('says it is open on another device instead of making the person try', async () => {
      h.status.mockResolvedValue(ELSEWHERE);
      openPage();
      expect(await findH1('Video interview')).toBeVisible();
      expect(screen.getByRole('status')).toHaveTextContent(
        'Your interview is open on another device or browser tab',
      );
    });

    it('words a busy answer as the person’s own interview, not "another interview"', async () => {
      h.status.mockResolvedValue(ELSEWHERE);
      h.createAttempt.mockRejectedValue(new ApiError('r1_busy', 409));
      openPage();
      await findH1('Video interview');
      fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Your interview is open on another device or browser tab');
      expect(alert).not.toHaveTextContent('Another interview is finishing');
      expect(alert).toHaveTextContent('Your link stays valid');
    });

    it('says nothing of the kind to the tab that holds the interview (it can rejoin)', async () => {
      saveNonce(LINK, NONCE);
      h.status.mockResolvedValue(ELSEWHERE);
      openPage();
      expect(await findH1('Video interview')).toBeVisible();
      expect(screen.queryByRole('status')).toBeNull();
    });

    it('keeps the generic wording when it is somebody else’s interview that is busy', async () => {
      h.createAttempt.mockRejectedValue(new ApiError('r1_busy', 409));
      await toLanding();
      expect(screen.queryByRole('status')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Another interview is finishing');
    });
  });
});

describe('a staff dry run is spoken to as staff', () => {
  const STAFF = { ...STATUS, audience: 'staff' };

  it('does not promise a hiring team’s review, or a way to contest, on the closing screens', async () => {
    h.status.mockResolvedValue(STAFF);
    const live = await toLive();
    act(() => live.handlers.onEnded('agent_ended'));
    expect(await findH1('Your interview is complete.')).toBeVisible();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/The project team will review it/);
    expect(text).toMatch(/not used to make any decision about you/);
    expect(text).not.toMatch(/hiring team|contest|appeal link/i);
  });

  it.each([
    ['completed', { state: 'completed' }, /project team will review it/],
    ['expired', { state: 'expired' }, /Tell the project team/],
    ['cancelled', { state: 'cancelled' }, /Tell the project team/],
    ['withdrawn', { consent_state: 'withdrawn' }, /Tell the project team/],
    ['declined', { consent_state: 'declined' }, /Please tell the project team/],
    ['out of starts', { can_start: false, starts_left: 0 }, /Please tell the project team/],
  ])('speaks of the project team when the link is %s', async (_name, over, expected) => {
    h.status.mockResolvedValue({ ...STAFF, ...over });
    openPage();
    const body = await screen.findByText(expected);
    expect(body).toBeVisible();
    expect(document.body.textContent).not.toMatch(/hiring team|conversation with a person/);
  });

  it('ends a technical stop and a lost connection by pointing at the project team', async () => {
    h.status.mockResolvedValue(STAFF);
    const live = await toLive();
    act(() => live.handlers.onEnded('disconnected'));
    await findH1('The connection to your interview ended.');
    expect(document.body.textContent).toMatch(/Otherwise tell the project team/);
    expect(document.body.textContent).not.toMatch(/hiring team/);
  });

  it('keeps the candidate wording for a candidate, and for anything the server does not name', async () => {
    h.status.mockResolvedValue({ ...STATUS, state: 'completed' });
    openPage();
    await findH1('Your interview is already complete');
    expect(screen.getByText(/The hiring team will review it and get back to you/)).toBeVisible();
    view.unmount();

    h.status.mockResolvedValue({ ...STATUS, state: 'completed', audience: 'something-new' });
    openPage();
    await findH1('Your interview is already complete');
    expect(screen.getByText(/The hiring team will review it and get back to you/)).toBeVisible();
  });
});
