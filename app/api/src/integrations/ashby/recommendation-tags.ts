/**
 * ashby/recommendation-tags.ts — the Christy verdict tag on the Ashby candidate.
 *
 * Owner decisions, binding (M027):
 *   - advance -> `Christy: Select`, hold -> `Christy: Borderline`, reject ->
 *     `Christy: Reject`. A provisional verdict (scoring_status
 *     `incomplete_evidence` with a non-null recommendation) IS tagged, Reject
 *     included.
 *   - No verdict (NULL, which is how `human_review` is stored) or no assessment
 *     gets NO tag.
 *   - Evidence graded `insufficient` does NOT suppress the tag (owner decision
 *     2026-11-05, M028): a thin call that still carries a raw verdict is
 *     tagged with that lean, so the team can find it in Ashby. HELLO keeps
 *     showing it as held for insufficient evidence, and its scorecard is still
 *     not written to Ashby.
 *   - The newest verdict wins, and a candidate carries at most one Christy tag.
 *     Tags are candidate-wide, not per application.
 *   - The lane touches those three titles and no other tag, and never creates a
 *     tag: the admin created them in Ashby.
 *
 * WHY ITS OWN OPERATION. A tag failure can never resend or disturb a scorecard,
 * which cannot be retracted, and a tag has no dependency on a scorecard (see
 * migration 0134).
 *
 * WHICH VERDICT. An operation is a trigger, not a decision. Every run asks the
 * database for the candidate's authoritative verdict NOW: the newest assessment
 * on any of the candidate's Ashby links (0134 `ashby_candidate_tag_verdict`).
 * So claim order, defers, retries, the backfill and two workers at once all
 * converge on the newest verdict, and a result that never got an operation
 * (kill switch off, a failed enqueue) is honoured by any later one.
 *
 * THE RUN. Resolve the candidate, read the verdict, read the candidate's tags,
 * write the difference: add first, then remove, so a candidate is never without
 * a tag it should have. Then look once more and complete only when the desired
 * state holds. A repeat makes no writes, which is what makes
 * `{ idempotent: true }` on the client's tag writes safe.
 *
 * THE ERRORS ARE CLASSIFIED HERE, not in the worker's catch, which copies
 * `error.retriable` and so makes a timeout or `retry_exhausted` terminal. Almost
 * everything WAITS (a defer refunds the attempt), and age ends a wait, so a hot
 * retry can never burn the attempts in seconds.
 *
 * THE RUN HAS A DEADLINE under its lease. A defer is refused once the lease has
 * run out (0035), and nothing reclaims a `running` row, so a slow run that then
 * waited would be stranded for good. Every Ashby call is cut off at the
 * deadline and none starts close to it, so the run reaches its defer with the
 * lease still live. Should a defer be refused anyway, a retryable fail (which
 * does not check the lease's expiry) puts the row back to pending.
 *
 * LOGS AND EVENTS ARE METADATA ONLY: no tag id, candidate id or name, and no
 * title beyond the fixed constants below.
 */

import { isAshbyError, type AshbyError } from './errors.js';
import { extractApplicationInfo } from './extractors.js';
import type {
  OperationClaimRow,
  RecommendationTagLink,
  RecommendationTagSource,
  RuntimeWorkflowStores,
} from './orchestration.js';
import type { OperationRunOutcome } from './operation-worker.js';
import type { AshbyCallOptions, AshbyResult, CandidateTagListParams } from './types.js';

/** The exact titles the admin created in Ashby. Compared after a trim, case-sensitive. */
export const CHRISTY_VERDICT_TAG_TITLES = {
  select: 'Christy: Select',
  borderline: 'Christy: Borderline',
  reject: 'Christy: Reject',
} as const;

export type ChristyVerdictTag = keyof typeof CHRISTY_VERDICT_TAG_TITLES;
export type ChristyTagTitle = (typeof CHRISTY_VERDICT_TAG_TITLES)[ChristyVerdictTag];

const CHRISTY_TITLES: ReadonlySet<string> = new Set(Object.values(CHRISTY_VERDICT_TAG_TITLES));

/** A complete catalogue read is reused this long, the form definition cache's TTL. */
export const CHRISTY_TAG_CACHE_MS = 5 * 60_000;
/** A tenant needs far fewer pages than this; more reads as a truncated catalogue. */
const MAX_TAG_LIST_PAGES = 100;
const TAG_LIST_PAGE_SIZE = 100;

