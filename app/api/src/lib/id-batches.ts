/**
 * id-batches.ts — reads over a whole list of ids that stay inside the limits
 * of the HTTP stack and of PostgREST.
 *
 * WHY THE BATCH SIZE (M026, 2026-11-04)
 * A `.in(column, ids)` read sends every id in the GET URL, at 39 characters a
 * UUID once the comma is encoded. The response echoes that URL back in a
 * header, and Node's fetch (undici) rejects a response whose headers pass
 * 16 KiB: `TypeError: fetch failed ... HeadersOverflowError
 * (UND_ERR_HEADERS_OVERFLOW)`. Reproduced inside the production API machine:
 * 353 ids passed, 400 failed, and so did one read over the workspace's 529
 * candidates, while the same reads in batches of 100 passed in about 120 ms.
 * postgrest-js retries a failed GET three times (1 s, 2 s, 4 s), so each
 * oversized read also cost about 8 s before it failed. 100 ids is a URL of
 * about 4 KB, far inside both that limit and the gateway's own (a 27 KB URL is
 * refused with 400).
 *
 * WHY THE PAGE SIZE
 * PostgREST answers at most `max_rows` rows (app/supabase/config.toml) and
 * truncates anything longer WITHOUT an error, so a read that can return more
 * must page with `.range()` until a short page.
 */

/** At most this many ids in one `in (...)` read. */
export const ID_BATCH_SIZE = 100;

/** PostgREST `max_rows`: a longer response is truncated silently. */
export const POSTGREST_MAX_ROWS = 1000;

/** How many batches one route reads at the same time. */
export const ID_BATCH_CONCURRENCY = 4;

/** Split into chunks of at most `size` (the last may be shorter). */
export function chunkIds<T>(ids: readonly T[], size: number = ID_BATCH_SIZE): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunk size must be a positive integer');
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

export interface MapChunksOptions<R> {
  /** At most this many `fn` calls in flight (default ID_BATCH_CONCURRENCY). */
  concurrency?: number;
  /**
   * When it returns true for a result, no further chunk is STARTED (chunks
   * already in flight finish). Unstarted slots stay `undefined`. Lets a
   * fail-closed caller answer at once instead of waiting for every remaining
   * batch to fail through postgrest-js's retries (~8 s each).
   */
  stopWhen?: (result: R) => boolean;
}

/**
 * Run `fn` over every chunk, at most `concurrency` at a time. Results come
 * back in chunk order whatever order the reads finish in. A rejection
 * propagates (and stops new chunks from starting), so callers that must never
 * reject wrap the call.
 */
export async function mapChunks<T, R>(
  chunks: readonly T[][],
  fn: (chunk: T[], index: number) => Promise<R>,
  options: MapChunksOptions<R> = {},
): Promise<Array<R | undefined>> {
  const requested = options.concurrency ?? ID_BATCH_CONCURRENCY;
  const concurrency = Number.isInteger(requested) && requested >= 1 ? requested : ID_BATCH_CONCURRENCY;
  const results = new Array<R | undefined>(chunks.length).fill(undefined);
  let next = 0;
  let stopped = false;
  const worker = async (): Promise<void> => {
    while (!stopped && next < chunks.length) {
      const index = next;
      next += 1;
      try {
        const result = await fn(chunks[index], index);
        results[index] = result;
        if (options.stopWhen?.(result)) stopped = true;
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(chunks.length, 1)) }, worker));
  return results;
}

/** One page of a paged read: PostgREST's `{ data, error }` shape. */
export type PageResult = PromiseLike<{ data: unknown; error: unknown }>;

/**
 * Read every row of a query past PostgREST's row cap. `page(from, to)` must
 * build a FRESH query each call (a builder runs once) with a deterministic
 * order, ending in `.range(from, to)`. Stops at the first short page.
 *
 * Returns the rows, or the first error. More than `maxPages` full pages is
 * reported as an error rather than returned truncated.
 *
 * Never rejects. A page that throws is returned as `{ ok: false }`, because
 * Express 4 does not catch a rejection from an async route handler: the
 * request would hang until the client gave up.
 *
 * PostgREST answers `data: null` only together with an error, so the error is
 * the one failure signal and an absent list is an empty page (the R1 lookup in
 * routes/candidates.ts reads it the same way).
 */
export async function readAllPages<T>(
  page: (from: number, to: number) => PageResult,
  maxPages: number,
): Promise<{ ok: true; rows: T[] } | { ok: false; error: unknown }> {
  try {
    const rows: T[] = [];
    for (let p = 0; p < maxPages; p += 1) {
      const from = p * POSTGREST_MAX_ROWS;
      const { data, error } = await page(from, from + POSTGREST_MAX_ROWS - 1);
      if (error) return { ok: false, error };
      const got = (Array.isArray(data) ? data : []) as T[];
      rows.push(...got);
      if (got.length < POSTGREST_MAX_ROWS) return { ok: true, rows };
    }
    return { ok: false, error: new Error('page_bound_exceeded') };
  } catch (error) {
    return { ok: false, error };
  }
}
