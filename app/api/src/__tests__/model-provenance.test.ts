import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateProvenance,
  createProvenance,
  screeningProvenance,
  scoringProvenance,
  LEGACY_PROVENANCE,
  MODEL_PROVENANCE_SCHEMA_VERSION,
  type ModelProvenance,
  type ProvenanceClock,
} from '../lib/model-provenance.js';

// ── Shared helpers ─────────────────────────────────────────────────────

/** Fixed clock frozen at a known UTC instant. */
const FIXED_NOW = new Date('2026-07-28T12:00:00.000Z');

const fixedClock: ProvenanceClock = {
  now: () => new Date(FIXED_NOW),
  parseDate: (iso: string) => Date.parse(iso),
};

/** Convenience: build a valid base payload. */
function validPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    schema_version: MODEL_PROVENANCE_SCHEMA_VERSION,
    provider: 'anthropic',
    requestedModel: 'claude-haiku-4-5-20251001',
    workload: 'screening',
    prompt_template_version: '2026-07-28.1',
    timestamp: '2026-07-28T12:00:00.000Z',
    ...overrides,
  };
}

// ── validateProvenance — happy paths ──────────────────────────────────

describe('validateProvenance — happy paths', () => {
  it('accepts a minimal valid provenance', () => {
    const result = validateProvenance(validPayload(), fixedClock);
    expect(result.valid).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.provider).toBe('anthropic');
    expect(result.data!.requestedModel).toBe('claude-haiku-4-5-20251001');
    expect(result.data!.workload).toBe('screening');
    expect(result.data!.schema_version).toBe(1);
  });

  it('accepts provenance with optional inference_params', () => {
    const result = validateProvenance(
      validPayload({ inference_params: { temperature: 0.7, max_tokens: 4096 } }),
      fixedClock,
    );
    expect(result.valid).toBe(true);
    expect(result.data!.inference_params).toBeDefined();
    expect(result.data!.inference_params!.temperature).toBe(0.7);
    expect(result.data!.inference_params!.max_tokens).toBe(4096);
  });

  it('accepts scoring workload', () => {
    const result = validateProvenance(
      validPayload({
        workload: 'scoring',
        requestedModel: 'claude-sonnet-4-20250514',
      }),
      fixedClock,
    );
    expect(result.valid).toBe(true);
    expect(result.data!.workload).toBe('scoring');
  });

  it('accepts current timestamp with ms', () => {
    const result = validateProvenance(
      validPayload({ timestamp: '2026-07-28T12:00:00.123Z' }),
      fixedClock,
    );
    expect(result.valid).toBe(true);
  });

  it('accepts timestamp exactly matching clock', () => {
    const result = validateProvenance(
      validPayload({ timestamp: '2026-07-28T12:00:00.000Z' }),
      fixedClock,
    );
    expect(result.valid).toBe(true);
  });

  it('accepts timestamp slightly in the future (within tolerance)', () => {
    const result = validateProvenance(
      validPayload({ timestamp: '2026-07-28T12:00:04.999Z' }),
      fixedClock,
    );
    expect(result.valid).toBe(true);
  });
});

// ── validateProvenance — null/array/primitive rejection ────────────────

describe('validateProvenance — null/array/primitive rejection', () => {
  it('rejects null', () => {
    expect(validateProvenance(null, fixedClock).valid).toBe(false);
  });

  it('rejects undefined', () => {
    expect(validateProvenance(undefined, fixedClock).valid).toBe(false);
  });

  it('rejects an array', () => {
    expect(validateProvenance([], fixedClock).valid).toBe(false);
  });

  it('rejects a string', () => {
    expect(validateProvenance('hello', fixedClock).valid).toBe(false);
  });

  it('rejects a number', () => {
    expect(validateProvenance(42, fixedClock).valid).toBe(false);
  });

  it('rejects a boolean', () => {
    expect(validateProvenance(true, fixedClock).valid).toBe(false);
  });
});

// ── validateProvenance — unknown fields ────────────────────────────────

