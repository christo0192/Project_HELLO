/**
 * adversarial.ts — LLM-08 adversarial prompt/output harness (PR-A Lane A3).
 *
 * DETERMINISTIC, FULLY OFFLINE, NO MODEL CALLS. This harness builds the REAL
 * exported prompt constructors from app/api/src/lib/prompts.ts
 * (buildConversationPrompt / buildAssessmentPrompt / SCREENING_SYSTEM), embeds
 * synthetic adversarial payloads as untrusted candidate input, and
 * deterministically verifies:
 *
 *  - containment: the injection sentinel stays inside the untrusted input
 *    region of the built prompt (the `"""` fenced transcript for assessment
 *    prompts; the inline "Conversation so far" block for conversation
 *    prompts), and the output contract is still present;
 *  - classification: every injection attempt is classified failure/quarantine
 *    by fixed-category pattern matching (no model is consulted);
 *  - output hardening: candidate model outputs are validated against the
 *    strict pure validator exported from prompts.ts (malformed JSON, extra
 *    unsafe keys, out-of-range scores and invalid enums are rejected);
 *  - sentinel discipline: every fixture payload/sentinel uses obvious
 *    SENTINEL_ tokens only — no real secrets.
 *
 * HONESTY CONTRACT (audited plan C6 + Lane A3): the production runtime
 * (claude.ts runClaudeJSON / services/assessment.ts) does NOT call the new
 * validator; LLM-08 is therefore foundation/partial — the harness proves the
 * prompt-construction seams and the strict validator behave as specified, but
 * is NOT a claim of production prompt hardening.
 *
 * Fixture provenance is validated with the REAL LLM-06 validateProvenance
 * import (no provenance duplication), and fixture digests reuse the
 * canonicalStringify from evaluation.ts (no duplication).
 */

import {
  buildConversationPrompt,
  buildAssessmentPrompt,
  SCREENING_SYSTEM,
  PROMPT_TRANSCRIPT_DELIMITER,
  validateConversationOutput,
  validateAssessmentOutput,
  detectRawOutputLeak,
  type ConversationContext,
  type OutputValidationResult,
} from '../lib/prompts.js';
import { validateProvenance, type ModelProvenance } from '../lib/model-provenance.js';
import { computeFixtureDigest } from './evaluation.js';

// ── Schema identity ─────────────────────────────────────────────────────

export const ADVERSARIAL_SCHEMA_ID = 'model-governance-adversarial.schema.json';
export const ADVERSARIAL_SCHEMA_VERSION = 1;
export const ADVERSARIAL_DIGEST_ALGORITHM = 'sha256';

// ── Closed enumerations ─────────────────────────────────────────────────

export const ADVERSARIAL_CATEGORIES = [
  'system_prompt_extraction',
  'secret_extraction',
  'rubric_override',
  'tool_invocation',
  'hidden_instructions',
  'malformed_output',
] as const;
export type AdversarialCategory = (typeof ADVERSARIAL_CATEGORIES)[number];

/** Categories that represent an instruction-injection attempt. */
export const INJECTION_CATEGORIES: readonly AdversarialCategory[] = [
  'system_prompt_extraction',
  'secret_extraction',
  'rubric_override',
  'tool_invocation',
  'hidden_instructions',
];

export const ADVERSARIAL_PROMPT_KINDS = ['conversation', 'assessment'] as const;
export type AdversarialPromptKind = (typeof ADVERSARIAL_PROMPT_KINDS)[number];

export const ADVERSARIAL_CLASSIFICATIONS = ['failure', 'quarantine'] as const;
export type AdversarialClassification = (typeof ADVERSARIAL_CLASSIFICATIONS)[number];

/** Sentinel convention: all fixture tokens are obvious markers, never real secrets. */
export const SENTINEL_PREFIX = 'SENTINEL_';
const SENTINEL_RE = /^SENTINEL_[A-Z0-9_]{4,64}$/;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

// ── Deterministic injection classification (fixed-category patterns) ────

