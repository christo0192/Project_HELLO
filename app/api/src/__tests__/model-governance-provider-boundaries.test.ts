import { describe, it, expect } from 'vitest';
import {
  PROVIDER_BOUNDARIES,
  validateProviderBoundaries,
  ALLOWED_POLICY_STATUSES,
  ALLOWED_PROVIDERS,
  ALLOWED_WORKLOADS,
  ALLOWED_RUNTIMES,
  ALLOWED_BOUNDARY_KINDS,
  MODEL_GOVERNANCE_SCHEMA_VERSION,
  type ProviderBoundaryEntry,
} from '../model-governance/provider-boundaries.js';

// ── Shared helpers ─────────────────────────────────────────────────────

/** Convenience: build a valid base entry. */
function validEntry(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'example-boundary',
    workloads: ['screening'],
    provider: 'anthropic',
    runtime: 'api',
    boundaryKind: 'cli_spawn',
    constructorPath: 'app/api/src/lib/example.ts',
    envVars: ['CLAUDE_MODEL'],
    allowlists: [],
    policyStatus: 'PROPOSED',
    ...overrides,
  };
}

const asEntries = (entry: Record<string, unknown>): ProviderBoundaryEntry[] =>
  validateProviderBoundaries([entry]).data ?? [];

// ── Shipped inventory ──────────────────────────────────────────────────

