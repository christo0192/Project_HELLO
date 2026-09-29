/**
 * Ask Hello on the Scorebar — the PROVIDER-CALL cap: at most two calls per
 * press, worst case.
 *
 * WHY THIS FILE EXISTS. The generator used to run each of its two attempts
 * through the JSON runner, and the JSON runner silently re-asks once on an
 * unparseable answer before throwing `BusinessError`. The generator classified
 * that throw as retryable and ran its own second attempt — up to FOUR 45 s
 * provider calls behind one button. Counting `infer` calls could never see it:
 * the hidden re-ask lives INSIDE one `infer`. So this counts the thing that
 * costs money, the transport, through the REAL DeepSeek runner.
 *
 * And it drives the PRODUCTION default wiring (no `infer`, no `runText`), with
 * `claude.js` replaced only so that its text runner can be pointed at a real
 * runner over a counting transport — and its JSON runners made to fail loudly,
 * because a generator that reached for them again is the regression.
 *
 * No real provider is called: the transport is a function in this file.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  runText: null as null | ((prompt: string, opts?: unknown) => Promise<string>),
  jsonRunnerCalls: 0,
}));

vi.mock('../lib/claude.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/claude.js')>();
  const forbidden = async (): Promise<never> => {
    h.jsonRunnerCalls += 1;
    throw new Error('metric drafting must not use a JSON runner: it re-asks on its own');
  };
  return {
    ...actual,
    runClaude: (prompt: string, opts?: unknown) => {
      if (!h.runText) throw new Error('test did not configure runClaude');
      return h.runText(prompt, opts);
    },
    runClaudeJSON: forbidden,
    runClaudeJSONWithProvenance: forbidden,
  };
});

const { draftMetricRubric } = await import('../lib/scorecards/metric-draft.js');
const { createDeepseekRunner } = await import('../lib/deepseek.js');
const { RoleDraftError } = await import('../lib/role-authoring.js');
const { BusinessError } = await import('../lib/provider-resilience.js');

const INPUT = { name: 'Problem solving', description: 'How they work through obstacles.' };
const GOOD = {
  default_instruction: 'Look for concrete examples of how the candidate solved a problem. Use only what they said.',
  rubric: {
    '1': 'Gives no example.',
    '2': 'Gives a vague example with no outcome.',
    '3': 'Gives a specific example with steps and an outcome.',
    '4': 'Gives several specific examples with outcomes and lessons.',
  },
};

/**
 * A transport that answers every request with the next scripted reply (the
 * last one repeats) and COUNTS requests. Each request is one provider call.
 */
function countingTransport(replies: Array<{ content?: string; status?: number }>) {
  let calls = 0;
  const transport = async () => {
    const reply = replies[Math.min(calls, replies.length - 1)];
    calls += 1;
    const status = reply.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify({ choices: [{ message: { content: reply.content ?? '' } }] }),
    };
  };
  return { transport, calls: () => calls };
}

/** A real runner over the counting transport, wired in as `runClaude`. */
function wire(replies: Array<{ content?: string; status?: number }>) {
  const counted = countingTransport(replies);
  const runner = createDeepseekRunner({ transport: counted.transport, cacheSink: () => {} });
  h.runText = (prompt, opts) => runner.runDeepseek(prompt, opts as never);
  return { runner, transportCalls: counted.calls };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RoleDraftError);
    return (err as InstanceType<typeof RoleDraftError>).reason;
  }
  throw new Error('expected draftMetricRubric to throw');
}

const PROSE = 'I am sorry, I cannot produce that as JSON.';

let savedKey: string | undefined;
beforeAll(() => {
  // The runner refuses without a key before it touches the transport. A fake
  // one reaches nothing: the transport is the function above.
  savedKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key-not-a-real-credential';
});
afterAll(() => {
  if (savedKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = savedKey;
});
beforeEach(() => {
  h.runText = null;
  h.jsonRunnerCalls = 0;
});

describe('draftMetricRubric — at most TWO provider calls per press, through the default wiring', () => {
  it('unparseable prose on every call → invalid_output after EXACTLY 2 provider calls (was 4)', async () => {
    const { transportCalls } = wire([{ content: PROSE }]);
    expect(await reasonOf(draftMetricRubric(INPUT))).toBe('invalid_output');
    expect(transportCalls()).toBe(2);
    expect(h.jsonRunnerCalls).toBe(0);
  });

  it('JSON mode answering blank content every time → 2 provider calls, invalid_output', async () => {
    const { transportCalls } = wire([{ content: '' }]);
    expect(await reasonOf(draftMetricRubric(INPUT))).toBe('invalid_output');
    expect(transportCalls()).toBe(2);
  });

  it('valid JSON that fails the checks every time → 2 provider calls, output_too_long', async () => {
    const { transportCalls } = wire([
      { content: JSON.stringify({ ...GOOD, default_instruction: 'x'.repeat(1001) }) },
    ]);
    expect(await reasonOf(draftMetricRubric(INPUT))).toBe('output_too_long');
    expect(transportCalls()).toBe(2);
  });

  it('prose, then a valid answer → the draft, after 2 provider calls', async () => {
    const { transportCalls } = wire([{ content: PROSE }, { content: JSON.stringify(GOOD) }]);
    expect(await draftMetricRubric(INPUT)).toEqual(GOOD);
    expect(transportCalls()).toBe(2);
  });

  it('a valid first answer → 1 provider call', async () => {
    const { transportCalls } = wire([{ content: JSON.stringify(GOOD) }]);
    expect(await draftMetricRubric(INPUT)).toEqual(GOOD);
    expect(transportCalls()).toBe(1);
  });

  it('an upstream 5xx → provider_error after 1 provider call (not retried)', async () => {
    const { transportCalls } = wire([{ status: 502 }]);
    expect(await reasonOf(draftMetricRubric(INPUT))).toBe('provider_error');
    expect(transportCalls()).toBe(1);
  });
});

describe('POSITIVE CONTROL — the counting harness sees the JSON runner\'s hidden re-ask', () => {
  // Without these, "2 calls" above could be a harness that under-counts.

  it('the JSON runner alone makes 2 provider calls on prose, then throws BusinessError', async () => {
    const { runner, transportCalls } = wire([{ content: PROSE }]);
    await expect(runner.runDeepseekJSON('prompt naming json', { responseFormat: 'json_object' }))
      .rejects.toBeInstanceOf(BusinessError);
    expect(transportCalls()).toBe(2);
  });

  it('the composition this replaced — two attempts over the JSON runner — costs 4 provider calls', async () => {
    const { runner, transportCalls } = wire([{ content: PROSE }]);
    const infer = (prompt: string) =>
      runner.runDeepseekJSON<unknown>(prompt, { responseFormat: 'json_object' });
    expect(await reasonOf(draftMetricRubric(INPUT, { infer }))).toBe('invalid_output');
    expect(transportCalls()).toBe(4);
  });
});
