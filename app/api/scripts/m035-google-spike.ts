/**
 * M035 S03 T5: the Google half of the live spike for Dex's meetings (owner-run, local).
 *
 * The public booking link puts each R1 interview on Dex's own Google calendar and needs the Meet of
 * that event to be OPEN (the guest bot is not host and Dex never joins). Before S05/S06 rely on it,
 * the owner checks, with Dex's real grant, what only Google can answer (roadmap §G, research R03 §6):
 * spike S2 (Dex's token may patch the Calendar-created space to OPEN), S3 (it stays OPEN on the
 * company plan), S6 (a time patch keeps the Meet link) and the insert half of S7 (about 20 inserts a
 * day without `usageLimits`).
 *
 *   npx tsx scripts/m035-google-spike.ts                      dry run: config check only, no network
 *   npx tsx scripts/m035-google-spike.ts --live [--patch-time] [--space] [--repeat=<1..20>]
 *
 * The settings come through the API's own reader, `getR1MeetPublicDrainConfig()` (Dex's account
 * only: `R1_MEET_GOOGLE_AUTH_MODE`, `R1_MEET_GOOGLE_DEX_EMAIL` and the chosen mode's credentials;
 * the public flag is not needed). DRY RUN BY DEFAULT: it prints `PASS config` (or
 * `FAIL config unavailable`) and the steps a live run would take, and sends nothing. A live run needs
 * BOTH `--live` and `M035_GOOGLE_SPIKE_LIVE=yes` in the shell; either one alone is refused (exit 2)
 * before anything is read or sent.
 *
 * A live run, in calendar mode (the default): `insert` one attendee-less event on Dex's primary
 * calendar about an hour ahead (45 minutes, `sendUpdates=none`, nobody is invited); `token` passes
 * when Dex's token was minted for it; `organizer` = the event's organizer is the Dex email;
 * `conference` polls the event (at most 10 reads, 1 s apart) until the Meet is ready; `space_get`
 * reads the space by its meeting code; `space_open` patches it OPEN (`updateMask=config.accessType`);
 * `space_readback` reads it again and wants OPEN with every entry point; `time_patch`
 * (`--patch-time`) moves the event 30 minutes and wants the same Meet link; `delete` removes the event
 * (`sendUpdates=none`) and is ALWAYS attempted once the event may exist; `repeat` (`--repeat=N`) then
 * makes N more insert + delete pairs, 1 s apart. `--space` takes the space-mode path instead
 * (`space_create`: a new OPEN space through the Meet API, then an event whose location is its link;
 * the grant must hold `meetings.space.created`, minted with the consent helper's `--space`).
 *
 * Output: only `PASS|FAIL|SKIP|DRY <step>[ <closed word>]` lines and one `RESULT:` line. Never an
 * event id, a booking id, a meeting code, a Meet URL, an email, a token, a secret or a vendor
 * message. Exit 0 = no FAIL, 1 = a FAIL, 2 = usage, refused or not configured. Never run in CI and
 * never by the API.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getR1MeetPublicDrainConfig, type R1MeetPublicDrainConfig } from '../src/lib/r1/meet/config.js';
import { createR1MeetGoogle, type R1MeetGoogle, type R1MeetGoogleOptions } from '../src/integrations/google/client.js';
import { isGoogleError } from '../src/integrations/google/errors.js';

type SpikeTransport = NonNullable<R1MeetGoogleOptions['transport']>;
type SpikeLogger = NonNullable<R1MeetGoogleOptions['logger']>;
type SpikeEvent = Awaited<ReturnType<R1MeetGoogle['calendar']['insertEvent']>>;
type SpikeSpace = Awaited<ReturnType<R1MeetGoogle['meet']['createOpenSpace']>>;

export interface SpikeDeps {
  /** Default: `getR1MeetPublicDrainConfig()` (the environment, through the API's reader). */
  getSettings?: () => R1MeetPublicDrainConfig;
  /** The live confirmation; default `process.env.M035_GOOGLE_SPIKE_LIVE`. Only `yes` confirms. */
  liveEnv?: string | null;
  /** The Google network. Default: the Google client's fetch transport (live runs only). */
  transport?: SpikeTransport;
  /** Clock in ms (event times, token cache). Default `Date.now`. */
  now?: () => number;
  /** Wait between conference polls and repeat cycles. Default a timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Default `crypto.randomUUID`: the booking id of a spike event (its id without dashes). */
  randomUuid?: () => string;
  out?: (line: string) => void;
}

