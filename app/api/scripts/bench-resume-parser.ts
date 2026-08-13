#!/usr/bin/env tsx
/**
 * bench-resume-parser.ts — run the synthetic resume-parser soak/throughput
 * benchmark and print bounded aggregate metrics as JSON.
 *
 * Usage:
 *   npm run bench:parser -- --count 500 --concurrency 4
 *
 * SYNTHETIC fixtures only; generates nothing on disk and commits no artifacts.
 * Local synthetic evidence only — NOT a production throughput claim.
 */

import { runResumeParserBenchmark } from '../src/lib/resume-parser-benchmark.js';

function arg(name: string, fallback: number): number {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) {
    const n = Number(process.argv[idx + 1]);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

async function main(): Promise<void> {
  const count = arg('count', 500);
  const maxConcurrency = arg('concurrency', 4);
  const maxQueueDepth = arg('queue', 2000);
  const timeoutMs = arg('timeout', 15_000);

  const startedAt = Date.now();
  process.stderr.write(`[bench] running ${count} synthetic items @ concurrency ${maxConcurrency}...\n`);
  const metrics = await runResumeParserBenchmark({
    count,
    maxConcurrency,
    maxQueueDepth,
    timeoutMs,
    onProgress: (done, total) => {
      if (done % 50 === 0 || done === total) {
        process.stderr.write(`[bench] ${done}/${total} (${Math.round((Date.now() - startedAt) / 1000)}s)\n`);
      }
    },
  });

  const mb = (b: number): number => Number((b / (1024 * 1024)).toFixed(1));
  const summary = {
    ...metrics,
    rssStartMB: mb(metrics.rssStartBytes),
    rssPeakMB: mb(metrics.rssPeakBytes),
    rssEndMB: mb(metrics.rssEndBytes),
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');

  if (metrics.failed > 0 && metrics.byFormat.adversarial.failed !== metrics.failed) {
    // Adversarial fixtures are allowed to fail gracefully; any OTHER failures
    // are unexpected in a healthy run.
    process.stderr.write('[bench] WARNING: non-adversarial failures observed\n');
  }
}

main().catch((err) => {
  process.stderr.write(`[bench] fatal: ${err instanceof Error ? err.name : 'error'}\n`);
  process.exit(1);
});
