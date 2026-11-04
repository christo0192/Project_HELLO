/**
 * ashby/recommendation-tags.ts — the Christy verdict tag on the Ashby candidate.
 *
 * Owner decisions, binding (M027):
 *   - advance -> `Christy: Select`, hold -> `Christy: Borderline`, reject ->
 *     `Christy: Reject`. A provisional verdict (scoring_status
 *     `incomplete_evidence` with a non-null recommendation) IS tagged, Reject
 *     included.
 *   - No verdict (NULL, which is how `human_review` is stored) or
 *     `evidence_grade = 'insufficient'` gets NO tag.
 *   - The newest verdict wins, and a candidate carries at most one Christy tag.
 *     Tags are candidate-wide, not per application.
 *   - The lane touches those three titles and no other tag, and never creates a
 *     tag: the admin created them in Ashby.
 *
 * WHY ITS OWN OPERATION. A tag failure can never resend or disturb a scorecard,
 * which cannot be retracted, and a tag has no dependency on a scorecard (see
 * migration 0134).
 *
 * THE RUN. Read the verdict at run time, read the candidate's tags, write the
 * difference: add first, then remove, so a candidate is never without a tag it
 * should have. A repeat makes no writes, which is what makes `{ idempotent: true }`
 * on the client's tag writes safe.
 *
 * THE ERRORS ARE CLASSIFIED HERE, not in the worker's catch, which copies
 * `error.retriable` and so makes a timeout or `retry_exhausted` terminal.
 *
 * LOGS AND EVENTS ARE METADATA ONLY: no tag id, candidate id or name, and no
 * title beyond the fixed constants below.
 */

import { isAshbyError, type AshbyError } from './errors.js';
import { extractApplicationInfo } from './extractors.js';
import type { OperationClaimRow, RuntimeWorkflowStores } from './orchestration.js';
import type { OperationRunOutcome } from './operation-worker.js';
import type { AshbyResult, CandidateTagListParams } from './types.js';

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

/** Kill switch. Exactly `'true'` is on. */
export function recommendationTagsEnabled(): boolean {
  return process.env.ASHBY_RECOMMENDATION_TAGS_ENABLED === 'true';
}

/**
 * Pure verdict-to-tag map. `recommendation` MUST be the raw
 * `assessments.recommendation` column, never `ScorecardSource.recommendation` or
 * `NormalizedScorecard.recommendation`: those coerce a missing verdict to `hold`,
 * which would tag it Borderline.
 */