/** The env name that, with `--live`, confirms a live run. Not a Meet variable: the owner sets it in a local shell only. */
export const SPIKE_LIVE_ENV_NAME = 'M035_GOOGLE_SPIKE_LIVE';
export const SPIKE_MAX_REPEAT = 20;
export const SPIKE_CONFERENCE_POLLS = 10;
export const SPIKE_POLL_INTERVAL_MS = 1_000;
export const SPIKE_LEAD_MS = 60 * 60_000;
export const SPIKE_EVENT_MS = 45 * 60_000;
export const SPIKE_PATCH_SHIFT_MS = 30 * 60_000;
export const SPIKE_EVENT_SUMMARY = 'Hello R1 spike (delete me)';
export const SPIKE_EVENT_DESCRIPTION = 'Owner-run Google spike for the R1 public booking link: no guest, deleted by the run.';

/** The step words, in the order a live run reports them. */
export const SPIKE_STEPS = Object.freeze([
  'config',
  'token',
  'space_create',
  'insert',
  'organizer',
  'conference',
  'space_get',
  'space_open',
  'space_readback',
  'time_patch',
  'delete',
  'repeat',
] as const);
export type SpikeStep = (typeof SPIKE_STEPS)[number];

const USAGE =
  'usage: npx tsx scripts/m035-google-spike.ts [--live] [--patch-time] [--space] [--repeat=<1..20>] ' +
  `(a dry run unless --live is given AND ${SPIKE_LIVE_ENV_NAME}=yes is set; reads R1_MEET_GOOGLE_AUTH_MODE, ` +
  'R1_MEET_GOOGLE_DEX_EMAIL and the credentials of that mode; run it locally, never in CI)';

const FIVE_MINUTES_MS = 5 * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
/** An insert that failed this way may still have created the event: delete it anyway. */
const MAY_EXIST_CODES: ReadonlySet<string> = new Set(['timeout', 'unavailable', 'malformed_response']);

// ── Arguments ───────────────────────────────────────────────────────────────

interface SpikeArgs {
  live: boolean;
  patchTime: boolean;
  space: boolean;
  repeat: number;
}

function parseArgs(argv: readonly string[]): SpikeArgs | 'usage' | 'help' {
  const args: SpikeArgs = { live: false, patchTime: false, space: false, repeat: 0 };
  const seen = new Set<string>();
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return 'help';
    const equals = arg.indexOf('=');
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? null : arg.slice(equals + 1);
    if (seen.has(name)) return 'usage';
    seen.add(name);
    if (name === '--live' && value === null) args.live = true;
    else if (name === '--patch-time' && value === null) args.patchTime = true;
    else if (name === '--space' && value === null) args.space = true;
    else if (name === '--repeat' && value !== null && /^[1-9]\d?$/.test(value) && Number(value) <= SPIKE_MAX_REPEAT) {
      args.repeat = Number(value);
    } else {
      return 'usage';
    }
  }
  return args;
}

// ── Output ──────────────────────────────────────────────────────────────────

/** Counts and prints the closed lines; nothing else ever reaches the output. */
class Report {
  pass = 0;
  fail = 0;
  skip = 0;

  constructor(private readonly out: (line: string) => void) {}

  #line(verdict: 'PASS' | 'FAIL' | 'SKIP' | 'DRY', step: SpikeStep, word?: string): void {
    this.out(word === undefined ? `${verdict} ${step}` : `${verdict} ${step} ${word}`);
  }

  passed(step: SpikeStep, word?: string): void {
    this.pass += 1;
    this.#line('PASS', step, word);
  }

  failed(step: SpikeStep, word: string): void {
    this.fail += 1;
    this.#line('FAIL', step, word);
  }

  skipped(step: SpikeStep, word: string): void {
    this.skip += 1;
    this.#line('SKIP', step, word);
  }

  dry(step: SpikeStep, word?: string): void {
    this.#line('DRY', step, word);
  }

  result(): void {
    this.out(`RESULT: ${this.pass} pass, ${this.fail} fail, ${this.skip} skipped`);
  }
}

/** The closed word of a failure: a Google error code, else `unexpected` (never a message). */
const errorWord = (error: unknown): string => (isGoogleError(error) ? error.code : 'unexpected');
const isTokenError = (error: unknown): boolean =>
  isGoogleError(error) && (error.operation === 'token.refresh' || error.operation === 'token.jwt_bearer');

type Outcome<T> = { ok: true; value: T } | { ok: false; word: string; tokenFailure: boolean };

async function attempt<T>(fn: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, word: errorWord(error), tokenFailure: isTokenError(error) };
  }
}

// ── Event times ─────────────────────────────────────────────────────────────

