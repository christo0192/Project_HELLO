/**
 * deepseek-json-mode.test.ts — provider JSON Output mode is OPT-IN per call.
 *
 * DeepSeek's "JSON Output" (`response_format: {type: 'json_object'}`) requires
 * the word "json" in the prompt; a caller whose prompt lacks it would turn a
 * good request into a 4xx. So the runner sends the field only when a caller
 * asks for it, the default body is byte-identical to before, and the résumé
 * structurer — whose prompt does contain "json" — is the one caller that asks.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDeepseekRunner,
  DeepseekError,
  type DeepseekTransport,
  type DeepseekTransportRequest,
} from '../lib/deepseek.js';
import { BusinessError, CircuitBreaker, isProviderFailure } from '../lib/provider-resilience.js';
import { EXTRACTION_INSTRUCTIONS } from '../lib/prompts.js';

function capturing() {
  const requests: DeepseekTransportRequest[] = [];
  const transport: DeepseekTransport = async (req) => {
    requests.push(req);
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }),
    };
  };
  const runner = createDeepseekRunner({
    transport,
    breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
  });
  const lastBody = () => JSON.parse(String(requests[requests.length - 1].init.body)) as Record<string, unknown>;
  return { runner, lastBody };
}

describe('DeepSeek response_format wiring', () => {
  beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'test-key'; });

  it('OMITS response_format by default (body unchanged for every existing caller)', async () => {
    const { runner, lastBody } = capturing();
    await runner.runDeepseekJSON('prompt');
    expect('response_format' in lastBody()).toBe(false);
  });

  it('INCLUDES response_format json_object when a caller opts in, after the messages', async () => {
    const { runner, lastBody } = capturing();
    await runner.runDeepseekJSON('Return json', { responseFormat: 'json_object' });
    const body = lastBody();
    expect(body.response_format).toEqual({ type: 'json_object' });
    // Field order: the messages (the cached prefix) come first; the mode is appended.
    expect(Object.keys(body).indexOf('messages')).toBeLessThan(Object.keys(body).indexOf('response_format'));
  });

  it('rejects any other response_format value before spawning a request', async () => {
    const { runner } = capturing();
    await expect(
      runner.runDeepseek('prompt', { responseFormat: 'text' as unknown as 'json_object' }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('the résumé extraction prompt satisfies the provider precondition (contains "json")', () => {
    expect(EXTRACTION_INSTRUCTIONS.toLowerCase()).toContain('json');
  });
});

describe('DeepSeek JSON mode — the documented blank answer', () => {
  function blankRunner() {
    let calls = 0;
    const transport: DeepseekTransport = async () => {
      calls += 1;
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
      };
    };
    const runner = createDeepseekRunner({
      transport,
      breaker: new CircuitBreaker({ failureThreshold: 5, cooldownMs: 30_000 }),
    });
    return { runner, calls: () => calls };
  }

  beforeEach(() => { process.env.DEEPSEEK_API_KEY = 'test-key'; });

  it('in JSON mode surfaces as a distinct, retryable empty_content error after ONE call', async () => {
    // "The API may occasionally return empty content" — DeepSeek JSON Output
    // docs. The structurer retries this on its transient ladder; a generic
    // parse_error would not be retried and would cost the candidate a phone.
    const { runner, calls } = blankRunner();
    await expect(runner.runDeepseekJSON('Return json', { responseFormat: 'json_object' }))
      .rejects.toMatchObject({ category: 'empty_content' });
    expect(calls()).toBe(1);
  });

  it('on the plain path keeps the historical treatment: one re-ask, then a parse_error BusinessError', async () => {
    const { runner, calls } = blankRunner();
    await expect(runner.runDeepseekJSON('prompt')).rejects.toBeInstanceOf(BusinessError);
    expect(calls()).toBe(2);
  });

  it('is not counted as a breaker failure', () => {
    expect(isProviderFailure(new DeepseekError('empty_content'))).toBe(false);
  });
});
