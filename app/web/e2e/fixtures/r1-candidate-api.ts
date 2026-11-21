/**
 * The fake R1 candidate API (plan section 8.3, PR-3 routes).
 *
 * Mirrors the PR-3 routes `src/lib/r1/r1-api.ts` calls (app/api/src/routes/
 * r1-candidate.ts, documented in app/api/openapi/openapi.yaml), with the same
 * wire shapes and status codes. State is per test and mutable: a test flips
 * `consentRequired`, queues `exchangePreparing` answers, or installs an error
 * for one route, and reads back every request body the page sent.
 *
 * The link token is the body field `token`, checked exactly as the real routes
 * would: a body carrying the wrong token is answered 404, never 200, so a page
 * that sent the token in the wrong place (or not at all) fails visibly. That
 * includes the consent template, which is a POST carrying the token in its
 * body (see R1_CONTRACT in src/lib/r1/r1-api.ts): a GET, or a token in the URL,
 * is not a route here. The routes are strict about their bodies like the real
 * ones: a request naming a locale (the notice audience is server-owned) is a 400,
 * answered with the real validator's envelope (`{ error: { type, message, details } }`,
 * app/api/src/lib/validation.ts), not a bare code.
 *
 * The consent a status reports follows what the person did, as the real routes do:
 * `required` until they act, then `granted`, `declined` or `withdrawn`. A withdrawn
 * link reads `withdrawn`, never `required`, so a page that offered a new grant to a
 * person who had just withdrawn would be seen doing it here.
 *
 * Concurrency is 1 (plan section 5.11): once an attempt has been admitted the
 * candidate's own session is live, and a further `attempts` call is refused as
 * `r1_busy` unless it presents the attempt's nonce. A page that forgets the
 * nonce therefore cannot rejoin, exactly as against the real server.
 *
 * The Meet bridge's `POST /api/r1/meet/exchange` (M034 S07; contract sections 4 and 9) is here
 * too: the ticket travels in the body, a claimed ticket is refused unless the call presents the
 * `resume_token` a 202 handed out, and the server's Meet switch answers 503 before anything else.
 * The real route is built later (M034 S05) from the same contract.
 *
 * Nothing here is verified against PR-3 (it is built in parallel). It mirrors
 * the web client and so proves the page is self-consistent, not that the server
 * agrees; src/lib/r1/r1-contract.test.ts is the guard against that drift.
 */

import type { MockResponse } from './api-router';
import type { ApiRouter } from './harness';
import { FROZEN_NOW_MS, MOCK_LIVEKIT_ORIGIN } from './env';

/**
 * "Now", for token lifetimes: the instant the browser's clock is frozen at (`page.clock.setFixedTime`
 * in the harness). The page reads `attempt_token_expires_at` against ITS clock, so a lifetime
 * counted from the machine's clock would put every token years away from, or behind, the page's
 * "now". Time does not pass in the page; a token lapses only by being minted with `ttl` 0.
 */
const now = (): number => FROZEN_NOW_MS;

/** 64 lowercase hex characters, the shape the page accepts from the fragment. */
export const R1_LINK_TOKEN = 'e2e1'.repeat(16);
export const R1_ATTEMPT_TOKEN = 'e2e-attempt-token-not-a-secret';
/**
 * What a rejoin-style `attempts` call (link + nonce) mints. The real attempt token lasts five
 * minutes and the role-play briefing comes later, so "I'm ready" must present a FRESH one: the
 * fake accepts only this token on `/api/r1/ready`, while the exchange takes either.
 */
export const R1_FRESH_ATTEMPT_TOKEN = 'e2e-fresh-attempt-token-not-a-secret';
export const R1_NONCE = 'e2e-nonce-0123456789abcdef';
/**
 * The Meet bridge ticket the Recall bot's page carries in `#t=` (M034; contract section 9 item 2:
 * `[A-Za-z0-9_-]{32,128}`). Plainly not a secret, so no scanner mistakes it for one.
 */