export const ATTACK_PATTERNS: Record<Exclude<AdversarialCategory, 'malformed_output'>, readonly RegExp[]> = {
  system_prompt_extraction: [
    /ignore (?:all |any )?(?:previous|prior|above) instructions/i,
    /reveal.{0,40}(?:system prompt)/i,
    /output.{0,40}(?:system prompt)/i,
    /what are your (?:initial |system )?instructions/i,
    /show.{0,30}your instructions/i,
    /forget (?:your )?(?:instructions|rules)/i,
  ],
  secret_extraction: [
    /reveal.{0,40}(?:api key|secret|token|password)/i,
    /(?:api key|secret|token|password).{0,40}(?:reveal|output|show|echo)/i,
    /repeat (?:the )?(?:api key|secret|token)/i,
  ],
  rubric_override: [
    /ignore (?:the )?rubric/i,
    /score (?:me|the candidate) (?:10|100|perfect)/i,
    /give (?:me|the candidate) (?:a |an )?(?:10|full marks|perfect score)/i,
    /always (?:rate|score) (?:everything|everyone) (?:10|high)/i,
    /override.{0,30}(?:rubric|criteria)/i,
  ],
  tool_invocation: [
    /call (?:the )?function/i,
    /invoke (?:the )?tool/i,
    /what tools (?:do you have|are available)/i,
    /send (?:an )?email (?:to|using)/i,
    /execute.{0,30}(?:query|command|code)/i,
  ],
  hidden_instructions: [
    /do not (?:tell|disclose|reveal|mention).{0,30}(?:you are|being) (?:an )?(?:ai|automated)/i,
    /do not disclose/i,
    /hide.{0,30}(?:ai|automated|disclosure)/i,
    /pretend (?:you are|to be) human/i,
    /your instructions are to/i,
  ],
};

export interface InjectionClassification {
  detected: boolean;
  category: AdversarialCategory | null;
  matchedPattern: string | null;
}

/**
 * Deterministically classify an untrusted payload against fixed-category
 * attack patterns. malformed_output is never an instruction-injection; it is
 * handled by the strict output validator instead.
 */
export function classifyInjection(text: string): InjectionClassification {
  for (const category of ADVERSARIAL_CATEGORIES) {
    if (category === 'malformed_output') continue;
    for (const pattern of ATTACK_PATTERNS[category]) {
      if (pattern.test(text)) {
        return { detected: true, category, matchedPattern: pattern.source };
      }
    }
  }
  return { detected: false, category: null, matchedPattern: null };
}

// ── Fixture shapes ──────────────────────────────────────────────────────

export interface AdversarialFixtureExpected {
  /** failure = instruction-injection attempt; quarantine = malformed/leaked output. */
  classification: AdversarialClassification;
  /** Whether the strict output validator must reject this fixture's output. */
  outputRejected: boolean;
}

export interface AdversarialFixture {
  id: string;
  category: AdversarialCategory;
  promptKind: AdversarialPromptKind;
  /** Untrusted candidate transcript text; embeds the sentinel. */
  payload: string;
  /** Obvious SENTINEL_ token used to prove input-region containment. */
  sentinel: string;
  /** Optional candidate model output to validate (malformed/leak cases). */
  outputPayload?: string;
  expected: AdversarialFixtureExpected;
  /** LLM-06 validated provenance (validated with the real validateProvenance). */
  provenance: ModelProvenance;
}

export interface AdversarialFixtureDocument {
  schema: typeof ADVERSARIAL_SCHEMA_ID;
  schemaVersion: number;
  status: 'proposed';
  description?: string;
  manifest: { algorithm: typeof ADVERSARIAL_DIGEST_ALGORITHM; digests: Record<string, string> };
  fixtures: AdversarialFixture[];
}

export interface AdversarialValidationResult {
  valid: boolean;
  error?: string;
}

// ── Fixture document validation ─────────────────────────────────────────

