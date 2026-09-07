/**
 * resume-model-degradation.test.ts — what happens when the MODEL tier fails,
 * and whether anyone can tell.
 *
 * RCA 2026-09-07: three IDENTICAL résumés were ingested and one silently fell
 * back to the deterministic regex extractor — the DeepSeek call failed
 * mid-batch, the row landed `ready` with the non-dialable
 * `deterministic-fallback-1` tag, and NOTHING recorded why. Three properties
 * repair that, and each is pinned here:
 *
 *   1. OBSERVABILITY. `structureResumeWithModelDetailed` reports a sanitized
 *      failure CATEGORY (timeout / protocol:<status> / parse_error /
 *      shape_rejected / circuit_open / slot_timeout), and the Ashby parse
 *      port emits ONE structured log line carrying it — category only, never
 *      résumé content.
 *
 *   2. BOUNDED IN-TIER RETRY. A TRANSIENT provider failure (timeout / 429 /
 *      5xx) is retried exactly ONCE before surrendering to the fallback. A
 *      non-transient failure is not retried at all, and a JSON-parse failure
 *      is not retried HERE because the shared runner already re-asks once —
 *      retrying it again would quietly square the provider load.
 *
 *   3. CONTRACT PRESERVED. The classic `structureResumeWithModel` still
 *      returns `null` on surrender and never throws, so no existing caller
 *      changes behaviour.
 *
 * No provider is ever contacted: every test injects its own runner. Every
 * phone value is synthetic.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  structureResumeWithModel,
  structureResumeWithModelDetailed,
  __setModelRetryBackoffForTest,
  __setModelConcurrencyForTest,
  type ResumeModelRunner,
} from '../lib/resume-structurer.js';
import { DeepseekError } from '../lib/deepseek.js';
import { BusinessError, ProviderError } from '../lib/provider-resilience.js';
import {
  createAshbyRuntime,
  emitResumeModelFallback,
  ASHBY_STRUCTURER_VERSION,
} from '../integrations/ashby/runtime.js';
import { loadAshbyConfig, loadAshbyRuntimeConfig } from '../integrations/ashby/config.js';

const GOOD_SHAPE = {
  name: 'Rohan Mehta',
  email: 'rohan@example.invalid',
  phone: '98765 43210',
  skills: ['TypeScript'],
};

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length > 0) restores.pop()!();
});

/** Zero the retry backoff so no test waits a real 2 seconds. */
function fastRetry(): void {
  restores.push(__setModelRetryBackoffForTest(0));
}

