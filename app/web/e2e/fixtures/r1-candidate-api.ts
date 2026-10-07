/**
 * The fake R1 candidate API (plan section 8.3, PR-3 routes).
 *
 * Mirrors exactly the routes `src/lib/r1/r1-api.ts` calls, with the same
 * wire shapes, so reconciling with the merged PR-3 means changing that client,
 * this file and nothing else. State is per test and mutable: a test flips
 * `consentRequired`, queues `exchangePreparing` answers, or installs an error
 * for one route, and reads back every request body the page sent.
 *
 * The link token is checked exactly as the real routes would: a body carrying
 * the wrong token is answered 404, never 200, so a page that sent the token in
 * the wrong place (or not at all) fails visibly. That includes the consent
 * template, which is a POST carrying the token in its body (see R1_CONTRACT in
 * src/lib/r1/r1-api.ts): a GET, or a token in the URL, is not a route here.
 *
 * Concurrency is 1 (plan section 5.11): once an attempt has been admitted the
 * candidate's own session is live, and a further `attempts` call is refused as
 * `r1_busy` unless it presents the attempt's nonce. A page that forgets the
 * nonce therefore cannot rejoin, exactly as against the real server.
 *
 * Nothing here is verified against PR-3 (it is built in parallel). It mirrors
 * the web client and so proves the page is self-consistent, not that the server
 * agrees; src/lib/r1/r1-contract.test.ts is the guard against that drift.
 */

import type { MockResponse } from './api-router';
import type { ApiRouter } from './harness';
import { MOCK_LIVEKIT_ORIGIN } from './env';

/** 64 lowercase hex characters, the shape the page accepts from the fragment. */
export const R1_LINK_TOKEN = 'e2e1'.repeat(16);
export const R1_ATTEMPT_TOKEN = 'e2e-attempt-token-not-a-secret';
export const R1_NONCE = 'e2e-nonce-0123456789abcdef';

export interface R1RecordedRequest {
  method: string;
  path: string;
  query: string;
  body: Record<string, unknown> | null;
}

export interface R1ForcedError {
  status: number;
  error: string;
}

export interface R1MockState {
  requests: R1RecordedRequest[];
  roundState: 'invited' | 'in_progress' | 'completed' | 'expired' | 'cancelled';
  attemptsLeft: number;
  consentRequired: boolean;
  budgetPaused: boolean;
  declined: boolean;
  withdrawn: boolean;
  /** An attempt was admitted and has not been finished: the candidate's own session is live. */
  liveSession: boolean;
  /** How many 202 `preparing` answers the exchange gives before the room is ready. */
  exchangePreparing: number;
  /** Install an error to make one route fail (consumed on use unless `sticky`). */
  failures: Partial<Record<'status' | 'preflight' | 'attempts' | 'exchange' | 'consent', R1ForcedError>>;
}

export function createR1State(): R1MockState {
  return {
    requests: [],
    roundState: 'invited',
    attemptsLeft: 2,
    consentRequired: true,
    budgetPaused: false,
    declined: false,
    withdrawn: false,
    liveSession: false,
    exchangePreparing: 0,
    failures: {},
  };
}

export const R1_TEMPLATE = {
  version: 'e2e-r1-v1',
  locale: 'en-IN',
  title: 'Notice and consent for your AI interview',
  body_md: [
    '# What we collect',
    'Your camera video, voice, interview transcript, scores, and your device and IP address.',
    '',
    '# Who processes it',
    '- Sarvam AI (speech)',
    '- DeepSeek (language model)',
    '- LiveKit Cloud (media relay)',
    '',
    '# Your choices',
    'You can withdraw your consent at any time from your interview link. If you decline, the hiring team will arrange a conversation with a person instead.',
  ].join('\n'),
  required_consents: ['ai_interview', 'recording', 'ai_evaluation'],
  consent_items: [],
};

const json = (status: number, body: unknown): MockResponse => ({ status, json: body });
const fail = (error: R1ForcedError): MockResponse => json(error.status, { error: error.error });

function tokenOk(body: Record<string, unknown> | null): boolean {
  return body?.link_token === R1_LINK_TOKEN;
}

