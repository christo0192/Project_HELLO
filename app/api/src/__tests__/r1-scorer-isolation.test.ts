/**
 * R1 scorer isolation fences (plan 9, PR-5):
 *   2. the phone scorer prompt is byte-identical;
 *   8. the default DeepSeek breaker stays closed under R1 failures.
 * Plus source fences: R1 code uses its own runner, never the phone scorer modules, and never
 * imports a phone-only module.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeepseekError, runDeepseek } from '../lib/deepseek.js';
import { ProviderError } from '../lib/provider-resilience.js';
import {
  R1_BREAKER_FAILURE_THRESHOLD,
  R1_SCORER_TIMEOUT_MS,
  createR1DeepseekRunner,
  createR1Infer,
  getR1DeepseekRunner,
  r1ScoringModel,
  resetR1DeepseekRunnerForTests,
} from '../lib/r1/deepseek-runner.js';
import { DEEPSEEK_TIMEOUT_CEILING_MS } from '../lib/env.js';
import { buildScorecardPrompt } from '../lib/scorecards/prompt.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');

/** LF-normalised sha256: the repo is LF in git, CRLF in some Windows working copies. */
function lfSha(relativeToSrc: string): string {
  const text = readFileSync(path.join(src, relativeToSrc), 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

describe('phone scorer byte-identity fence (PR-5)', () => {
  // An intentional phone-scorer change updates the matching pin IN THE SAME PR, with the phone
  // owner's sign-off. An R1 PR that trips one of these has edited the phone scorer.
  const PINS: Record<string, string> = {
    'lib/scorecards/prompt.ts': '93df1c703a2469deabf47fcb3943cfd9abd1c0bc3b5a394d2adaea5516880c6d',
    'lib/scorecards/scorer.ts': '173d62ed3d4fcb5c07c43766d6cc906005a6309e30090bada93b8f70ff10f887',
    'lib/scorecards/domain.ts': 'da506d335f9050d403d942ca7190a7f60b447e3a211e5aa33d51bdd902cefe94',
    'lib/scorecards/evidence.ts': 'b00860aa671659acf206e9edb8eaff19b69094dc91c890b086435492aa0ead77',
    'lib/scorecards/integrity.ts': '4c2460cd8e90f7b1a0dfc5898fd256defd7da3b2e0bb8ed884218ebf27d9a6c3',
    'lib/prompts.ts': '4e8ea472b2c3657b0845362ff1edecebe533ef3e36b2230f8d2d3a7ce55b82fd',
  };

  for (const [file, sha] of Object.entries(PINS)) {
    it(`${file} is byte-identical to the phone baseline`, () => {
      expect(lfSha(file)).toBe(sha);
    });
  }

  it('the phone prompt text is unchanged: same structure, labels and thresholds', () => {
    const prompt = buildScorecardPrompt({
      metrics: [{
        id: '00000000-0000-4000-8000-000000000001',
        libraryMetricId: '10000000-0000-4000-8000-000000000001',
        key: 'communication',
        name: 'Communication',
        instruction: 'Assess clarity and structure.',
        rubric: { 1: 'Poor.', 2: 'Average.', 3: 'Good.', 4: 'Excellent.' },
        weightBps: 10000,
        displayOrder: 0,
      }],
      roleTitle: 'Program Advisor',
      candidateName: 'Test Candidate',
      transcript: [
        { speaker: 'bot', text: 'Hello, how are you?' },
        { speaker: 'candidate', text: 'I am well, thank you.' },
      ],
      resumeFacts: 'Five years in customer success.',
      callTimestampIso: '2026-10-06T10:00:00Z',
    });
    const normalized = prompt.replace(
      /(\[(?:BEGIN|END) UNTRUSTED CANDIDATE (?:TRANSCRIPT|RESUME FACTS) )[0-9a-f]+\]/g,
      '$1SENTINEL]',
    );
    // The phone labels every bot line "Interviewer", has no R1 vocabulary and no turn indices.
    expect(normalized).toContain('Interviewer: Hello, how are you?');
    expect(normalized).toContain('Candidate: I am well, thank you.');
    expect(normalized).not.toMatch(/Learner \(simulated|never evidence|\[T\d+ \||T<turn/);
    expect(createHash('sha256').update(normalized).digest('hex')).toBe('652dcb8c66f4220497f4fde7b36b629fcef6e9da1452112a93bc805350987df3');
  });
});

describe('R1 DeepSeek runner isolation (PR-5)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DEEPSEEK_API_KEY;
    resetR1DeepseekRunnerForTests();
  });

  it('opens its own breaker after the R1 threshold and leaves the default breaker CLOSED', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
    const transport = vi.fn(async () => { throw new Error('socket hang up'); });
    const r1 = createR1DeepseekRunner({ transport });

    for (let i = 0; i < R1_BREAKER_FAILURE_THRESHOLD; i += 1) {
      await expect(r1.runDeepseek('x')).rejects.toBeInstanceOf(DeepseekError);
    }
    expect(transport).toHaveBeenCalledTimes(R1_BREAKER_FAILURE_THRESHOLD);
    // R1's breaker is OPEN: the next call is refused without touching the transport.
    await expect(r1.runDeepseek('x')).rejects.toBeInstanceOf(ProviderError);
    expect(transport).toHaveBeenCalledTimes(R1_BREAKER_FAILURE_THRESHOLD);

    // The shared default runner (resume parsing, phone scoring) is unaffected.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    await expect(runDeepseek('hello')).resolves.toBe('ok');
    await expect(runDeepseek('hello again')).resolves.toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('the process-wide R1 runner is a separate instance from the default exports', () => {
    expect(getR1DeepseekRunner()).toBe(getR1DeepseekRunner());
    expect(getR1DeepseekRunner().runDeepseek).not.toBe(runDeepseek);
  });

  it('keeps the default breaker closed even when the SHARED R1 runner is hammered', async () => {
    process.env.DEEPSEEK_API_KEY = 'test-key-not-real';
    const failing = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response('boom', { status: 503 }));
    const infer = createR1Infer();
    for (let i = 0; i < R1_BREAKER_FAILURE_THRESHOLD + 2; i += 1) {
      await expect(infer('prompt')).rejects.toBeTruthy();
    }
    // The shared R1 runner went through the same fetch, but its breaker opened at the threshold.
    expect(failing.mock.calls.length).toBe(R1_BREAKER_FAILURE_THRESHOLD);
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'fine' } }] }), { status: 200 }));
    await expect(runDeepseek('still works')).resolves.toBe('fine');
  });

  it('passes the scoring model and the R1 timeout, within the shared ceiling', async () => {
    const runDeepseekJSONWithProvenance = vi.fn(async () => ({ data: { results: [] }, requestedModel: 'm' }));
    const infer = createR1Infer({
      runDeepseek: vi.fn(),
      runDeepseekJSON: vi.fn(),
      runDeepseekJSONWithProvenance: runDeepseekJSONWithProvenance as never,
    });
    await expect(infer('p')).resolves.toEqual({ results: [] });
    expect(runDeepseekJSONWithProvenance).toHaveBeenCalledWith('p', {
      model: r1ScoringModel(),
      timeoutMs: R1_SCORER_TIMEOUT_MS,
    });
    expect(R1_SCORER_TIMEOUT_MS).toBeLessThanOrEqual(DEEPSEEK_TIMEOUT_CEILING_MS);
    expect(r1ScoringModel()).toMatch(/^deepseek/);
  });
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const R1_SOURCES = [
  ...listFiles(path.join(src, 'lib/r1')),
  path.join(src, 'lib/scorecards/r1-prompt.ts'),
  path.join(src, 'services/r1-assessment.ts'),
];

