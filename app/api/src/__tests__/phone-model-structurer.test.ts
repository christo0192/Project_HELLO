/**
 * phone-model-structurer.test.ts — the step that decides whether an
 * Ashby-imported candidate can be called at all.
 *
 * Before this, the Ashby ingestion structured every resume with the
 * DETERMINISTIC regex extractor, whose tag is not on the dialable allowlist.
 * The consequence was a complete end-to-end gap: the persistence, the strict
 * format gate and the provenance gate were all in place and no imported
 * candidate could ever reach a dialable state. Wiring the bounded model
 * structurer into the parse port is what closes it — and it is the ONE line
 * that lets a real call happen, so the tests below are about its edges.
 *
 * TWO PROPERTIES ARE UNDER TEST, AND THEY PULL IN OPPOSITE DIRECTIONS:
 *
 *   1. A model-structured strict Indian mobile MUST become dialable, or the
 *      feature does not exist.
 *   2. Everything else — a provider outage, a malformed shape, a landline, a
 *      non-IN number, a rescued-by-regex parse — MUST NOT, and must still
 *      produce a populated candidate rather than a failed ingestion.
 *
 * NO PROVIDER IS EVER CONTACTED. Every test injects its own runner through the
 * `modelRunner` seam, except the one case that deliberately exercises the
 * default and mocks the shared module underneath.
 *
 * ── PAIRED WITH A SECURITY-POSTURE BULLET ───────────────────────────────────
 *
 * The "Security posture" list at the top of
 * `src/integrations/ashby/resume-ingestion.ts` used to state that structuring
 * was deterministic with "no LLM in this path". Wiring the model tier reversed
 * that, and the bullet now describes the two-tier structurer, its containment
 * and its fail-soft degradation — and points here. These two move TOGETHER: if
 * the parse port ever stops composing the model tier, or stops degrading to
 * the deterministic one, the tests below fail and that bullet becomes wrong.
 * A stale exclusion on the untrusted-input boundary file is exactly the kind
 * of claim a reviewer relies on to stop checking.
 *
 * Every phone value in this file is synthetic.
 */

import { describe, it, expect, vi } from 'vitest';

/**
 * The SHARED runner, mocked at the module boundary.
 *
 * Used by exactly one test — the one that omits the `modelRunner` seam — to
 * prove production is wired to the default path. Every other test injects its
 * own runner and never touches this. No provider is contacted either way.
 */
const sharedRunner = vi.fn(async () => ({
  name: 'Default Path', phone: '98765 43210', skills: ['TypeScript'],
}) as unknown);
vi.mock('../lib/claude.js', () => ({
  runClaudeJSON: (...a: unknown[]) => sharedRunner(...(a as [])),
  runClaude: vi.fn(),
  runClaudeJSONWithProvenance: vi.fn(),
}));
import {
  createAshbyRuntime,
  ASHBY_STRUCTURER_VERSION,
} from '../integrations/ashby/runtime.js';
import { loadAshbyConfig, loadAshbyRuntimeConfig } from '../integrations/ashby/config.js';
import {
  coerceStructuredResume,
  structureResumeWithModel,
  type ResumeModelRunner,
} from '../lib/resume-structurer.js';
import {
  deriveCandidatePhone,
  isDialableStructurer,
  MODEL_STRUCTURER_VERSION,
} from '../lib/candidate-phone.js';

const APIKEY = 'SENTINEL_APIKEY_aaaaaaaaaaaaaaaaaaaa';
const SECRET = 'SENTINEL_SECRET_bbbbbbbbbbbbbbbbbbbb';

function env(): NodeJS.ProcessEnv {
  return {
    ASHBY_INTEGRATION_ENABLED: 'true',
    ASHBY_WEBHOOK_SECRET: SECRET,
    ASHBY_RUNTIME_ENABLED: 'true',
    ASHBY_API_KEY: APIKEY,
  } as NodeJS.ProcessEnv;
}

const RESUME_TEXT = [
  'Rohan Mehta',
  'rohan@example.invalid',
  'Mobile: 98765 43210',
  'Senior Engineer, 7 years experience',
].join('\n');

/**
 * A Supabase double that returns a link row carrying a resume handle, which is
 * what `buildIngestionPorts` needs before it will hand back a real ports
 * object.
 */
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

/**
 * A transport that answers `file.info` with a presigned URL on the allowlisted
 * host. It never reaches a network — it is the client's injected test seam.
 */
