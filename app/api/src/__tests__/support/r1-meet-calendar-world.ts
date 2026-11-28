/**
 * The calendar world of M035 S05 (T3, shared with T4..T6): Lexy's calendar for public-page bookings,
 * end to end over doubles, with no network.
 *
 * What it holds:
 *  - the Meet harness (`createR1MeetHarness({ publicTriggers: true })`): the in-memory 0142/0143 port
 *    with both 0143 triggers firing, the REAL Recall client over the Recall fake, a settable clock and
 *    the captured log lines;
 *  - the Google fake (`createFakeGoogle`) behind a REAL Google client built with `createR1MeetGoogle`
 *    from settings that `getR1MeetPublicDrainConfig` reads out of a run-time source (the fake's
 *    low-entropy fixtures), the harness clock and the job's own Google logger
 *    (`r1MeetGoogleClientLogger`). Tests may name the factory; runtime code may not (fence (g));
 *  - a scripted Ashby read stub (`candidateInfo`, `applicationInfo`) answering
 *    `{ results, moreDataAvailable: false }` or throwing `AshbyError`, every call recorded;
 *  - the calendar ports (`R1MeetCalendarDeps`) over the real calendar store, with switches for "no
 *    Google settings", "no Ashby key" and the public config, and `deps` = the harness deps plus them;
 *  - `seed`: a public booking (round, application link, `candidates` row with an `@example.test`
 *    sentinel email, the Ashby person) plus its event inserted on the fake through the real client
 *    (id = the booking id without dashes, no attendee, the conference ready at once), the booking's
 *    Meet link being the event's own (calendar mode);
 *  - ONE merged timeline (the harness's): `db:<rpc>` and `queue:<kind>` from the fake database,
 *    `google:<call>` (`google:calendar.get`, `google:calendar.insert`, `google:token`, ...) and
 *    `ashby:<operation>` (`ashby:candidate.info`, `ashby:application.info`) from here.
 *
 * `interceptGoogle(call, response)` answers ONE matching Google request instead of the fake: a canned
 * status (and body / headers), `network` (nothing reached Google) or `hang` (no answer: the client's
 * deadline fires; build the world with a small `googleTimeoutMs`).
 *
 * Fixtures are built at run time from low-entropy parts. Never shipped: `tsconfig.build.json` excludes
 * `src/__tests__`.
 */

import { AshbyError, type AshbyErrorCategory } from '../../integrations/ashby/errors.js';
import type { AshbyResult } from '../../integrations/ashby/types.js';
import { createR1MeetGoogle, type R1MeetGoogle } from '../../integrations/google/client.js';
import { GOOGLE_TOKEN_URL, type GoogleTransport, type GoogleTransportRequest } from '../../integrations/google/http.js';
import { GOOGLE_SCOPES } from '../../integrations/google/token.js';
import {
  r1MeetGoogleClientLogger,
  runR1MeetCalendarSync,
  type R1MeetCalendarAshby,
  type R1MeetCalendarDeps,
  type R1MeetCalendarGoogle,
} from '../../lib/r1/meet/calendar-sync.js';
import {
  getR1MeetPublicDrainConfig,
  type R1MeetGoogleEnvSource,
  type R1MeetGoogleSettings,
  type R1MeetPublicConfig,
} from '../../lib/r1/meet/config.js';
import type { R1MeetCalendarOp, R1MeetJobMeta, R1MeetJobResult } from '../../lib/r1/meet/jobs.js';
import { createR1MeetCalendarStore, type R1MeetCalendarState } from '../../lib/r1/meet/public/calendar-store.js';
import { R1_MEET_PUBLIC_EVENT_SUMMARY } from '../../lib/r1/meet/public/invite-copy.js';
import type { R1MeetFlowDeps } from '../../lib/r1/meet/recall-actions.js';
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_DEX_EMAIL,
  FAKE_GOOGLE_REFRESH_TOKEN,
  createFakeGoogle,
  fakeGoogleResponse,
  type FakeGoogle,
  type FakeGoogleOptions,
} from './google-fake.js';
import { MEET_URL, createR1MeetHarness, fixtureId, type HarnessOptions, type R1MeetHarness } from './r1-meet-harness.js';

/** The `candidates.email` of a seeded booking: a sentinel, so a test can prove it never leaks. */
export const LOCAL_EMAIL = ['local', 'sentinel', 'r1'].join('.') + '@example.test';
/** The Ashby `primaryEmailAddress` of a seeded booking's person. */
export const ASHBY_EMAIL = ['ashby', 'sentinel', 'r1'].join('.') + '@example.test';

const SPACE_SCOPES = [GOOGLE_SCOPES.calendarEventsOwned, GOOGLE_SCOPES.meetSpaceSettings, GOOGLE_SCOPES.meetSpaceCreated];