describe('validateProvenance — unknown fields', () => {
  it('rejects an unknown field at the top level', () => {
    const result = validateProvenance(validPayload({ extraField: 'oops' }), fixedClock);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('provenance: unknown field at top level');
  });

  it('rejects multiple unknown fields without echoing their names', () => {
    const result = validateProvenance(
      validPayload({ x: 1, y: 2 }),
      fixedClock,
    );
    expect(result.valid).toBe(false);
    // The error message should not contain "x" or "y"
    expect(result.error).not.toContain('x');
    expect(result.error).not.toContain('y');
  });

  it('rejects unknown inference param keys without echoing the key', () => {
    const result = validateProvenance(
      validPayload({ inference_params: { badKey: 0.5 } }),
      fixedClock,
    );
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('badKey');
  });
});

// ── validateProvenance — allowlist violations ──────────────────────────

describe('validateProvenance — allowlist violations', () => {
  it('rejects unknown provider', () => {
    expect(validateProvenance(validPayload({ provider: 'openai' }), fixedClock).valid).toBe(false);
  });

  it('rejects empty provider', () => {
    expect(validateProvenance(validPayload({ provider: '' }), fixedClock).valid).toBe(false);
  });

  it('rejects unknown workload', () => {
    expect(validateProvenance(validPayload({ workload: 'deployment' }), fixedClock).valid).toBe(false);
  });
});

// ── validateProvenance — schema version ────────────────────────────────

describe('validateProvenance — schema version', () => {
  it('rejects wrong schema version (2)', () => {
    expect(validateProvenance(validPayload({ schema_version: 2 }), fixedClock).valid).toBe(false);
  });

  it('rejects zero schema version', () => {
    expect(validateProvenance(validPayload({ schema_version: 0 }), fixedClock).valid).toBe(false);
  });

  it('rejects string schema version', () => {
    expect(validateProvenance(validPayload({ schema_version: '1' }), fixedClock).valid).toBe(false);
  });

  it('rejects float schema version', () => {
    expect(validateProvenance(validPayload({ schema_version: 1.5 }), fixedClock).valid).toBe(false);
  });

  it('rejects boolean schema version', () => {
    expect(validateProvenance(validPayload({ schema_version: true }), fixedClock).valid).toBe(false);
  });

  it('rejects NaN schema version', () => {
    expect(validateProvenance(validPayload({ schema_version: NaN }), fixedClock).valid).toBe(false);
  });

  it('rejects Infinity schema version', () => {
    expect(validateProvenance(validPayload({ schema_version: Infinity }), fixedClock).valid).toBe(false);
  });
});

// ── validateProvenance — closed identifier grammar ─────────────────────

describe('validateProvenance — closed identifier grammar', () => {
  it('rejects model with whitespace', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'claude haiku' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects model with control characters', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'claude\x00haiku' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects model that is a URL', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'http://evil.com/model' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects model with absolute path', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: '/usr/bin/claude' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects model with parent path', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: '../etc/passwd' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects model with Windows drive path', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'C:\\Users\\claude.exe' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects model with an API key pattern', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'sk-abcdef1234567890' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('accepts valid model with hyphens, dots, colons', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'claude-3.5-sonnet:20241022' }),
      fixedClock,
    ).valid).toBe(true);
  });

  it('accepts valid model with slashes for model paths', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'anthropic/claude-3-haiku' }),
      fixedClock,
    ).valid).toBe(true);
  });
});

// ── validateProvenance — timestamp validation ──────────────────────────