/** Waits between tries. The RPC clamps a defer to 3600 s. */
export const TAG_CONFIG_FAULT_DEFER_SECONDS = 3600;
export const TAG_TRANSIENT_DEFER_SECONDS = 300;
/** A defer refunds the attempt, so age is what ends a row that keeps deferring. */
export const TAG_DEFER_AGE_LIMIT_MS = 7 * 24 * 60 * 60_000;

/**
 * The run stops this long before its lease ends, so its defer (0035 refuses an
 * expired lease) still lands. A lease under 30 s keeps half of itself instead,
 * so the deadline is never at or before the start.
 */
export const TAG_LEASE_MARGIN_MS = 15_000;
/** No Ashby call starts with less than this left (a third of a shorter run). */
export const TAG_MIN_CALL_MS = 5_000;

/** Too little of the run's time is left to start an Ashby call. The lane waits. */
export class TagRunOutOfTime extends Error {
  constructor() {
    super('tag_run_out_of_time');
  }
}

/**
 * The run's time, spent one Ashby call at a time. `beforeCall` is called right
 * before each call: it throws {@link TagRunOutOfTime} when too little is left,
 * and otherwise answers the options that cut that call off at the deadline.
 */
export interface TagCallBudget {
  beforeCall(): AshbyCallOptions;
}

/**
 * The budget for a run claimed at `claimedAtMs` (on `nowMs`'s clock) with a
 * lease of `leaseSeconds`, or undefined when either is unknown. The client
 * keeps time on the wall clock, so each call is handed the time LEFT, carried
 * across to `Date.now()`: the two clocks are then never compared.
 */
export function tagCallBudget(
  nowMs: () => number,
  claimedAtMs: number | undefined,
  leaseSeconds: number | undefined,
): TagCallBudget | undefined {
  if (typeof claimedAtMs !== 'number' || !Number.isFinite(claimedAtMs)) return undefined;
  if (typeof leaseSeconds !== 'number' || !Number.isFinite(leaseSeconds) || leaseSeconds <= 0) return undefined;
  // The claim RPC clamps the lease to 900 s.
  const leaseMs = Math.min(leaseSeconds, 900) * 1000;
  const runMs = leaseMs - Math.min(TAG_LEASE_MARGIN_MS, leaseMs / 2);
  const deadlineMs = claimedAtMs + runMs;
  const minCallMs = Math.min(TAG_MIN_CALL_MS, runMs / 3);
  return {
    beforeCall() {
      const left = deadlineMs - nowMs();
      if (left < minCallMs) throw new TagRunOutOfTime();
      return { deadlineAt: Date.now() + left };
    },
  };
}

/** The link or the candidate's verdict could not be read from the database. */
export const TAG_VERDICT_UNREADABLE = 'ashby_tag_verdict_unreadable';
/** The tags changed under the run (another worker, a recruiter); the next run re-checks. */
export const TAG_CONTENDED = 'ashby_tag_contended';

/** Kill switch. Exactly `'true'` is on. */
export function recommendationTagsEnabled(): boolean {
  return process.env.ASHBY_RECOMMENDATION_TAGS_ENABLED === 'true';
}

/**
 * Pure verdict-to-tag map. `recommendation` MUST be the raw
 * `assessments.recommendation` column, read for the tag itself. Since M029
 * `ScorecardSource.recommendation` carries the raw verdict too and
 * `buildScorecard` refuses a missing one (`invalid_recommendation`) rather than
 * reading it as `hold`, but the tag still never depends on the scorecard path.
 *
 * The evidence grade is deliberately not an input: since M028 a verdict graded
 * `insufficient` is tagged with its lean like any other.
 */
export function christyTagForVerdict(input: {
  recommendation: unknown;
}): ChristyVerdictTag | null {
  if (input.recommendation === 'advance') return 'select';
  if (input.recommendation === 'hold') return 'borderline';
  if (input.recommendation === 'reject') return 'reject';
  return null;
}

// ── Tag id resolver ─────────────────────────────────────────────────────────

/** The one client method the resolver needs. */
export interface TagCatalogueReader {
  candidateTagList(params?: CandidateTagListParams): Promise<AshbyResult<unknown>>;
}