/** Lexy's Google settings the way the runtime reads them: through the drain config, from a source. */
export function calendarWorldGoogleSettings(): R1MeetGoogleSettings {
  const source: R1MeetGoogleEnvSource = {
    R1_MEET_GOOGLE_DEX_EMAIL: FAKE_GOOGLE_DEX_EMAIL,
    R1_MEET_GOOGLE_OAUTH_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
  };
  source['R1_MEET_GOOGLE_OAUTH_CLIENT_SECRET'] = FAKE_GOOGLE_CLIENT_SECRET;
  source['R1_MEET_GOOGLE_OAUTH_REFRESH_TOKEN'] = FAKE_GOOGLE_REFRESH_TOKEN;
  const drain = getR1MeetPublicDrainConfig(source);
  if (!drain.available) throw new Error('calendar world: expected usable Google settings');
  return drain.google;
}

/** The name of a Google request on the timeline: `token`, `calendar.<call>` or `meet.<method>`. */
export function googleCallName(req: Pick<GoogleTransportRequest, 'method' | 'url'>): string {
  const url = new URL(req.url);
  if (`${url.origin}${url.pathname}` === GOOGLE_TOKEN_URL) return 'token';
  if (url.hostname.startsWith('meet.')) return `meet.${req.method.toLowerCase()}`;
  if (url.pathname.endsWith('/events')) return 'calendar.insert';
  const verb = req.method === 'GET' ? 'get' : req.method === 'DELETE' ? 'delete' : req.method.toLowerCase();
  return `calendar.${verb}`;
}

export type GoogleIntercept =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  | 'network'
  | 'hang';

/** One Google request as sent (API calls only carry a parsed body; the token form is never kept). */
export interface CalendarWorldGoogleRequest {
  readonly call: string;
  readonly method: string;
  readonly path: string;
  readonly query: Record<string, string>;
  readonly body: unknown;
}

export interface AshbyStub {
  readonly port: R1MeetCalendarAshby;
  readonly calls: Array<{ readonly op: 'candidate.info' | 'application.info'; readonly id: string }>;
  /** `candidate.info` results by Ashby candidate id (an unknown id answers `logical_failure`). */
  readonly candidates: Map<string, Record<string, unknown>>;
  /** `application.info` results by application id (an unknown id answers `logical_failure`). */
  readonly applications: Map<string, Record<string, unknown>>;
  /** The NEXT call of `op` throws an `AshbyError` of `category`. */
  failNext(op: 'candidate.info' | 'application.info', category?: AshbyErrorCategory): void;
  /** Every call throws an `AshbyError` of `category` (null: answer again). */
  failAll(category: AshbyErrorCategory | null): void;
  /** Runs before each call is answered (a test changes the database "meanwhile"). */
  onCall: ((op: 'candidate.info' | 'application.info') => void) | null;
}

function createAshbyStub(timeline: string[]): AshbyStub {
  const calls: AshbyStub['calls'] = [];
  const candidates = new Map<string, Record<string, unknown>>();
  const applications = new Map<string, Record<string, unknown>>();
  const pending = new Map<string, AshbyErrorCategory[]>();
  let always: AshbyErrorCategory | null = null;

  const answer = <T>(op: 'candidate.info' | 'application.info', id: string, table: Map<string, Record<string, unknown>>): AshbyResult<T> => {
    timeline.push(`ashby:${op}`);
    calls.push({ op, id });
    stub.onCall?.(op);
    const queued = pending.get(op)?.shift();
    const category = queued ?? always;
    if (category !== null && category !== undefined) {
      throw new AshbyError(category, { code: category, operation: op, httpStatus: category === 'http_server_error' ? 503 : null });
    }
    const results = table.get(id);
    if (results === undefined) throw new AshbyError('logical_failure', { code: 'not_found', operation: op });
    return { results: structuredClone(results) as unknown as T, moreDataAvailable: false };
  };

  const port: R1MeetCalendarAshby = {
    async candidateInfo<T>(candidateId: string): Promise<AshbyResult<T>> {
      return answer<T>('candidate.info', candidateId, candidates);
    },
    async applicationInfo<T>(applicationId: string): Promise<AshbyResult<T>> {
      return answer<T>('application.info', applicationId, applications);
    },
  };

  const stub: AshbyStub = {
    port,
    calls,
    candidates,
    applications,
    failNext(op, category = 'http_server_error') {
      const queue = pending.get(op) ?? [];
      queue.push(category);
      pending.set(op, queue);
    },
    failAll(category) {
      always = category;
    },
    onCall: null,
  };
  return stub;
}

export interface CalendarWorldOptions {
  readonly meetMode?: 'calendar' | 'space';
  /** The harness options (`publicTriggers` is always on here). */
  readonly harness?: Omit<HarnessOptions, 'publicTriggers'>;
  /** The Google client's per-request deadline (a `hang` test uses a few ms). */
  readonly googleTimeoutMs?: number;
  readonly fake?: FakeGoogleOptions;
}

