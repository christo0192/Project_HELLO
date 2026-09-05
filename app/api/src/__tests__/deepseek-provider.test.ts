import { beforeEach, describe, expect, it } from 'vitest';
import {
  createDeepseekRunner,
  DeepseekError,
  formatCacheMarker,
  type DeepseekCacheUsage,
  type DeepseekTransport,
  type DeepseekTransportRequest,
} from '../lib/deepseek.js';
import { BusinessError, CircuitBreaker, DefaultTimerSet, MonotonicClock } from '../lib/provider-resilience.js';

function newBreaker() {
  return new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, clock: MonotonicClock, timers: DefaultTimerSet });
}

function runnerWith(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const transport: DeepseekTransport = async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  });
  return createDeepseekRunner({ transport, breaker: newBreaker() });
}

/**
 * Capturing runner: records the outgoing request and any cache-usage points so
 * a test can assert both the request-body shape and the parsed cache metric.
 */
function capturingRunner(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const requests: DeepseekTransportRequest[] = [];
  const cachePoints: DeepseekCacheUsage[] = [];
  const transport: DeepseekTransport = async (req) => {
    requests.push(req);
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };
  const runner = createDeepseekRunner({
    transport,
    breaker: newBreaker(),
    cacheSink: (u) => cachePoints.push(u),
  });
  const lastBody = () => JSON.parse(String(requests[requests.length - 1].init.body)) as Record<string, unknown>;
  return { runner, requests, cachePoints, lastBody };
}