describe('structureResumeWithModelDetailed — bounded transient retry', () => {
  it('retries ONCE on a timeout and succeeds on the second attempt', async () => {
    fastRetry();
    const runner = vi.fn<ResumeModelRunner>()
      .mockRejectedValueOnce(new DeepseekError('timeout'))
      .mockResolvedValueOnce(GOOD_SHAPE);
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(out.failure).toBeNull();
    expect(out.structured?.phone).toBe('98765 43210');
  });

  it.each([[429], [500], [503]])('retries ONCE on protocol %i and succeeds', async (status) => {
    fastRetry();
    const runner = vi.fn<ResumeModelRunner>()
      .mockRejectedValueOnce(new DeepseekError('protocol', status))
      .mockResolvedValueOnce(GOOD_SHAPE);
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(out.structured).not.toBeNull();
  });

  it('retries at most once: a second transient failure surrenders with ITS category', async () => {
    fastRetry();
    const runner = vi.fn<ResumeModelRunner>()
      .mockRejectedValueOnce(new DeepseekError('timeout'))
      .mockRejectedValueOnce(new DeepseekError('protocol', 502));
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ structured: null, failure: 'protocol:502' });
  });

  it('does NOT retry a non-transient protocol failure (4xx that is not 429)', async () => {
    fastRetry();
    const runner = vi.fn<ResumeModelRunner>()
      .mockRejectedValue(new DeepseekError('protocol', 400));
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ structured: null, failure: 'protocol:400' });
  });

  it('does NOT re-retry a JSON-parse failure — the shared runner already re-asked once', async () => {
    fastRetry();
    // `runDeepseekJSON` performs its own bounded second ask and then throws
    // BusinessError. Seeing BusinessError HERE means two provider calls were
    // already spent; a third would be a hidden retry-of-a-retry.
    const runner = vi.fn<ResumeModelRunner>().mockRejectedValue(new BusinessError());
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ structured: null, failure: 'parse_error' });
  });

  it.each([
    ['circuit_open', new ProviderError('circuit_open'), 'circuit_open'],
    ['missing_api_key', new DeepseekError('missing_api_key'), 'missing_api_key'],
    ['connection', new DeepseekError('connection'), 'connection'],
    ['output_limit', new DeepseekError('output_limit'), 'output_limit'],
    ['statusless protocol', new DeepseekError('protocol'), 'protocol'],
    ['unclassifiable error', new Error('SENTINEL: never surfaces'), 'unknown'],
  ])('does NOT retry %s and reports its sanitized category', async (_label, err, category) => {
    fastRetry();
    const runner = vi.fn<ResumeModelRunner>().mockRejectedValue(err);
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ structured: null, failure: category });
  });

  it('a rejected SHAPE is shape_rejected, not a retry', async () => {
    fastRetry();
    const runner = vi.fn<ResumeModelRunner>().mockResolvedValue(42);
    const out = await structureResumeWithModelDetailed('résumé text', runner);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ structured: null, failure: 'shape_rejected' });
  });

  it('a semaphore-slot timeout is slot_timeout and never reaches the runner', async () => {
    // One slot, held by a hanging call; a 5ms acquire budget for the second.
    restores.push(__setModelConcurrencyForTest(1, 5));
    let release!: () => void;
    const hang = new Promise<unknown>((resolve) => { release = () => resolve(GOOD_SHAPE); });
    const holder = structureResumeWithModelDetailed('résumé one', () => hang);
    const runner = vi.fn<ResumeModelRunner>().mockResolvedValue(GOOD_SHAPE);
    const starved = await structureResumeWithModelDetailed('résumé two', runner);
    expect(starved).toEqual({ structured: null, failure: 'slot_timeout' });
    expect(runner).not.toHaveBeenCalled();
    release();
    await holder;
  });

  it('the retry holds the slot: a saturated semaphore still bounds total fan-out', async () => {
    fastRetry();
    restores.push(__setModelConcurrencyForTest(1, 5));
    // The retrying call keeps the ONE slot across its backoff; a concurrent
    // call must starve rather than sneak a second provider call in.
    const retrying = vi.fn<ResumeModelRunner>()
      .mockRejectedValueOnce(new DeepseekError('timeout'))
      .mockImplementationOnce(async () => {
        // While the first call is on its retry, the competitor must be refused.
        const competitor = await structureResumeWithModelDetailed('résumé two', async () => GOOD_SHAPE);
        expect(competitor.failure).toBe('slot_timeout');
        return GOOD_SHAPE;
      });
    const out = await structureResumeWithModelDetailed('résumé one', retrying);
    expect(out.structured).not.toBeNull();
  });

  it('the classic wrapper still answers plain null on surrender and never throws', async () => {
    fastRetry();
    const runner: ResumeModelRunner = async () => { throw new DeepseekError('protocol', 400); };
    await expect(structureResumeWithModel('résumé text', runner)).resolves.toBeNull();
  });
});

// ── The parse port emits the fallback line ──────────────────────────────────

const APIKEY = 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaaaaaa';
const SECRET = 'SENTINEL_SECRET_bbbbbbbbbbbbbbbbbbbb';

const RESUME_TEXT = [
  'Rohan Mehta',
  'rohan@example.invalid',
  'Mobile: 98765 43210',
].join('\n');