export type ChristyTagResolution =
  /** `cached`: the id came from a catalogue read up to five minutes old. */
  | { status: 'found'; tagId: string; cached: boolean }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  /** The catalogue could not be read to its end, so "not found" cannot be said. */
  | { status: 'truncated' };

export interface ChristyTagResolver {
  /**
   * `budget` is the run's time: each catalogue page is a call against it, so a
   * slow walk stops (throwing {@link TagRunOutOfTime}) rather than run past it.
   */
  resolve(title: ChristyTagTitle, options?: { fresh?: boolean; budget?: TagCallBudget }): Promise<ChristyTagResolution>;
  /** Drop the cached catalogue, so the next resolve reads Ashby again. */
  invalidate?(): void;
}

type TagCatalogue = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Walk every page and keep the active ids of the three titles. Returns null when
 * the walk did not reach the end: a truthy `moreDataAvailable` with no usable
 * cursor, a repeated cursor, the page cap, or a result that is not a list.
 * An Ashby page may be empty while more data follows, so an empty page continues.
 * A provider error, or the budget running out, propagates to the lane's own
 * classification.
 */
async function readTagCatalogue(reader: TagCatalogueReader, budget?: TagCallBudget): Promise<TagCatalogue | null> {
  const catalogue = new Map<string, Set<string>>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TAG_LIST_PAGES; page++) {
    const call = budget?.beforeCall();
    const res = await reader.candidateTagList({
      ...(cursor !== undefined ? { cursor } : {}),
      limit: TAG_LIST_PAGE_SIZE,
      ...(call?.deadlineAt !== undefined ? { deadlineAt: call.deadlineAt } : {}),
    });
    if (!Array.isArray(res.results)) return null;
    for (const item of res.results as unknown[]) {
      if (item === null || typeof item !== 'object') continue;
      const { id, title, isArchived } = item as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') continue;
      // `=== false` only: a row that does not say it is active is not trusted.
      if (isArchived !== false) continue;
      const trimmed = title.trim();
      if (!CHRISTY_TITLES.has(trimmed)) continue;
      let ids = catalogue.get(trimmed);
      if (!ids) {
        ids = new Set();
        catalogue.set(trimmed, ids);
      }
      ids.add(id);
    }
    if (!res.moreDataAvailable) return catalogue;
    const next = res.nextCursor;
    if (!next || seenCursors.has(next)) return null;
    seenCursors.add(next);
    cursor = next;
  }
  return null;
}

/**
 * Resolve a title to its one active tag id. A complete read is cached for
 * {@link CHRISTY_TAG_CACHE_MS}; a failed or truncated one never is. `fresh`
 * bypasses the cache and refreshes it, and `invalidate` drops it. More than one
 * active match fails closed.
 */
export function createChristyTagResolver(
  reader: TagCatalogueReader,
  nowMs: () => number = () => Date.now(),
): ChristyTagResolver {
  let cached: { at: number; catalogue: TagCatalogue } | null = null;
  return {
    async resolve(title, options = {}) {
      let catalogue: TagCatalogue | null =
        !options.fresh && cached && nowMs() - cached.at < CHRISTY_TAG_CACHE_MS ? cached.catalogue : null;
      const fromCache = catalogue !== null;
      if (!catalogue) {
        catalogue = await readTagCatalogue(reader, options.budget);
        if (!catalogue) return { status: 'truncated' };
        cached = { at: nowMs(), catalogue };
      }
      const ids = catalogue.get(title);
      if (!ids || ids.size === 0) return { status: 'not_found' };
      if (ids.size > 1) return { status: 'ambiguous' };
      return { status: 'found', tagId: [...ids][0], cached: fromCache };
    },
    invalidate() {
      cached = null;
    },
  };
}

// ── Lane executor ───────────────────────────────────────────────────────────

/**
 * The client surface the lane uses. `AshbyClient` satisfies it. The lane sends
 * no `extra` fields; `options` carries the run's deadline.
 */
export interface RecommendationTagClient {
  applicationInfo(applicationId: string, extra?: undefined, options?: AshbyCallOptions): Promise<AshbyResult<unknown>>;
  candidateInfo(candidateId: string, extra?: undefined, options?: AshbyCallOptions): Promise<AshbyResult<unknown>>;
  candidateAddTag(candidateId: string, tagId: string, options?: AshbyCallOptions): Promise<unknown>;
  candidateRemoveTag(candidateId: string, tagId: string, options?: AshbyCallOptions): Promise<unknown>;
}

