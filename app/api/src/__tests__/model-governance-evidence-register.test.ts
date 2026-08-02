import { describe, it, expect } from 'vitest';
import {
  EVIDENCE_REGISTER_SCHEMA_ID,
  EVIDENCE_REGISTER_SCHEMA_VERSION,
  ALLOWED_REGISTER_PROVIDERS,
  ALLOWED_REGISTER_CATEGORIES,
  ALLOWED_REGISTER_STATUSES,
  EVIDENCE_REGISTER_ENTRIES,
  validateEvidenceRegisterEntries,
  type EvidenceRegisterEntry,
} from '../model-governance/evidence-register.js';

// ── Shared helpers ─────────────────────────────────────────────────────

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'evidence-example',
    provider: 'anthropic',
    category: 'current',
    regionStatus: 'PENDING',
    dataRetentionStatus: 'PENDING',
    subprocessorsStatus: 'PENDING',
    endpointStatus: 'PENDING',
    dpaStatus: 'PENDING',
    residencyStatus: 'PENDING',
    approvalStatus: 'PENDING',
    endpointPlaceholder: 'PENDING_OWNER',
    ...overrides,
  };
}

const asEntries = (entry: Record<string, unknown>): EvidenceRegisterEntry[] =>
  validateEvidenceRegisterEntries([entry]).valid ? ([entry] as unknown as EvidenceRegisterEntry[]) : [];

// ── Shipped register ───────────────────────────────────────────────────

