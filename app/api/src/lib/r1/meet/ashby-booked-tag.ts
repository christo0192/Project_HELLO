/**
 * The `ashby_booked_tag` job of the `r1-meet` runtime (M035 S11, dark; D-S11-2, D-S11-6..13, D-S11-15):
 * keep the Ashby tag "Lexy R1: Booked" on the candidate of a public booking exactly while the database
 * says the booking stands.
 *
 * OWNER DECISION 5 (M035 roadmap §2): "Booked tag + scorecard (Recommended)": a "Lexy R1: Booked" tag
 * on the candidate when they book, removed when the booking is cancelled by the candidate or HR, or
 * fails before the interview; Lexy's scorecard as application feedback afterwards. No Ashby
 * interview-schedule mirror.
 *
 * WHO QUEUES IT. Only migration 0143: its public create RPC queues `op: 'add'` for every booked answer,
 * and its terminal-status trigger queues `op: 'remove'` when a public booking first becomes
 * `cancelled`, `failed` or `drained` (candidate cancel, HR cancel, every failure transition and the
 * drain). Payload `{ kind, op, booking_id }`, key `r1-meet:ashby-tag:<booking>:<op>`, 10 attempts.
 * `r1MeetJobs.ashbyBookedTag` builds the same payload for tests and an operator's re-drive.
 *
 * THE CONVERGE RULE (D-S11-2). Decided from the database on EVERY run: `op` is a hint and decides
 * nothing. Per application, its NEWEST public booking (by `created_at`, then `id`) wants the tag when
 * it is live, `completed`, or `failed` / `drained` at or after its start (`updated_at >= start_at`);
 * a cancelled booking, or one that failed or was drained before its start, does not. Nor does a
 * booking that FAILED with a reason of `R1_MEET_BOOKED_TAG_PRE_INTERVIEW_REASONS` (no bot was ever
 * created, its round expired first, or the invite never reached the candidate), whatever the time:
 * maintenance fails a booking that never got a bot `in_past` 30 minutes after its slot ENDS, long
 * after the start, and that was never an interview (PR #453 review S11-R1; owner decision 5: removed
 * when the booking "fails before the interview"). The tag is candidate-wide, so it is wanted when ANY
 * application of the Ashby candidate wants it: the booking's own application plus every application
 * linked to the same Ashby candidate (at most 25, its id matched in any case as 0143 does).
 *
 * THE STEPS, each stopping at its first answer (closed codes):
 *   1  unwired                  `deps.ashbyTag` absent: throw `r1_meet_ashby_tag_unwired` (a build bug).
 *   2  booking_missing          no such booking; `ashby_booking`: an Ashby-scheduled row. Both are
 *                               `ignored` before any other read and with no Ashby call.
 *   3  ashby_inactive           Ashby's own write switches are off (a throw counts as off): one warning
 *                               `r1_meet_ashby_tag_ashby_inactive`, then the wait `ashby_inactive`.
 *   4  ashby_key_missing        no usable Ashby key: alert, then the wait `ashby_key_missing`.
 *   5  candidate_id_missing     the Ashby candidate id, from the link, else one `application.info`;
 *                               none: alert, `ignored`.
 *   6  candidate_links_overflow WANTED, as above; more than 25 linked applications: alert, `ignored`
 *                               (the lane never decides from a partial list).
 *      tag_wanted_held          a remove-only run (only the Meet-off catch-up, PR #453 review S11-R2)
 *                               whose candidate still wants the tag: `ignored`, no Ashby read.
 *   7  tag_present / tag_absent `candidate.info` already holds the wanted state: `processed`, ZERO
 *                               writes.
 *   8  wanted: resolve the tag id (cached, then once FRESH on a miss): `tag_not_found` and
 *      `tag_ambiguous` alert and wait an hour (the Ashby admin's setup), a truncated catalogue waits
 *      `ashby_unavailable`; then ONE `candidate.addTag`. Not wanted: `candidate.removeTag` of every
 *      Lexy tag on the candidate (archived duplicates included), at most 5 per run. A write the tenant
 *      REFUSES drops the catalogue cache and looks again: the state already holding goes on; a refused
 *      add is tried once more with a fresh id; still refused is alert `write_rejected` and
 *      `ignored('tag_write_rejected')`.
 *   9  tag_added / tag_removed  the final look: `candidate.info` again AND WANTED recomputed. Done only
 *                               when Ashby holds the recomputed state and it equals the state the run
 *                               acted on; otherwise (a recruiter changed the tag, a booking changed
 *                               meanwhile) the cache is dropped and the job waits `tag_contended`.
 * An Ashby failure out of steps 5-9 (`classifyR1MeetAshbyTagFailure`): `permission` (401, 403,
 * `missing_endpoint_permission`) alerts `permission_denied` and waits; `rate_limited` and
 * `unavailable` wait; a refused READ alerts its detail and is `ignored('ashby_rejected')`; the
 * client's own request validation alerts and is `ignored('ashby_request_invalid')`. Only a write the
 * tenant REFUSES drops the cached tag id (it may be dead); a 429, a 5xx, a timeout, a permission
 * fault or the run's own time running out says nothing about the id, so the cache is kept and the
 * next run does not walk the catalogue again while Ashby is throttling (PR #453 review S11-R5).
 * Anything that is not an Ashby failure (a store fault is `r1_meet_db_error`) is rethrown unchanged.
 *
 * THE WAITS (`R1_MEET_ASHBY_TAG_WAITS`). Each is an `r1MeetDefer(code, seconds)` within
 * `canDeferR1MeetJob` (30 deferrals, a 60-minute streak); past that bound the job throws the wait's
 * closed code (bounded attempts, then the dead-letter queue):
 *   ashby_inactive, ashby_key_missing, ashby_permission_denied, tag_not_found, tag_ambiguous  3600 s
 *   ashby_rate_limited 60 s, ashby_unavailable 30 s, tag_contended 60 s.
 * BACK-OFF (PR #453 review S11-R3). `ashby_rate_limited` and `ashby_unavailable` grow while the same
 * wait repeats: the delay is the time the job has already waited in that streak (the queue keeps the
 * streak's start, `deferred_at`, while the reason repeats: 0037), at least the base and at most
 * `R1_MEET_ASHBY_TAG_BACKOFF_MAX_SEC`, so the delays run 30, 30, 60, 120, 240, 300, ... s. A burst of
 * tag jobs during an Ashby slowdown so asks the shared `r1-meet` lane for fewer and fewer runs instead
 * of one every 30 s each, and each run holds a lane slot for at most its 20 s budget
 * (`ashby-booked-tag-ashby.ts`: 5 s per call), leaving the lane to the interview jobs.
 *
 * THE PUBLIC FLAG. Not read here (contracts §2): a job queued just before the flag went off still
 * converges, so existing public bookings finish and cancel normally.
 *
 * LOGS (D-S11-15). Closed words, counts and an HTTP status only: never a booking, application,
 * candidate or tag id, never the tag's title, a name or an email. Alerts are `error` lines
 * `r1_meet_ashby_tag_failed` with an `error_type` of `R1_MEET_ASHBY_TAG_ALERT_TYPES` or an Ashby
 * failure detail `<category>[:<code>]`.
 *
 * Loading this module performs no I/O: every port arrives in `R1MeetFlowDeps.ashbyTag`.
 */