export interface SeedPublicOptions {
  readonly status?: string;
  readonly reason?: string;
  readonly startAt?: string;
  readonly endAt?: string;
  readonly calendarState?: R1MeetCalendarState;
  /** `candidates.email`; null = the row has none. Default `LOCAL_EMAIL`. */
  readonly localEmail?: string | null;
  /** The person's `primaryEmailAddress` in Ashby; null = none. Default `ASHBY_EMAIL`. */
  readonly ashbyEmail?: string | null;
  /** Set the application link's `external_candidate_id` (default true). */
  readonly linkAshbyCandidate?: boolean;
  /** `application.info` names the person (default true). */
  readonly applicationNamesCandidate?: boolean;
  /** Insert the event on Lexy's calendar (default true). */
  readonly event?: boolean;
  /** A held bot (default: one for `bot_scheduled`, none otherwise). */
  readonly recallBotId?: string | null;
}

export interface SeededPublicBooking {
  readonly bookingId: string;
  readonly eventId: string;
  readonly roundId: string;
  readonly candidateId: string;
  readonly applicationId: string;
  readonly ashbyCandidateId: string;
  readonly meetUrl: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly recallBotId: string | null;
}

export interface CalendarWorld {
  readonly h: R1MeetHarness;
  readonly fake: FakeGoogle;
  readonly google: R1MeetGoogle;
  readonly ashby: AshbyStub;
  readonly calendar: R1MeetCalendarDeps;
  readonly deps: R1MeetFlowDeps;
  /** Live switches the calendar ports read per call. */
  readonly switches: { google: boolean; ashby: boolean; publicConfig: R1MeetPublicConfig };
  readonly meetMode: 'calendar' | 'space';
  /** Every Google request a test made, in order (token requests included, no token body; never a seed's). */
  readonly requests: CalendarWorldGoogleRequest[];
  seed(options?: SeedPublicOptions): Promise<SeededPublicBooking>;
  /** An Ashby-scheduled booking (no calendar columns, no event). */
  seedAshbyBooking(): string;
  interceptGoogle(call: string, response: GoogleIntercept): void;
  /** Runs after the fake answered a (not intercepted) Google request: a test changes the database "meanwhile". */
  afterGoogle: ((call: string) => void) | null;
  /** The Google API requests (no token requests). */
  apiCalls(): CalendarWorldGoogleRequest[];
  /** The Google API requests that change something (anything but a GET). */
  writes(): CalendarWorldGoogleRequest[];
  tokenCalls(): CalendarWorldGoogleRequest[];
  /** The merged timeline without the token requests. */
  steps(): string[];
  run(op: R1MeetCalendarOp, bookingId: string, meta?: R1MeetJobMeta): Promise<R1MeetJobResult>;
}