export interface RecommendationTagAdapter {
  client: RecommendationTagClient;
  resolver: ChristyTagResolver;
}

/** What settling a claimed tag operation needs: the three outbox writes, a clock and the observer. */
export interface RecommendationTagSettleDeps {
  stores: Pick<RuntimeWorkflowStores, 'completeOperation' | 'failOperation' | 'deferOperation'>;
  nowMs?: () => number;
  onEvent?: (event: { kind: string; operationType: string; code?: string }) => void;
}

export interface RecommendationTagDeps extends RecommendationTagSettleDeps {
  stores: Pick<
    RuntimeWorkflowStores,
    | 'completeOperation'
    | 'failOperation'
    | 'deferOperation'
    | 'readRecommendationTagLink'
    | 'readRecommendationTagSource'
    | 'bindLinkExternalCandidateId'
  >;
  adapter: RecommendationTagAdapter;
  /**
   * When the operation was claimed (on `nowMs`'s clock, read just BEFORE the
   * claim call, so the deadline errs early) and the lease it was claimed with.
   * Together they set the run's deadline ({@link tagCallBudget}). Either one
   * absent: no deadline.
   */
  claimedAtMs?: number;
  leaseSeconds?: number;
}

/**
 * Where the age limit counts from: the newest manual Retry (0134 claim
 * `age_anchor`), else creation. NaN when neither can be read.
 */
function waitStartedMs(claim: OperationClaimRow): number {
  for (const value of [claim.ageAnchor, claim.createdAt]) {
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isFinite(ms)) return ms;
  }
  return Number.NaN;
}

/** The lane's three ways to end a run. Shared by the executor and the worker's preamble. */
function tagSettlers(claim: OperationClaimRow, deps: RecommendationTagSettleDeps) {
  const { stores } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());

  const emit = (kind: string, code: string): void => {
    if (!deps.onEvent) return;
    try { deps.onEvent({ kind, operationType: claim.operationType, code }); } catch { /* never break */ }
  };
  const outcome = (committed: boolean, staleLease: boolean, code: string): OperationRunOutcome => ({
    claimed: true, operationType: claim.operationType, committed, staleLease, code,
  });

  const fail = async (code: string, retryable: boolean): Promise<OperationRunOutcome> => {
    const r = await stores.failOperation(claim.id, claim.leaseToken, code, retryable);
    emit(retryable ? 'retry' : 'blocked', code);
    return outcome(false, r === 'not_owned', code);
  };
  const complete = async (anchor: string): Promise<OperationRunOutcome> => {
    // Marker null: a tag has no content marker, and complete keeps it null.
    const r = await stores.completeOperation(claim.id, claim.leaseToken, anchor, null);
    emit('christy_tag', r === 'ok' ? anchor : 'stale_lease');
    return outcome(r === 'ok', r !== 'ok', anchor);
  };
  /**
   * A wait, not a failure: the attempt is refunded. That same refund means a wait
   * never ends by itself, so an operation whose wait began more than the limit
   * ago (its creation, or its newest manual Retry) fails with the code it was
   * waiting on. An unknown age keeps waiting.
   *
   * The one defer helper. 0035 defer refuses a lease that has run out, while
   * fail checks only the token and the state, and nothing reclaims a `running`
   * row. So a refused defer falls back to a retryable fail, which puts the row
   * back to pending (spending the attempt the defer would have refunded). Only a
   * fail refused too means the lease is really gone.
   */
  const defer = async (code: string, seconds: number): Promise<OperationRunOutcome> => {
    const startedMs = waitStartedMs(claim);
    if (Number.isFinite(startedMs) && nowMs() - startedMs > TAG_DEFER_AGE_LIMIT_MS) {
      return fail(code, false);
    }
    const r = await stores.deferOperation(claim.id, claim.leaseToken, code, seconds);
    if (r !== 'not_owned') {
      emit('deferred', code);
      return outcome(false, false, code);
    }
    emit('defer_refused', code);
    return fail(code, true);
  };

  return { emit, outcome, fail, complete, defer };
}

/**
 * Defer a claimed tag operation: the worker's preamble uses it, so a database
 * blip before the executor waits like one inside it instead of failing hot.
 * Same age limit and the same not_owned fallback as the executor's own waits.
 */