import { extractApplicationInfo } from '../../../integrations/ashby/extractors.js';
import {
  R1_MEET_ASHBY_TAG_MAX_REMOVES,
  classifyR1MeetAshbyTagFailure,
  r1MeetAshbyTagBudget,
  r1MeetBookedTagHolds,
  r1MeetDexTagsOf,
  type R1MeetAshbyTagPort,
  type R1MeetBookedTagResolution,
  type R1MeetDexTag,
} from './ashby-booked-tag-ashby.js';
import type { R1MeetBookedTagBooking, R1MeetBookedTagReason, R1MeetBookedTagStore } from './ashby-booked-tag-store.js';
import {
  R1MeetJobError,
  canDeferR1MeetJob,
  parseAshbyBookedTagJob,
  r1MeetDefer,
  r1MeetIgnored,
  r1MeetProcessed,
  type R1MeetAshbyBookedTagJob,
  type R1MeetJobMeta,
  type R1MeetJobResult,
} from './jobs.js';
import { R1_MEET_ALERTS, type R1MeetFlowDeps, type R1MeetJobDefinition, type R1MeetLog } from './recall-actions.js';
import { R1_MEET_LIVE_STATUSES } from './runtime-store.js';

/** The ports of the tag job. Production builds them in `runtime.ts` (`createR1MeetAshbyTagPorts`). */
export interface R1MeetAshbyTagDeps {
  /** The booked-tag store (`ashby-booked-tag-store.ts`): four narrow reads, no write. */
  readonly store: R1MeetBookedTagStore;
  /**
   * Ashby's own write switches, asked per job: the integration master switch with a usable webhook
   * secret AND `ASHBY_RUNTIME_ENABLED` (the same two as Lexy's scorecard). A throw counts as off.
   */
  ashbyActive(): boolean;
  /** The Ashby tag port, or null while no usable Ashby key is configured. */
  ashby(): R1MeetAshbyTagPort | null;
}