describe('shipped inventory — non-vacuous and accurate', () => {
  it('has at least one entry and validates cleanly', () => {
    expect(PROVIDER_BOUNDARIES.length).toBeGreaterThan(0);
    const result = validateProviderBoundaries(PROVIDER_BOUNDARIES);
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('covers every required TypeScript boundary path', () => {
    const paths = PROVIDER_BOUNDARIES.map((e) => e.constructorPath);
    for (const required of [
      'app/api/src/lib/claude.ts',
      'app/api/src/lib/prompts.ts',
      'app/api/src/services/assessment.ts',
      'app/api/src/lib/model-provenance.ts',
    ]) {
      expect(paths).toContain(required);
    }
  });

  it('covers every required Python boundary path', () => {
    const paths = PROVIDER_BOUNDARIES.map((e) => e.constructorPath);
    for (const required of [
      'app/voice-livekit/agent.py',
      'app/voice-livekit/prompting.py',
      'app/voice-livekit/provenance.py',
      'app/voice-livekit/persistence.py',
    ]) {
      expect(paths).toContain(required);
    }
  });

  it('records only truthful repository-only policy states', () => {
    for (const entry of PROVIDER_BOUNDARIES) {
      expect(ALLOWED_POLICY_STATUSES).toContain(entry.policyStatus);
      expect(entry.optionalEvidenceRefs).toBeUndefined();
    }
  });

  it('mentions the no-universal-abstraction contract in notes', () => {
    expect(JSON.stringify(PROVIDER_BOUNDARIES)).toMatch(/no interface wraps the CLI/i);
  });

  it('exports closed enumerations', () => {
    expect(ALLOWED_PROVIDERS).toContain('anthropic');
    expect(ALLOWED_WORKLOADS).toContain('screening');
    expect(ALLOWED_RUNTIMES).toContain('api');
    expect(ALLOWED_BOUNDARY_KINDS).toContain('cli_spawn');
    expect(MODEL_GOVERNANCE_SCHEMA_VERSION).toBe(1);
  });
});

// ── validateProviderBoundaries — happy paths ───────────────────────────

describe('validateProviderBoundaries — happy paths', () => {
  it('accepts a minimal valid entry', () => {
    const result = validateProviderBoundaries([validEntry()]);
    expect(result.valid).toBe(true);
    expect(result.data!.length).toBe(1);
    expect(result.data![0].id).toBe('example-boundary');
  });

  it('accepts PENDING and NOT_EVALUATED policy statuses', () => {
    for (const status of ['PENDING', 'NOT_EVALUATED']) {
      const result = validateProviderBoundaries([validEntry({ policyStatus: status })]);
      expect(result.valid).toBe(true);
    }
  });

  it('rejects an approval claim even WITH evidence references (HIGH-review regression: no escape hatch)', () => {
    const withRefs = validateProviderBoundaries([
      validEntry({
        policyStatus: 'APPROVED',
        optionalEvidenceRefs: ['EV-FAKE'],
      }),
    ]);
    expect(withRefs.valid).toBe(false);
    expect(withRefs.error).toMatch(/no external evidence escape/);

    const withUuid = validateProviderBoundaries([
      validEntry({
        policyStatus: 'APPROVED',
        optionalEvidenceRefs: ['4c8e6f2a-1b3d-4e9f-8a7c-0d5e6f7a8b9c'],
      }),
    ]);
    expect(withUuid.valid).toBe(false);
  });

  it('accepts optional notes and evidence refs', () => {
    const entry = validEntry({ notes: 'Closed prose; no endpoints or tokens.' });
    const result = validateProviderBoundaries([entry]);
    expect(result.valid).toBe(true);
    expect(asEntries(entry)[0].notes).toMatch(/Closed prose/);
  });

  it('rejects a non-array input', () => {
    const result = validateProviderBoundaries({ not: 'an array' });
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/non-empty array/);
  });

  it('rejects an empty array (non-vacuous)', () => {
    const result = validateProviderBoundaries([]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/must not be empty/);
  });

  it('rejects unknown top-level fields', () => {
    const result = validateProviderBoundaries([validEntry({ malicious: 'extra' })]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/unknown field/);
  });

  it('rejects allowlist violations', () => {
    const result = validateProviderBoundaries([
      validEntry({ provider: 'openai', policyStatus: 'PROPOSED' }),
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/provider: not allowlisted/);
  });
});

// ── Negative controls (lane A1 mandatory) ──────────────────────────────

describe('negative controls — unsafe optional metadata', () => {
  it('rejects an optional provider entry containing a URL-lookalike value', () => {
    const urlCases: Array<Record<string, unknown>> = [
      validEntry({ notes: 'See https://example.invalid/evidence for details.' }),
      validEntry({ optionalEvidenceRefs: ['https://example.invalid/evidence/123'] }),
      validEntry({ constructorPath: 'app/api/src/lib/claude.ts', notes: 'endpoint wss://rtc.example.invalid' }),
    ];
    for (const entry of urlCases) {
      const result = validateProviderBoundaries([entry]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/URL/i);
    }
  });

  it('rejects an optional provider entry containing a token-lookalike value', () => {
    const tokenCases: Array<Record<string, unknown>> = [
      validEntry({ notes: 'rotated sk-ant-test-abcdef1234567890 last month.' }),
      validEntry({ optionalEvidenceRefs: ['sk-livekit-abcdef1234567890'] }),
      validEntry({ notes: 'guard: api_key value never stored' }),
    ];
    for (const entry of tokenCases) {
      const result = validateProviderBoundaries([entry]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/credential/i);
    }
  });

  it('rejects status APPROVED unconditionally (no evidence ID can authorize it)', () => {
    const result = validateProviderBoundaries([validEntry({ policyStatus: 'APPROVED' })]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/no external evidence escape/);
  });

  it('rejects DEPLOYED / ACCEPTED / winner claims unconditionally (EV-FAKE cannot bypass)', () => {
    for (const claim of ['DEPLOYED', 'ACCEPTED', 'winner', 'Winner']) {
      const result = validateProviderBoundaries([
        validEntry({ policyStatus: claim, optionalEvidenceRefs: ['EV-FAKE'] }),
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/no external evidence escape/);
    }
  });

  it('rejects unsafe repository paths (absolute / traversal)', () => {
    for (const unsafePath of ['/etc/passwd', '../outside/file.ts', 'C:\\outside\\file.ts']) {
      const result = validateProviderBoundaries([
        validEntry({ constructorPath: unsafePath }),
      ]);
      expect(result.valid).toBe(false);
    }
  });

  it('rejects malformed env var names and evidence refs', () => {
    const badEnv = validateProviderBoundaries([validEntry({ envVars: ['claude_model'] })]);
    expect(badEnv.valid).toBe(false);
    expect(badEnv.error).toMatch(/envVars/);

    const badRef = validateProviderBoundaries([
      validEntry({ optionalEvidenceRefs: ['../outside-ref'] }),
    ]);
    expect(badRef.valid).toBe(false);
    expect(badRef.error).toMatch(/evidence/);
  });

  it('keeps truthful prose permitted: PENDING / PROPOSED / NOT_EVALUATED', () => {
    const result = validateProviderBoundaries([
      validEntry({ policyStatus: 'PROPOSED', notes: 'Pending owner verification.' }),
      validEntry({ id: 'second-entry', policyStatus: 'NOT_EVALUATED' }),
    ]);
    expect(result.valid).toBe(true);
  });
});