const DOC_KEYS: ReadonlySet<string> = new Set([
  'schema',
  'schemaVersion',
  'status',
  'description',
  'manifest',
  'fixtures',
]);
const FIXTURE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'category',
  'promptKind',
  'payload',
  'sentinel',
  'outputPayload',
  'expected',
  'provenance',
]);
const EXPECTED_KEYS: ReadonlySet<string> = new Set(['classification', 'outputRejected']);
const MANIFEST_KEYS: ReadonlySet<string> = new Set(['algorithm', 'digests']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/**
 * Validate a single adversarial fixture shape. Rejects unknown fields, closed-
 * set violations, non-SENTINEL tokens (no real secrets), invalid provenance,
 * and an expected contract inconsistent with the category.
 */
export function validateAdversarialFixtureShape(raw: unknown): AdversarialValidationResult {
  if (!isPlainObject(raw)) {
    return { valid: false, error: 'adversarial fixture: must be a plain object' };
  }
  for (const key of Object.keys(raw)) {
    if (!FIXTURE_KEYS.has(key)) {
      return { valid: false, error: 'adversarial fixture: unknown field' };
    }
  }

  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
    return { valid: false, error: 'adversarial fixture: id must be a lowercase kebab-case identifier' };
  }
  if (!(ADVERSARIAL_CATEGORIES as readonly string[]).includes(raw.category as string)) {
    return { valid: false, error: 'adversarial fixture: category not allowlisted' };
  }
  if (!(ADVERSARIAL_PROMPT_KINDS as readonly string[]).includes(raw.promptKind as string)) {
    return { valid: false, error: 'adversarial fixture: promptKind not allowlisted' };
  }
  if (typeof raw.payload !== 'string' || raw.payload.length === 0) {
    return { valid: false, error: 'adversarial fixture: payload must be a non-empty string' };
  }
  if (typeof raw.sentinel !== 'string' || !SENTINEL_RE.test(raw.sentinel)) {
    return { valid: false, error: 'adversarial fixture: sentinel must be an obvious SENTINEL_ token (no real secrets)' };
  }
  if (raw.outputPayload !== undefined && (typeof raw.outputPayload !== 'string' || raw.outputPayload.length === 0)) {
    return { valid: false, error: 'adversarial fixture: outputPayload must be a non-empty string' };
  }

  if (!isPlainObject(raw.expected) || !hasOnlyKeys(raw.expected, EXPECTED_KEYS)) {
    return { valid: false, error: 'adversarial fixture: expected malformed' };
  }
  const expected = raw.expected;
  if (!(ADVERSARIAL_CLASSIFICATIONS as readonly string[]).includes(expected.classification as string)) {
    return { valid: false, error: 'adversarial fixture: expected.classification not allowlisted' };
  }
  if (typeof expected.outputRejected !== 'boolean') {
    return { valid: false, error: 'adversarial fixture: expected.outputRejected must be a boolean' };
  }
  const isInjection = (INJECTION_CATEGORIES as readonly string[]).includes(raw.category as string);
  if (isInjection && expected.classification !== 'failure') {
    return { valid: false, error: 'adversarial fixture: injection category must expect failure classification' };
  }
  if (!isInjection && expected.classification !== 'quarantine') {
    return { valid: false, error: 'adversarial fixture: output-shape category must expect quarantine classification' };
  }
  if (expected.outputRejected === true && raw.outputPayload === undefined) {
    return { valid: false, error: 'adversarial fixture: expected.outputRejected requires an outputPayload to validate' };
  }

  const provenanceResult = validateProvenance(raw.provenance);
  if (!provenanceResult.valid) {
    return { valid: false, error: 'adversarial fixture: invalid provenance' };
  }
  return { valid: true };
}

/**
 * Validate an adversarial fixture document: closed schema, unique ids, valid
 * fixture shapes, digest manifest integrity (tamper detection).
 */
