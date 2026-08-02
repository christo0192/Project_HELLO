/**
 * provider-boundaries.ts — LLM-01 provider boundary inventory (PR-A Lane A1).
 *
 * PURE METADATA ONLY. This module catalogs every current provider boundary
 * path in the TypeScript (API) runtime and validates the inventory shape. It
 * performs NO network access, NO provider client construction, NO CLI spawn,
 * and NO instantiation of any provider SDK.
 *
 * No universal provider abstraction exists in this repository: each workload
 * reaches its provider through a workload-specific, concrete contract (CLI
 * spawn in claude.ts, prompt construction in prompts.ts, scoring in
 * assessment.ts, provenance in model-provenance.ts). This inventory records
 * those contracts as they are today; it does not introduce adapters.
 *
 * Policy states are repository-only: every entry is PROPOSED, PENDING, or
 * NOT_EVALUATED. A positive approval claim (APPROVED/DEPLOYED/ACCEPTED/winner)
 * is rejected UNCONDITIONALLY — no EV-xxxx/UUID/identifier reference can
 * authorize it, because repository-only Phase 10 work carries no authentic
 * external evidence.
 *
 * Env var names are recorded as names only. No values, endpoints, tokens,
 * keys, or credentials appear in this module.
 */

// ── Schema version ──────────────────────────────────────────────────────

export const MODEL_GOVERNANCE_SCHEMA_VERSION = 1;

// ── Closed enumerations ─────────────────────────────────────────────────

/** Repository-only policy states. Approval tokens are NOT in this set. */
export const ALLOWED_POLICY_STATUSES = ['PROPOSED', 'PENDING', 'NOT_EVALUATED'] as const;
export type PolicyStatus = (typeof ALLOWED_POLICY_STATUSES)[number];

/** Current third-party/orchestrator providers present at some boundary. */
export const ALLOWED_PROVIDERS = ['anthropic', 'sarvam', 'silero', 'livekit', 'supabase'] as const;
export type ProviderName = (typeof ALLOWED_PROVIDERS)[number];

/** Workloads served by the screening product. */
export const ALLOWED_WORKLOADS = ['screening', 'scoring', 'resume_extraction'] as const;
export type Workload = (typeof ALLOWED_WORKLOADS)[number];

/** Runtime owning the boundary. */
export const ALLOWED_RUNTIMES = ['api', 'voice-livekit'] as const;
export type Runtime = (typeof ALLOWED_RUNTIMES)[number];

/** Concrete boundary kind — the mechanism by which the provider is reached. */
export const ALLOWED_BOUNDARY_KINDS = [
  'cli_spawn', // child-process CLI launch (e.g. `claude -p`)
  'sdk_constructor', // provider SDK / LiveKit plugin constructor
  'prompt_construction', // deterministic prompt/context assembly
  'scoring', // post-session scoring path
  'provenance', // non-secret provenance tracking
  'persistence', // durable state / first-party API calls
] as const;
export type BoundaryKind = (typeof ALLOWED_BOUNDARY_KINDS)[number];

// ── Approval claim detection ────────────────────────────────────────────

/** A positive approval/outcome claim token (rejected without evidence). */
const APPROVAL_CLAIM_RE = /\b(?:approved|deployed|accepted|winner)\b/i;

// ── Closed identifier grammars ──────────────────────────────────────────

/** Entry id: lowercase kebab-case. */
const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** Env var name: uppercase identifier, name only. */
const ENV_VAR_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

/** Allowlist value: lowercase closed identifier. */
const ALLOWLIST_VALUE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Evidence reference: compact identifier (UUID or slug). Not a URL. */
const EVIDENCE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Repository-relative source path. No URLs, no absolute paths, no traversal. */
const CONSTRUCTOR_PATH_RE = /^(?:app|scripts|config|docs)\/[A-Za-z0-9._/-]+$/;

// ── Defense-in-depth string guards (mirror model-provenance.ts) ─────────

