/**
 * The Ashby side of the "Dex R1: Booked" tag lane (M035 S11, dark; D-S11-5, D-S11-6, D-S11-8, D-S11-9).
 *
 * OWNER DECISION 5 (M035): a candidate who books R1 through the public link carries the Ashby tag
 * "Dex R1: Booked" while that booking stands, and loses it when the booking is cancelled or fails
 * before the interview. The `ashby_booked_tag` job (`ashby-booked-tag.ts`) decides WHETHER the tag is
 * wanted, from the database; this module is only how the job talks to Ashby.
 *
 * EXPLICIT SETTINGS. The API key, the logger, the clock and the test transport are arguments: this
 * module reads no environment, and loading it performs no I/O. The runtime builds the port lazily,
 * on the first tag job that needs it, from the existing Ashby runtime configuration.
 *
 * ONE TITLE, NEVER CREATED (D-S11-5). The tag id is resolved by its exact title
 * `R1_MEET_BOOKED_TAG_TITLE` through `candidateTag.list`: every page is walked (100 per page, at most
 * 100 pages), and an entry counts only with a non-empty string id, a string title whose trim equals
 * the title exactly (case-sensitive) and `isArchived === false`. One id is `found`, none `not_found`,
 * two or more `ambiguous`, and a walk that did not reach its end (results not a list, more data with
 * no cursor or a repeated one, the page cap) `truncated`. A complete walk is cached for five minutes
 * per port; a truncated or failed one never is; `fresh` bypasses and refreshes the cache and
 * `invalidate()` drops it. The lane NEVER creates a tag (the client has no such operation): the
 * Ashby admin creates it once.
 *
 * THE CANDIDATE'S TAGS (D-S11-6). From a `candidate.info` answer only the entries titled exactly
 * "Dex R1: Booked" (after a trim, any `isArchived`) are kept; every other tag (Christy's, Referral,
 * anything) is dropped before a later step can see it. `tags` left out reads as none; `tags` that is
 * not a list, or an answer that is not a Candidate, is malformed and the job waits.
 *
 * THE CLIENT AND THE RUN BUDGET (D-S11-8). A dedicated Ashby client with one attempt per call and a
 * 10 s timeout: the `r1-meet` queue does every retry. A run has 30 s from its start: each call is
 * handed the time LEFT, carried across to the wall clock the client keeps (the two clocks are never
 * compared), and no call starts with under 3 s left, so nothing is half-written when time runs out.
 * The port exposes exactly five calls: `application.info`, `candidate.info`, `candidateTag.list`,
 * `candidate.addTag` and `candidate.removeTag`, and never forwards an `extra` field.
 *
 * FAILURES (D-S11-9), first match wins: `permission` (HTTP 401 or 403, or the endpoint code
 * `missing_endpoint_permission` in any case, which Ashby also sends with a 200); otherwise the
 * scorecard lane's classes (`classifyR1MeetAshbyFailure`): `rate_limited`, `unavailable`,
 * `rejected`, `request_invalid`. Our own malformed-tags answer and the out-of-time stop count as
 * `unavailable`. Anything else answers null and the caller rethrows it.
 *
 * LOGS ARE METADATA ONLY. The client's own lines become `r1_meet_ashby_ok` / `r1_meet_ashby_failed`
 * with the operation, the category and the HTTP status: never the key, a tag id, a candidate id or
 * name, or the title.
 */

import { createAshbyClient, type AshbyTransport } from '../../../integrations/ashby/client.js';
import { isAshbyError } from '../../../integrations/ashby/errors.js';
import type { AshbyCallOptions, AshbyResult, CandidateTagListParams } from '../../../integrations/ashby/types.js';
import { classifyR1MeetAshbyFailure, r1MeetAshbyClientLogger, type R1MeetAshbyFailureKind } from './feedback-ashby.js';
import type { R1MeetLog } from './recall-actions.js';

/** The exact title the Ashby admin creates. Compared after a trim, case-sensitive. */
export const R1_MEET_BOOKED_TAG_TITLE = 'Dex R1: Booked';

/** The client settings of the port (D-S11-8): no retries inside the client, 10 s per call. */
export const R1_MEET_ASHBY_TAG_CLIENT_SETTINGS = Object.freeze({ maxAttempts: 1, timeoutMs: 10_000 });

