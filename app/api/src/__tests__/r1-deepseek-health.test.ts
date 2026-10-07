import { describe, expect, it, vi } from 'vitest';
import {
  R1_DEEPSEEK_ORIGIN,
  R1_DEEPSEEK_PROBE_MODEL,
  R1_HEALTH_DEADLINE_MS,
  R1_HEALTH_FAILURE_TTL_MS,
  R1_HEALTH_TTL_MS,
  createDeepSeekHealthProbe,
} from '../lib/r1/deepseek-health.js';

function response(ok: boolean, body: unknown): Response {
  return { ok, status: ok ? 200 : 500, text: async () => JSON.stringify(body) } as Response;
}

function healthyFetch() {
  return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => (
    String(url).endsWith('/user/balance')
      ? response(true, { is_available: true, balance_infos: [] })
      : response(true, { choices: [{ message: { content: 'p' } }] })
  ));
}

function probeWith(fetchFn: typeof fetch, clock: { now: number }, key = 'k') {
  return createDeepSeekHealthProbe({
    fetch: fetchFn,
    now: () => clock.now,
    apiKey: () => key,
  });
}

describe('R1 DeepSeek admission health probe', () => {
  it('asks balance and a one-token completion on the pinned host and model', async () => {
    const fetchFn = healthyFetch();
    const probe = probeWith(fetchFn as unknown as typeof fetch, { now: 0 });
    expect(await probe.check()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const calls = fetchFn.mock.calls.map(([url, init]) => ({
      url: String(url),
      init: init as RequestInit,
    }));
    const balance = calls.find((c) => c.url.endsWith('/user/balance'))!;
    const completion = calls.find((c) => c.url.endsWith('/v1/chat/completions'))!;
    expect(balance.url).toBe(`${R1_DEEPSEEK_ORIGIN}/user/balance`);
    expect(balance.init.method).toBe('GET');
    expect(completion.init.method).toBe('POST');
    expect(JSON.parse(completion.init.body as string)).toEqual({
      model: R1_DEEPSEEK_PROBE_MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: false,
      thinking: { type: 'disabled' },
    });
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer k');
      expect(call.init.redirect).toBe('error');
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(R1_DEEPSEEK_ORIGIN).toBe('https://api.deepseek.com');
    expect(R1_DEEPSEEK_PROBE_MODEL).toBe('deepseek-flash');
  });

  it('is unhealthy when the account reports it is not available', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => (
      String(url).endsWith('/user/balance')
        ? response(true, { is_available: false })
        : response(true, {})
    ));
    expect(await probeWith(fetchFn as unknown as typeof fetch, { now: 0 }).check()).toBe(false);
  });

  it.each([
    ['balance non-2xx', (url: string) => url.endsWith('/user/balance'), 402],
    ['completion non-2xx', (url: string) => url.endsWith('/chat/completions'), 429],
  ])('is unhealthy on %s', async (_name, failing, _status) => {
    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const failed = failing(String(url));
      return failed ? response(false, {}) : response(true, { is_available: true });
    });
    expect(await probeWith(fetchFn as unknown as typeof fetch, { now: 0 }).check()).toBe(false);
  });

  it('is unhealthy on a network error, a non-JSON balance body or a missing key', async () => {
    const down = vi.fn(async () => { throw new Error('ECONNRESET'); });
    expect(await probeWith(down as unknown as typeof fetch, { now: 0 }).check()).toBe(false);
    const garbled = vi.fn(async () => (
      { ok: true, status: 200, text: async () => '<html>' }) as Response);
    expect(await probeWith(garbled as unknown as typeof fetch, { now: 0 }).check()).toBe(false);
    const never = vi.fn();
    expect(await probeWith(never as unknown as typeof fetch, { now: 0 }, '').check()).toBe(false);
    expect(never).not.toHaveBeenCalled();
  });

  it('gives up at the 3 s deadline', async () => {
    vi.useFakeTimers();
    try {
      const hung = vi.fn((_url: string | URL | Request, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
      ));
      const probe = probeWith(hung as unknown as typeof fetch, { now: 0 });
      const pending = probe.check();
      await vi.advanceTimersByTimeAsync(R1_HEALTH_DEADLINE_MS);
      expect(await pending).toBe(false);
      expect(R1_HEALTH_DEADLINE_MS).toBe(3_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches a healthy verdict for 60 s and a failure for 10 s', async () => {
    const clock = { now: 1_000 };
    const fetchFn = healthyFetch();
    const probe = probeWith(fetchFn as unknown as typeof fetch, clock);
    expect(await probe.check()).toBe(true);
    clock.now += R1_HEALTH_TTL_MS - 1;
    expect(await probe.check()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    clock.now += 1;
    expect(await probe.check()).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(4);

    const failing = vi.fn(async () => response(false, {}));
    const failClock = { now: 0 };
    const failProbe = probeWith(failing as unknown as typeof fetch, failClock);
    expect(await failProbe.check()).toBe(false);
    failClock.now += R1_HEALTH_FAILURE_TTL_MS - 1;
    expect(await failProbe.check()).toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
    failClock.now += 1;
    await failProbe.check();
    expect(failing).toHaveBeenCalledTimes(4);
    expect(R1_HEALTH_TTL_MS).toBe(60_000);
  });

  it('shares one in-flight probe between concurrent callers and can be reset', async () => {
    const fetchFn = healthyFetch();
    const probe = probeWith(fetchFn as unknown as typeof fetch, { now: 0 });
    const verdicts = await Promise.all([probe.check(), probe.check(), probe.check()]);
    expect(verdicts).toEqual([true, true, true]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    probe.reset();
    await probe.check();
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('never logs the key or any response content', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const failing = vi.fn(async () => response(false, { secret: 'response-body-secret' }));
      const key = 'sk-super-secret-key';
      const probe = probeWith(failing as unknown as typeof fetch, { now: 0 }, key);
      await probe.check();
      const written = [...spy.mock.calls, ...warn.mock.calls, ...log.mock.calls].flat().join(' ');
      expect(written).not.toContain('sk-super-secret-key');
      expect(written).not.toContain('response-body-secret');
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      log.mockRestore();
    }
  });
});
