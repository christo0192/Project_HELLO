import { describe, it, expect } from 'vitest';
import { chunkIds, mapChunks, readAllPages, ID_BATCH_SIZE, POSTGREST_MAX_ROWS } from '../lib/id-batches.js';

describe('chunkIds', () => {
  it('splits into chunks of at most the batch size, keeping order', () => {
    const ids = Array.from({ length: 529 }, (_, i) => `id-${i}`);
    const chunks = chunkIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 100, 100, 100, 29]);
    expect(chunks.flat()).toEqual(ids);
    expect(ID_BATCH_SIZE).toBe(100);
  });

  it('returns no chunks for no ids', () => {
    expect(chunkIds([])).toEqual([]);
  });

  it('refuses a size that would loop forever', () => {
    expect(() => chunkIds(['a'], 0)).toThrow(RangeError);
    expect(() => chunkIds(['a'], 1.5)).toThrow(RangeError);
  });
});

describe('mapChunks', () => {
  it('returns results in chunk order however the reads finish', async () => {
    const chunks = [[1], [2], [3], [4], [5]];
    const out = await mapChunks(chunks, async (c) => {
      await new Promise((r) => setTimeout(r, (6 - c[0]) * 3));
      return c[0] * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('never runs more reads at once than the concurrency limit', async () => {
    let running = 0;
    let peak = 0;
    await mapChunks(Array.from({ length: 12 }, (_, i) => [i]), async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running -= 1;
    }, { concurrency: 3 });
    expect(peak).toBe(3);
  });

  it('falls back to the default concurrency (4) for a value that is not a positive integer', async () => {
    for (const bad of [Number.NaN, 0, -2, 1.5, Infinity]) {
      let running = 0;
      let top = 0;
      const out = await mapChunks(Array.from({ length: 9 }, (_, i) => [i]), async (c) => {
        running += 1;
        top = Math.max(top, running);
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
        return c[0];
      }, { concurrency: bad });
      expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      expect(top).toBe(4);
    }
  });

  it('handles an empty list', async () => {
    expect(await mapChunks([], async () => 1)).toEqual([]);
  });

  it('starts no new chunk once stopWhen matches; unstarted slots stay undefined', async () => {
    const started: number[] = [];
    const out = await mapChunks(Array.from({ length: 10 }, (_, i) => [i]), async (c) => {
      started.push(c[0]);
      return c[0] === 0 ? 'failed' : 'ok';
    }, { concurrency: 1, stopWhen: (r) => r === 'failed' });
    expect(started).toEqual([0]);
    expect(out).toEqual(['failed', ...Array.from({ length: 9 }, () => undefined)]);
  });

  it('propagates a rejection and, with other workers still running, starts no new chunk after it', async () => {
    const started: number[] = [];
    await expect(mapChunks(Array.from({ length: 8 }, (_, i) => [i]), async (c) => {
      started.push(c[0]);
      // Chunk 0 throws at once while chunk 1 is still in flight on the second worker.
      if (c[0] === 0) throw new Error('read threw');
      await new Promise((r) => setTimeout(r, 5));
      return c[0];
    }, { concurrency: 2 })).rejects.toThrow('read threw');
    // Let the surviving worker finish its in-flight chunk.
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual([0, 1]);
  });
});

describe('readAllPages', () => {
  const table = (n: number) => Array.from({ length: n }, (_, i) => ({ i }));

  it('reads past the row cap until a short page', async () => {
    const rows = table(2345);
    const ranges: Array<[number, number]> = [];
    const out = await readAllPages<{ i: number }>(async (from, to) => {
      ranges.push([from, to]);
      return { data: rows.slice(from, to + 1).slice(0, POSTGREST_MAX_ROWS), error: null };
    }, 50);
    expect(out.ok).toBe(true);
    expect(out.ok && out.rows).toHaveLength(2345);
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('asks for one more page when the last page is exactly full', async () => {
    const rows = table(1000);
    let calls = 0;
    const out = await readAllPages<{ i: number }>(async (from, to) => {
      calls += 1;
      return { data: rows.slice(from, to + 1), error: null };
    }, 50);
    expect(out.ok && out.rows).toHaveLength(1000);
    expect(calls).toBe(2);
  });

  it('returns the first error and no rows', async () => {
    const err = { message: 'boom' };
    const out = await readAllPages(async (from) => (from === 0 ? { data: table(1000), error: null } : { data: null, error: err }), 50);
    expect(out).toEqual({ ok: false, error: err });
  });

  it('turns a page that throws into an error result instead of rejecting (Express 4 would hang)', async () => {
    const boom = new Error('client fault');
    const out = await readAllPages(() => { throw boom; }, 5);
    expect(out).toEqual({ ok: false, error: boom });
    const rejected = await readAllPages(() => Promise.reject(boom), 5);
    expect(rejected).toEqual({ ok: false, error: boom });
  });

  it('treats an absent list as an empty page, not a failure', async () => {
    const out = await readAllPages(async () => ({ data: null, error: null }), 5);
    expect(out).toEqual({ ok: true, rows: [] });
  });

  it('reports an error rather than a truncated list past the page bound', async () => {
    const out = await readAllPages(async () => ({ data: table(1000), error: null }), 3);
    expect(out.ok).toBe(false);
    expect(!out.ok && String(out.error)).toContain('page_bound_exceeded');
  });
});
