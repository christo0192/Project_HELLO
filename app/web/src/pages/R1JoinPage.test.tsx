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
  created: [] as Array<{
    handlers: {
      onPhase: (phase: string) => void;
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
  required_consents: ['ai_interview', 'recording', 'ai_evaluation'],
  consent_items: [],
};
const STATUS = {
  state: 'invited',
  attempts_left: 2,
  consent_required: false,
  role_title: 'Sales Program Advisor',
  format: { duration_minutes: 20, summary: null },
  budget_paused: false,
};
const ATTEMPT = {
  attempt_token: 'attempt-token',
  nonce: NONCE,
  session_id: null,
  lead: { name: 'Meera', city: 'Pune' },
  attempts_left: 1,
};
const ROOM = {
  status: 'ready',
  url: 'wss://r1.invalid',
  livekit_token: 'room-token',
  session_id: null,
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
    h.status.mockResolvedValueOnce({ ...STATUS, budget_paused: true });
    openPage();
    const paused = await findH1('We cannot start interviews right now');
    expect(paused).toBeVisible();
    expect(screen.getByText(/Your link stays valid/)).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await findH1('Video interview')).toBeVisible();
    expect(h.status).toHaveBeenCalledTimes(2);
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
    h.status.mockResolvedValue({ ...STATUS, consent_required: true });
    openPage();
    return findH1('Notice and consent');
  }

  it('shows the notice first and lets nothing proceed without every purpose', async () => {
    await toNotice();
    expect(h.consentTemplate).toHaveBeenCalledWith(LINK, 'en-IN');
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
      locale: 'en-IN',
      consents: ['ai_interview', 'recording', 'ai_evaluation'],
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
      locale: 'en-IN',
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
    h.createAttempt.mockRejectedValue(new ApiError('consent_withdrawn', 409));
    h.status
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValue({ ...STATUS, consent_required: true });
    await toLanding();
    fireEvent.click(screen.getByRole('button', { name: 'Check my camera and microphone' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Pass device check' }));
    expect(await findH1('Notice and consent')).toBeVisible();
  });

  it('returns to the notice when the device check reports lapsed consent', async () => {
    h.status
      .mockResolvedValueOnce(STATUS)
      .mockResolvedValue({ ...STATUS, consent_required: true });
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
    expect(within(card).getByText('Meera from Pune')).toBeVisible();

    act(() => live.handlers.onPhase('roleplay'));
    expect(screen.getByText('Role-play')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Your role-play' })).toBeVisible();

    act(() => live.handlers.onPhase('paused_disconnected'));
    expect(screen.getByRole('region', { name: 'Your role-play' })).toBeVisible();

    act(() => live.handlers.onPhase('roleplay_exit'));
    expect(screen.queryByRole('region', { name: 'Your role-play' })).toBeNull();
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