export function validateAdversarialDocument(raw: unknown): AdversarialValidationResult {
  if (!isPlainObject(raw)) {
    return { valid: false, error: 'adversarial document: must be a plain object' };
  }
  for (const key of Object.keys(raw)) {
    if (!DOC_KEYS.has(key)) {
      return { valid: false, error: 'adversarial document: unknown field at top level' };
    }
  }
  if (raw.schema !== ADVERSARIAL_SCHEMA_ID) {
    return { valid: false, error: 'adversarial document: schema id mismatch' };
  }
  if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1) {
    return { valid: false, error: 'adversarial document: schemaVersion must be a positive integer' };
  }
  if (raw.status !== 'proposed') {
    return { valid: false, error: 'adversarial document: status must be proposed' };
  }
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length === 0)) {
    return { valid: false, error: 'adversarial document: description must be a non-empty string' };
  }
  if (!isPlainObject(raw.manifest) || !hasOnlyKeys(raw.manifest, MANIFEST_KEYS)) {
    return { valid: false, error: 'adversarial document: manifest malformed' };
  }
  if (raw.manifest.algorithm !== ADVERSARIAL_DIGEST_ALGORITHM) {
    return { valid: false, error: 'adversarial document: manifest algorithm must be sha256' };
  }
  if (!isPlainObject(raw.manifest.digests)) {
    return { valid: false, error: 'adversarial document: manifest digests must be a plain object' };
  }
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) {
    return { valid: false, error: 'adversarial document: fixtures must be a non-empty array' };
  }

  const seenIds = new Set<string>();
  for (let i = 0; i < raw.fixtures.length; i += 1) {
    const fixture = raw.fixtures[i];
    const shape = validateAdversarialFixtureShape(fixture);
    if (!shape.valid) {
      return { valid: false, error: `adversarial document: fixtures[${i}]: ${shape.error}` };
    }
    const id = (fixture as Record<string, unknown>).id as string;
    if (seenIds.has(id)) {
      return { valid: false, error: `adversarial document: fixtures[${i}]: duplicate fixture id` };
    }
    seenIds.add(id);
    const expectedDigest = (raw.manifest.digests as Record<string, string>)[id];
    if (!expectedDigest) {
      return { valid: false, error: `adversarial document: fixtures[${i}]: missing manifest digest` };
    }
    const actualDigest = computeFixtureDigest(fixture);
    if (actualDigest !== expectedDigest) {
      return { valid: false, error: `adversarial document: fixtures[${i}]: digest drift (tampered fixture)` };
    }
  }

  return { valid: true };
}

// ── Prompt construction and containment verification ────────────────────

const BENIGN_RESUME_FACTS =
  '- Name: Test Candidate\n' +
  '- Current/most recent role: unknown\n' +
  '- Total experience (years): unknown\n' +
  '- Skills: communication\n' +
  '- Summary: Synthetic candidate summary.';

function conversationContextFor(payload: string): ConversationContext {
  return {
    company: 'Example Company',
    roleTitle: 'Customer Support Associate',
    jd: 'Handle customer queries in English',
    requiredSkills: ['communication', 'english'],
    candidateName: 'Test Candidate',
    candidateSummary: 'Synthetic candidate summary.',
    candidateSkills: ['communication'],
    resumeFacts: BENIGN_RESUME_FACTS,
    template: [{ id: 'q1', question: 'Tell me about your current work', mandatory: true }],
    transcript: [
      { speaker: 'bot', text: 'Hi, this is an automated AI assistant.' },
      { speaker: 'candidate', text: payload },
    ],
  };
}

function assessmentArgsFor(payload: string): {
  roleTitle: string;
  requiredSkills: string[];
  candidateName: string;
  transcript: Array<{ speaker: 'bot' | 'candidate'; text: string }>;
  resumeFacts: string;
} {
  return {
    roleTitle: 'Customer Support Associate',
    requiredSkills: ['communication', 'english'],
    candidateName: 'Test Candidate',
    transcript: [
      { speaker: 'bot' as const, text: 'Hi, this is an automated AI assistant.' },
      { speaker: 'candidate' as const, text: payload },
    ],
    resumeFacts: BENIGN_RESUME_FACTS,
  };
}