describe('shipped evidence register — non-vacuous and truthful', () => {
  it('has at least seven entries and validates cleanly', () => {
    expect(EVIDENCE_REGISTER_ENTRIES.length).toBeGreaterThanOrEqual(7);
    const result = validateEvidenceRegisterEntries(EVIDENCE_REGISTER_ENTRIES);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('covers every current provider plus optional comparisons', () => {
    const providers = new Set(EVIDENCE_REGISTER_ENTRIES.map((e) => e.provider));
    for (const p of [
      'anthropic',
      'sarvam',
      'silero',
      'livekit',
      'supabase',
      'gemini',
      'deepseek',
    ] as const) {
      expect(providers.has(p)).toBe(true);
    }
  });

  it('marks gemini and deepseek as optional_comparison entries', () => {
    const gemini = EVIDENCE_REGISTER_ENTRIES.find((e) => e.provider === 'gemini');
    const deepseek = EVIDENCE_REGISTER_ENTRIES.find((e) => e.provider === 'deepseek');
    expect(gemini?.category).toBe('optional_comparison');
    expect(deepseek?.category).toBe('optional_comparison');
    expect(gemini?.notes).toMatch(/NOT_EVALUATED/i);
    expect(deepseek?.notes).toMatch(/NOT_EVALUATED/i);
  });

  it('keeps every evidence slot PENDING or OWNER_VERIFY only', () => {
    for (const entry of EVIDENCE_REGISTER_ENTRIES) {
      for (const field of [
        'regionStatus',
        'dataRetentionStatus',
        'subprocessorsStatus',
        'endpointStatus',
        'dpaStatus',
        'residencyStatus',
        'approvalStatus',
      ]) {
        expect(ALLOWED_REGISTER_STATUSES).toContain(
          (entry as unknown as Record<string, string>)[field],
        );
      }
      expect(entry.ownerEvidenceRefs).toBeUndefined();
    }
  });

  it('uses only closed uppercase endpoint placeholders, never URLs', () => {
    for (const entry of EVIDENCE_REGISTER_ENTRIES) {
      const placeholder = entry.endpointPlaceholder ?? '';
      expect(placeholder).toMatch(/^[A-Z][A-Z0-9_]{0,63}$/);
      expect(placeholder).not.toMatch(/:\/\//);
    }
  });
});

// ── Happy paths ────────────────────────────────────────────────────────

describe('validateEvidenceRegisterEntries — happy paths', () => {
  it('accepts a minimal valid entry', () => {
    const result = validateEvidenceRegisterEntries([validEntry()]);
    expect(result.valid).toBe(true);
    expect(asEntries(validEntry())[0].id).toBe('evidence-example');
  });

  it('accepts OWNER_VERIFY and PENDING statuses everywhere', () => {
    const entry = validEntry({
      regionStatus: 'OWNER_VERIFY',
      dataRetentionStatus: 'PENDING',
      subprocessorsStatus: 'OWNER_VERIFY',
      endpointStatus: 'OWNER_VERIFY',
      dpaStatus: 'PENDING',
      residencyStatus: 'PENDING',
      approvalStatus: 'OWNER_VERIFY',
    });
    expect(validateEvidenceRegisterEntries([entry]).valid).toBe(true);
  });

  it('rejects an approval claim even WITH owner evidence references (HIGH-review regression: no escape hatch)', () => {
    const withRefs = validateEvidenceRegisterEntries([
      validEntry({
        approvalStatus: 'APPROVED',
        ownerEvidenceRefs: ['EV-FAKE'],
      }),
    ]);
    expect(withRefs.valid).toBe(false);
    expect(withRefs.error).toMatch(/no external evidence escape/);

    const withUuid = validateEvidenceRegisterEntries([
      validEntry({
        approvalStatus: 'APPROVED',
        ownerEvidenceRefs: ['4c8e6f2a-1b3d-4e9f-8a7c-0d5e6f7a8b9c'],
      }),
    ]);
    expect(withUuid.valid).toBe(false);
  });

  it('accepts optional notes and evidence refs', () => {
    const entry = validEntry({
      notes: 'Closed prose; no endpoints or tokens.',
      ownerEvidenceRefs: ['owner-note-1'],
    });
    expect(validateEvidenceRegisterEntries([entry]).valid).toBe(true);
  });

  it('rejects a non-array input and an empty array (non-vacuous)', () => {
    expect(validateEvidenceRegisterEntries({ not: 'an array' }).valid).toBe(false);
    expect(validateEvidenceRegisterEntries([]).valid).toBe(false);
  });

  it('rejects unknown fields and allowlist violations', () => {
    expect(validateEvidenceRegisterEntries([validEntry({ malicious: 'extra' })]).valid).toBe(false);
    expect(validateEvidenceRegisterEntries([validEntry({ provider: 'openai' })]).valid).toBe(false);
    expect(validateEvidenceRegisterEntries([validEntry({ category: 'future' })]).valid).toBe(false);
  });
});

// ── Mandatory negative controls ────────────────────────────────────────

describe('negative controls — evidence register', () => {
  it('rejects approvalStatus APPROVED unconditionally (no owner evidence can authorize it)', () => {
    const result = validateEvidenceRegisterEntries([validEntry({ approvalStatus: 'APPROVED' })]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no external evidence escape/);
  });

  it('rejects DEPLOYED / ACCEPTED / winner claims unconditionally (EV-FAKE cannot bypass)', () => {
    for (const claim of ['DEPLOYED', 'ACCEPTED', 'winner', 'Winner']) {
      const result = validateEvidenceRegisterEntries([
        validEntry({ approvalStatus: claim, ownerEvidenceRefs: ['EV-FAKE'] }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/no external evidence escape/);
    }
  });

  it('rejects latency-as-residency values (region and residency slots)', () => {
    const latencyRegion = validateEvidenceRegisterEntries([validEntry({ regionStatus: '35ms' })]);
    expect(latencyRegion.valid).toBe(false);
    expect(latencyRegion.error).toMatch(/latency is not residency/);

    const latencyResidency = validateEvidenceRegisterEntries([
      validEntry({ residencyStatus: 'latency-120ms' }),
    ]);
    expect(latencyResidency.valid).toBe(false);

    const numericSlots = validateEvidenceRegisterEntries([
      validEntry({
        dataRetentionStatus: '90',
        subprocessorsStatus: 'PENDING',
        endpointStatus: 'PENDING',
        dpaStatus: 'PENDING',
        residencyStatus: 'PENDING',
      }),
    ]);
    expect(numericSlots.valid).toBe(false);
  });

  it('rejects secret-like endpoint placeholders (URL / credential lookalikes)', () => {
    const urlCase = validateEvidenceRegisterEntries([
      validEntry({ endpointPlaceholder: 'wss://rtc.example.invalid/abc' }),
    ]);
    expect(urlCase.valid).toBe(false);

    const credCase = validateEvidenceRegisterEntries([
      validEntry({ endpointPlaceholder: 'https://user:pass@example.invalid' }),
    ]);
    expect(credCase.valid).toBe(false);

    const tokenCase = validateEvidenceRegisterEntries([
      validEntry({ endpointPlaceholder: 'sk-livekit-abcdef1234567890' }),
    ]);
    expect(tokenCase.valid).toBe(false);
    expect(tokenCase.error).toMatch(/credentials|placeholder/);
  });

  it('rejects URL/token-lookalike notes and evidence refs', () => {
    const urlNotes = validateEvidenceRegisterEntries([
      validEntry({ notes: 'See https://example.invalid/evidence for details.' }),
    ]);
    expect(urlNotes.valid).toBe(false);

    const tokenRefs = validateEvidenceRegisterEntries([
      validEntry({ ownerEvidenceRefs: ['sk-livekit-abcdef1234567890'] }),
    ]);
    expect(tokenRefs.valid).toBe(false);
  });

  it('rejects malformed ids and placeholder tokens', () => {
    expect(validateEvidenceRegisterEntries([validEntry({ id: 'Bad Id!' })]).valid).toBe(false);
    expect(
      validateEvidenceRegisterEntries([validEntry({ endpointPlaceholder: 'pending-owner' })]).valid,
    ).toBe(false);
  });
});

// ── Constants ──────────────────────────────────────────────────────────

describe('register constants', () => {
  it('exposes the schema identity and version', () => {
    expect(EVIDENCE_REGISTER_SCHEMA_ID).toBe('model-governance-evidence.schema.json');
    expect(EVIDENCE_REGISTER_SCHEMA_VERSION).toBe(1);
  });

  it('includes current and optional providers', () => {
    expect(ALLOWED_REGISTER_PROVIDERS).toEqual([
      'anthropic',
      'sarvam',
      'silero',
      'livekit',
      'supabase',
      'gemini',
      'deepseek',
    ]);
    expect(ALLOWED_REGISTER_CATEGORIES).toEqual(['current', 'optional_comparison']);
    expect(ALLOWED_REGISTER_STATUSES).toEqual(['PENDING', 'OWNER_VERIFY']);
  });
});