export function christyTagForVerdict(input: {
  recommendation: unknown;
  evidenceGrade?: string | null;
}): ChristyVerdictTag | null {
  if (input.evidenceGrade === 'insufficient') return null;
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
  | { status: 'found'; tagId: string }
  | { status: 'not_found' }
  | { status: 'ambiguous' }
  /** The catalogue could not be read to its end, so "not found" cannot be said. */
  | { status: 'truncated' };

export interface ChristyTagResolver {
  resolve(title: ChristyTagTitle, options?: { fresh?: boolean }): Promise<ChristyTagResolution>;
}

type TagCatalogue = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Walk every page and keep the active ids of the three titles. Returns null when
 * the walk did not reach the end: a truthy `moreDataAvailable` with no usable
 * cursor, a repeated cursor, the page cap, or a result that is not a list.
 * An Ashby page may be empty while more data follows, so an empty page continues.
 * A provider error propagates to the lane's own classification.
 */
async function readTagCatalogue(reader: TagCatalogueReader): Promise<TagCatalogue | null> {
  const catalogue = new Map<string, Set<string>>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TAG_LIST_PAGES; page++) {
    const res = await reader.candidateTagList({
      ...(cursor !== undefined ? { cursor } : {}),
      limit: TAG_LIST_PAGE_SIZE,
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
 * bypasses the cache and refreshes it. More than one active match fails closed.
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
      if (!catalogue) {
        catalogue = await readTagCatalogue(reader);
        if (!catalogue) return { status: 'truncated' };
        cached = { at: nowMs(), catalogue };
      }
      const ids = catalogue.get(title);
      if (!ids || ids.size === 0) return { status: 'not_found' };
      if (ids.size > 1) return { status: 'ambiguous' };
      return { status: 'found', tagId: [...ids][0] };
    },
  };
}

// ── Lane executor ───────────────────────────────────────────────────────────

/** The client surface the lane uses. `AshbyClient` satisfies it. */
export interface RecommendationTagClient {
  applicationInfo(applicationId: string): Promise<AshbyResult<unknown>>;
  candidateInfo(candidateId: string): Promise<AshbyResult<unknown>>;
  candidateAddTag(candidateId: string, tagId: string): Promise<unknown>;
  candidateRemoveTag(candidateId: string, tagId: string): Promise<unknown>;
}

export interface RecommendationTagAdapter {
  client: RecommendationTagClient;
  resolver: ChristyTagResolver;
}

export interface RecommendationTagDeps {
  stores: Pick<
    RuntimeWorkflowStores,
    | 'completeOperation'
    | 'failOperation'
    | 'deferOperation'
    | 'readRecommendationTagSource'
    | 'bindLinkExternalCandidateId'
  >;
  adapter: RecommendationTagAdapter;
  nowMs?: () => number;
  onEvent?: (event: { kind: string; operationType: string; code?: string }) => void;
}

interface CandidateChristyTag {
  id: string;
  title: string;
  isArchived: boolean;
}

/**
 * The Christy tags on a candidate. Everything else in `tags` is dropped here, so
 * no later step can touch another tag. A result with no `tags` list throws: the
 * lane must not read that as "no tags" and write from it.
 */
function christyTagsOf(results: unknown): CandidateChristyTag[] {
  const tags = results !== null && typeof results === 'object'
    ? (results as { tags?: unknown }).tags
    : undefined;
  if (!Array.isArray(tags)) throw new Error('candidate_tags_unreadable');
  const out: CandidateChristyTag[] = [];
  for (const item of tags as unknown[]) {
    if (item === null || typeof item !== 'object') continue;
    const { id, title, isArchived } = item as Record<string, unknown>;
    if (typeof id !== 'string' || id.length === 0 || typeof title !== 'string') continue;
    const trimmed = title.trim();
    if (CHRISTY_TITLES.has(trimmed)) out.push({ id, title: trimmed, isArchived: isArchived === true });
  }
  return out;
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

/** `ashby_tag_write_rejected`, plus the endpoint's code when it fits the column. */
function writeRejectedCode(error: AshbyError): string {
  const base = 'ashby_tag_write_rejected';
  for (const raw of error.endpointCodes) {
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
   * never ends by itself, so an operation older than the limit fails with the
   * code it was waiting on. An unknown age keeps waiting.
   */
  const defer = async (code: string, seconds: number): Promise<OperationRunOutcome> => {
    const createdMs = claim.createdAt ? Date.parse(claim.createdAt) : Number.NaN;
    if (Number.isFinite(createdMs) && nowMs() - createdMs > TAG_DEFER_AGE_LIMIT_MS) {
      return fail(code, false);
    }
    const r = await stores.deferOperation(claim.id, claim.leaseToken, code, seconds);
    emit('deferred', code);
    return outcome(false, r === 'not_owned', code);
  };
  const settleFault = async (error: unknown): Promise<OperationRunOutcome> => {
    const fault = classifyTagError(error);
    if (fault === 'permission') return defer('ashby_tag_permission_denied', TAG_CONFIG_FAULT_DEFER_SECONDS);
    if (fault === 'transient') return defer('ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
    return fail('operation_error', true);
  };

  try {
    // (a) Read the verdict at run time, so a rescore after enqueue is honoured.
    let source: Awaited<ReturnType<NonNullable<RecommendationTagDeps['stores']['readRecommendationTagSource']>>> = null;
    try {
      source = (await stores.readRecommendationTagSource?.(claim.applicationLinkId, claim.sourceSessionId ?? null)) ?? null;
    } catch {
      source = null;
    }
    if (!source) return await fail('assessment_missing', true);

    // (b) A newer result has its own operation, which decides the tag.
    if (!source.isNewestTagOperation(claim.id)) return await complete('christy_tag_superseded');

    // (c) The candidate. Older links have no stored id; application.info has it.
    let candidateId = source.externalCandidateId;
    if (!candidateId && source.externalApplicationId) {
      const info = await adapter.client.applicationInfo(source.externalApplicationId);
      candidateId = extractApplicationInfo(info.results).candidateId ?? null;
      if (candidateId) {
        // Compare-and-set, best effort: the tag does not depend on the backfill.
        try {
          await stores.bindLinkExternalCandidateId?.(claim.applicationLinkId, candidateId);
        } catch { /* the next run reads application.info again */ }
      }
    }
    if (!candidateId) return await fail('candidate_id_missing', false);
    const candidate = candidateId;

    // (d) What the candidate carries now.
    const readChristyTags = async (): Promise<CandidateChristyTag[]> =>
      christyTagsOf((await adapter.client.candidateInfo(candidate)).results);
    const present = await readChristyTags();

    // (e) What it should carry. A missing or ambiguous tag writes NOTHING: the
    // old tag stays until the new one can go on.
    const target = christyTagForVerdict({
      recommendation: source.recommendation,
      evidenceGrade: source.evidenceGrade,
    });
    const targetTitle = target ? CHRISTY_VERDICT_TAG_TITLES[target] : null;
    const alreadyThere = findTarget(present, targetTitle);
    let keepId = alreadyThere?.id ?? null;
    if (targetTitle && !keepId) {
      let resolved = await adapter.resolver.resolve(targetTitle);
      if (resolved.status === 'not_found') {
        resolved = await adapter.resolver.resolve(targetTitle, { fresh: true });
      }
      if (resolved.status === 'not_found') return await defer('ashby_tag_not_found', TAG_CONFIG_FAULT_DEFER_SECONDS);
      if (resolved.status === 'ambiguous') return await defer('ashby_tag_ambiguous', TAG_CONFIG_FAULT_DEFER_SECONDS);
      if (resolved.status === 'truncated') return await defer('ashby_tag_transient', TAG_TRANSIENT_DEFER_SECONDS);
      keepId = resolved.tagId;
    }

    // (f) Add before remove. With no target this removes every Christy tag: a
    // newer result has no verdict, so an old verdict must not stay on show.
    const anchor = `christy_tag_${target ?? 'none'}`;
    try {
      if (keepId && !alreadyThere) await adapter.client.candidateAddTag(candidate, keepId);
      for (const tag of present) {
        if (tag.id !== keepId) await adapter.client.candidateRemoveTag(candidate, tag.id);
      }
    } catch (error) {
      if (!isAshbyError(error) || classifyTagError(error) !== 'logical') throw error;
      // Ashby documents nothing about a repeated add or remove, and a recruiter
      // can edit tags between our read and our write. So look before calling it
      // a failure. Any error from this read is classified below as usual.
      const after = await readChristyTags();
      if (desiredStateHolds(after, targetTitle)) return await complete(anchor);
      return await fail(writeRejectedCode(error), false);
    }

    // (g) Done. A repeat of this operation finds nothing to write.
    return await complete(anchor);
  } catch (error) {
    try {
      return await settleFault(error);
    } catch {
      // The store is down too. The lease expires and the row is visible.
      return outcome(false, false, 'operation_error');
    }
  }
}