/** A complete catalogue walk is reused this long (per port, so per process). */
export const R1_MEET_BOOKED_TAG_CACHE_MS = 5 * 60_000;
/** `candidateTag.list` page size: the endpoint's documented maximum. */
export const R1_MEET_BOOKED_TAG_PAGE_SIZE = 100;
/** A tenant needs far fewer pages than this; more reads as a truncated catalogue. */
export const R1_MEET_BOOKED_TAG_MAX_PAGES = 100;
/** One run's time for every Ashby call it makes. */
export const R1_MEET_ASHBY_TAG_RUN_MS = 30_000;
/** No Ashby call starts with less than this left of the run. */
export const R1_MEET_ASHBY_TAG_MIN_CALL_MS = 3_000;
/** At most this many `candidate.removeTag` calls in one run. */
export const R1_MEET_ASHBY_TAG_MAX_REMOVES = 5;

// ── The run budget ──────────────────────────────────────────────────────────

/** Too little of the run's time is left to start an Ashby call. The job waits. */
export class R1MeetAshbyTagOutOfTime extends Error {
  constructor() {
    super('r1_meet_ashby_tag_out_of_time');
    this.name = 'R1MeetAshbyTagOutOfTime';
  }
}

/**
 * The run's time, spent one Ashby call at a time. `beforeCall` is called right before each call: it
 * throws {@link R1MeetAshbyTagOutOfTime} when too little is left, and otherwise answers the options
 * that cut that call off at the run's end.
 */
export interface R1MeetAshbyTagBudget {
  beforeCall(): AshbyCallOptions;
}

/**
 * The budget of a run that starts now on `nowMs`'s clock. The client keeps time on the wall clock,
 * so each call is handed the time LEFT, carried across to `Date.now()`. A clock that answers no
 * finite time fails closed (out of time).
 */
export function r1MeetAshbyTagBudget(nowMs: () => number): R1MeetAshbyTagBudget {
  const deadlineMs = nowMs() + R1_MEET_ASHBY_TAG_RUN_MS;
  return Object.freeze({
    beforeCall(): AshbyCallOptions {
      const left = deadlineMs - nowMs();
      if (!Number.isFinite(left) || left < R1_MEET_ASHBY_TAG_MIN_CALL_MS) throw new R1MeetAshbyTagOutOfTime();
      return { deadlineAt: Date.now() + left };
    },
  });
}

// ── The client surface ──────────────────────────────────────────────────────

/**
 * The five Ashby calls the lane makes. `AshbyClient` satisfies it. The lane sends no `extra` fields;
 * `options` carries the run's deadline.
 */
export interface R1MeetAshbyTagClient {
  applicationInfo(applicationId: string, extra?: undefined, options?: AshbyCallOptions): Promise<AshbyResult<unknown>>;
  candidateInfo(candidateId: string, extra?: undefined, options?: AshbyCallOptions): Promise<AshbyResult<unknown>>;
  candidateAddTag(candidateId: string, tagId: string, options?: AshbyCallOptions): Promise<unknown>;
  candidateRemoveTag(candidateId: string, tagId: string, options?: AshbyCallOptions): Promise<unknown>;
  candidateTagList(params?: CandidateTagListParams): Promise<AshbyResult<unknown>>;
}

// ── The tag id resolver (D-S11-5) ───────────────────────────────────────────

export type R1MeetBookedTagResolution =
  /** `cached`: the id came from a catalogue walk up to five minutes old. */
  | { readonly status: 'found'; readonly tagId: string; readonly cached: boolean }
  | { readonly status: 'not_found' }
  | { readonly status: 'ambiguous' }
  /** The catalogue could not be read to its end, so "not found" cannot be said. */
  | { readonly status: 'truncated' };

export interface R1MeetBookedTagResolver {
  /**
   * `budget` is the run's time: each catalogue page is one call against it, so a slow walk stops
   * (throwing {@link R1MeetAshbyTagOutOfTime}) rather than run past it.
   */
  resolve(options?: { readonly fresh?: boolean; readonly budget?: R1MeetAshbyTagBudget }): Promise<R1MeetBookedTagResolution>;
  /** Drop the cached catalogue, so the next resolve reads Ashby again. */
  invalidate(): void;
}

/**
 * Walk every page and keep the active ids titled exactly `R1_MEET_BOOKED_TAG_TITLE`. Returns null
 * when the walk did not reach its end: results that are not a list, a truthy `moreDataAvailable`
 * with no cursor or a repeated one, or the page cap. An Ashby page may be empty while more data
 * follows, so an empty page continues. A provider error, or the budget running out, propagates.
 */