export const R1_MEET_TICKET = 'e2e-meet-ticket-not-a-secret-0123456789';
/** What a 202 `preparing` hands the bridge to present on its next call (contract section 9 item 4). */
export const R1_MEET_RESUME_TOKEN = 'e2e-meet-resume-not-a-secret';

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
  /** Whom the link is for: the status reports it so the closing screens can speak to them. */
  audience: 'candidate' | 'staff';
  declined: boolean;
  withdrawn: boolean;
  /** An attempt was admitted and has not been finished: the candidate's own session is live. */
  liveSession: boolean;
  /** How many 202 `preparing` answers the exchange gives before the room is ready. */
  exchangePreparing: number;
  /**
   * How long an attempt token minted from now lasts, in seconds (the real one: 300). The page
   * reads it back as `attempt_token_expires_at`; a test sets it to 0 BEFORE joining to stand for
   * "the briefing comes minutes after the join, and the join's token has lapsed by then".
   */
  attemptTokenTtlSec: number;
  /** When each token this fake minted stops being accepted by `/api/r1/ready`, in epoch ms. */
  tokenExpiresAt: Record<string, number>;
  /**
   * A Google Meet round (M034; contract section 3, refined in section 9). `null` is today's
   * server: the status body has no `channel` key at all. `'context'`: the status answers 200
   * with `channel: 'meet'` and `/attempts` refuses 409 `round_channel_meet`. `'refuse'`: both
   * `/status` and `/attempts` refuse 409 `round_channel_meet`. The real server may give either.
   */
  meetRound: null | 'context' | 'refuse';
  /** The server's Meet switch (`R1_MEET_ENABLED`) is off: the bridge exchange answers 503 `meet_disabled`. */
  meetDisabled: boolean;
  /** How many 202 `preparing` answers the bridge exchange gives before the room is ready. */
  meetPreparing: number;
  /**
   * The bridge ticket has been claimed (set by the first exchange that got past the checks, a 202
   * or a 200). From then on the ticket alone is refused as `ticket_already_claimed`: only the
   * continuation `{ ticket, resume_token }` a 202 handed out is let through.
   */
  meetClaimed: boolean;
  /** Install an error to make one route fail (consumed on use unless `sticky`). */
  failures: Partial<
    Record<
      'status' | 'preflight' | 'attempts' | 'exchange' | 'consent' | 'ready' | 'meetExchange',
      R1ForcedError
    >
  >;
}

export function createR1State(): R1MockState {
  return {
    requests: [],
    roundState: 'invited',
    attemptsLeft: 2,
    consentRequired: true,
    budgetPaused: false,
    audience: 'candidate',
    declined: false,
    withdrawn: false,
    liveSession: false,
    exchangePreparing: 0,
    attemptTokenTtlSec: 300,
    tokenExpiresAt: {},
    meetRound: null,
    meetDisabled: false,
    meetPreparing: 0,
    meetClaimed: false,
    failures: {},
  };
}

/** The four agreements PR-CT's notices require, with the candidate wording the server returns. */
const R1_CONSENT_ITEMS = [
  {
    type: 'ai_interview',
    label: 'I agree to take part in an interview led by an AI interviewer, including a sales role-play.',
  },
  {
    type: 'video_audio_recording',
    label: 'I agree to my camera video and voice being recorded for review by the hiring team.',
  },
  {
    type: 'ai_evaluation',
    label:
      'I agree to an AI evaluation of my interview that may update my application status, which the hiring team can review and change and which I can contest.',
  },
  {
    type: 'data_processing',
    label:
      "I agree to the providers listed in this notice, including DeepSeek in the People's Republic of China, processing my data.",
  },
];

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
  required_consents: R1_CONSENT_ITEMS.map((item) => item.type),
  consent_items: R1_CONSENT_ITEMS,
};

const json = (status: number, body: unknown): MockResponse => ({ status, json: body });

/**
 * The real 400 for a body the route's strict schema refuses: the shared validator's
 * envelope (app/api/src/lib/validation.ts), whose `error` is an object, not a code.
 */
const validationError = (): MockResponse =>
  json(400, {
    error: {
      type: 'validation_error',
      message: 'Request validation failed',
      details: [{ field: '(root)', code: 'unrecognized_keys', message: 'Unrecognized key(s) in object' }],
    },
  });

/** What the status route reports for the consent: the person's last action, as the server reads it. */
function consentState(state: R1MockState): 'granted' | 'required' | 'declined' | 'withdrawn' {
  if (!state.consentRequired) return 'granted';
  if (state.withdrawn) return 'withdrawn';
  if (state.declined) return 'declined';
  return 'required';
}
/** One stable answer for an unknown, expired or cancelled link, as the real routes give. */
const LINK_INVALID = 'r1_link_invalid_or_expired';
/** The refusal for a round that takes place in Google Meet (contract section 3; the string is fixed). */
const ROUND_CHANNEL_MEET = 'round_channel_meet';
const fail = (error: R1ForcedError): MockResponse => json(error.status, { error: error.error });

function tokenOk(body: Record<string, unknown> | null): boolean {
  return body?.token === R1_LINK_TOKEN;
}