/** What a run throws when `deps.ashbyTag` is not wired (a build bug; bounded, then the DLQ). */
export const R1_MEET_ASHBY_TAG_UNWIRED = 'r1_meet_ashby_tag_unwired';

/** The warning of a tag held back because Ashby's own switches are off (a rollback, not a fault). */
export const R1_MEET_ASHBY_TAG_INACTIVE_LOG = 'r1_meet_ashby_tag_ashby_inactive';

/** One wait of the job: the deferral code, its delay, and the code thrown past the deferral bound. */
export interface R1MeetAshbyTagWait {
  readonly code: string;
  readonly seconds: number;
  readonly thrown: string;
}

const waitOf = (code: string, seconds: number, thrown: string): R1MeetAshbyTagWait =>
  Object.freeze({ code, seconds, thrown });

/** Every wait of the job (see the header). Frozen. */
export const R1_MEET_ASHBY_TAG_WAITS = Object.freeze({
  inactive: waitOf('ashby_inactive', 3600, 'r1_meet_ashby_tag_ashby_inactive'),
  keyMissing: waitOf('ashby_key_missing', 3600, 'r1_meet_ashby_tag_key_missing'),
  permission: waitOf('ashby_permission_denied', 3600, 'r1_meet_ashby_tag_permission_denied'),
  notFound: waitOf('tag_not_found', 3600, 'r1_meet_ashby_tag_not_found'),
  ambiguous: waitOf('tag_ambiguous', 3600, 'r1_meet_ashby_tag_ambiguous'),
  rateLimited: waitOf('ashby_rate_limited', 60, 'r1_meet_ashby_tag_rate_limited'),
  unavailable: waitOf('ashby_unavailable', 30, 'r1_meet_ashby_tag_unavailable'),
  contended: waitOf('tag_contended', 60, 'r1_meet_ashby_tag_contended'),
});

/**
 * The closed `error_type` words of the `r1_meet_ashby_tag_failed` alert, other than an Ashby failure
 * detail (`<category>[:<code>]`, sent with its HTTP status) of a refused read or an invalid request.
 * Frozen.
 */
export const R1_MEET_ASHBY_TAG_ALERT_TYPES = Object.freeze([
  'ashby_key_missing',
  'candidate_id_missing',
  'candidate_links_overflow',
  'tag_not_found',
  'tag_ambiguous',
  'permission_denied',
  'write_rejected',
] as const);
export type R1MeetAshbyTagAlertType = (typeof R1_MEET_ASHBY_TAG_ALERT_TYPES)[number];