export function deferRecommendationTag(
  claim: OperationClaimRow,
  deps: RecommendationTagSettleDeps,
  code: string,
  seconds: number,
): Promise<OperationRunOutcome> {
  return tagSettlers(claim, deps).defer(code, seconds);
}

interface CandidateChristyTag {
  id: string;
  title: string;
  isArchived: boolean;
}

/** A candidate answer Ashby sent in a shape the lane will not write from. */
class MalformedTagAnswer extends Error {
  constructor() {
    super('candidate_tags_malformed');
  }
}

/** Keep the three Christy titles; drop every other tag, so no later step can touch one. */
function christyOnly(tags: readonly unknown[]): CandidateChristyTag[] {
  const out: CandidateChristyTag[] = [];
  for (const item of tags) {
    if (item === null || typeof item !== 'object') continue;
    const { id, title, isArchived } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') continue;
    const trimmed = title.trim();
    if (CHRISTY_TITLES.has(trimmed)) out.push({ id, title: trimmed, isArchived: isArchived === true });
  }
  return out;
}

/**
 * The Christy tags in a `candidate.info` answer. Ashby marks `tags` required, so
 * a candidate with the key left out most plausibly has none: that reads as an
 * empty list. A `tags` that is there but not a list, or an answer that is not a
 * Candidate at all, is malformed, and the lane waits rather than write from it.
 */
function christyTagsOf(results: unknown): CandidateChristyTag[] {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) throw new MalformedTagAnswer();
  if (!('tags' in results)) return [];
  const tags = (results as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) throw new MalformedTagAnswer();
  return christyOnly(tags);
}

/**
 * The Christy tags in a tag write's answer (documented as the Candidate), or
 * null when the answer carries no tag list to trust: the caller reads instead.
 */
function christyTagsInWriteAnswer(answer: unknown): CandidateChristyTag[] | null {
  const results = answer !== null && typeof answer === 'object'
    ? (answer as { results?: unknown }).results
    : undefined;
  if (results === null || typeof results !== 'object') return null;
  const tags = (results as { tags?: unknown }).tags;
  return Array.isArray(tags) ? christyOnly(tags) : null;
}

/** The tag that already satisfies the target. An archived one does not. */
function findTarget(tags: readonly CandidateChristyTag[], targetTitle: string | null): CandidateChristyTag | undefined {
  return targetTitle === null ? undefined : tags.find((t) => t.title === targetTitle && !t.isArchived);
}

function desiredStateHolds(tags: readonly CandidateChristyTag[], targetTitle: string | null): boolean {
  const kept = findTarget(tags, targetTitle);
  if (targetTitle !== null && !kept) return false;
  return tags.every((t) => t.id === kept?.id);
}

type TagFault = 'permission' | 'transient' | 'logical' | 'unknown';

/** Ashby documents both forms of a missing permission: HTTP 403 and a 200 with the code. */
export function classifyTagError(error: unknown): TagFault {
  if (!isAshbyError(error)) return 'unknown';
  // A 401 is the same fault as a 403 (a wrong or dead key) and no retry heals it.
  if (error.httpStatus === 403 || error.httpStatus === 401) return 'permission';
  if (error.endpointCodes.some((c) => c.toLowerCase() === 'missing_endpoint_permission')) return 'permission';
  switch (error.category) {
    case 'rate_limited':
    case 'http_server_error':
    case 'timeout':
    case 'network':
    case 'retry_exhausted':
      return 'transient';
    case 'logical_failure':
      return 'logical';
    default:
      return 'unknown';
  }
}

/** A logical failure on a tag WRITE: Ashby answered, and said no. Anything else is not one. */
function refusedWrite(error: unknown): error is AshbyError {
  return isAshbyError(error) && classifyTagError(error) === 'logical';
}

/** `ashby_tag_write_rejected`, plus the endpoint's code when it fits the column. */
function writeRejectedCode(error: AshbyError | null): string {
  const base = 'ashby_tag_write_rejected';
  for (const raw of error?.endpointCodes ?? []) {
    const candidate = `${base}:${raw.toLowerCase()}`;
    if (/^[a-z0-9_.:-]{1,64}$/.test(candidate)) return candidate;
  }
  return base;
}

/**
 * Execute one claimed `recommendation_tag` operation under its lease. Never
 * throws, so the worker's catch is never reached.
 */