/** The routes' bodies are strict: any key outside `allowed` is a 400. */
function onlyKeys(body: Record<string, unknown> | null, allowed: readonly string[]): boolean {
  return Object.keys(body ?? {}).every((key) => allowed.includes(key));
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
        if (!onlyKeys(body, ['token'])) return validationError();
        if (!tokenOk(body)) return json(404, { error: LINK_INVALID });
        if (state.meetRound === 'refuse') return json(409, { error: ROUND_CHANNEL_MEET });
        return (
          forced('status') ??
          json(200, {
            round_status: state.roundState,
            expires_at: '2026-10-10T00:00:00.000Z',
            availability: state.budgetPaused ? 'paused' : 'open',
            attempts_allowed: 2,
            attempts_remaining: state.attemptsLeft,
            starts_remaining: 3,
            consent: { state: consentState(state), template_version: R1_TEMPLATE.version },
            live_attempt: state.liveSession,
            can_start: !state.consentRequired && !state.budgetPaused && !state.liveSession,
            role_title: 'Sales Program Advisor',
            format: {
              duration_minutes: 20,
              camera_required: true,
              microphone_required: true,
              interviewer: 'ai',
              includes_role_play: true,
            },
            audience: state.audience,
            // Today's server sends no channel: the key appears only for a Meet round.
            ...(state.meetRound === 'context' ? { channel: 'meet' } : {}),
          })
        );
      }
      case 'POST /api/r1/consent-template':
        // Strict: a locale (or anything but the token) is a 400, the audience is the server's.
        if (!onlyKeys(body, ['token'])) return validationError();
        if (!tokenOk(body)) return json(404, { error: LINK_INVALID });
        return json(200, R1_TEMPLATE);
      case 'POST /api/r1/consent': {
        if (!onlyKeys(body, ['token', 'template_version', 'consents', 'status'])) {
          return validationError();
        }
        if (!tokenOk(body)) return json(404, { error: LINK_INVALID });
        const failure = forced('consent');
        if (failure) return failure;
        if (body?.status === 'declined') {
          state.declined = true;
          return json(201, {
            status: 'declined',
            consents: [],
            template_version: R1_TEMPLATE.version,
            locale: R1_TEMPLATE.locale,
            created_at: '2026-10-07T00:00:00.000Z',
          });
        }
        if (body?.template_version !== R1_TEMPLATE.version) {
          return json(409, { error: 'consent_template_stale', template_version: R1_TEMPLATE.version });
        }
        const given = Array.isArray(body?.consents) ? (body?.consents as string[]) : [];
        if (!R1_TEMPLATE.required_consents.every((type) => given.includes(type))) {
          return json(400, {
            error: 'required_consents_missing',
            missing_consents: R1_TEMPLATE.required_consents.filter((type) => !given.includes(type)),
          });
        }
        state.consentRequired = false;
        state.withdrawn = false;
        state.declined = false;
        return json(201, {
          id: 'e2e-consent-1',
          status: 'granted',
          consents: given,
          template_version: R1_TEMPLATE.version,
          locale: R1_TEMPLATE.locale,
          created_at: '2026-10-07T00:00:00.000Z',
        });
      }
      case 'POST /api/r1/consent/withdraw':
        if (!onlyKeys(body, ['token'])) return validationError();
        if (!tokenOk(body)) return json(404, { error: LINK_INVALID });
        state.withdrawn = true;
        state.consentRequired = true;
        return json(200, { ok: true, withdrawn: true, sessions_stopped: 0 });
      case 'POST /api/r1/preflight': {
        if (!onlyKeys(body, ['token'])) return validationError();
        if (!tokenOk(body)) return json(404, { error: LINK_INVALID });
        const failure = forced('preflight');
        if (failure) return failure;
        if (state.consentRequired) return json(409, { error: 'consent_required' });
        return json(200, {
          url: MOCK_LIVEKIT_ORIGIN,
          livekit_token: 'e2e-preflight-room-token',
          expires_at: '2026-09-16T06:40:00.000Z',
          policy_version: 'r1-av-v1',
          max_seconds: 10,
          min_audio_packets: 50,
          min_video_frames: 45,
        });
      }
      case 'POST /api/r1/attempts': {
        if (!onlyKeys(body, ['token', 'nonce'])) return validationError();
        if (!tokenOk(body)) return json(404, { error: LINK_INVALID });
        if (state.meetRound !== null) return json(409, { error: ROUND_CHANNEL_MEET });
        const failure = forced('attempts');
        if (failure) return failure;
        // Every token is minted with a lifetime, like the real route's (`attempt_token_expires_at`).
        const mint = (token: string, ttlSec: number) => {
          const expiresAt = now() + ttlSec * 1000;
          state.tokenExpiresAt[token] = expiresAt;
          return {
            attempt_id: 'e2e00000-0000-4000-8000-0000000000a1',
            attempt_number: 1,
            attempt_token: token,
            attempt_token_expires_at: new Date(expiresAt).toISOString(),
          };
        };
        if (body?.nonce !== undefined) {
          // A rejoin: link + nonce re-mint a token for the live attempt, and the
          // nonce is NOT returned again (the page already holds it).
          if (!state.liveSession) return json(409, { error: 'r1_attempt_not_live' });
          if (body.nonce !== R1_NONCE) return json(404, { error: 'r1_attempt_invalid' });
          // A re-mint always lasts the full five minutes, whatever the join's token was minted with.
          return json(200, { ...mint(R1_FRESH_ATTEMPT_TOKEN, 300), rejoin: true });
        }
        if (state.liveSession) return json(409, { error: 'r1_busy', retry_after_sec: 1200 });
        state.liveSession = true;
        return json(201, {
          ...mint(R1_ATTEMPT_TOKEN, state.attemptTokenTtlSec),
          nonce: R1_NONCE,
          rejoin: false,
        });
      }
      case 'POST /api/r1/exchange': {
        if (!onlyKeys(body, ['attempt_token', 'nonce'])) return validationError();
        const knownToken = body?.attempt_token === R1_ATTEMPT_TOKEN
          || body?.attempt_token === R1_FRESH_ATTEMPT_TOKEN;
        if (!knownToken || body?.nonce !== R1_NONCE) {
          return json(404, { error: 'r1_attempt_invalid' });
        }
        const failure = forced('exchange');
        if (failure) return failure;
        if (state.exchangePreparing > 0) {
          state.exchangePreparing -= 1;
          return json(202, { status: 'preparing', retry_after_sec: 3 });
        }
        return json(200, {
          url: MOCK_LIVEKIT_ORIGIN,
          livekit_token: 'e2e-interview-room-token',
          expires_at: '2026-10-07T00:10:00.000Z',
          attempt_id: 'e2e00000-0000-4000-8000-0000000000a1',
        });
      }
      case 'POST /api/r1/ready': {
        // The relay to the interviewer (the candidate's room token cannot publish data). The body is
        // the exchange's; the attempt token must be a current one (this fake's exchange takes
        // either token without looking at its lifetime, because it is called right after the
        // join), and the attempt must be live.
        if (!onlyKeys(body, ['attempt_token', 'nonce'])) return validationError();
        const token = typeof body?.attempt_token === 'string' ? body.attempt_token : '';
        const lapsed = (state.tokenExpiresAt[token] ?? 0) <= now();
        if (lapsed || body?.nonce !== R1_NONCE) {
          return json(404, { error: 'r1_attempt_invalid' });
        }
        const failure = forced('ready');
        if (failure) return failure;
        if (!state.liveSession) return json(409, { error: 'not_live' });
        return json(200, { ok: true });
      }
      case 'POST /api/r1/meet/exchange': {
        // The Meet bridge's ticket exchange (M034; `.gsd/milestones/M034/contracts/meet-contracts.md`
        // section 4, as refined in section 9 items 2 to 5). The switch is checked before anything
        // else, as the server's flag check is; then the strict body, the ticket, the claim.
        if (state.meetDisabled) return json(503, { error: 'meet_disabled' });
        if (!onlyKeys(body, ['ticket', 'resume_token']) || typeof body?.ticket !== 'string') {
          return validationError();
        }
        if (body.ticket !== R1_MEET_TICKET) return json(404, { error: 'ticket_unknown' });
        const failure = forced('meetExchange');
        if (failure) return failure;
        if (body.resume_token === undefined) {
          // The claim is single-use and runs before admission: the ticket alone works once.
          if (state.meetClaimed) return json(409, { error: 'ticket_already_claimed' });
        } else if (!state.meetClaimed || body.resume_token !== R1_MEET_RESUME_TOKEN) {
          // A continuation is only for the booking whose claim handed it out.
          return json(404, { error: 'ticket_unknown' });
        }
        state.meetClaimed = true;
        if (state.meetPreparing > 0) {
          state.meetPreparing -= 1;
          return json(202, { status: 'preparing', retry_after_sec: 3, resume_token: R1_MEET_RESUME_TOKEN });
        }
        // Nothing about the candidate: room and identity are inside the token (section 9 item 3).
        return json(200, {
          url: MOCK_LIVEKIT_ORIGIN,
          livekit_token: 'e2e-meet-room-token',
          expires_at: '2026-10-07T00:10:00.000Z',
        });
      }
      default:
        // An /api/r1/ route the page called that this fake does not know:
        // answered null so the harness fails the test loudly.
        return null;
    }
  };
}