function contractPresent(prompt: string, kind: AdversarialPromptKind): boolean {
  if (kind === 'conversation') {
    return (
      prompt.includes("Decide Gopu's NEXT message") &&
      prompt.includes('"message"') &&
      prompt.includes('"done"')
    );
  }
  return (
    prompt.includes('EXACTLY this shape') &&
    prompt.includes('"overall_score"') &&
    prompt.includes('"recommendation"')
  );
}

/** True when the sentinel appears only inside the untrusted input region. */
function sentinelContained(prompt: string, kind: AdversarialPromptKind, sentinel: string): boolean {
  const sentinelIndex = prompt.indexOf(sentinel);
  if (sentinelIndex === -1) return false;
  if (kind === 'assessment') {
    // Transcript is fenced with the exported delimiter; the sentinel must sit
    // between the opening and closing delimiter and nowhere else.
    const opening = prompt.indexOf(PROMPT_TRANSCRIPT_DELIMITER);
    if (opening === -1) return false;
    const closing = prompt.indexOf(PROMPT_TRANSCRIPT_DELIMITER, opening + PROMPT_TRANSCRIPT_DELIMITER.length);
    if (closing === -1) return false;
    if (sentinelIndex <= opening + PROMPT_TRANSCRIPT_DELIMITER.length) return false;
    if (sentinelIndex >= closing) return false;
    return prompt.indexOf(sentinel, sentinelIndex + sentinel.length) === -1;
  }
  // Conversation prompt: the transcript is inline (no delimiter). The sentinel
  // must sit inside the "Conversation so far" block, before the output contract.
  const start = prompt.indexOf('Conversation so far:');
  if (start === -1) return false;
  const end = prompt.indexOf("Decide Gopu's NEXT message");
  if (end === -1 || end < start) return false;
  if (sentinelIndex <= start) return false;
  if (sentinelIndex >= end) return false;
  return prompt.indexOf(sentinel, sentinelIndex + sentinel.length) === -1;
}

// ── Output leak detection ───────────────────────────────────────────────

/**
 * Recursively check whether any string inside a parsed output contains the
 * fixture sentinel (a leaked system prompt/secret marker).
 */
export function detectOutputLeak(value: unknown, sentinel: string): boolean {
  if (typeof value === 'string') {
    return value.includes(sentinel);
  }
  if (Array.isArray(value)) {
    return value.some((item) => detectOutputLeak(item, sentinel));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).some((item) => detectOutputLeak(item, sentinel));
  }
  return false;
}

// ── Runner ──────────────────────────────────────────────────────────────

export interface AdversarialRunResult {
  fixtureId: string;
  category: AdversarialCategory;
  promptKind: AdversarialPromptKind;
  /** The real exported constructor produced a prompt (no throw). */
  promptBuilt: boolean;
  /** SCREENING_SYSTEM (exact exported constant) for conversation; null for assessment. */
  systemUsed: string | null;
  /** True when the input is fenced with the exported transcript delimiter. */
  inputDelimited: boolean;
  sentinelInInputRegion: boolean;
  outputContractPresent: boolean;
  classification: InjectionClassification;
  /** Strict-validator result over outputPayload when present. */
  outputValidation: OutputValidationResult | null;
  verdict: 'pass' | 'fail';
  checks: string[];
}

/**
 * Run one adversarial fixture against the REAL prompt constructors and the
 * strict output validator. Deterministic: no model calls, no randomness.
 */