const LIVE: ReadonlySet<string> = new Set(R1_MEET_LIVE_STATUSES);
const PUBLIC_SOURCE = 'public_page';

/**
 * The `failed` reasons that mean no interview could have taken place, whatever the time
 * (PR #453 review S11-R1): `in_past` (the booking never got a bot: maintenance fails a pending,
 * blocked, unmatched or unmapped booking 30 minutes after its slot ends), `bot_create_failed` (the
 * bot could not be created), `round_expired` (the round expired before a bot was created; these three
 * never had a bot, `runtime-store.ts` `R1_MEET_CAP_REASONS`) and `invite_undeliverable` (0143: the
 * calendar invite never reached the candidate). The other `failed` reasons (`no_show`, `bot_fatal`,
 * `admission_refused`, `multiple_humans`) follow a bot that was sent to the interview: they keep the
 * time rule. Frozen.
 */
export const R1_MEET_BOOKED_TAG_PRE_INTERVIEW_REASONS = Object.freeze([
  'in_past',
  'bot_create_failed',
  'round_expired',
  'invite_undeliverable',
] as const satisfies readonly R1MeetBookedTagReason[]);
const PRE_INTERVIEW: ReadonlySet<string> = new Set(R1_MEET_BOOKED_TAG_PRE_INTERVIEW_REASONS);

/**
 * Does this booking, the newest public booking of its application, want the tag (D-S11-2, the
 * per-application rule)? Live or `completed`: yes. `failed` with a reason of
 * `R1_MEET_BOOKED_TAG_PRE_INTERVIEW_REASONS`: no, at any time (it was never an interview). Any other
 * `failed`, or `drained`, at or after its start (`updated_at >= start_at`): yes, the interview's time
 * had come. Cancelled, or failed or drained before its start: no. An instant that does not parse
 * fails closed (no). Pure.
 */
export function r1MeetBookedTagWanted(
  booking: Pick<R1MeetBookedTagBooking, 'status' | 'reason' | 'startAt' | 'updatedAt'>,
): boolean {
  if (LIVE.has(booking.status) || booking.status === 'completed') return true;
  if (booking.status !== 'failed' && booking.status !== 'drained') return false;
  if (booking.status === 'failed' && PRE_INTERVIEW.has(booking.reason)) return false;
  const updatedMs = Date.parse(booking.updatedAt);
  const startMs = Date.parse(booking.startAt);
  return Number.isFinite(updatedMs) && Number.isFinite(startMs) && updatedMs >= startMs;
}

/** The longest a backed-off wait (`ashby_rate_limited`, `ashby_unavailable`) ever gets. */
export const R1_MEET_ASHBY_TAG_BACKOFF_MAX_SEC = 300;

/**
 * The delay of a backed-off wait (see the header): the base when the previous run did not end in the
 * same wait, else the seconds already waited in this streak, between the base and the cap. A streak
 * start that does not parse, or lies in the future, answers the base. Pure.
 */
export function r1MeetAshbyTagBackoffSeconds(
  meta: Pick<R1MeetJobMeta, 'lastDeferReason' | 'deferredAt'>,
  nowMs: number,
  wait: Pick<R1MeetAshbyTagWait, 'code' | 'seconds'>,
): number {
  if (meta.lastDeferReason !== wait.code || meta.deferredAt === null) return wait.seconds;
  const since = Date.parse(meta.deferredAt);
  if (!Number.isFinite(since) || !Number.isFinite(nowMs) || nowMs < since) return wait.seconds;
  const waited = Math.floor((nowMs - since) / 1000);
  return Math.min(Math.max(wait.seconds, waited), Math.max(wait.seconds, R1_MEET_ASHBY_TAG_BACKOFF_MAX_SEC));
}