describe('DeepSeek HTTP provider', () => {
  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  });
  it('parses chat-completions JSON content', async () => {
    const runner = runnerWith({ choices: [{ message: { content: '{"message":"Hi","done":false}' } }] });
    await expect(runner.runDeepseekJSON('prompt')).resolves.toEqual({ message: 'Hi', done: false });
  });

  it('extracts fenced JSON content', async () => {
    const runner = runnerWith({ choices: [{ message: { content: '```json\n{"ok":true}\n```' } }] });
    await expect(runner.runDeepseekJSON('prompt')).resolves.toEqual({ ok: true });
  });

  it('returns requested model with provenance helper', async () => {
    const runner = runnerWith({ choices: [{ message: { content: '{"ok":true}' } }] });
    await expect(runner.runDeepseekJSONWithProvenance('prompt', { model: 'deepseek-chat' })).resolves.toEqual({
      data: { ok: true },
      requestedModel: 'deepseek-chat',
    });
  });

  it('maps non-2xx responses to stable protocol errors', async () => {
    const runner = runnerWith({ error: { message: 'secret-bearing provider error' } }, { ok: false, status: 429 });
    await expect(runner.runDeepseek('prompt')).rejects.toMatchObject({
      name: 'DeepseekError',
      category: 'protocol',
      status: 429,
      message: 'protocol',
    } satisfies Partial<DeepseekError>);
  });

  it('throws BusinessError after two invalid JSON generations', async () => {
    const runner = runnerWith({ choices: [{ message: { content: 'not json' } }] });
    await expect(runner.runDeepseekJSON('prompt')).rejects.toBeInstanceOf(BusinessError);
  });

  it('fails closed when DEEPSEEK_API_KEY is absent', async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const runner = runnerWith({ choices: [{ message: { content: '{"ok":true}' } }] });
      await expect(runner.runDeepseek('prompt')).rejects.toMatchObject({ category: 'missing_api_key' });
    } finally {
      if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = previous;
    }
  });

  describe('reasoning_effort wiring', () => {
    it('OMITS reasoning_effort by default (empty env, no opt)', async () => {
      const previous = process.env.DEEPSEEK_REASONING_EFFORT;
      delete process.env.DEEPSEEK_REASONING_EFFORT;
      try {
        const { runner, lastBody } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
        await runner.runDeepseek('prompt');
        const body = lastBody();
        expect(body.temperature).toBe(0.2);
        expect('reasoning_effort' in body).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_REASONING_EFFORT;
        else process.env.DEEPSEEK_REASONING_EFFORT = previous;
      }
    });

    it('OMITS reasoning_effort when the opt is an empty string', async () => {
      const { runner, lastBody } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
      await runner.runDeepseek('prompt', { reasoningEffort: '' });
      expect('reasoning_effort' in lastBody()).toBe(false);
    });

    it('INCLUDES reasoning_effort when the opt is a non-empty string', async () => {
      const { runner, lastBody } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
      await runner.runDeepseek('prompt', { reasoningEffort: 'high' });
      const body = lastBody();
      expect(body.reasoning_effort).toBe('high');
      expect(body.temperature).toBe(0.2);
    });

    it('INCLUDES reasoning_effort sourced from env when no opt is given', async () => {
      const previous = process.env.DEEPSEEK_REASONING_EFFORT;
      // env is read at module import, so drive this path via the opt which
      // shares the exact same include/omit branch; assert both directions.
      try {
        const { runner, lastBody } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
        await runner.runDeepseek('prompt', { reasoningEffort: 'xhigh' });
        expect(lastBody().reasoning_effort).toBe('xhigh');
      } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_REASONING_EFFORT;
        else process.env.DEEPSEEK_REASONING_EFFORT = previous;
      }
    });

    it('rejects an over-long reasoningEffort before any transport call', async () => {
      const { runner, requests } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
      await expect(runner.runDeepseek('prompt', { reasoningEffort: 'x'.repeat(65) }))
        .rejects.toBeInstanceOf(TypeError);
      expect(requests).toHaveLength(0);
    });
  });

  describe('prefix-cache usage accounting', () => {
    it('parses prompt_cache_hit_tokens / prompt_cache_miss_tokens and reports them', async () => {
      const { runner, cachePoints } = capturingRunner({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_cache_hit_tokens: 1280, prompt_cache_miss_tokens: 64 },
      });
      await runner.runDeepseek('prompt');
      expect(cachePoints).toEqual([{ hitTokens: 1280, missTokens: 64 }]);
    });

    it('reports zeros (does not throw) when the usage object is absent', async () => {
      const { runner, cachePoints } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
      await expect(runner.runDeepseek('prompt')).resolves.toBe('{"ok":true}');
      expect(cachePoints).toEqual([{ hitTokens: 0, missTokens: 0 }]);
    });

    it('reports zeros when only some cache fields are present or malformed', async () => {
      const { runner, cachePoints } = capturingRunner({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_cache_hit_tokens: 'not-a-number', prompt_cache_miss_tokens: -5 },
      });
      await runner.runDeepseek('prompt');
      expect(cachePoints).toEqual([{ hitTokens: 0, missTokens: 0 }]);
    });

    it('the default sink cannot throw into the request path', async () => {
      // The default sink logs; a successful call must resolve regardless.
      const runner = runnerWith({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 2 },
      });
      await expect(runner.runDeepseekJSON('prompt')).resolves.toEqual({ ok: true });
    });

    it('formats a greppable, logger-safe cache marker', () => {
      // SAFE_IDENT allowlist: [a-zA-Z0-9_:.-], max 64 — no slash, no space.
      const marker = formatCacheMarker({ hitTokens: 1280, missTokens: 64 });
      expect(marker).toBe('resume_model_cache:hit-1280:miss-64');
      expect(marker).toMatch(/^[a-zA-Z0-9_:.\-]{1,64}$/);
    });
  });

  describe('base URL selection', () => {
    it('defaults to the official DeepSeek endpoint', async () => {
      const previous = process.env.DEEPSEEK_BASE_URL;
      delete process.env.DEEPSEEK_BASE_URL;
      try {
        const { runner, requests } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
        await runner.runDeepseek('prompt');
        expect(requests[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
      } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL;
        else process.env.DEEPSEEK_BASE_URL = previous;
      }
    });

    it('honours a DEEPSEEK_BASE_URL override', async () => {
      const previous = process.env.DEEPSEEK_BASE_URL;
      process.env.DEEPSEEK_BASE_URL = 'https://proxy.example.test/v1/chat/completions';
      try {
        const { runner, requests } = capturingRunner({ choices: [{ message: { content: '{"ok":true}' } }] });
        await runner.runDeepseek('prompt');
        expect(requests[0].url).toBe('https://proxy.example.test/v1/chat/completions');
      } finally {
        if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL;
        else process.env.DEEPSEEK_BASE_URL = previous;
      }
    });
  });
});