export async function executeRecommendationTag(
  claim: OperationClaimRow,
  deps: RecommendationTagDeps,
): Promise<OperationRunOutcome> {
  const { stores, adapter } = deps;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const { outcome, fail, complete, defer } = tagSettlers(claim, deps);

  // Every Ashby call goes through here, so each one is checked against the
  // run's deadline and cut off at it. With no deadline the calls are as before.
  const budget = tagCallBudget(nowMs, deps.claimedAtMs, deps.leaseSeconds);
  const ashby = {
    applicationInfo: async (applicationId: string) => {
      const o = budget?.beforeCall();
      return o ? adapter.client.applicationInfo(applicationId, undefined, o) : adapter.client.applicationInfo(applicationId);
    },
    candidateInfo: async (candidateId: string) => {
      const o = budget?.beforeCall();
      return o ? adapter.client.candidateInfo(candidateId, undefined, o) : adapter.client.candidateInfo(candidateId);
    },
    addTag: async (candidateId: string, tagId: string) => {
      const o = budget?.beforeCall();
      return o ? adapter.client.candidateAddTag(candidateId, tagId, o) : adapter.client.candidateAddTag(candidateId, tagId);
    },
    removeTag: async (candidateId: string, tagId: string) => {
      const o = budget?.beforeCall();
      return o ? adapter.client.candidateRemoveTag(candidateId, tagId, o) : adapter.client.candidateRemoveTag(candidateId, tagId);
    },
    resolve: (title: ChristyTagTitle, fresh: boolean) =>
      budget || fresh
        ? adapter.resolver.resolve(title, { ...(fresh ? { fresh: true } : {}), ...(budget ? { budget } : {}) })
        : adapter.resolver.resolve(title),
  };
  /**
   * A failed tag write may mean the cached id is dead (the admin deleted or
   * archived the tag), whatever Ashby answered: drop the cache, so the next
   * resolve reads the catalogue. A run out of time wrote nothing.
   */
  const writeFailed = (error: unknown): void => {
    if (!(error instanceof TagRunOutOfTime)) adapter.resolver.invalidate?.();
  };
  /**
   * Every error that escapes the run waits. A hot retryable fail would spend all
   * five attempts in about 25 s and end in a row Mission Control cannot retry.
   */
  const settleFault = async (error: unknown): Promise<OperationRunOutcome> => {
    // The deadline stopped the run while its lease is live: wait, as for a slow Ashby.
    if (error instanceof TagRunOutOfTime) return defer('ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
    const fault = classifyTagError(error);
    if (fault === 'permission') return defer('ashby_tag_permission_denied', TAG_CONFIG_FAULT_DEFER_SECONDS);
    if (fault === 'transient') return defer('ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
    // Unknown, a malformed answer, or a logical failure on a read.
    return defer('operation_error', TAG_TRANSIENT_DEFER_SECONDS);
  };

  try {
    // (a) The link's Ashby ids.
    let link: RecommendationTagLink | null = null;
    try {
      link = (await stores.readRecommendationTagLink?.(claim.applicationLinkId)) ?? null;
    } catch {
      link = null;
    }
    if (!link) return await defer(TAG_VERDICT_UNREADABLE, TAG_TRANSIENT_DEFER_SECONDS);

    // (b) The candidate. Older links have no stored id; application.info has it.
    let candidateId = link.externalCandidateId;
    if (!candidateId && link.externalApplicationId) {
      const info = await ashby.applicationInfo(link.externalApplicationId);
      candidateId = extractApplicationInfo(info.results).candidateId ?? null;
      if (candidateId) {
        // Compare-and-set, best effort: the tag does not depend on the bind.
        try {
          await stores.bindLinkExternalCandidateId?.(claim.applicationLinkId, candidateId);
        } catch { /* the next run reads application.info again */ }
      }
    }
    if (!candidateId) return await fail('candidate_id_missing', false);
    const candidate = candidateId;

    // (c) The candidate's verdict, decided now across all its links, with the
    // id just resolved, so a sibling in another job is found even when this
    // link had no stored id.
    let source: RecommendationTagSource | null = null;
    try {
      source = (await stores.readRecommendationTagSource?.(claim.applicationLinkId, candidate)) ?? null;
    } catch {
      source = null;
    }
    if (!source) return await defer(TAG_VERDICT_UNREADABLE, TAG_TRANSIENT_DEFER_SECONDS);
    const target = source.status === 'ok'
      ? christyTagForVerdict({ recommendation: source.recommendation })
      : null;
    const targetTitle = target ? CHRISTY_VERDICT_TAG_TITLES[target] : null;
    const anchor = `christy_tag_${target ?? 'none'}`;

    // (d) What the candidate carries now. A repeat ends here, with no write.
    const readChristyTags = async (): Promise<CandidateChristyTag[]> =>
      christyTagsOf((await ashby.candidateInfo(candidate)).results);
    let tags = await readChristyTags();
    if (desiredStateHolds(tags, targetTitle)) return await complete(anchor);

    // (e) Put the target on. A missing or ambiguous tag writes NOTHING: the old
    // tag stays until the new one can go on.
    let keepId = findTarget(tags, targetTitle)?.id ?? null;
    if (targetTitle && !keepId) {
      let resolved = await ashby.resolve(targetTitle, false);
      if (resolved.status === 'not_found') resolved = await ashby.resolve(targetTitle, true);
      let retried = false;
      for (;;) {
        if (resolved.status === 'not_found') return await defer('ashby_tag_not_found', TAG_CONFIG_FAULT_DEFER_SECONDS);
        if (resolved.status === 'ambiguous') return await defer('ashby_tag_ambiguous', TAG_CONFIG_FAULT_DEFER_SECONDS);
        if (resolved.status === 'truncated') return await defer('ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
        let refused: AshbyError | null = null;
        let after: CandidateChristyTag[];
        let answer: unknown;
        try {
          answer = await ashby.addTag(candidate, resolved.tagId);
        } catch (error) {
          writeFailed(error);
          // Ashby documents nothing about a repeated add, and a recruiter can
          // edit tags between our read and our write: look before deciding.
          if (!refusedWrite(error)) throw error;
          refused = error;
        }
        if (refused) {
          after = await readChristyTags();
        } else {
          // A freshly read id is trusted. A cached one is checked: the admin may
          // have renamed or archived that tag since the catalogue was read.
          if (!resolved.cached) {
            keepId = resolved.tagId;
            break;
          }
          after = christyTagsInWriteAnswer(answer) ?? (await readChristyTags());
        }
        const on = findTarget(after, targetTitle);
        if (on) {
          keepId = on.id;
          tags = after;
          break;
        }
        // Not on. The cached id was stale, or Ashby refused it: drop the cache
        // and try once more with an id from a fresh catalogue read.
        adapter.resolver.invalidate?.();
        if (retried) return await fail(writeRejectedCode(refused), false);
        retried = true;
        tags = after;
        resolved = await ashby.resolve(targetTitle, true);
      }
    }

    // (f) Take every other Christy tag off. With no target this removes them all:
    // the newest result has no verdict, so an old verdict must not stay on show.
    for (const tag of tags) {
      if (tag.id === keepId) continue;
      try {
        await ashby.removeTag(candidate, tag.id);
      } catch (error) {
        writeFailed(error);
        if (!refusedWrite(error)) throw error;
        // A remove refused because the tag is already gone is a remove done.
        const after = await readChristyTags();
        if (after.some((t) => t.id === tag.id)) return await fail(writeRejectedCode(error), false);
      }
    }

    // (g) Look once more: another worker or a recruiter may have changed the
    // tags since our read. Complete only when the desired state holds.
    const settled = await readChristyTags();
    if (desiredStateHolds(settled, targetTitle)) return await complete(anchor);
    const kept = findTarget(settled, targetTitle);
    if (targetTitle === null || kept) {
      // One pass over the leftovers. The next run confirms, so a refusal here
      // only waits.
      for (const tag of settled) {
        if (tag.id === kept?.id) continue;
        try {
          await ashby.removeTag(candidate, tag.id);
        } catch (error) {
          writeFailed(error);
          if (!refusedWrite(error)) throw error;
        }
      }
    }
    // Our target is gone, or leftovers were just removed: the next run reads the
    // newest verdict again and decides from what is really there.
    return await defer(TAG_CONTENDED, TAG_TRANSIENT_DEFER_SECONDS);
  } catch (error) {
    try {
      return await settleFault(error);
    } catch {
      // The store is down too. The lease expires and the row is visible.
      return outcome(false, false, 'operation_error');
    }
  }
}