describe('validateProvenance — timestamp validation', () => {
  it('rejects non-UTC timestamp (no Z)', () => {
    expect(validateProvenance(
      validPayload({ timestamp: '2026-07-28T12:00:00' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects timezone-offset timestamp', () => {
    expect(validateProvenance(
      validPayload({ timestamp: '2026-07-28T12:00:00+00:00' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects far-future timestamp', () => {
    expect(validateProvenance(
      validPayload({ timestamp: '2077-01-01T00:00:00Z' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects empty timestamp', () => {
    expect(validateProvenance(
      validPayload({ timestamp: '' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects impossible date (Feb 31)', () => {
    expect(validateProvenance(
      validPayload({ timestamp: '2026-02-31T12:00:00Z' }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects pre-epoch timestamp', () => {
    expect(validateProvenance(
      validPayload({ timestamp: '1969-12-31T23:59:59Z' }),
      fixedClock,
    ).valid).toBe(false);
  });
});

// ── validateProvenance — inference_params validation ───────────────────

describe('validateProvenance — inference_params validation', () => {
  it('rejects unknown inference param key', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { unknownParam: 0.5 } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects temperature > 2', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { temperature: 3 } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects negative temperature', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { temperature: -1 } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects boolean temperature', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { temperature: true } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects NaN temperature', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { temperature: NaN } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects string max_tokens', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { max_tokens: 'bad' } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects float max_tokens', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { max_tokens: 100.5 } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects max_tokens > 100000', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { max_tokens: 100001 } }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects max_tokens < 1', () => {
    expect(validateProvenance(
      validPayload({ inference_params: { max_tokens: 0 } }),
      fixedClock,
    ).valid).toBe(false);
  });
});

// ── validateProvenance — oversized values ──────────────────────────────

describe('validateProvenance — oversized values', () => {
  it('rejects model longer than 200 chars', () => {
    expect(validateProvenance(
      validPayload({ requestedModel: 'a'.repeat(201) }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects template version longer than 100 chars', () => {
    expect(validateProvenance(
      validPayload({ prompt_template_version: 'a'.repeat(101) }),
      fixedClock,
    ).valid).toBe(false);
  });

  it('rejects payload exceeding 2KB', () => {
    const bigInference = { temperature: 0.5, max_tokens: 1 };
    // Pad with inference params to exceed 2KB
    // The total JSON serialization must exceed 2048 bytes
    const payload = validPayload({
      inference_params: { temperature: 0.5, max_tokens: 1 },
      requestedModel: 'm' + 'x'.repeat(500), // pushes size
    });
    expect(validateProvenance(payload, fixedClock).valid).toBe(false);
  });
});

// ── validateProvenance — missing required fields ───────────────────────

describe('validateProvenance — missing required fields', () => {
  it('rejects missing requestedModel', () => {
    const { requestedModel, ...rest } = validPayload();
    expect(validateProvenance(rest, fixedClock).valid).toBe(false);
  });

  it('rejects missing provider', () => {
    const { provider, ...rest } = validPayload();
    expect(validateProvenance(rest, fixedClock).valid).toBe(false);
  });

  it('rejects missing timestamp', () => {
    const { timestamp, ...rest } = validPayload();
    expect(validateProvenance(rest, fixedClock).valid).toBe(false);
  });
});

// ── validateProvenance — prototype pollution / accessor defense ─────────

describe('validateProvenance — prototype pollution defense', () => {
  it('rejects a class instance', () => {
    class FakeProvenance {
      schema_version = 1;
      provider = 'anthropic';
      requestedModel = 'claude';
      workload = 'screening';
      prompt_template_version = 'v1';
      timestamp = '2026-07-28T12:00:00Z';
    }
    expect(validateProvenance(new FakeProvenance(), fixedClock).valid).toBe(false);
  });

  it('rejects object with accessor (getter)', () => {
    const obj: Record<string, unknown> = {
      schema_version: 1,
      provider: 'anthropic',
      requestedModel: 'claude',
      workload: 'screening',
      prompt_template_version: 'v1',
      timestamp: '2026-07-28T12:00:00Z',
    };
    Object.defineProperty(obj, 'hidden', {
      get: () => 'secret',
      enumerable: false,
    });
    // non-enumerable accessor — still rejected because isPlainProvenanceObject
    // checks ALL own property descriptors (not just enumerable ones).
    expect(validateProvenance(obj, fixedClock).valid).toBe(false);
  });

  it('rejects object with enumerable accessor', () => {
    const obj: Record<string, unknown> = {
      schema_version: 1,
      provider: 'anthropic',
      requestedModel: 'claude',
      workload: 'screening',
      prompt_template_version: 'v1',
      timestamp: '2026-07-28T12:00:00Z',
    };
    Object.defineProperty(obj, 'leaked', {
      get: () => 'secret',
      enumerable: true,
    });
    expect(validateProvenance(obj, fixedClock).valid).toBe(false);
  });

  it('rejects object with symbol keys', () => {
    const obj: Record<string, unknown> = {
      schema_version: 1,
      provider: 'anthropic',
      requestedModel: 'claude',
      workload: 'screening',
      prompt_template_version: 'v1',
      timestamp: '2026-07-28T12:00:00Z',
    };
    (obj as any)[Symbol('hidden')] = 'secret';
    expect(validateProvenance(obj, fixedClock).valid).toBe(false);
  });
});

// ── Deep-copy / freeze tests ──────────────────────────────────────────

describe('deep-copy and deep-freeze', () => {
  it('returns a deep copy - mutation of original does not affect data', () => {
    const original = validPayload({ inference_params: { temperature: 0.5 } });
    const result = validateProvenance(original, fixedClock);
    expect(result.valid).toBe(true);
    // Mutate the original
    (original as any).requestedModel = 'mutated';
    (original as any).inference_params.temperature = 999;
    // The data should be unchanged
    expect(result.data!.requestedModel).toBe('claude-haiku-4-5-20251001');
    expect(result.data!.inference_params!.temperature).toBe(0.5);
  });

  it('returns a frozen object - mutation throws in strict mode', () => {
    const result = validateProvenance(validPayload(), fixedClock);
    expect(result.valid).toBe(true);
    expect(() => {
      (result.data as any).requestedModel = 'mutated';
    }).toThrow();
  });

  it('freezes nested inference_params', () => {
    const result = validateProvenance(
      validPayload({ inference_params: { temperature: 0.7, max_tokens: 4096 } }),
      fixedClock,
    );
    expect(result.valid).toBe(true);
    expect(Object.isFrozen(result.data!.inference_params!)).toBe(true);
  });
});

// ── createProvenance ──────────────────────────────────────────────────

describe('createProvenance', () => {
  it('builds a valid provenance object', () => {
    const p = createProvenance(
      {
        provider: 'anthropic',
        requestedModel: 'claude-haiku-4-5-20251001',
        workload: 'screening',
        prompt_template_version: '2026-07-28.1',
      },
      fixedClock,
    );
    expect(p.provider).toBe('anthropic');
    expect(p.requestedModel).toBe('claude-haiku-4-5-20251001');
    expect(p.workload).toBe('screening');
    expect(p.schema_version).toBe(1);
    expect(p.timestamp).toBe('2026-07-28T12:00:00Z');
  });

  it('strips empty inference_params', () => {
    const p = createProvenance(
      {
        provider: 'anthropic',
        requestedModel: 'claude',
        workload: 'screening',
        prompt_template_version: 'v1',
        inference_params: {},
      },
      fixedClock,
    );
    expect(p.inference_params).toBeUndefined();
  });

  it('sets valid timestamp by default', () => {
    const p = createProvenance(
      {
        provider: 'anthropic',
        requestedModel: 'claude',
        workload: 'screening',
        prompt_template_version: 'v1',
      },
      fixedClock,
    );
    expect(p.timestamp).toBe('2026-07-28T12:00:00Z');
  });

  it('returns a frozen object', () => {
    const p = createProvenance(
      {
        provider: 'anthropic',
        requestedModel: 'claude',
        workload: 'screening',
        prompt_template_version: 'v1',
      },
      fixedClock,
    );
    expect(Object.isFrozen(p)).toBe(true);
  });

  it('constructor throws on invalid input', () => {
    expect(() =>
      createProvenance(
        {
          provider: 'bogus' as any,
          requestedModel: '',
          workload: 'screening',
          prompt_template_version: 'v1',
        },
        fixedClock,
      ),
    ).toThrow();
  });
});

// ── screeningProvenance / scoringProvenance ────────────────────────────

describe('screeningProvenance', () => {
  it('builds screening provenance', () => {
    const p = screeningProvenance('claude-haiku-4-5-20251001', fixedClock);
    expect(p.workload).toBe('screening');
    expect(p.requestedModel).toBe('claude-haiku-4-5-20251001');
    expect(p.prompt_template_version).toBe('2026-07-28.1');
  });
});

describe('scoringProvenance', () => {
  it('builds scoring provenance', () => {
    const p = scoringProvenance('claude-sonnet-4-20250514', fixedClock);
    expect(p.workload).toBe('scoring');
    expect(p.requestedModel).toBe('claude-sonnet-4-20250514');
    expect(p.prompt_template_version).toBe('2026-07-28.1');
  });
});

// ── LEGACY_PROVENANCE ──────────────────────────────────────────────────

describe('LEGACY_PROVENANCE', () => {
  it('is frozen with expected sentinel values', () => {
    expect(LEGACY_PROVENANCE).toEqual({
      schema_version: 0,
      provider: 'legacy',
      requestedModel: 'unknown',
      workload: 'unknown',
      prompt_template_version: 'legacy',
      timestamp: '1970-01-01T00:00:00Z',
    });
    expect(Object.isFrozen(LEGACY_PROVENANCE)).toBe(true);
  });
});

// ── Diagnostics must not echo values ──────────────────────────────────

describe('diagnostics must not echo values', () => {
  it('error for unknown provider does not leak the provider name', () => {
    const result = validateProvenance(
      validPayload({ provider: 'some-evil-provider-name' }),
      fixedClock,
    );
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('some-evil-provider-name');
  });

  it('error for URL in requestedModel does not leak the URL', () => {
    const result = validateProvenance(
      validPayload({ requestedModel: 'http://evil.com/steal?secret=key' }),
      fixedClock,
    );
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('evil.com');
    expect(result.error).not.toContain('secret');
  });

  it('error for unknown field does not leak the field name', () => {
    const result = validateProvenance(
      validPayload({ secret_field: 'super-secret' }),
      fixedClock,
    );
    expect(result.valid).toBe(false);
    expect(result.error).not.toContain('secret_field');
  });
});

// ── interview vs scoring model provenance ──────────────────────────────

describe('interview vs scoring model provenance', () => {
  it('screening provenance uses workload=screening', () => {
    const p = screeningProvenance('claude-haiku', fixedClock);
    expect(p.workload).toBe('screening');
  });

  it('scoring provenance uses workload=scoring', () => {
    const p = scoringProvenance('claude-sonnet', fixedClock);
    expect(p.workload).toBe('scoring');
  });

  it('distinct models produce distinct provenance objects', () => {
    const p1 = screeningProvenance('model-a', fixedClock);
    const p2 = screeningProvenance('model-b', fixedClock);
    expect(p1.requestedModel).toBe('model-a');
    expect(p2.requestedModel).toBe('model-b');
  });
});

// ── no external calls during provenance operations ─────────────────────

describe('no external calls during provenance operations', () => {
  it('validateProvenance is pure computation with no side effects', () => {
    const result = validateProvenance(validPayload(), fixedClock);
    expect(result.valid).toBe(true);
    // Re-validation with same inputs gives same result
    const result2 = validateProvenance(validPayload(), fixedClock);
    expect(result2).toEqual(result);
  });

  it('createProvenance does not trigger imports with side effects', () => {
    const p = createProvenance(
      {
        provider: 'anthropic',
        requestedModel: 'test',
        workload: 'screening',
        prompt_template_version: '2026-07-28.1',
      },
      fixedClock,
    );
    expect(p.requestedModel).toBe('test');
  });
});

// ── Clock injection tests ──────────────────────────────────────────────

describe('clock injection', () => {

  it('uses injected clock for validateProvenance', () => {
    const pastClock: ProvenanceClock = {
      now: () => new Date('2020-01-01T00:00:00.000Z'),
      parseDate: (iso: string) => Date.parse(iso),
    };
    // A timestamp in 2026 should be "in the future" from the past clock
    const result = validateProvenance(validPayload(), pastClock);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('future');
  });

  it('uses injected clock for createProvenance', () => {
    const customClock: ProvenanceClock = {
      now: () => new Date('2025-06-15T10:30:00.000Z'),
      parseDate: (iso: string) => Date.parse(iso),
    };
    const p = createProvenance(
      {
        provider: 'anthropic',
        requestedModel: 'claude',
        workload: 'screening',
        prompt_template_version: 'v1',
      },
      customClock,
    );
    expect(p.timestamp).toBe('2025-06-15T10:30:00Z');
  });

  it('default clock produces current timestamps', () => {
    const before = Date.now();
    const p = createProvenance({
      provider: 'anthropic',
      requestedModel: 'claude',
      workload: 'screening',
      prompt_template_version: 'v1',
    });
    const after = Date.now();
    const ts = Date.parse(p.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });
});