function fakeSupabase() {
  const row = { external_resume_file_handle: 'handle_1' };
  return {
    from() {
      const b: Record<string, unknown> = {};
      const chain = () => b;
      for (const m of ['insert', 'update', 'delete', 'select', 'eq', 'is', 'in', 'order', 'limit']) b[m] = chain;
      b.single = async () => ({ data: row, error: null });
      b.maybeSingle = b.single;
      b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: row, error: null }).then(ok);
      return b;
    },
  } as never;
}

const fileInfoTransport = async () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  text: async () => JSON.stringify({
    success: true,
    results: { url: 'https://files.ashby.example/resume.pdf' },
  }),
});

/** The REAL runtime's REAL parse port, with only the pool and runner faked. */
async function realParsePort(modelRunner: ResumeModelRunner) {
  const e = {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: SECRET,
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: APIKEY,
    ASHBY_RESUME_HOSTS: 'files.ashby.example',
  } as NodeJS.ProcessEnv;
  const runtime = createAshbyRuntime({
    supabase: fakeSupabase(),
    config: loadAshbyConfig(e),
    runtimeConfig: loadAshbyRuntimeConfig(e),
    transport: fileInfoTransport,
    parserPool: {
      submit: async () => ({ text: RESUME_TEXT, totalLength: RESUME_TEXT.length, truncated: false }),
      stats: () => ({}) as never,
      drain: async () => {},
    },
    modelRunner,
  })!;
  const built = await runtime.buildIngestionPorts({
    applicationLinkId: 'link_1',
    onState: async () => {},
  });
  if (built.status !== 'ok') throw new Error(`ports not built: ${built.status}`);
  return { ports: built.ports, shutdown: () => runtime.shutdown() };
}

describe('emitResumeModelFallback — the one sanitized line', () => {
  it('emits exactly one warn with the category and nothing content-shaped', () => {
    const warn = vi.fn();
    emitResumeModelFallback('protocol:502', { warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('unknown_event', {
      error_category: 'resume_model_fallback',
      error_type: 'protocol:502',
    });
  });

  it('a throwing logger never escapes into the ingestion', () => {
    expect(() => emitResumeModelFallback('timeout', {
      warn: () => { throw new Error('sink failure'); },
    })).not.toThrow();
  });
});

describe('the Ashby parse port logs the degradation category', () => {
  it('emits ONE structured warn line with the category when the model tier surrenders', async () => {
    restores.push(__setModelRetryBackoffForTest(0));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Non-transient, so exactly one provider call and one fallback line.
      const runner = vi.fn<ResumeModelRunner>()
        .mockRejectedValue(new DeepseekError('protocol', 400));
      const { ports, shutdown } = await realParsePort(runner);
      try {
        const out = await ports.parse(Buffer.from('%PDF-1.4 inert'), 'application/pdf');
        // The degraded result is unchanged: deterministic fields, fallback tag.
        expect(out.structurerVersion).toBe(ASHBY_STRUCTURER_VERSION);
        expect(out.structured.email).toBe('rohan@example.invalid');
      } finally {
        await shutdown();
      }
      const lines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('resume_model_fallback'));
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]) as Record<string, unknown>;
      expect(entry.component).toBe('ashby-resume-structurer');
      expect(entry.error_category).toBe('resume_model_fallback');
      expect(entry.error_type).toBe('protocol:400');
      // Category only — never the résumé.
      expect(lines[0]).not.toContain('Rohan');
      expect(lines[0]).not.toContain('98765');
      expect(lines[0]).not.toContain('rohan@example.invalid');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('emits NO fallback line when the model answers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { ports, shutdown } = await realParsePort(async () => GOOD_SHAPE);
      try {
        await ports.parse(Buffer.from('%PDF-1.4 inert'), 'application/pdf');
      } finally {
        await shutdown();
      }
      const lines = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.includes('resume_model_fallback'));
      expect(lines).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