export function r1Router(state: R1MockState): ApiRouter {
  return (method, url, body) => {
    if (!url.pathname.startsWith('/api/r1/')) return null;
    state.requests.push({ method, path: url.pathname, query: url.search, body });
    const route = `${method} ${url.pathname}`;

    const forced = (key: keyof R1MockState['failures']): MockResponse | null => {
      const failure = state.failures[key];
      if (!failure) return null;
      delete state.failures[key];
      return fail(failure);
    };

    switch (route) {
      case 'POST /api/r1/status': {
        if (!tokenOk(body)) return json(404, { error: 'link_invalid' });
        return (
          forced('status') ??
          json(200, {
            state: state.roundState,
            attempts_left: state.attemptsLeft,
            consent_required: state.consentRequired,
            role_title: 'Sales Program Advisor',
            format: { duration_minutes: 20, summary: null },
            budget_paused: state.budgetPaused,
          })
        );
      }
      case 'POST /api/r1/consent-template':
        if (!tokenOk(body)) return json(404, { error: 'link_invalid' });
        if (body?.locale !== R1_TEMPLATE.locale) return json(400, { error: 'locale_unsupported' });
        return json(200, R1_TEMPLATE);
      case 'POST /api/r1/consent': {
        if (!tokenOk(body)) return json(404, { error: 'link_invalid' });
        const failure = forced('consent');
        if (failure) return failure;
        if (body?.template_version !== R1_TEMPLATE.version) return json(409, { error: 'consent_version_stale' });
        if (body?.status === 'declined') {
          state.declined = true;
          return json(200, { ok: true });
        }
        const given = Array.isArray(body?.consents) ? (body?.consents as string[]) : [];
        if (!R1_TEMPLATE.required_consents.every((type) => given.includes(type))) {
          return json(400, { error: 'consents_incomplete' });
        }
        state.consentRequired = false;
        return json(200, { ok: true });
      }
      case 'POST /api/r1/consent/withdraw':
        if (!tokenOk(body)) return json(404, { error: 'link_invalid' });
        state.withdrawn = true;
        state.consentRequired = true;
        return json(200, { ok: true });
      case 'POST /api/r1/preflight': {
        if (!tokenOk(body)) return json(404, { error: 'link_invalid' });
        const failure = forced('preflight');
        if (failure) return failure;
        if (state.consentRequired) return json(409, { error: 'consent_required' });
        return json(200, {
          url: MOCK_LIVEKIT_ORIGIN,
          livekit_token: 'e2e-preflight-room-token',
          expires_at: '2026-09-16T06:40:00.000Z',
          policy_version: 'r1-av-v1',
        });
      }
      case 'POST /api/r1/attempts': {
        if (!tokenOk(body)) return json(404, { error: 'link_invalid' });
        const failure = forced('attempts');
        if (failure) return failure;
        if (state.liveSession && body?.nonce !== R1_NONCE) return json(409, { error: 'r1_busy' });
        state.liveSession = true;
        return json(200, {
          attempt_token: R1_ATTEMPT_TOKEN,
          nonce: R1_NONCE,
          session_id: 'e2e00000-0000-4000-8000-0000000000a1',
          lead: { name: 'Meera', city: 'Pune' },
          attempts_left: Math.max(0, state.attemptsLeft - 1),
        });
      }
      case 'POST /api/r1/exchange': {
        if (body?.attempt_token !== R1_ATTEMPT_TOKEN || body?.nonce !== R1_NONCE) {
          return json(401, { error: 'attempt_invalid' });
        }
        const failure = forced('exchange');
        if (failure) return failure;
        if (state.exchangePreparing > 0) {
          state.exchangePreparing -= 1;
          return json(202, { status: 'preparing' });
        }
        return json(200, {
          url: MOCK_LIVEKIT_ORIGIN,
          livekit_token: 'e2e-interview-room-token',
          session_id: 'e2e00000-0000-4000-8000-0000000000a1',
        });
      }
      default:
        // An /api/r1/ route the page called that this fake does not know:
        // answered null so the harness fails the test loudly.
        return null;
    }
  };
}