/** A wait within the job's deferral bound; past it, the wait's closed code is thrown (retries, DLQ). */
function deferOrThrow(
  meta: R1MeetJobMeta,
  nowMs: number,
  wait: R1MeetAshbyTagWait,
  seconds: number = wait.seconds,
): R1MeetJobResult {
  if (!canDeferR1MeetJob(meta, nowMs)) throw new R1MeetJobError(wait.thrown);
  return r1MeetDefer(wait.code, seconds);
}

function alert(log: R1MeetLog, errorType: string, httpStatus: number | null = null): void {
  log.error({
    error_category: R1_MEET_ALERTS.ashbyTagFailed,
    error_type: errorType,
    ...(typeof httpStatus === 'number' ? { http_status: httpStatus } : {}),
  });
}

function switchesOn(tag: R1MeetAshbyTagDeps): boolean {
  try {
    return tag.ashbyActive() === true;
  } catch {
    return false;
  }
}

/** Step 6's answer: whether the candidate wants the tag, or an overflow of linked applications. */
type R1MeetBookedTagWant = { readonly overflow: false; readonly wanted: boolean } | { readonly overflow: true };

/** How a run may act. The queue's runs use the default; only the Meet-off catch-up narrows it. */
export interface R1MeetAshbyTagRunOptions {
  /**
   * Never ADD the tag (PR #453 review S11-R2, `ashby-booked-tag-meet-off.ts`): while Meet is off the
   * catch-up only takes tags away from public bookings that ended. A candidate who still wants the
   * tag is left as is (`ignored('tag_wanted_held')`, before any Ashby read); the queued job converges
   * it once Meet is back on.
   */
  readonly removeOnly?: boolean;
}

/** What a remove-only run answers when the candidate still wants the tag (no Ashby read, no write). */
export const R1_MEET_ASHBY_TAG_WANTED_HELD = 'tag_wanted_held';

/**
 * Run the job (see the header). Exported for tests and for the Meet-off catch-up; the dispatcher
 * reaches it through the definition. Only `ashbyTag`, `now` and `log` of the flow deps are used.
 */
