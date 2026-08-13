/**
 * resume-parser-benchmark.ts — synthetic soak/throughput harness for the
 * bounded resume parser pool.
 *
 * Generates SYNTHETIC fixtures only (no real candidate data, no committed bulk
 * artifacts) and drives them through {@link createResumeParserPool}, producing
 * bounded aggregate metrics: item count, completed/failed, wall time,
 * throughput, latency percentiles, observed peak concurrency, and RSS
 * (start/peak/end). It supports a 500-item run.
 *
 * This measures LOCAL synthetic behavior only. It must NOT be read as a claim
 * of production throughput. Formats that the local environment cannot generate
 * (e.g. true scanned-image PDFs) are reported as skipped, never fabricated.
 */

import { createResumeParserPool, type ParseFn } from './resume-parser-pool.js';
import { parseResume } from './resume-parser.js';

export type BenchFormat = 'txt' | 'adversarial' | 'empty';

export interface BenchOptions {
  /** Number of synthetic documents to run (clamped to [1, 2000]). */
  count?: number;
  maxConcurrency?: number;
  maxQueueDepth?: number;
  timeoutMs?: number;
  /** Node binary for the child (default process.execPath). */
  nodeBin?: string;
  /** Injectable parser (defaults to the real child parser). */
  parse?: ParseFn;
  /** Deterministic PRNG seed for reproducible fixture sizes. */
  seed?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface BenchFormatStat {
  count: number;
  completed: number;
  failed: number;
}

export interface BenchMetrics {
  count: number;
  completed: number;
  failed: number;
  wallMs: number;
  throughputPerSec: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  latencyMaxMs: number;
  peakConcurrency: number;
  peakQueueDepth: number;
  rssStartBytes: number;
  rssPeakBytes: number;
  rssEndBytes: number;
  byFormat: Record<BenchFormat, BenchFormatStat>;
}

/** Small deterministic PRNG (mulberry32) so fixture sizes are reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RESUME_WORDS = [
  'experience', 'engineer', 'python', 'typescript', 'sales', 'advisor', 'led',
  'built', 'managed', 'team', 'project', 'results', 'growth', 'customer',
  'communication', 'analytics', 'react', 'node', 'postgres', 'docker',
];

function synthText(rng: () => number, targetBytes: number): string {
  const parts: string[] = ['SYNTHETIC RESUME (benchmark fixture — not real data)'];
  let bytes = 0;
  while (bytes < targetBytes) {
    const w = RESUME_WORDS[Math.floor(rng() * RESUME_WORDS.length)];
    parts.push(w);
    bytes += w.length + 1;
    if (parts.length % 12 === 0) parts.push('\n');
  }
  return parts.join(' ');
}

interface BenchItem { format: BenchFormat; mime: string; buf: Buffer; }

function buildItems(count: number, rng: () => number): BenchItem[] {
  const items: BenchItem[] = [];
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.08) {
      // Adversarial: random bounded bytes fed as text/plain — must not crash.
      const len = 512 + Math.floor(rng() * 2048);
      const buf = Buffer.allocUnsafe(len);
      for (let j = 0; j < len; j++) buf[j] = Math.floor(rng() * 256);
      items.push({ format: 'adversarial', mime: 'text/plain', buf });
    } else if (roll < 0.12) {
      items.push({ format: 'empty', mime: 'text/plain', buf: Buffer.from('   ') });
    } else {
      const target = 500 + Math.floor(rng() * 20_000);
      items.push({ format: 'txt', mime: 'text/plain', buf: Buffer.from(synthText(rng, target), 'utf-8') });
    }
  }
  return items;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function runResumeParserBenchmark(options: BenchOptions = {}): Promise<BenchMetrics> {
  const count = Math.max(1, Math.min(2000, Math.floor(options.count ?? 50)));
  const rng = mulberry32(options.seed ?? 0x9e3779b9);
  const items = buildItems(count, rng);
  const parse = options.parse ?? parseResume;

  const byFormat: Record<BenchFormat, BenchFormatStat> = {
    txt: { count: 0, completed: 0, failed: 0 },
    adversarial: { count: 0, completed: 0, failed: 0 },
    empty: { count: 0, completed: 0, failed: 0 },
  };
  for (const it of items) byFormat[it.format].count += 1;

  const pool = createResumeParserPool({
    maxConcurrency: options.maxConcurrency ?? 4,
    maxQueueDepth: options.maxQueueDepth ?? 2000,
    parse,
  });

  const latencies: number[] = [];
  let completed = 0;
  let failed = 0;
  let done = 0;

  const rssStart = process.memoryUsage().rss;
  let rssPeak = rssStart;
  const rssTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > rssPeak) rssPeak = rss;
  }, 25);
  if (typeof rssTimer.unref === 'function') rssTimer.unref();

  const wallStart = Date.now();
  const runs = items.map((it) => {
    const t0 = Date.now();
    return pool.submit(it.buf, it.mime, { timeoutMs: options.timeoutMs ?? 15_000, nodeBin: options.nodeBin }).then(
      () => { latencies.push(Date.now() - t0); completed += 1; byFormat[it.format].completed += 1; },
      () => { latencies.push(Date.now() - t0); failed += 1; byFormat[it.format].failed += 1; },
    ).finally(() => { done += 1; options.onProgress?.(done, count); });
  });
  await Promise.all(runs);
  await pool.drain();
  const wallMs = Date.now() - wallStart;
  clearInterval(rssTimer);

  latencies.sort((a, b) => a - b);
  const stats = pool.stats();
  const rssEnd = process.memoryUsage().rss;

  return {
    count,
    completed,
    failed,
    wallMs,
    throughputPerSec: wallMs > 0 ? Number((count / (wallMs / 1000)).toFixed(2)) : 0,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    latencyMaxMs: latencies.length ? latencies[latencies.length - 1] : 0,
    peakConcurrency: stats.peakConcurrency,
    peakQueueDepth: stats.peakQueueDepth,
    rssStartBytes: rssStart,
    rssPeakBytes: rssPeak,
    rssEndBytes: rssEnd,
    byFormat,
  };
}
