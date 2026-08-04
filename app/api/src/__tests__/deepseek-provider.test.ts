import { beforeEach, describe, expect, it } from 'vitest';
import { createDeepseekRunner, DeepseekError, type DeepseekTransport } from '../lib/deepseek.js';
import { BusinessError, CircuitBreaker, DefaultTimerSet, MonotonicClock } from '../lib/provider-resilience.js';

function runnerWith(body: unknown, opts: { ok?: boolean; status?: number } = {}) {
  const transport: DeepseekTransport = async () => ({
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  });
  return createDeepseekRunner({
    transport,
    breaker: new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, clock: MonotonicClock, timers: DefaultTimerSet }),
  });
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
});