export function createR1MeetCalendarWorld(options: CalendarWorldOptions = {}): CalendarWorld {
  const meetMode = options.meetMode ?? 'calendar';
  const h = createR1MeetHarness({ ...options.harness, publicTriggers: true });
  const fake = createFakeGoogle({
    grantedScopes: SPACE_SCOPES,
    conferenceReadyAfterGets: 0,
    now: () => h.now(),
    ...options.fake,
  });
  const requests: CalendarWorldGoogleRequest[] = [];
  const interceptors: Array<{ call: string; response: GoogleIntercept }> = [];
  let quiet = false;

  const transport: GoogleTransport = async (req) => {
    const call = googleCallName(req);
    if (!quiet) {
      h.timeline.push(`google:${call}`);
      const url = new URL(req.url);
      let body: unknown = null;
      if (call !== 'token' && req.body !== undefined) body = JSON.parse(req.body) as unknown;
      requests.push({ call, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), body });
    }
    const index = interceptors.findIndex((entry) => entry.call === call);
    if (index !== -1) {
      const [entry] = interceptors.splice(index, 1);
      const response = entry!.response;
      if (response === 'network') throw new Error('fake network failure');
      if (response === 'hang') return new Promise(() => {});
      return fakeGoogleResponse(response.status, response.body, response.headers ?? {});
    }
    const response = await fake.transport(req);
    world.afterGoogle?.(call);
    return response;
  };

  const google = createR1MeetGoogle({
    settings: calendarWorldGoogleSettings(),
    meetMode,
    transport,
    now: () => h.now(),
    logger: r1MeetGoogleClientLogger(h.deps.log),
    ...(options.googleTimeoutMs === undefined ? {} : { timeoutMs: options.googleTimeoutMs }),
  });
  const ashby = createAshbyStub(h.timeline);
  const switches: CalendarWorld['switches'] = { google: true, ashby: true, publicConfig: Object.freeze({ status: 'off' as const }) };
  const calendarGoogle: R1MeetCalendarGoogle = Object.freeze({ calendar: google.calendar, meetMode });
  const calendar: R1MeetCalendarDeps = Object.freeze({
    store: createR1MeetCalendarStore(h.db.client),
    google: () => (switches.google ? calendarGoogle : null),
    ashby: () => (switches.ashby ? ashby.port : null),
    publicConfig: () => switches.publicConfig,
  });
  const deps: R1MeetFlowDeps = { ...h.deps, calendar };

  async function seed(o: SeedPublicOptions = {}): Promise<SeededPublicBooking> {
    const bookingId = fixtureId();
    const eventId = bookingId.replace(/-/g, '');
    const applicationId = fixtureId();
    const ashbyCandidateId = fixtureId();
    const status = o.status ?? 'pending';
    const startAt = o.startAt ?? new Date(h.now() + 24 * 3600 * 1000).toISOString();
    const endAt = o.endAt ?? new Date(Date.parse(startAt) + 45 * 60 * 1000).toISOString();
    const round = h.db.addRound({ channel: 'meet', status: 'invited' });
    const candidateId = round.candidate_id as string;
    h.db.linkApplication(applicationId, candidateId);
    if (o.linkAshbyCandidate !== false) h.db.linkAshbyCandidate(applicationId, ashbyCandidateId);
    h.db.seedCandidate({ id: candidateId, email: o.localEmail === undefined ? LOCAL_EMAIL : o.localEmail });
    const ashbyEmail = o.ashbyEmail === undefined ? ASHBY_EMAIL : o.ashbyEmail;
    ashby.candidates.set(ashbyCandidateId, {
      id: ashbyCandidateId,
      name: 'Never Read',
      ...(ashbyEmail === null ? {} : { primaryEmailAddress: { value: ashbyEmail, type: 'Personal', isPrimary: true } }),
      applicationIds: [applicationId],
    });
    ashby.applications.set(applicationId, {
      id: applicationId,
      status: 'Active',
      ...(o.applicationNamesCandidate === false ? {} : { candidate: { id: ashbyCandidateId } }),
    });

    let meetUrl = MEET_URL;
    if (o.event !== false) {
      const logsBefore = h.logs.length;
      quiet = true;
      try {
        const inserted = await google.calendar.insertEvent({
          id: eventId,
          summary: R1_MEET_PUBLIC_EVENT_SUMMARY,
          description: '',
          startAt,
          endAt,
          requestId: bookingId,
          bookingId,
          withConference: meetMode === 'calendar',
          location: meetMode === 'calendar' ? null : MEET_URL,
        });
        if (meetMode === 'calendar') {
          if (inserted.hangoutLink === null) throw new Error('calendar world: the conference is not ready');
          meetUrl = inserted.hangoutLink;
        }
      } finally {
        quiet = false;
        // The seed's own Google lines (the token mint, the insert) are not part of the test.
        h.logs.splice(logsBefore);
      }
    }
    const recallBotId = o.recallBotId !== undefined ? o.recallBotId : status === 'bot_scheduled' ? fixtureId() : null;
    h.db.seedPublicBooking({
      id: bookingId,
      round_id: round.id,
      status,
      reason: o.reason ?? (status === 'blocked' ? 'bot_cap_reached' : 'eligible'),
      start_at: startAt,
      end_at: endAt,
      ashby_application_id: applicationId,
      meet_url: meetUrl,
      recall_bot_id: recallBotId,
      ...(o.calendarState === undefined ? {} : { calendar_state: o.calendarState }),
    });
    return Object.freeze({
      bookingId,
      eventId,
      roundId: round.id as string,
      candidateId,
      applicationId,
      ashbyCandidateId,
      meetUrl,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
      recallBotId,
    });
  }

  const isToken = (request: CalendarWorldGoogleRequest): boolean => request.call === 'token';

  const world: CalendarWorld = {
    h,
    fake,
    google,
    ashby,
    calendar,
    deps,
    switches,
    meetMode,
    requests,
    seed,
    seedAshbyBooking() {
      const booking = h.db.seedBooking({ status: 'pending', reason: 'eligible', round_id: h.db.addRound({ channel: 'meet' }).id });
      return booking.id as string;
    },
    interceptGoogle(call, response) {
      interceptors.push({ call, response });
    },
    apiCalls: () => requests.filter((request) => !isToken(request)),
    writes: () => requests.filter((request) => !isToken(request) && request.method !== 'GET'),
    tokenCalls: () => requests.filter(isToken),
    steps: () => h.timeline.filter((step) => step !== 'google:token'),
    run(op, bookingId, meta) {
      return runR1MeetCalendarSync(deps, { kind: 'calendar_sync', op, bookingId }, meta ?? h.meta());
    },
    afterGoogle: null,
  };
  return world;
}
