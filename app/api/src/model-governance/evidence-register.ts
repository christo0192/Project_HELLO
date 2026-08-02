/**
 * evidence-register.ts — LLM-05 provider evidence register (PR-A Lane A2).
 *
 * PURE METADATA ONLY. Catalogs repository-only evidence status slots for
 * every current provider (anthropic, sarvam, silero, livekit, supabase) and
 * the optional-comparison providers (gemini, deepseek). Performs NO network
 * access, NO provider client construction, NO endpoint resolution, and reads
 * NO environment variables.
 *
 * HONESTY CONTRACT (audited plan C4):
 *  - every shipped entry carries PENDING or OWNER_VERIFY for region,
 *    retention, subprocessors, endpoints, DPA, residency, and approval;
 *  - an approval claim (APPROVED/DEPLOYED/ACCEPTED/winner) is rejected
 *    UNCONDITIONALLY — no ownerEvidenceRefs/EV-xxxx/UUID can authorize it,
 *    because repository-only Phase 10 work carries no authentic external
 *    evidence;
 *  - latency is NOT residency: latency-like status values are rejected;
 *  - endpoints are never recorded: only closed uppercase placeholders, and
 *    URL-lookalike / credential-lookalike values are rejected.
 *
 * Shape mirrors app/api/src/model-governance/provider-boundaries.ts.
 */

// ── Schema identity ─────────────────────────────────────────────────────

export const EVIDENCE_REGISTER_SCHEMA_ID = 'model-governance-evidence.schema.json';
export const EVIDENCE_REGISTER_SCHEMA_VERSION = 1;

// ── Closed enumerations ─────────────────────────────────────────────────

export const ALLOWED_REGISTER_PROVIDERS = [
  'anthropic',
  'sarvam',
  'silero',
  'livekit',
  'supabase',
  'gemini',
  'deepseek',
] as const;
export type RegisterProvider = (typeof ALLOWED_REGISTER_PROVIDERS)[number];

export const ALLOWED_REGISTER_CATEGORIES = ['current', 'optional_comparison'] as const;
export type RegisterCategory = (typeof ALLOWED_REGISTER_CATEGORIES)[number];

/** Repository-only evidence statuses carried by shipped entries. */
export const ALLOWED_REGISTER_STATUSES = ['PENDING', 'OWNER_VERIFY'] as const;
export type RegisterStatus = (typeof ALLOWED_REGISTER_STATUSES)[number];

// ── Approval claim detection ────────────────────────────────────────────

const APPROVAL_CLAIM_RE = /\b(?:approved|deployed|accepted|winner)\b/i;

// ── Closed identifier grammars ──────────────────────────────────────────

const ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const ENDPOINT_PLACEHOLDER_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const EVIDENCE_REF_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

const URL_OR_PATH_RE =
  /(?:https?:\/\/|ftp:\/\/|file:\/\/|wss?:\/\/|[\s(]\/[\w./-]|^\/[\w./-]|\.\.(?:[/\\]|$)|\\(?:\\[\w.-]+)+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})/i;

const TOKEN_LIKE_RE =
  /\b(?:sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/i;

const MAX_NOTES_LENGTH = 1000;

function hasUrlOrPath(value: string): boolean {
  return URL_OR_PATH_RE.test(value);
}

function hasCredential(value: string): boolean {
  return TOKEN_LIKE_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ── Entry shape ─────────────────────────────────────────────────────────

export interface EvidenceRegisterEntry {
  /** Stable register id (kebab-case). */
  id: string;
  provider: RegisterProvider;
  /** current (in production boundaries) or optional_comparison (LLM-03/04). */
  category: RegisterCategory;
  regionStatus: string;
  dataRetentionStatus: string;
  subprocessorsStatus: string;
  endpointStatus: string;
  dpaStatus: string;
  residencyStatus: string;
  /** Repository-only approval state. Never a positive approval claim. */
  approvalStatus: string;
  /** Closed uppercase placeholder token. Real endpoints are never recorded. */
  endpointPlaceholder?: string;
  /** Informational owner-evidence slot only; NEVER authorizes approvalStatus (repository-only work has no authentic external evidence). */
  ownerEvidenceRefs?: string[];
  notes?: string;
}

export interface EvidenceRegisterValidationResult {
  valid: boolean;
  /** Fixed-category diagnostics; never echo a rejected value verbatim. */
  error?: string;
}

// ── Entry validation ────────────────────────────────────────────────────

const ENTRY_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'provider',
  'category',
  'regionStatus',
  'dataRetentionStatus',
  'subprocessorsStatus',
  'endpointStatus',
  'dpaStatus',
  'residencyStatus',
  'approvalStatus',
  'endpointPlaceholder',
  'ownerEvidenceRefs',
  'notes',
]);