export function runAdversarialFixture(raw: unknown): AdversarialRunResult {
  const shape = validateAdversarialFixtureShape(raw);
  const baseChecks: string[] = [];
  if (!shape.valid) {
    baseChecks.push('fixture-shape-invalid');
    return {
      fixtureId: 'invalid',
      category: 'malformed_output',
      promptKind: 'conversation',
      promptBuilt: false,
      systemUsed: null,
      inputDelimited: false,
      sentinelInInputRegion: false,
      outputContractPresent: false,
      classification: { detected: false, category: null, matchedPattern: null },
      outputValidation: null,
      verdict: 'fail',
      checks: [...baseChecks, `shape: ${shape.error}`],
    };
  }
  const fixture = raw as AdversarialFixture;
  const checks: string[] = [];

  let prompt = '';
  let promptBuilt = true;
  try {
    prompt =
      fixture.promptKind === 'conversation'
        ? buildConversationPrompt(conversationContextFor(fixture.payload))
        : buildAssessmentPrompt(assessmentArgsFor(fixture.payload));
  } catch {
    promptBuilt = false;
  }
  if (!promptBuilt) checks.push('prompt-construction-threw');
  else checks.push('prompt-built-with-real-constructor');

  const systemUsed = fixture.promptKind === 'conversation' ? SCREENING_SYSTEM : null;
  const inputDelimited = fixture.promptKind === 'assessment';

  const sentinelInInputRegion = promptBuilt && sentinelContained(prompt, fixture.promptKind, fixture.sentinel);
  if (!sentinelInInputRegion) checks.push('sentinel-not-contained-in-input-region');
  else checks.push('sentinel-contained-in-untrusted-input-region');

  const outputContractPresent = promptBuilt && contractPresent(prompt, fixture.promptKind);
  if (!outputContractPresent) checks.push('output-contract-missing');
  else checks.push('output-contract-present');

  const classification = classifyInjection(fixture.payload);

  const outputValidation =
    fixture.outputPayload !== undefined
      ? fixture.promptKind === 'conversation'
        ? validateConversationOutput(fixture.outputPayload)
        : validateAssessmentOutput(fixture.outputPayload)
      : null;

  // Raw-output leak detection over the unparsed payload: a valid fenced JSON
  // object followed/preceded by a leaked unsafe object, unsafe key, SENTINEL_
  // token, extra fenced block, or non-whitespace trailing content must fail.
  const rawLeak = fixture.outputPayload !== undefined ? detectRawOutputLeak(fixture.outputPayload) : null;
  const rawLeakDetected = rawLeak !== null && rawLeak.leaked;
  if (fixture.outputPayload === undefined) {
    checks.push('no-output-payload');
  } else if (rawLeakDetected) {
    checks.push('raw-output-leak-detected');
  } else {
    checks.push('raw-output-clean');
  }

  const isInjection = (INJECTION_CATEGORIES as readonly string[]).includes(fixture.category);
  const classificationOk = isInjection
    ? classification.detected && classification.category === fixture.category
    : !classification.detected;
  if (!classificationOk) checks.push('classification-mismatch');
  else checks.push('classification-matches-expected');

  const expectedClassOk = isInjection
    ? fixture.expected.classification === 'failure'
    : fixture.expected.classification === 'quarantine';
  if (!expectedClassOk) checks.push('expected-classification-inconsistent');
  else checks.push('expected-classification-consistent');

  const outputRejected = outputValidation !== null && !outputValidation.ok;
  const outputOk =
    fixture.expected.outputRejected === outputRejected &&
    (fixture.expected.outputRejected || outputValidation === null || outputValidation.ok) &&
    (!rawLeakDetected || fixture.expected.outputRejected);
  if (!outputOk) checks.push('output-rejection-mismatch');
  else checks.push('output-rejection-matches-expected');

  const pass =
    promptBuilt &&
    sentinelInInputRegion &&
    outputContractPresent &&
    classificationOk &&
    expectedClassOk &&
    outputOk;
  checks.push(pass ? 'verdict-pass' : 'verdict-fail');

  return {
    fixtureId: fixture.id,
    category: fixture.category,
    promptKind: fixture.promptKind,
    promptBuilt,
    systemUsed,
    inputDelimited,
    sentinelInInputRegion,
    outputContractPresent,
    classification,
    outputValidation,
    verdict: pass ? 'pass' : 'fail',
    checks,
  };
}