const fileInfoTransport = async () => ({
  status: 200,
  ok: true,
  headers: { get: () => null },
  text: async () => JSON.stringify({
    success: true,
    results: { url: 'https://files.ashby.example/resume.pdf' },
  }),
});

/**
 * Build the REAL runtime and take the REAL parse port out of it, injecting
 * only two seams: the document parser (so no child process runs) and the model
 * runner (so no provider is contacted).
 *
 * Going through `buildIngestionPorts` rather than reconstructing the
 * composition by hand is the point — a test that rebuilt the port would pass
 * even if production stopped calling the structurer.
 */
async function realParsePort(modelRunner: ResumeModelRunner | undefined, text = RESUME_TEXT) {
  const e = { ...env(), ASHBY_RESUME_HOSTS: 'files.ashby.example' } as NodeJS.ProcessEnv;
  const runtime = createAshbyRuntime({
    supabase: fakeSupabase(),
    config: loadAshbyConfig(e),
    runtimeConfig: loadAshbyRuntimeConfig(e),
    transport: fileInfoTransport,
    parserPool: {
      submit: async () => ({ text, totalLength: text.length, truncated: false }),
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

describe('the Ashby parse port structures with the model', () => {
  /** Drive the REAL parse port. The bytes/mime are inert — the pool is faked. */
  async function runParse(modelRunner: ResumeModelRunner, text = RESUME_TEXT) {
    const { ports, shutdown } = await realParsePort(modelRunner, text);
    try {
      return await ports.parse(Buffer.from('%PDF-1.4 inert'), 'application/pdf');
    } finally {
      await shutdown();
    }
  }

  it('takes the document parse from the pooled child process, unchanged', async () => {
    // The new structuring tier must not have disturbed the step that actually
    // touches the bytes.
    const out = await runParse(async () => ({ phone: '9876543210', skills: [] }));
    expect(out.text).toBe(RESUME_TEXT);
  });

  it('a model-structured strict Indian mobile becomes DIALABLE', async () => {
    // The whole point of the change. Without this, everything else in PR-N is
    // machinery with no reachable end state.
    const runner: ResumeModelRunner = async () => ({
      name: 'Rohan Mehta', email: 'rohan@example.invalid', phone: '98765 43210',
      skills: ['TypeScript'], experience_years: 7, current_role: 'Senior Engineer',
      summary: 'Synthetic.',
    });
    const { structured, structurerVersion } = await runParse(runner);
    expect(structurerVersion).toBe(MODEL_STRUCTURER_VERSION);
    expect(isDialableStructurer(structurerVersion)).toBe(true);

    const phone = deriveCandidatePhone(structured.phone, structurerVersion);
    expect(phone).toEqual({ raw: '98765 43210', e164: '+919876543210', valid: true });
  });

  it('uses the SHARED default runner when no seam is injected', async () => {
    // THE WIRING TEST. Without it, changing the seam default to
    // `async () => null` leaves every other test green while Ashby dialing is
    // silently dead in production — the exact end-to-end gap this change
    // exists to close.
    sharedRunner.mockClear();
    const { ports, shutdown } = await realParsePort(undefined);
    try {
      const out = await ports.parse(Buffer.from('%PDF-1.4 inert'), 'application/pdf');
      expect(sharedRunner).toHaveBeenCalledTimes(1);
      expect(out.structurerVersion).toBe(MODEL_STRUCTURER_VERSION);
      expect(deriveCandidatePhone(out.structured.phone, out.structurerVersion).valid).toBe(true);
    } finally {
      await shutdown();
    }
  });

  it('MERGES: a model answer that omits the phone keeps the one the regex found', async () => {
    // The regression this guards. A model that drops a number sitting in a
    // header still returns a name, and `usefulStructured` is an OR across all
    // seven fields — so nothing would have re-run the regex, and the candidate
    // would have been written with `phone_raw: null` where the pre-change path
    // populated it. A change made to let candidates be CALLED must not make
    // one LESS contactable than before.
    const runner: ResumeModelRunner = async () => ({
      name: 'Rohan Mehta', summary: 'Senior engineer.', skills: [],
    });
    const { structured, structurerVersion } = await runParse(runner);

    // The regex value survives…
    expect(structured.phone).toBeTruthy();
    expect(structured.email).toBe('rohan@example.invalid');
    // …and the model's own fields win where it produced them.
    expect(structured.name).toBe('Rohan Mehta');
    expect(structured.summary).toBe('Senior engineer.');

    // …but the phone came from the REGEX, so it is NOT dialable. A merge must
    // not launder a digit-run false positive into a call.
    expect(structurerVersion).toBe(`${MODEL_STRUCTURER_VERSION}+fallback`);
    expect(isDialableStructurer(structurerVersion)).toBe(false);
    expect(deriveCandidatePhone(structured.phone, structurerVersion).valid).toBe(false);
  });

  it('MERGES: a model phone wins over the regex and stays dialable', async () => {
    const runner: ResumeModelRunner = async () => ({ phone: '+91 90000-00000', skills: [] });
    const { structured, structurerVersion } = await runParse(runner);
    expect(structured.phone).toBe('+91 90000-00000');       // model, not regex
    expect(structurerVersion).toBe(MODEL_STRUCTURER_VERSION);
    expect(deriveCandidatePhone(structured.phone, structurerVersion))
      .toEqual({ raw: '+91 90000-00000', e164: '+919000000000', valid: true });
  });

  it('MERGES: no phone anywhere is undialable regardless of the tag', async () => {
    const runner: ResumeModelRunner = async () => ({ name: 'No Number', skills: [] });
    const { structured, structurerVersion } = await runParse(runner, 'No Number\nSenior engineer with no contact details listed.');
    expect(structured.phone).toBeNull();
    expect(deriveCandidatePhone(structured.phone, structurerVersion).valid).toBe(false);
  });

  it('a model-structured NON-IN number is refused', async () => {
    const runner: ResumeModelRunner = async () => ({ phone: '+14155552671', skills: [] });
    const { structured, structurerVersion } = await runParse(runner);
    expect(structurerVersion).toBe(MODEL_STRUCTURER_VERSION);
    // Approved provenance is NOT sufficient — the strict format gate still
    // applies, and a valid US number is not dialable by this system.
    expect(deriveCandidatePhone(structured.phone, structurerVersion))
      .toEqual({ raw: '+14155552671', e164: null, valid: false });
  });

  it('a model-structured Indian LANDLINE is refused', async () => {
    const runner: ResumeModelRunner = async () => ({ phone: '+912212345678', skills: [] });
    const { structured, structurerVersion } = await runParse(runner);
    expect(deriveCandidatePhone(structured.phone, structurerVersion))
      .toEqual({ raw: '+912212345678', e164: null, valid: false });
  });

  it('a PROVIDER FAILURE falls back to the deterministic extractor, raw-only', async () => {
    // The document was fetched, screened and parsed successfully. A model
    // outage must cost a phone call, not a candidate.
    const runner: ResumeModelRunner = async () => { throw new Error('provider_down'); };
    const { structurerVersion } = await runParse(runner);
    expect(structurerVersion).toBe(ASHBY_STRUCTURER_VERSION);
    expect(isDialableStructurer(structurerVersion)).toBe(false);

    // The regex still finds the number, and it is still written to phone_raw —
    // just never dialed.
    const { fallbackParseResumeText } = await import('../lib/resume-fallback.js');
    const rescued = fallbackParseResumeText(RESUME_TEXT);
    expect(rescued.phone).toBeTruthy();
    expect(deriveCandidatePhone(rescued.phone, structurerVersion))
      .toEqual({ raw: rescued.phone, e164: null, valid: false });
  });

  it.each([
    ['a bare string', 'not json at all'],
    ['an array', [{ phone: '9876543210' }]],
    ['null', null],
    ['a number-typed phone', { phone: 9876543210, skills: [] }],
    ['a non-array skills field', { phone: '9876543210', skills: 'TypeScript' }],
    ['a string-typed experience_years', { phone: '9876543210', experience_years: '7' }],
  ])('MALFORMED model output (%s) falls back and is never dialable', async (_label, payload) => {
    const runner: ResumeModelRunner = async () => payload;
    const { structurerVersion } = await runParse(runner);
    expect(structurerVersion).toBe(ASHBY_STRUCTURER_VERSION);
    expect(isDialableStructurer(structurerVersion)).toBe(false);
  });

  it('does not fail the ingestion when structuring fails', async () => {
    // `structureResumeWithModel` is the only new call in the parse path and it
    // NEVER rejects — a throw here would propagate into `runResumeIngestion`,
    // which would classify it as `unexpected_error` and park the row in
    // `failed_review`. That would turn a model outage into a stuck candidate.
    for (const runner of [
      async () => { throw new Error('boom'); },
      async () => { throw { not: 'an Error' }; },
      async () => Promise.reject(new Error('rejected')),
      async () => undefined,
    ] as ResumeModelRunner[]) {
      await expect(structureResumeWithModel(RESUME_TEXT, runner)).resolves.toBeNull();
    }
  });

  it('writes no resume content to any console or logger sink', async () => {
    // Asserted against SPIES, not against file text. The runner receives the
    // resume text in its prompt; if a failure surfaced that prompt in a log
    // line, the PII would travel wherever ingestion failures are shipped.
    //
    // An output grep would also be the wrong instrument here: `lib/logger.ts`
    // redacts runs of 10+ digits, so a leaking call site still produces a
    // clean-looking line. These spies capture the ARGUMENTS.
    const seen: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const)
      .map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { seen.push(...a); }));
    try {
      await structureResumeWithModel(RESUME_TEXT, async (prompt) => { throw new Error(prompt); });
      await structureResumeWithModel(RESUME_TEXT, async () => ({ phone: 9876543210 }));
      await structureResumeWithModel(RESUME_TEXT, async () => 'not json');
    } finally {
      for (const s of spies) s.mockRestore();
    }
    const dumped = JSON.stringify(seen.map(String));
    expect(dumped).not.toContain('Rohan Mehta');
    expect(dumped).not.toContain('98765');
    expect(dumped).not.toContain('rohan@example.invalid');
    expect(seen).toHaveLength(0);   // it logs nothing at all
  });

  it('bounds an echoed prompt so an unbounded blob cannot ride into the row', async () => {
    const echo: ResumeModelRunner = async (prompt) => ({ summary: prompt, skills: [] });
    const out = await structureResumeWithModel(RESUME_TEXT, echo);
    expect(out!.summary!.length).toBeLessThanOrEqual(500);
  });
});

describe('coerceStructuredResume — the validator that replaced a cast', () => {
  it('rejects anything that is not a plain object', () => {
    for (const v of [null, undefined, 'text', 42, true, [], [{ phone: '9876543210' }]]) {
      expect(coerceStructuredResume(v)).toBeNull();
    }
  });

  it('rejects a present key whose TYPE is wrong', () => {
    // A wrong shape is not a partially-good answer. Falling back is safer than
    // keeping the fields that happened to be right.
    expect(coerceStructuredResume({ phone: 9876543210 })).toBeNull();
    expect(coerceStructuredResume({ name: 42 })).toBeNull();
    expect(coerceStructuredResume({ skills: 'TypeScript' })).toBeNull();
    expect(coerceStructuredResume({ experience_years: '7' })).toBeNull();
    expect(coerceStructuredResume({ summary: { text: 'x' } })).toBeNull();
  });

  it('treats an ABSENT key as null rather than malformed', () => {
    expect(coerceStructuredResume({})).toEqual({
      name: null, email: null, phone: null, skills: [],
      experience_years: null, current_role: null, summary: null,
    });
  });

  it('nulls an out-of-RANGE number without discarding the whole result', () => {
    // Out of range is a bad answer for one field; wrong type is a bad shape.
    for (const years of [NaN, Infinity, -1, 1000]) {
      const out = coerceStructuredResume({ phone: '9876543210', experience_years: years });
      expect(out).not.toBeNull();
      expect(out!.experience_years).toBeNull();
      expect(out!.phone).toBe('9876543210');
    }
    expect(coerceStructuredResume({ experience_years: 7 })!.experience_years).toBe(7);
  });

  it('DISCARDS an over-long phone rather than truncating it', () => {
    // Every other string here is sliced to a bound. A shortened phone number
    // is a DIFFERENT phone number — quite possibly someone else's — and this
    // is the field that decides who gets called.
    const tooLong = `+91${'9'.repeat(200)}`;
    expect(coerceStructuredResume({ phone: tooLong })!.phone).toBeNull();
    // Boundary: a normal number with punctuation is well inside the bound.
    expect(coerceStructuredResume({ phone: '+91 (98765) 43210' })!.phone).toBe('+91 (98765) 43210');
  });

  it('rejects an email that is not email-SHAPED', () => {
    // `phone` has a strict format gate, a provenance allowlist and a
    // re-assertion at the column write; `email` had none of that. A model
    // answering `"see resume"` wrote that string into `candidates.email` — a
    // field the deterministic extractor could only ever fill with something
    // email-shaped, because it finds it with a regex. This restores the floor.
    for (const bad of ['see resume', 'n/a', 'ada at example dot com', 'ada@example', '@example.com', 'ada@@x.com']) {
      expect(coerceStructuredResume({ email: bad })!.email).toBeNull();
    }
    for (const good of ['ada@example.invalid', 'first.last+tag@sub.example.co.in']) {
      expect(coerceStructuredResume({ email: good })!.email).toBe(good);
    }
    // A bad email nulls only its own field — it is not a malformed SHAPE.
    const out = coerceStructuredResume({ email: 'see resume', phone: '9876543210' })!;
    expect(out.email).toBeNull();
    expect(out.phone).toBe('9876543210');
  });

  it('bounds the display strings and the skills list', () => {
    const out = coerceStructuredResume({
      name: 'n'.repeat(500),
      summary: 's'.repeat(2000),
      skills: [...Array(100)].map((_, i) => `skill-${i}`),
    })!;
    expect(out.name!.length).toBe(200);
    expect(out.summary!.length).toBe(500);
    expect(out.skills.length).toBe(30);
  });

  it('drops non-string skill entries instead of failing the whole result', () => {
    // One bad element in an otherwise good list is noise, and skills decide
    // nothing dangerous — unlike `phone`.
    const out = coerceStructuredResume({ skills: ['TypeScript', 42, null, ' Postgres ', 'typescript'] })!;
    expect(out.skills).toEqual(['TypeScript', 'Postgres']);   // trimmed, deduped
  });

  it('never throws, for any hostile input', () => {
    // `structureResumeWithModel` swallows everything, but `coerceStructuredResume`
    // is exported and is the piece that decides dialing — it must be total.
    const throwingGetter = Object.defineProperty({}, 'phone', {
      get() { throw new Error('hostile'); }, enumerable: true, configurable: true,
    });
    const proxy = new Proxy({}, { get() { throw new Error('hostile'); }, has: () => true });
    for (const v of [throwingGetter, proxy, Object.create(null), new Date(), Symbol('x')]) {
      expect(() => coerceStructuredResume(v)).not.toThrow();
    }
    // A getter that throws rejects the whole result rather than half-filling it.
    expect(coerceStructuredResume(throwingGetter)).toBeNull();
  });

  it('reads OWN properties only, so an inherited phone cannot be dialed', () => {
    // A value decides whether a person gets phoned. An inherited `phone` — from
    // prototype pollution anywhere else in the process — must be
    // indistinguishable from absent, not from an answer.
    const polluted = Object.create({ phone: '9876543210', name: 'Inherited' });
    const out = coerceStructuredResume(polluted)!;
    expect(out.phone).toBeNull();
    expect(out.name).toBeNull();
    // An OWN value on the same object is still read normally.
    polluted.phone = '9876543210';
    expect(coerceStructuredResume(polluted)!.phone).toBe('9876543210');
  });

  it('normalizes empty and whitespace-only strings to null', () => {
    const out = coerceStructuredResume({ name: '   ', phone: '', summary: '\t\n' })!;
    expect(out.name).toBeNull();
    expect(out.phone).toBeNull();
    expect(out.summary).toBeNull();
  });
});

describe('the provenance tag names no vendor', () => {
  it('is provider-neutral, because the runner has already been swapped once', () => {
    // `lib/claude.ts` exports `runClaudeJSON`, but that export is a
    // compatibility alias repointed at the DeepSeek HTTP runner — its own
    // header says so. A tag reading `claude-…` would describe a model that
    // does not run, and this tag decides whether a number may be DIALED.
    expect(MODEL_STRUCTURER_VERSION).toBe('model-extraction-1');
    expect(MODEL_STRUCTURER_VERSION).not.toMatch(/claude|deepseek|gpt|anthropic|openai/i);
    expect(isDialableStructurer(MODEL_STRUCTURER_VERSION)).toBe(true);
  });

  it('introduces no provider configuration of its own', () => {
    const src = require('node:fs').readFileSync(
      require('node:path').join(process.cwd(), 'src/lib/resume-structurer.ts'),
      'utf8',
    ) as string;
    // Anti-vacuity: a `not.toContain` suite passes on an empty file, so first
    // prove we are reading the module we think we are.
    expect(src).toContain('export async function structureResumeWithModel');
    expect(src).toContain("from './claude.js'");
    // No key, no endpoint, no flag, no env read — it composes the shared
    // runner and nothing else.
    for (const forbidden of ['process.env', 'API_KEY', 'apiKey', 'fetch(', 'https://', 'env.']) {
      expect(src).not.toContain(forbidden);
    }
  });
});