const STATUS_FIELD_LABELS: ReadonlyArray<[string, string]> = [
  ['regionStatus', 'region'],
  ['dataRetentionStatus', 'data retention'],
  ['subprocessorsStatus', 'subprocessors'],
  ['endpointStatus', 'endpoint'],
  ['dpaStatus', 'DPA'],
  ['residencyStatus', 'residency'],
  ['approvalStatus', 'approval'],
];

function validateStatusField(
  value: unknown,
  fieldLabel: string,
  humanLabel: string,
  errors: string[],
): void {
  if (typeof value !== 'string' || value.length === 0) {
    errors.push(`${fieldLabel}: must be a non-empty status token`);
    return;
  }
  if (APPROVAL_CLAIM_RE.test(value)) {
    // Positive approval claims are rejected unconditionally: repository-only
    // Phase 10 work carries no authentic external evidence, so no EV-xxxx /
    // UUID / identifier reference can authorize an APPROVED/DEPLOYED/
    // ACCEPTED/winner status.
    errors.push(`${fieldLabel}: positive ${humanLabel} approval claim is not permitted in repository-only work (no external evidence escape)`);
    return;
  }
  if (!(ALLOWED_REGISTER_STATUSES as readonly string[]).includes(value)) {
    errors.push(`${fieldLabel}: ${humanLabel} status is not PENDING or OWNER_VERIFY (latency is not residency)`);
  }
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

  if (typeof record.id !== 'string' || !ID_RE.test(record.id)) {
    errors.push(`${label}.id: must be a lowercase kebab-case identifier`);
  }
  if (typeof record.provider !== 'string') {
    errors.push(`${label}.provider: must be a string`);
  } else if (!(ALLOWED_REGISTER_PROVIDERS as readonly string[]).includes(record.provider)) {
    errors.push(`${label}.provider: not allowlisted`);
  }
  if (typeof record.category !== 'string') {
    errors.push(`${label}.category: must be a string`);
  } else if (!(ALLOWED_REGISTER_CATEGORIES as readonly string[]).includes(record.category)) {
    errors.push(`${label}.category: not allowlisted`);
  }

  for (const [field, humanLabel] of STATUS_FIELD_LABELS) {
    validateStatusField(record[field], `${label}.${field}`, humanLabel, errors);
  }

  // Approval claims are rejected unconditionally (validateStatusField above);
  // this branch is a second, defensive net for the approval field so a claim
  // can never pass through a caller that skips validateStatusField.
  if (typeof record.approvalStatus === 'string' && APPROVAL_CLAIM_RE.test(record.approvalStatus)) {
    errors.push(`${label}.approvalStatus: positive approval claim is not permitted in repository-only work (no external evidence escape)`);
  }

  if (record.endpointPlaceholder !== undefined) {
    if (typeof record.endpointPlaceholder !== 'string' || !ENDPOINT_PLACEHOLDER_RE.test(record.endpointPlaceholder)) {
      errors.push(`${label}.endpointPlaceholder: must be a closed uppercase placeholder token (no URLs, paths, or credentials)`);
    }
    if (
      typeof record.endpointPlaceholder === 'string' &&
      (hasUrlOrPath(record.endpointPlaceholder) || hasCredential(record.endpointPlaceholder))
    ) {
      errors.push(`${label}.endpointPlaceholder: must not contain URLs, paths, or credentials`);
    }
  }

  if (record.ownerEvidenceRefs !== undefined) {
    if (!isStringArray(record.ownerEvidenceRefs)) {
      errors.push(`${label}.ownerEvidenceRefs: must be a string array`);
    } else {
      for (const ref of record.ownerEvidenceRefs) {
        if (!EVIDENCE_REF_RE.test(ref)) {
          errors.push(`${label}.ownerEvidenceRefs: must be compact evidence identifiers (not URLs)`);
        }
        if (hasUrlOrPath(ref) || hasCredential(ref)) {
          errors.push(`${label}.ownerEvidenceRefs: must not contain URLs, paths, or credentials`);
        }
      }
    }
  }

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
 * Validate an evidence-register entry list. Rejects non-array inputs, empty
 * lists, unknown fields, closed-set violations, URL-lookalike / token-lookalike
 * values, latency-like residency values, and ANY positive approval claim
 * (APPROVED/DEPLOYED/ACCEPTED/winner) — unconditionally, with no external-
 * evidence escape. Diagnostics use fixed category labels and never echo the
 * rejected value.
 */
export function validateEvidenceRegisterEntries(raw: unknown): EvidenceRegisterValidationResult {
  if (!Array.isArray(raw)) {
    return { valid: false, error: 'evidence register: must be a non-empty array' };
  }
  if (raw.length === 0) {
    return { valid: false, error: 'evidence register: must not be empty' };
  }

  const errors: string[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    validateEntry(raw[i], i, errors);
  }

  if (errors.length > 0) {
    return { valid: false, error: errors.join('; ') };
  }
  return { valid: true };
}

// ── Current register (repository-only; as of baseline b3f1f301) ─────────
//
// All seven evidence slots are PENDING or OWNER_VERIFY for every provider.
// No endpoint, residency, or DPA approval exists in repository-only work.
// Gemini/DeepSeek are optional-comparison slots (LLM-03/04) and are
// NOT_EVALUATED: no evaluation was performed and no endpoint is recorded.

export const EVIDENCE_REGISTER_ENTRIES: readonly EvidenceRegisterEntry[] = [
  {
    id: 'evidence-anthropic',
    provider: 'anthropic',
    category: 'current',
    regionStatus: 'OWNER_VERIFY',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'OWNER_VERIFY',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    notes:
      'Claude CLI (api) and Anthropic LLM plugin (voice-livekit). Region, retention, subprocessors, DPA, and residency documentation pending owner verification; no endpoint or account evidence exists in-repository.',
  },
  {
    id: 'evidence-sarvam',
    provider: 'sarvam',
    category: 'current',
    regionStatus: 'PENDING',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'PENDING',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    notes:
      'LiveKit Sarvam STT/TTS plugins (voice-livekit). All external evidence slots pending owner verification; no endpoints recorded.',
  },
  {
    id: 'evidence-silero',
    provider: 'silero',
    category: 'current',
    regionStatus: 'PENDING',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'PENDING',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'NOT_APPLICABLE',
    notes:
      'Local ONNX VAD model, not a network provider. Placeholder NOT_APPLICABLE; external evidence slots still documented as pending.',
  },
  {
    id: 'evidence-livekit',
    provider: 'livekit',
    category: 'current',
    regionStatus: 'OWNER_VERIFY',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'OWNER_VERIFY',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    notes:
      'LiveKit Cloud pilot topology per ADR-0010 (managed LiveKit Cloud + Cloud Agents). Region/endpoint behavior owner verification pending; no deployment or quota evidence exists in-repository.',
  },
  {
    id: 'evidence-supabase',
    provider: 'supabase',
    category: 'current',
    regionStatus: 'PENDING',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'OWNER_VERIFY',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    notes:
      'Persistence via Supabase client (voice-livekit). Region/retention/DPA pending owner verification; no endpoint values recorded here.',
  },
  {
    id: 'evidence-gemini',
    provider: 'gemini',
    category: 'optional_comparison',
    regionStatus: 'PENDING',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'PENDING',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    notes:
      'LLM-03 optional compare slot. NOT_EVALUATED: no evaluation performed, no endpoint, no account evidence. Gated on the LLM-02 framework completing AND authentic human-annotated data.',
  },
  {
    id: 'evidence-deepseek',
    provider: 'deepseek',
    category: 'optional_comparison',
    regionStatus: 'PENDING',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'PENDING',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    notes:
      'LLM-04 optional compare slot. NOT_EVALUATED: no evaluation performed, no endpoint, no account evidence. Gated on the LLM-02 framework completing AND authentic human-annotated data.',
  },
];

// ── Register verification ───────────────────────────────────────────────

/**
 * Validate the shipped register once at import time (fail fast on drift).
 * A corrupted register must never be silently usable.
 */
const REGISTER_CHECK = validateEvidenceRegisterEntries(EVIDENCE_REGISTER_ENTRIES);
if (!REGISTER_CHECK.valid) {
  throw new Error(`Provider evidence register failed validation: ${REGISTER_CHECK.error}`);
}