export async function runR1MeetAshbyBookedTag(
  deps: Pick<R1MeetFlowDeps, 'ashbyTag' | 'now' | 'log'>,
  job: R1MeetAshbyBookedTagJob,
  meta: R1MeetJobMeta,
  options: R1MeetAshbyTagRunOptions = {},
): Promise<R1MeetJobResult> {
  // 1. Wiring.
  const tag = deps.ashbyTag;
  if (tag === undefined || tag === null) throw new R1MeetJobError(R1_MEET_ASHBY_TAG_UNWIRED);
  const store = tag.store;
  const wait = (which: R1MeetAshbyTagWait): R1MeetJobResult => deferOrThrow(meta, deps.now(), which);
  /** A transient Ashby wait, backed off while it repeats (see the header). */
  const backoff = (which: R1MeetAshbyTagWait): R1MeetJobResult => {
    const nowMs = deps.now();
    return deferOrThrow(meta, nowMs, which, r1MeetAshbyTagBackoffSeconds(meta, nowMs, which));
  };

  // 2. The booking: public only. Nothing else is read for a missing or an Ashby-scheduled row.
  const booking = await store.booking(job.bookingId);
  if (booking === null) return r1MeetIgnored('booking_missing');
  if (booking.source !== PUBLIC_SOURCE) return r1MeetIgnored('ashby_booking');

  // 3. Ashby's own switches (the "stop all Ashby writes" rollback holds this write too), 4. the key.
  if (!switchesOn(tag)) {
    deps.log.warn({ error_category: R1_MEET_ASHBY_TAG_INACTIVE_LOG });
    return wait(R1_MEET_ASHBY_TAG_WAITS.inactive);
  }
  const port = tag.ashby();
  if (port === null) {
    alert(deps.log, 'ashby_key_missing');
    return wait(R1_MEET_ASHBY_TAG_WAITS.keyMissing);
  }

  // 5. The run's time starts: every Ashby call below is one call against it.
  const budget = r1MeetAshbyTagBudget(deps.now);
  const resolver = port.resolver;
  const ashby = {
    applicationInfo: async (applicationId: string) => port.client.applicationInfo(applicationId, undefined, budget.beforeCall()),
    candidateInfo: async (candidateId: string) => port.client.candidateInfo(candidateId, undefined, budget.beforeCall()),
    addTag: async (candidateId: string, tagId: string) => port.client.candidateAddTag(candidateId, tagId, budget.beforeCall()),
    removeTag: async (candidateId: string, tagId: string) =>
      port.client.candidateRemoveTag(candidateId, tagId, budget.beforeCall()),
    resolve: (fresh: boolean): Promise<R1MeetBookedTagResolution> =>
      resolver.resolve({ ...(fresh ? { fresh: true } : {}), budget }),
  };

  /** The candidate's "Lexy R1: Booked" tags, every other tag already dropped. */
  const dexTags = async (candidateId: string): Promise<R1MeetDexTag[]> =>
    r1MeetDexTagsOf((await ashby.candidateInfo(candidateId)).results);

  /** Step 6: does ANY application of this Ashby candidate want the tag? */
  const wantedNow = async (candidateId: string): Promise<R1MeetBookedTagWant> => {
    const linked = await store.candidateApplications(candidateId);
    if (linked.overflow) return { overflow: true };
    for (const applicationId of new Set([booking.applicationId, ...linked.applicationIds])) {
      const newest = await store.newestPublicBooking(applicationId);
      if (newest !== null && r1MeetBookedTagWanted(newest)) return { overflow: false, wanted: true };
    }
    return { overflow: false, wanted: false };
  };

  /**
   * One tag write. A refusal by the tenant may mean the cached tag id is dead, so it drops the cache
   * and answers `refused`. Every other failure (429, 5xx, a timeout, a permission fault, out of time)
   * keeps the cache and propagates to the classification below.
   */
  const write = async (send: () => Promise<unknown>): Promise<'written' | 'refused'> => {
    try {
      await send();
      return 'written';
    } catch (error) {
      if (classifyR1MeetAshbyTagFailure(error)?.kind !== 'rejected') throw error;
      resolver.invalidate();
      return 'refused';
    }
  };

  /** A resolution that is not `found`, as the job's answer (alerts and waits). */
  const unresolved = (resolution: Exclude<R1MeetBookedTagResolution, { status: 'found' }>): R1MeetJobResult => {
    switch (resolution.status) {
      case 'not_found':
        alert(deps.log, 'tag_not_found');
        return wait(R1_MEET_ASHBY_TAG_WAITS.notFound);
      case 'ambiguous':
        alert(deps.log, 'tag_ambiguous');
        return wait(R1_MEET_ASHBY_TAG_WAITS.ambiguous);
      default:
        return backoff(R1_MEET_ASHBY_TAG_WAITS.unavailable);
    }
  };

  const writeRejected = (): R1MeetJobResult => {
    alert(deps.log, 'write_rejected');
    return r1MeetIgnored('tag_write_rejected');
  };

  try {
    // 5. The Ashby candidate: the link's id, else one application.info read. No write-back.
    const link = await store.applicationLink(booking.applicationId);
    const candidateId = link?.externalCandidateId
      ?? extractApplicationInfo((await ashby.applicationInfo(booking.applicationId)).results).candidateId
      ?? null;
    if (candidateId === null) {
      alert(deps.log, 'candidate_id_missing');
      return r1MeetIgnored('candidate_id_missing');
    }

    // 6. WANTED, candidate-wide, from the database.
    const want = await wantedNow(candidateId);
    if (want.overflow) {
      alert(deps.log, 'candidate_links_overflow');
      return r1MeetIgnored('candidate_links_overflow');
    }
    const wanted = want.wanted;
    // The Meet-off catch-up never adds (see `R1MeetAshbyTagRunOptions`).
    if (wanted && options.removeOnly === true) return r1MeetIgnored(R1_MEET_ASHBY_TAG_WANTED_HELD);

    // 7. Already so: nothing to write.
    const tags = await dexTags(candidateId);
    if (r1MeetBookedTagHolds(tags, wanted)) return r1MeetProcessed(wanted ? 'tag_present' : 'tag_absent');

    if (wanted) {
      // 8a. Add the one Lexy tag. The cached id first, once more from a fresh catalogue on a miss.
      let resolution = await ashby.resolve(false);
      if (resolution.status === 'not_found') resolution = await ashby.resolve(true);
      if (resolution.status !== 'found') return unresolved(resolution);
      const tagId = resolution.tagId;
      if ((await write(() => ashby.addTag(candidateId, tagId))) === 'refused') {
        // Refused: look again (the write may have met a tag already there), then once with a fresh id.
        if (!r1MeetBookedTagHolds(await dexTags(candidateId), true)) {
          const again = await ashby.resolve(true);
          if (again.status !== 'found') return unresolved(again);
          const freshTagId = again.tagId;
          if (
            (await write(() => ashby.addTag(candidateId, freshTagId))) === 'refused'
            && !r1MeetBookedTagHolds(await dexTags(candidateId), true)
          ) {
            return writeRejected();
          }
        }
      }
    } else {
      // 8b. Remove every Lexy tag on the candidate (archived duplicates too), a bounded number per run.
      for (const dexTag of tags.slice(0, R1_MEET_ASHBY_TAG_MAX_REMOVES)) {
        if ((await write(() => ashby.removeTag(candidateId, dexTag.id))) === 'refused') {
          const stillThere = (await dexTags(candidateId)).some((held) => held.id === dexTag.id);
          if (stillThere) return writeRejected();
        }
      }
    }

    // 9. The final look: Ashby again AND the wanted state again.
    const after = await dexTags(candidateId);
    const wantAfter = await wantedNow(candidateId);
    if (wantAfter.overflow) {
      alert(deps.log, 'candidate_links_overflow');
      return r1MeetIgnored('candidate_links_overflow');
    }
    if (wantAfter.wanted === wanted && r1MeetBookedTagHolds(after, wanted)) {
      return r1MeetProcessed(wanted ? 'tag_added' : 'tag_removed');
    }
    // Someone changed the tag, or a booking changed, while the run wrote: converge on the next run.
    resolver.invalidate();
    return wait(R1_MEET_ASHBY_TAG_WAITS.contended);
  } catch (error) {
    const failure = classifyR1MeetAshbyTagFailure(error);
    if (failure === null) throw error;
    switch (failure.kind) {
      case 'permission':
        alert(deps.log, 'permission_denied', failure.httpStatus);
        return wait(R1_MEET_ASHBY_TAG_WAITS.permission);
      case 'rate_limited':
        return backoff(R1_MEET_ASHBY_TAG_WAITS.rateLimited);
      case 'unavailable':
        return backoff(R1_MEET_ASHBY_TAG_WAITS.unavailable);
      case 'rejected':
        alert(deps.log, failure.detail, failure.httpStatus);
        return r1MeetIgnored('ashby_rejected');
      case 'request_invalid':
        alert(deps.log, failure.detail, failure.httpStatus);
        return r1MeetIgnored('ashby_request_invalid');
      default:
        throw error;
    }
  }
}

/** `ashby_booked_tag` (M035 S11): converge the "Lexy R1: Booked" tag of a public booking's candidate. */
export const r1MeetAshbyBookedTagDefinition: R1MeetJobDefinition<R1MeetAshbyBookedTagJob> = Object.freeze({
  kind: 'ashby_booked_tag',
  parse: parseAshbyBookedTagJob,
  run(deps: R1MeetFlowDeps, job: R1MeetAshbyBookedTagJob, meta: R1MeetJobMeta): Promise<R1MeetJobResult> {
    return runR1MeetAshbyBookedTag(deps, job, meta);
  },
});