/** `ms` as an IST ISO 8601 time with offset, to the second (the calendar client wants an offset). */
function istIso(ms: number): string {
  return `${new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;
}

/** An hour ahead, rounded up to the next 5 minutes. */
const spikeStartMs = (nowMs: number): number => Math.ceil((nowMs + SPIKE_LEAD_MS) / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;

// ── The run ─────────────────────────────────────────────────────────────────

export async function runSpike(argv: string[], deps: SpikeDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const args = parseArgs(argv);
  if (args === 'help') {
    out(USAGE);
    return 0;
  }
  if (args === 'usage') {
    out(USAGE);
    return 2;
  }
  const report = new Report(out);

  // FIRST: a live run needs both confirmations; one alone is refused before anything is read.
  const liveEnv = 'liveEnv' in deps ? deps.liveEnv : process.env.M035_GOOGLE_SPIKE_LIVE;
  const envConfirms = liveEnv === 'yes';
  if (args.live !== envConfirms) {
    report.failed('config', args.live ? 'live_env_missing' : 'live_flag_missing');
    report.result();
    return 2;
  }

  let drain: R1MeetPublicDrainConfig;
  try {
    drain = (deps.getSettings ?? getR1MeetPublicDrainConfig)();
  } catch {
    drain = { available: false };
  }
  if (drain === null || typeof drain !== 'object' || drain.available !== true) {
    report.failed('config', 'unavailable');
    report.result();
    return 2;
  }
  const settings = drain.google;
  const meetMode = args.space ? 'space' : 'calendar';
  const now = deps.now ?? Date.now;

  // A dry run can never reach the network: its client gets a transport that refuses every request.
  const refuse: SpikeTransport = () => Promise.reject(new Error('dry_run'));
  const transport = args.live ? deps.transport : refuse;
  // Only the mint outcome is read (metadata: operation and outcome), so `token` reports what happened.
  let tokensMinted = 0;
  const logger: SpikeLogger = {
    event(record) {
      if ((record.operation === 'token.refresh' || record.operation === 'token.jwt_bearer') && record.outcome === 'success') {
        tokensMinted += 1;
      }
    },
  };
  let google: R1MeetGoogle;
  try {
    // Construction validates the settings and sends nothing.
    google = createR1MeetGoogle({
      settings,
      meetMode,
      now,
      logger,
      ...(transport !== undefined ? { transport } : {}),
    });
  } catch {
    report.failed('config', 'client_refused');
    report.result();
    return 2;
  }
  report.passed('config');

  if (!args.live) {
    report.dry('token');
    if (args.space) report.dry('space_create');
    report.dry('insert');
    report.dry('organizer');
    if (!args.space) report.dry('conference');
    report.dry('space_get');
    if (!args.space) report.dry('space_open');
    report.dry('space_readback');
    if (args.patchTime) report.dry('time_patch');
    report.dry('delete');
    if (args.repeat > 0) report.dry('repeat', String(args.repeat));
    out(`RESULT: dry run, nothing sent; add --live with ${SPIKE_LIVE_ENV_NAME}=yes to run it`);
    return 0;
  }

  const progress: SpikeProgress = { step: 'token' };
  try {
    await live(args, deps, google, settings.dexEmail, () => tokensMinted, report, now, progress);
  } catch {
    // Every Google call catches its own failure; this last guard only keeps the output closed.
    report.failed(progress.step, 'unexpected');
  }
  report.result();
  return report.fail > 0 ? 1 : 0;
}

/** The step a live run is on (for the last-resort guard of `runSpike`). */
interface SpikeProgress {
  step: SpikeStep;
}

/** Steps the run did not reach, each reported as skipped with the same word. */
function skipAll(report: Report, steps: readonly SpikeStep[], word: string): void {
  for (const step of steps) report.skipped(step, word);
}

async function live(
  args: SpikeArgs,
  deps: SpikeDeps,
  google: R1MeetGoogle,
  dexEmail: string,
  tokensMinted: () => number,
  report: Report,
  now: () => number,
  progress: SpikeProgress,
): Promise<void> {
  const sleepDep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomDep = deps.randomUuid ?? randomUUID;
  // Neither seam may break the run between an insert and its delete.
  const sleep = async (ms: number): Promise<void> => {
    try {
      await sleepDep(ms);
    } catch {
      // A failed wait is only a shorter wait.
    }
  };
  const randomUuid = (): string => {
    try {
      return String(randomDep());
    } catch {
      return ''; // the calendar client refuses it (invalid_request) before any network call
    }
  };
  const at = (step: SpikeStep): void => {
    progress.step = step;
  };
  const space = args.space;

  /** The first Google call decides the `token` line; false = the token failed and the run stops. */
  let tokenReported = false;
  const settleToken = (outcome: Outcome<unknown>): boolean => {
    if (tokenReported) return true;
    tokenReported = true;
    if (!outcome.ok && outcome.tokenFailure) {
      report.failed('token', outcome.word);
      return false;
    }
    if (tokensMinted() > 0) report.passed('token');
    else report.skipped('token', 'not_reached');
    return true;
  };

  const startMs = spikeStartMs(now());
  const newEvent = (location: string | null) => {
    const bookingId = randomUuid();
    return {
      id: bookingId.replace(/-/g, ''),
      summary: SPIKE_EVENT_SUMMARY,
      description: SPIKE_EVENT_DESCRIPTION,
      startAt: istIso(startMs),
      endAt: istIso(startMs + SPIKE_EVENT_MS),
      requestId: bookingId,
      bookingId,
      withConference: !space,
      location,
    };
  };

  // ── space_create (space mode only) ──
  let created: SpikeSpace | null = null;
  if (space) {
    at('space_create');
    const outcome = await attempt(() => google.meet.createOpenSpace());
    if (!settleToken(outcome)) return;
    if (!outcome.ok) {
      report.failed('space_create', outcome.word);
    } else if (outcome.value.meetingUri === null) {
      report.failed('space_create', 'no_link');
    } else {
      created = outcome.value;
      report.passed('space_create');
    }
    if (created === null) {
      skipAll(
        report,
        ['insert', 'organizer', 'conference', 'space_get', 'space_open', 'space_readback', 'time_patch'],
        'after_failure',
      );
      report.skipped('delete', 'no_event');
      report.skipped('repeat', 'after_failure');
      return;
    }
  }

  // ── insert (the first call in calendar mode) ──
  at('insert');
  const insertInput = newEvent(created === null ? null : created.meetingUri);
  const eventId = insertInput.id;
  const inserted = await attempt(() => google.calendar.insertEvent(insertInput));
  if (!settleToken(inserted)) return;
  if (!space) report.skipped('space_create', 'calendar_mode');

  let event: SpikeEvent | null = null;
  let mayExist = false;
  if (inserted.ok) {
    event = inserted.value;
    report.passed('insert');
  } else {
    report.failed('insert', inserted.word);
    mayExist = MAY_EXIST_CODES.has(inserted.word);
  }

  try {
    if (event === null) {
      skipAll(report, ['organizer', 'conference', 'space_get', 'space_open', 'space_readback', 'time_patch'], 'after_failure');
    } else {
      await eventSteps(event);
    }
  } finally {
    // ── delete: ALWAYS once the event exists (or may exist after an unclear insert) ──
    at('delete');
    if (event !== null || mayExist) {
      const removed = await attempt(() => google.calendar.deleteEvent(eventId, 'none'));
      if (!removed.ok) report.failed('delete', removed.word);
      else if (removed.value === 'deleted') report.passed('delete');
      else report.passed('delete', 'gone'); // already gone: nothing is left on Dex's calendar
    } else {
      report.skipped('delete', 'no_event');
    }
  }

  // ── repeat (the insert half of spike S7): more attendee-less insert + delete pairs ──
  at('repeat');
  if (args.repeat === 0) {
    report.skipped('repeat', 'not_requested');
    return;
  }
  if (event === null) {
    report.skipped('repeat', 'after_failure');
    return;
  }
  for (let cycle = 1; cycle <= args.repeat; cycle += 1) {
    await sleep(SPIKE_POLL_INTERVAL_MS);
    const input = newEvent(created === null ? null : created.meetingUri);
    const made = await attempt(() => google.calendar.insertEvent(input));
    if (!made.ok) {
      report.failed('repeat', made.word);
      if (MAY_EXIST_CODES.has(made.word)) await attempt(() => google.calendar.deleteEvent(input.id, 'none'));
      return;
    }
    const removed = await attempt(() => google.calendar.deleteEvent(input.id, 'none'));
    if (!removed.ok) {
      report.failed('repeat', `delete_${removed.word}`);
      return;
    }
  }
  report.passed('repeat', `${args.repeat}/${args.repeat}`);

  /** The steps on the inserted event, from `organizer` to `time_patch` (the caller deletes it). */
  async function eventSteps(inserted: SpikeEvent): Promise<void> {
    let event: SpikeEvent = inserted;

    // ── organizer: the event is Dex's ──
    at('organizer');
    if (event.organizerEmail !== null && event.organizerEmail === dexEmail) report.passed('organizer');
    else report.failed('organizer', 'mismatch');

    // ── conference (calendar mode): Google makes the Meet ──
    at('conference');
    let conferenceReady = false;
    if (space) {
      report.skipped('conference', 'space_mode');
    } else {
      let current: SpikeEvent = event;
      /** `pass`, a closed failure word, or null while still pending. */
      let verdict: string | null = current.conferenceStatus === 'success' ? 'pass' : null;
      for (let poll = 0; verdict === null && poll < SPIKE_CONFERENCE_POLLS; poll += 1) {
        if (current.conferenceStatus === 'failure') {
          verdict = 'failure';
          break;
        }
        await sleep(SPIKE_POLL_INTERVAL_MS);
        const read = await attempt(() => google.calendar.getEvent(eventId));
        if (!read.ok) verdict = read.word;
        else if (read.value === null) verdict = 'gone';
        else {
          current = read.value;
          if (current.conferenceStatus === 'success') verdict = 'pass';
          else if (current.conferenceStatus === 'failure') verdict = 'failure';
        }
      }
      if (verdict === 'pass' && (current.hangoutLink === null || current.conferenceId === null)) verdict = 'no_link';
      if (verdict === 'pass') {
        conferenceReady = true;
        event = current;
        report.passed('conference');
      } else {
        report.failed('conference', verdict ?? 'timeout');
      }
    }

    // ── the space: read it (by meeting code, as S05 will), make it OPEN, read it back ──
    at('space_get');
    const createdSpace = created;
    const lookup =
      createdSpace !== null
        ? (createdSpace.meetingCode ?? createdSpace.name)
        : conferenceReady
          ? event.conferenceId
          : null;
    if (lookup === null) {
      skipAll(report, ['space_get', 'space_open', 'space_readback'], 'no_conference');
    } else {
      const got = await attempt(() => google.meet.getSpace(lookup));
      let spaceName: string | null = null;
      if (!got.ok) report.failed('space_get', got.word);
      else if (got.value === null) report.failed('space_get', 'not_found');
      else {
        spaceName = got.value.name;
        report.passed('space_get');
      }

      at('space_open');
      let opened = false;
      if (spaceName === null) {
        report.skipped('space_open', 'after_failure');
      } else if (space) {
        // The Meet API made it OPEN at creation; the read-back below is the proof.
        report.skipped('space_open', 'space_mode');
        opened = true;
      } else {
        const name = spaceName;
        const patched = await attempt(() => google.meet.makeSpaceOpen(name));
        if (patched.ok) {
          opened = true;
          report.passed('space_open');
        } else {
          report.failed('space_open', patched.word);
        }
      }

      at('space_readback');
      if (spaceName === null || !opened) {
        report.skipped('space_readback', 'after_failure');
      } else {
        const name = spaceName;
        const back = await attempt(() => google.meet.getSpace(name));
        if (!back.ok) report.failed('space_readback', back.word);
        else if (back.value === null) report.failed('space_readback', 'not_found');
        else if (back.value.accessType === 'OPEN' && back.value.entryPointAccess !== 'CREATOR_APP_ONLY') {
          report.passed('space_readback');
        } else {
          report.failed('space_readback', 'not_open');
        }
      }
    }

    // ── time_patch (spike S6): a move keeps the Meet link ──
    at('time_patch');
    if (!args.patchTime) {
      report.skipped('time_patch', 'not_requested');
    } else if (!space && !conferenceReady) {
      report.skipped('time_patch', 'no_link');
    } else {
      const linkBefore = event.hangoutLink;
      const movedStart = startMs + SPIKE_PATCH_SHIFT_MS;
      const patched = await attempt(() =>
        google.calendar.patchEvent(
          eventId,
          { startAt: istIso(movedStart), endAt: istIso(movedStart + SPIKE_EVENT_MS) },
          'none',
        ),
      );
      if (!patched.ok) {
        report.failed('time_patch', patched.word);
      } else {
        const after = await attempt(() => google.calendar.getEvent(eventId));
        if (!after.ok) report.failed('time_patch', after.word);
        else if (after.value === null) report.failed('time_patch', 'gone');
        else if (after.value.startAt === null || Date.parse(after.value.startAt) !== movedStart) {
          report.failed('time_patch', 'not_moved');
        } else if (after.value.hangoutLink !== linkBefore) {
          report.failed('time_patch', 'link_changed');
        } else {
          report.passed('time_patch');
        }
      }
    }
  }
}

// Run only when executed directly (`tsx scripts/m035-google-spike.ts`), not when imported by a test.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(path.resolve(entry)).href) {
  runSpike(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      console.error('FAIL config unexpected');
      process.exitCode = 1;
    },
  );
}