async function readBookedTagIds(
  reader: Pick<R1MeetAshbyTagClient, 'candidateTagList'>,
  budget: R1MeetAshbyTagBudget | undefined,
): Promise<ReadonlySet<string> | null> {
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < R1_MEET_BOOKED_TAG_MAX_PAGES; page++) {
    const call = budget?.beforeCall();
    const res = await reader.candidateTagList({
      ...(cursor !== undefined ? { cursor } : {}),
      limit: R1_MEET_BOOKED_TAG_PAGE_SIZE,
      ...(call?.deadlineAt !== undefined ? { deadlineAt: call.deadlineAt } : {}),
    });
    if (!Array.isArray(res.results)) return null;
    for (const item of res.results as unknown[]) {
      if (item === null || typeof item !== 'object') continue;
      const { id, title, isArchived } = item as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') continue;
      // `=== false` only: an entry that does not say it is active is not trusted.
      if (isArchived !== false) continue;
      if (title.trim() !== R1_MEET_BOOKED_TAG_TITLE) continue;
      ids.add(id);
    }
    if (!res.moreDataAvailable) return ids;
    const next = res.nextCursor;
    if (!next || seenCursors.has(next)) return null;
    seenCursors.add(next);
    cursor = next;
  }
  return null;
}

/**
 * Resolve the one active "Dex R1: Booked" tag id. A complete walk is cached for
 * {@link R1_MEET_BOOKED_TAG_CACHE_MS}; a failed or truncated one never is. `fresh` bypasses the cache
 * and refreshes it, and `invalidate` drops it. More than one active match fails closed.
 */
export function createR1MeetBookedTagResolver(
  reader: Pick<R1MeetAshbyTagClient, 'candidateTagList'>,
  nowMs: () => number = () => Date.now(),
): R1MeetBookedTagResolver {
  let cached: { readonly at: number; readonly ids: ReadonlySet<string> } | null = null;
  const usable = (): ReadonlySet<string> | null => {
    if (!cached) return null;
    const age = nowMs() - cached.at;
    return age >= 0 && age < R1_MEET_BOOKED_TAG_CACHE_MS ? cached.ids : null;
  };
  return Object.freeze({
    async resolve(options: { readonly fresh?: boolean; readonly budget?: R1MeetAshbyTagBudget } = {}) {
      let ids: ReadonlySet<string> | null = options.fresh === true ? null : usable();
      const fromCache = ids !== null;
      if (!ids) {
        ids = await readBookedTagIds(reader, options.budget);
        if (!ids) return { status: 'truncated' } as const;
        cached = { at: nowMs(), ids };
      }
      if (ids.size === 0) return { status: 'not_found' } as const;
      if (ids.size > 1) return { status: 'ambiguous' } as const;
      return { status: 'found', tagId: [...ids][0] as string, cached: fromCache } as const;
    },
    invalidate() {
      cached = null;
    },
  });
}

// ── The port ────────────────────────────────────────────────────────────────

export interface R1MeetAshbyTagPort {
  readonly client: R1MeetAshbyTagClient;
  readonly resolver: R1MeetBookedTagResolver;
}

export interface R1MeetAshbyTagPortOptions {
  /** `ASHBY_API_KEY`, passed in by the runtime. Never logged. */
  readonly apiKey: string;
  readonly log: R1MeetLog;
  /** Test seam: replaces the network (the Ashby fake). Production passes nothing. */
  readonly transport?: AshbyTransport;
  /** Test seam for the client's backoff sleep (unused with one attempt). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** The catalogue cache's clock. Defaults to `Date.now`. */
  readonly nowMs?: () => number;
}

/**
 * Build the port: one client (one attempt per call, 10 s), the resolver over it, both frozen. The
 * client is narrowed to the five calls of {@link R1MeetAshbyTagClient} and never forwards `extra`.
 * Throws the client's `invalid_request` (`missing_api_key`) for an empty key, so the caller builds
 * it only with a usable key.
 */
