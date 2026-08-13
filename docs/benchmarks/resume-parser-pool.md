# Benchmark methodology — bounded resume parser pool

Scope: the bounded resume parser pool (`app/api/src/lib/resume-parser-pool.ts`)
and the hardened single-document child parser
(`app/api/src/lib/resume-parser.ts` + `resume-parser-child.mjs`). This is the
**parser execution foundation** for later bulk/async ingestion — it is not the
async ingestion state machine, and it does not change the existing synchronous
resume route.

## What the pool provides

- **Bounded concurrency**: at most `maxConcurrency` isolated child parsers run
  at once (default 2, clamped to `[1, 8]`).
- **Bounded queue**: waiters beyond the running set are capped at
  `maxQueueDepth` (default 50, clamped to `[0, 500]`). Over-capacity submissions
  fail fast with a stable `ParserOverloadError`; there is no unbounded memory
  growth.
- **Release exactly once**: every submission's capacity permit is released
  exactly once across success, failure, synchronous throw, timeout, crash,
  spawn error, oversized output, and abort. A hung/crashed child cannot block
  later work.
- **Metadata-only instrumentation**: `stats()` and the optional `onEvent` hook
  expose counts, depths, queue-wait/exec durations, and peak concurrency — never
  resume text, contact fields, file bytes, or child output.

## Hardened child protocol

- **Binary stdin** — raw file bytes are streamed to the child (no base64
  expansion). The validated MIME (fixed enum) is `argv[2]`; the input-byte cap is
  `argv[3]`; the output-char cap is `argv[4]`. Bytes/text never appear in
  argv/logs/errors.
- **Byte-accurate bounds** — the parent caps stdout by Buffer **byte** length;
  the child caps input by Buffer byte length and truncates output text while
  still reporting the pre-truncation length.
- **Fail closed** — if the compiled `resume-parser-child.mjs` asset is absent,
  the parent throws `ParserAssetMissingError` **before** spawning or sending any
  bytes and never invokes `tsx`. A `.ts`/tsx fallback requires an explicit
  `allowTsxFallback: true` (development/test only).
- **Sanitized errors** — `ParserError` / `ParserTimeoutError` /
  `ParserOutputExceededError` / `ParserAssetMissingError` / `ParserOverloadError`
  carry stable codes only. Child stderr is drained and discarded, never stored
  or surfaced.

## Benchmark harness

`app/api/src/lib/resume-parser-benchmark.ts` generates **synthetic** fixtures
in-memory (no committed bulk artifacts) and drives them through the pool:

- **txt** — synthetic resume-like text of varied bounded sizes (the dominant
  format; it fully exercises spawn → binary stdin → extract → bounded stdout →
  JSON, which is what the scheduler/pool behavior depends on).
- **adversarial** — random bounded bytes fed as `text/plain`; these must fail
  gracefully (or decode lossily) without crashing the scheduler.
- **empty** — whitespace-only input.

It reports bounded aggregate metrics only: count, completed/failed, wall time,
throughput, latency p50/p95/max, peak concurrency, peak queue depth, and RSS
(start/peak/end).

### Formats not generated locally

True **scanned-image PDFs** (no text layer) and richly-structured **DOCX/PDF**
corpora are not synthesized by this harness — generating a faithful scanned PDF
or a large DOCX corpus without adding dependencies is out of scope here. The
committed `__tests__/fixtures/valid-resume.{pdf,docx}` provide real small
PDF/DOCX coverage in the unit tests. Per the acceptance contract, missing
formats are **reported here rather than fabricated**. Format handling for
PDF/DOCX is covered by the existing `resume-ingestion` tests; the pool/child
lifecycle (the thing this PR measures) is format-independent.

## Running

```
npm --prefix app/api run bench:parser -- --count 500 --concurrency 4
```

Flags: `--count`, `--concurrency`, `--queue`, `--timeout`. Output is a JSON
metrics object on stdout; progress is on stderr. Nothing is written to disk.

## Interpreting results

- `peakConcurrency` must be `<= maxConcurrency` (the scheduler bound holds).
- Non-adversarial failures should be zero; adversarial items may fail gracefully.
- RSS should stay bounded across the run (no monotonic growth to exhaustion).

**These are LOCAL synthetic measurements on developer hardware. They are NOT a
production throughput SLO.** Production capacity requires a separate, measured
capacity test on target infrastructure with representative documents.