/** The files this PR owns (PR-2's config.ts is policed by its own suite). */
const OWN_SOURCES = R1_SOURCES.filter((file) => path.basename(file) !== 'config.ts');

function importsOf(file: string): Array<{ names: string[]; from: string }> {
  const text = readFileSync(file, 'utf8');
  const found: Array<{ names: string[]; from: string }> = [];
  for (const match of text.matchAll(/import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+\w+|\w+)\s+from\s+'([^']+)'/g)) {
    found.push({
      names: (match[1] ?? '').split(',').map((n) => n.trim().replace(/^type\s+/, '')).filter(Boolean),
      from: match[2] as string,
    });
  }
  return found;
}

describe('R1 source fences', () => {
  it('finds the R1 sources it is meant to police', () => {
    const names = R1_SOURCES.map((file) => path.basename(file));
    for (const expected of [
      'scorer.ts', 'gate.ts', 'rubric.ts', 'evidence.ts', 'runtime.ts', 'deepseek-runner.ts',
      'r1-prompt.ts', 'r1-assessment.ts', 'assessment-handler.ts', 'transcript.ts', 'admin-log.ts',
    ]) {
      expect(names, expected).toContain(expected);
    }
  });

  it('never imports the shared DeepSeek/Claude default runners (only the factory and the error type)', () => {
    const allowed: Record<string, Set<string>> = {
      deepseek: new Set(['createDeepseekRunner', 'DeepseekRunner', 'DeepseekRunnerDeps', 'DeepseekError']),
      claude: new Set(),
    };
    for (const file of R1_SOURCES) {
      for (const { names, from } of importsOf(file)) {
        const target = /(?:^|\/)(deepseek|claude)\.js$/.exec(from)?.[1];
        if (!target) continue;
        for (const name of names) {
          expect(allowed[target]!.has(name), `${path.basename(file)} imports ${name} from ${from}`).toBe(true);
        }
      }
    }
  });

  it('never imports the phone scorer, the phone prompt, the legacy assessment service or any phone module', () => {
    const forbidden = [
      /\/scorecards\/prompt\.js$/,
      /\/scorecards\/scorer\.js$/,
      /\/scorecards\/integrity\.js$/,
      /\/scorecards\/evidence\.js$/,
      /\/services\/assessment\.js$/,
      /phone-runtime/,
      /phone-screening/,
      /phone-canary/,
      /livekit-phone/,
      /routes\/phone/,
      /\/lib\/phone/,
    ];
    for (const file of R1_SOURCES) {
      for (const { from } of importsOf(file)) {
        for (const pattern of forbidden) {
          expect(pattern.test(from), `${path.basename(file)} imports ${from}`).toBe(false);
        }
      }
    }
  });

  it('reads no environment variable directly (R1 adds none; R1_ENABLED stays in lib/r1/config.ts)', () => {
    for (const file of OWN_SOURCES) {
      const text = readFileSync(file, 'utf8');
      expect(text, path.basename(file)).not.toMatch(/process\.env\.[A-Z]/);
    }
  });

  it('logs through the structured logger only: no console output in the scorer modules', () => {
    for (const file of OWN_SOURCES) {
      const text = readFileSync(file, 'utf8');
      expect(text, path.basename(file)).not.toMatch(/console\.(log|info|warn|error)/);
    }
  });
});
