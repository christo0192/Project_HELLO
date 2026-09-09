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
  type DeepseekTransport,
  type DeepseekTransportRequest,
} from '../lib/deepseek.js';
import { CircuitBreaker } from '../lib/provider-resilience.js';
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