const URL_OR_PATH_RE =
  /(?:https?:\/\/|ftp:\/\/|file:\/\/|wss?:\/\/|[\s(]\/[\w./-]|^\/[\w./-]|\.\.(?:[/\\]|$)|\\(?:\\[\w.-]+)+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})/i;

const TOKEN_LIKE_RE =
  /\b(?:sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/i;

const MAX_NOTES_LENGTH = 1000;
const MAX_PATH_LENGTH = 200;

function hasUrlOrPath(value: string): boolean {
  return URL_OR_PATH_RE.test(value);
}

function hasCredential(value: string): boolean {
  return TOKEN_LIKE_RE.test(value);
}

// ── Entry shape ─────────────────────────────────────────────────────────

export interface ProviderBoundaryEntry {
  /** Stable inventory id (kebab-case). */
  id: string;
  /** Workloads served at this boundary (non-empty). */
  workloads: Workload[];
  /** Provider at this boundary. */
  provider: ProviderName;
  /** Runtime owning the boundary. */
  runtime: Runtime;
  /** Concrete boundary mechanism. */
  boundaryKind: BoundaryKind;
  /** Repository-relative source path that owns the boundary (not a URL). */
  constructorPath: string;
  /** Environment variable NAMES consumed at this boundary (names only). */
  envVars: string[];
  /** Closed allowlists enforced at this boundary (e.g. ['anthropic']). */
  allowlists: string[];
  /** Repository-only policy state. Never a positive approval claim. */
  policyStatus: PolicyStatus;
  /** Informational evidence-reference slot only; NEVER authorizes a positive policyStatus (repository-only work has no authentic external evidence). */
  optionalEvidenceRefs?: string[];
  /** Optional notes. Must not contain URL-lookalike or token-lookalike text. */
  notes?: string;
}

export interface ProviderBoundariesValidationResult {
  valid: boolean;
  /** Fixed-category diagnostics; never echo a rejected value verbatim. */
  error?: string;
  /** Cleaned entries (only set when valid). */
  data?: ProviderBoundaryEntry[];
}

// ── Helpers ─────────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

const ENTRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'workloads',
  'provider',
  'runtime',
  'boundaryKind',
  'constructorPath',
  'envVars',
  'allowlists',
  'policyStatus',
  'optionalEvidenceRefs',
  'notes',
]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidClosedId(value: unknown, label: string, errors: string[]): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${label}: must be a non-empty string`);
    return false;
  }
  if (hasUrlOrPath(value)) {
    errors.push(`${label}: must not contain URLs or paths`);
    return false;
  }
  if (hasCredential(value)) {
    errors.push(`${label}: must not contain credentials`);
    return false;
  }
  return true;
}

function validateEntry(raw: unknown, index: number, errors: string[]): void {
  const label = `entries[${index}]`;
  if (!isPlainObject(raw)) {
    errors.push(`${label}: must be a plain object`);
    return;
  }

  for (const key of Object.keys(raw)) {
    if (!ENTRY_ALLOWED_KEYS.has(key)) {
      errors.push(`${label}: unknown field at top level`);
    }
  }

  const record = raw as Record<string, unknown>;

  // ── id ────────────────────────────────────────────────────────────────
  if (typeof record.id !== 'string' || !ID_RE.test(record.id)) {
    errors.push(`${label}.id: must be a lowercase kebab-case identifier`);
  }

  // ── workloads (non-empty, allowlisted) ────────────────────────────────
  if (!isStringArray(record.workloads) || record.workloads.length === 0) {
    errors.push(`${label}.workloads: must be a non-empty string array`);
  } else {
    for (const workload of record.workloads) {
      if (!(ALLOWED_WORKLOADS as readonly string[]).includes(workload)) {
        errors.push(`${label}.workloads: not allowlisted`);
      }
    }
  }

  // ── provider ──────────────────────────────────────────────────────────
  if (typeof record.provider !== 'string') {
    errors.push(`${label}.provider: must be a string`);
  } else if (!(ALLOWED_PROVIDERS as readonly string[]).includes(record.provider)) {
    errors.push(`${label}.provider: not allowlisted`);
  }

  // ── runtime ───────────────────────────────────────────────────────────
  if (typeof record.runtime !== 'string') {
    errors.push(`${label}.runtime: must be a string`);
  } else if (!(ALLOWED_RUNTIMES as readonly string[]).includes(record.runtime)) {
    errors.push(`${label}.runtime: not allowlisted`);
  }

  // ── boundaryKind ──────────────────────────────────────────────────────
  if (typeof record.boundaryKind !== 'string') {
    errors.push(`${label}.boundaryKind: must be a string`);
  } else if (!(ALLOWED_BOUNDARY_KINDS as readonly string[]).includes(record.boundaryKind)) {
    errors.push(`${label}.boundaryKind: not allowlisted`);
  }

  // ── constructorPath (safe repository-relative path) ───────────────────
  if (typeof record.constructorPath !== 'string' || record.constructorPath.length > MAX_PATH_LENGTH) {
    errors.push(`${label}.constructorPath: must be a short repository-relative path`);
  } else if (!CONSTRUCTOR_PATH_RE.test(record.constructorPath)) {
    errors.push(`${label}.constructorPath: must be a repository-relative path (no URL, absolute, or traversal)`);
  } else if (hasUrlOrPath(record.constructorPath) || hasCredential(record.constructorPath)) {
    errors.push(`${label}.constructorPath: must not contain URLs, paths, or credentials`);
  }

  // ── envVars (names only) ──────────────────────────────────────────────
  if (!isStringArray(record.envVars)) {
    errors.push(`${label}.envVars: must be a string array`);
  } else {
    for (const envVar of record.envVars) {
      if (!ENV_VAR_RE.test(envVar)) {
        errors.push(`${label}.envVars: must be uppercase env var names`);
      }
    }
  }

  // ── allowlists (closed identifiers) ───────────────────────────────────
  if (record.allowlists !== undefined && !isStringArray(record.allowlists)) {
    errors.push(`${label}.allowlists: must be a string array`);
  } else {
    for (const allowlistValue of (record.allowlists as string[] | undefined) ?? []) {
      if (!ALLOWLIST_VALUE_RE.test(allowlistValue)) {
        errors.push(`${label}.allowlists: must be closed lowercase identifiers`);
      }
    }
  }

  // ── policyStatus (positive approval claims are unconditionally rejected) ──
  const policyStatus = record.policyStatus;
  if (typeof policyStatus !== 'string' || policyStatus.length === 0) {
    errors.push(`${label}.policyStatus: must be a non-empty string`);
  } else if (APPROVAL_CLAIM_RE.test(policyStatus)) {
    // Repository-only work carries no authentic external evidence: an
    // APPROVED/DEPLOYED/ACCEPTED/winner value is rejected regardless of any
    // optionalEvidenceRefs entry (EV-xxxx / UUID / arbitrary string).
    errors.push(`${label}.policyStatus: positive approval claim is not permitted in repository-only work (no external evidence escape)`);
  } else if (!(ALLOWED_POLICY_STATUSES as readonly string[]).includes(policyStatus)) {
    errors.push(`${label}.policyStatus: not allowlisted`);
  }

  // ── optionalEvidenceRefs (closed compact identifiers only) ────────────
  if (record.optionalEvidenceRefs !== undefined) {
    if (!isStringArray(record.optionalEvidenceRefs)) {
      errors.push(`${label}.optionalEvidenceRefs: must be a string array`);
    } else {
      for (const ref of record.optionalEvidenceRefs) {
        if (!EVIDENCE_REF_RE.test(ref)) {
          errors.push(`${label}.optionalEvidenceRefs: must be compact evidence identifiers (not URLs)`);
        }
        if (hasUrlOrPath(ref) || hasCredential(ref)) {
          errors.push(`${label}.optionalEvidenceRefs: must not contain URLs, paths, or credentials`);
        }
      }
    }
  }

  // ── notes (optional prose; no URL/token-lookalike values) ─────────────
  if (record.notes !== undefined) {
    if (typeof record.notes !== 'string' || record.notes.length === 0) {
      errors.push(`${label}.notes: must be a non-empty string when present`);
    } else if (record.notes.length > MAX_NOTES_LENGTH) {
      errors.push(`${label}.notes: exceeds maximum length`);
    } else if (hasUrlOrPath(record.notes) || hasCredential(record.notes)) {
      errors.push(`${label}.notes: must not contain URLs, paths, or credentials`);
    }
  }
}

// ── Public validation ───────────────────────────────────────────────────

/**
 * Validate a provider-boundary inventory.
 *
 * Rejects non-array inputs, unknown fields, closed-set violations, unsafe
 * paths, URL-lookalike values, token-lookalike values, and ANY positive
 * approval claim (APPROVED/DEPLOYED/ACCEPTED/winner) — unconditionally, with
 * no external-evidence escape. Diagnostics use fixed category labels and never
 * echo the rejected value.
 */
export function validateProviderBoundaries(raw: unknown): ProviderBoundariesValidationResult {
  if (!Array.isArray(raw)) {
    return { valid: false, error: 'provider boundaries: must be a non-empty array' };
  }
  if (raw.length === 0) {
    return { valid: false, error: 'provider boundaries: must not be empty' };
  }

  const errors: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    validateEntry(raw[i], i, errors);
  }

  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  return { valid: true, data: raw as ProviderBoundaryEntry[] };
}

// ── Current inventory (repository-only; as of baseline b3f1f301) ────────
//
// Each entry records a concrete boundary that EXISTS in this repository
// today. No entry is a proposal for a new abstraction; none implies a
// provider switch; none carries an endpoint, token, or credential.

export const PROVIDER_BOUNDARIES: readonly ProviderBoundaryEntry[] = [
  // ── TypeScript / API runtime ─────────────────────────────────────────
  {
    id: 'api-claude-cli-spawn',
    workloads: ['screening', 'scoring', 'resume_extraction'],
    provider: 'anthropic',
    runtime: 'api',
    boundaryKind: 'cli_spawn',
    constructorPath: 'app/api/src/lib/claude.ts',
    envVars: [
      'CLAUDE_BIN',
      'CLAUDE_MODEL',
      'CLAUDE_TIMEOUT_MS',
      'CLAUDE_MAX_OUTPUT_BYTES',
      'BREAKER_FAILURE_THRESHOLD',
      'BREAKER_COOLDOWN_MS',
      'BREAKER_TIMEOUT_MS',
    ],
    allowlists: [],
    policyStatus: 'PROPOSED',
    notes:
      'Spawns the claude CLI directly (shell:false, max-turns 1) with a circuit breaker and bounded output. ' +
      'Serves screening conversation (routes/screening.ts), scoring (services/assessment.ts), and resume ' +
      'extraction (routes/resumes.ts). No interface wraps the CLI; this concrete contract is the boundary.',
  },
  {
    id: 'api-prompt-construction',
    workloads: ['screening', 'scoring', 'resume_extraction'],
    provider: 'anthropic',
    runtime: 'api',
    boundaryKind: 'prompt_construction',
    constructorPath: 'app/api/src/lib/prompts.ts',
    envVars: [],
    allowlists: [],
    policyStatus: 'PROPOSED',
    notes:
      'SCREENING_SYSTEM, buildConversationPrompt, buildAssessmentPrompt, buildExtractionPrompt, and ' +
      'buildOpeningMessage. Version constants SCREENING_PROMPT_TEMPLATE_VERSION / SCORING_PROMPT_TEMPLATE_VERSION ' +
      'are consumed by model-provenance.ts. Pure text construction; no env reads and no network.',
  },
  {
    id: 'api-scoring-assessment',
    workloads: ['scoring'],
    provider: 'anthropic',
    runtime: 'api',
    boundaryKind: 'scoring',
    constructorPath: 'app/api/src/services/assessment.ts',
    envVars: ['CLAUDE_SCORING_MODEL'],
    allowlists: [],
    policyStatus: 'PROPOSED',
    notes:
      'Runs buildAssessmentPrompt through runClaudeJSONWithProvenance with the scoring model, recomputes ' +
      'overall/recommendation in code from fixed weights, and persists the assessment with scoringProvenance.',
  },
  {
    id: 'api-provenance',
    workloads: ['screening', 'scoring'],
    provider: 'anthropic',
    runtime: 'api',
    boundaryKind: 'provenance',
    constructorPath: 'app/api/src/lib/model-provenance.ts',
    envVars: [],
    allowlists: ['anthropic', 'screening', 'scoring'],
    policyStatus: 'PROPOSED',
    notes:
      'Closed-grammar validateProvenance with allowlisted provider and workloads. requestedModel records ' +
      'design intent only; it is never a provider-resolved value.',
  },

  // ── Python / voice-livekit runtime ───────────────────────────────────
  {
    id: 'livekit-worker-connect',
    workloads: ['screening'],
    provider: 'livekit',
    runtime: 'voice-livekit',
    boundaryKind: 'sdk_constructor',
    constructorPath: 'app/voice-livekit/agent.py',
    envVars: ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'],
    allowlists: [],
    policyStatus: 'PENDING',
    notes:
      'Worker bootstrap via cli.run_app (python agent.py start). Room connection behavior is OWNER_VERIFY; ' +
      'see docs/runbooks/hosting-livekit-cloud.md. Env names only; no values recorded here.',
  },
  {
    id: 'livekit-stt-sarvam',
    workloads: ['screening'],
    provider: 'sarvam',
    runtime: 'voice-livekit',
    boundaryKind: 'sdk_constructor',
    constructorPath: 'app/voice-livekit/agent.py',
    envVars: ['SARVAM_STT_MODEL', 'SARVAM_LANGUAGE'],
    allowlists: [],
    policyStatus: 'PENDING',
    notes:
      'livekit.plugins.sarvam.STT constructed inside AgentSession. Network calls are SDK-internal with no ' +
      'constructor timeout/breaker control (see docs/runbooks/provider-resilience.md).',
  },
  {
    id: 'livekit-tts-sarvam',
    workloads: ['screening'],
    provider: 'sarvam',
    runtime: 'voice-livekit',
    boundaryKind: 'sdk_constructor',
    constructorPath: 'app/voice-livekit/agent.py',
    envVars: ['SARVAM_TTS_MODEL', 'SARVAM_TTS_VOICE'],
    allowlists: [],
    policyStatus: 'PENDING',
    notes:
      'livekit.plugins.sarvam.TTS constructed inside AgentSession. Network calls are SDK-internal with no ' +
      'constructor timeout/breaker control (see docs/runbooks/provider-resilience.md).',
  },
  {
    id: 'livekit-llm-anthropic',
    workloads: ['screening'],
    provider: 'anthropic',
    runtime: 'voice-livekit',
    boundaryKind: 'sdk_constructor',
    constructorPath: 'app/voice-livekit/agent.py',
    envVars: ['ANTHROPIC_MODEL'],
    allowlists: ['anthropic'],
    policyStatus: 'PENDING',
    notes:
      'livekit.plugins.anthropic.LLM(model=ANTHROPIC_MODEL). Provenance is claimed via set_session_provenance ' +
      'before any provider construction; the same configured model feeds screening_provenance.',
  },
  {
    id: 'livekit-vad-silero',
    workloads: ['screening'],
    provider: 'silero',
    runtime: 'voice-livekit',
    boundaryKind: 'sdk_constructor',
    constructorPath: 'app/voice-livekit/agent.py',
    envVars: [
      'LIVEKIT_VAD_ACTIVATION_THRESHOLD',
      'LIVEKIT_VAD_MIN_SPEECH_DURATION',
      'LIVEKIT_VAD_MIN_SILENCE_DURATION',
      'LIVEKIT_VAD_PREFIX_PADDING_DURATION',
    ],
    allowlists: [],
    policyStatus: 'PENDING',
    notes: 'silero.VAD.load with bounded tuning values. Local ONNX model; not a network provider.',
  },
  {
    id: 'livekit-turn-detector',
    workloads: ['screening'],
    provider: 'livekit',
    runtime: 'voice-livekit',
    boundaryKind: 'sdk_constructor',
    constructorPath: 'app/voice-livekit/agent.py',
    envVars: [],
    allowlists: [],
    policyStatus: 'PENDING',
    notes: 'livekit.plugins.turn_detector.multilingual.MultilingualModel. Local model; not a network provider.',
  },
  {
    id: 'livekit-prompt-construction',
    workloads: ['screening'],
    provider: 'anthropic',
    runtime: 'voice-livekit',
    boundaryKind: 'prompt_construction',
    constructorPath: 'app/voice-livekit/prompting.py',
    envVars: ['COMPANY_NAME'],
    allowlists: [],
    policyStatus: 'PROPOSED',
    notes:
      'system_prompt, opening_line, build_prompt_context, collect_prompt_metadata. Context is env-only or ' +
      'server-verified (SEC-13); client-visible room metadata is never used.',
  },
  {
    id: 'livekit-provenance',
    workloads: ['screening'],
    provider: 'anthropic',
    runtime: 'voice-livekit',
    boundaryKind: 'provenance',
    constructorPath: 'app/voice-livekit/provenance.py',
    envVars: [],
    allowlists: ['anthropic', 'screening', 'scoring'],
    policyStatus: 'PROPOSED',
    notes:
      'screening_provenance mirrors model-provenance.ts shape without cross-imports. Documented version ' +
      'constant parity with prompts.ts is enforced by a CI parity test.',
  },
  {
    id: 'livekit-persistence-supabase',
    workloads: ['screening'],
    provider: 'supabase',
    runtime: 'voice-livekit',
    boundaryKind: 'persistence',
    constructorPath: 'app/voice-livekit/persistence.py',
    envVars: [
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_SCHEMA',
      'WORKER_CONTEXT_SECRET',
      'WORKER_CONTEXT_TIMEOUT_SEC',
      'API_BASE',
      'SCORING_BREAKER_THRESHOLD',
      'SCORING_BREAKER_COOLDOWN_SEC',
      'SCORING_BREAKER_TIMEOUT_SEC',
      'SCORING_HTTP_CONNECT_TIMEOUT',
      'SCORING_HTTP_READ_TIMEOUT',
      'SCORING_HTTP_WRITE_TIMEOUT',
      'SCORING_HTTP_POOL_TIMEOUT',
      'LIVEKIT_WORKER_DRAIN_SEC',
    ],
    allowlists: [],
    policyStatus: 'PENDING',
    notes:
      'Supabase client for session lifecycle plus first-party scoring-trigger and worker-context HTTP calls ' +
      'against the API (API_BASE). The scoring trigger is our own API, not a third-party provider. Breaker ' +
      'wrapping via provider_resilience.py.',
  },
];

// ── Inventory verification ──────────────────────────────────────────────

/**
 * Validate the shipped inventory once at import time (fail fast on drift).
 * A corrupted inventory must never be silently usable.
 */
const INVENTORY_CHECK = validateProviderBoundaries(PROVIDER_BOUNDARIES);
if (!INVENTORY_CHECK.valid) {
  throw new Error(`Provider boundary inventory failed validation: ${INVENTORY_CHECK.error}`);
}