export function createR1MeetAshbyTagPort(options: R1MeetAshbyTagPortOptions): R1MeetAshbyTagPort {
  const ashby = createAshbyClient({
    apiKey: options.apiKey,
    maxAttempts: R1_MEET_ASHBY_TAG_CLIENT_SETTINGS.maxAttempts,
    timeoutMs: R1_MEET_ASHBY_TAG_CLIENT_SETTINGS.timeoutMs,
    logger: r1MeetAshbyClientLogger(options.log),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  });
  const client: R1MeetAshbyTagClient = Object.freeze({
    applicationInfo: (applicationId: string, _extra?: undefined, call?: AshbyCallOptions) =>
      ashby.applicationInfo<unknown>(applicationId, undefined, call),
    candidateInfo: (candidateId: string, _extra?: undefined, call?: AshbyCallOptions) =>
      ashby.candidateInfo<unknown>(candidateId, undefined, call),
    candidateAddTag: (candidateId: string, tagId: string, call?: AshbyCallOptions) =>
      ashby.candidateAddTag<unknown>(candidateId, tagId, call),
    candidateRemoveTag: (candidateId: string, tagId: string, call?: AshbyCallOptions) =>
      ashby.candidateRemoveTag<unknown>(candidateId, tagId, call),
    candidateTagList: (params?: CandidateTagListParams) => ashby.candidateTagList<unknown>(params),
  });
  const resolver = createR1MeetBookedTagResolver(client, options.nowMs ?? (() => Date.now()));
  return Object.freeze({ client, resolver });
}

// ── The candidate's Dex tags (D-S11-6) ──────────────────────────────────────

/** One "Dex R1: Booked" tag on a candidate. Nothing else of a tag is kept. */
export interface R1MeetDexTag {
  readonly id: string;
  readonly isArchived: boolean;
}

/** A `candidate.info` answer in a shape the lane will not write from. The job waits. */
export class R1MeetAshbyTagMalformed extends Error {
  constructor() {
    super('r1_meet_ashby_tag_malformed');
    this.name = 'R1MeetAshbyTagMalformed';
  }
}

/**
 * The "Dex R1: Booked" tags of a `candidate.info` answer's `results`. Ashby marks `tags` required, so
 * a candidate with the key left out most plausibly has none: that reads as an empty list. A `tags`
 * that is there but not a list, or results that are not a plain object, throw
 * {@link R1MeetAshbyTagMalformed}. Every other tag is dropped here. An id listed twice is kept once,
 * archived only when every copy says so.
 */
export function r1MeetDexTagsOf(results: unknown): R1MeetDexTag[] {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) throw new R1MeetAshbyTagMalformed();
  if (!('tags' in results)) return [];
  const tags = (results as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) throw new R1MeetAshbyTagMalformed();
  const archivedById = new Map<string, boolean>();
  for (const item of tags as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { id, title, isArchived } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') continue;
    if (title.trim() !== R1_MEET_BOOKED_TAG_TITLE) continue;
    const archived = isArchived === true;
    archivedById.set(id, (archivedById.get(id) ?? true) && archived);
  }
  return [...archivedById].map(([id, isArchived]) => Object.freeze({ id, isArchived }));
}

/**
 * Does the candidate already hold the wanted state? Wanted: at least one Dex tag that is not
 * archived. Not wanted: no Dex tag at all (an archived one still has to go).
 */
export function r1MeetBookedTagHolds(tags: readonly R1MeetDexTag[], wanted: boolean): boolean {
  return wanted ? tags.some((tag) => !tag.isArchived) : tags.length === 0;
}

// ── Failure classes (D-S11-9) ───────────────────────────────────────────────

export type R1MeetAshbyTagFailureKind = 'permission' | R1MeetAshbyFailureKind;

export interface R1MeetAshbyTagFailure {
  readonly kind: R1MeetAshbyTagFailureKind;
  /** `<category>[:<code>]`, `permission_denied`, `malformed_response` or `out_of_time`: closed words. */
  readonly detail: string;
  readonly httpStatus: number | null;
}

const MISSING_PERMISSION = 'missing_endpoint_permission';

/** Classify a failure of the lane's Ashby side (see the header); null for anything else. */
export function classifyR1MeetAshbyTagFailure(error: unknown): R1MeetAshbyTagFailure | null {
  if (error instanceof R1MeetAshbyTagMalformed) {
    return Object.freeze({ kind: 'unavailable', detail: 'malformed_response', httpStatus: null });
  }
  if (error instanceof R1MeetAshbyTagOutOfTime) {
    return Object.freeze({ kind: 'unavailable', detail: 'out_of_time', httpStatus: null });
  }
  if (!isAshbyError(error)) return null;
  const httpStatus = typeof error.httpStatus === 'number' ? error.httpStatus : null;
  // A 401 is the same fault as a 403 (a wrong or dead key), and Ashby also names a missing module
  // with a 200: no retry heals either, so both wait an hour and alert.
  if (
    httpStatus === 401
    || httpStatus === 403
    || error.endpointCodes.some((code) => code.toLowerCase() === MISSING_PERMISSION)
  ) {
    return Object.freeze({ kind: 'permission', detail: 'permission_denied', httpStatus });
  }
  return classifyR1MeetAshbyFailure(error);
}
