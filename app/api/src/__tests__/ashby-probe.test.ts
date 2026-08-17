/**
 * Ashby tenant probe — read-only by construction.
 *
 * The probe is the only new outbound surface, so it carries the strictest
 * assertions: it may reach exactly one allowlisted READ operation, it has no
 * write seam at all, and it copies only opaque stage ids plus a bounded title —
 * never a sibling field that could carry candidate data.
 *
 * Zero network: the reader is an injected recorder.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  probeJobStages,
  extractStages,
  assertReadOnly,
  PROBE_READ_OPERATIONS,
} from '../integrations/ashby/probe.js';
import { ASHBY_OPERATIONS } from '../integrations/ashby/types.js';

describe('assertReadOnly — mutating operations are unreachable', () => {
  it('accepts only the declared read allowlist', () => {
    for (const op of PROBE_READ_OPERATIONS) {
      expect(() => assertReadOnly(op)).not.toThrow();
      expect(ASHBY_OPERATIONS[op].mutation).toBe(false);
    }
  });

  it('rejects every mutating operation in the registry', () => {
    const mutating = Object.entries(ASHBY_OPERATIONS)
      .filter(([, spec]) => spec.mutation)
      .map(([name]) => name);
    // Guard the guard: if the registry ever loses its mutating entries this
    // assertion becomes vacuous, so require at least the three we know of.
    expect(mutating.length).toBeGreaterThanOrEqual(3);
    for (const op of mutating) {
      expect(() => assertReadOnly(op), `must reject ${op}`).toThrow('ashby_probe_operation_not_allowed');
    }
  });

  it('rejects non-mutating operations that are simply not allowlisted', () => {
    // Read-only is necessary but not sufficient — the probe's surface is minimal.
    for (const op of ['application.info', 'application.list', 'candidate.info', 'file.info']) {
      expect(() => assertReadOnly(op), `must reject ${op}`).toThrow();
    }
  });

  it('rejects an unknown operation name', () => {
    expect(() => assertReadOnly('totally.made.up')).toThrow();
  });
});

describe('probeJobStages — exactly one read, nothing written', () => {
  it('performs one jobInterviewPlan.info read and returns sanitized stages', async () => {
    const jobInterviewPlanInfo = vi.fn(async () => ({
      results: { interviewStages: [{ id: 'stage_ai', title: 'Bot Screening' }, { id: 'stage_ta', title: 'TA Screen' }] },
    }));
    const r = await probeJobStages('job_1', { jobInterviewPlanInfo } as never);

    expect(jobInterviewPlanInfo).toHaveBeenCalledTimes(1);
    expect(jobInterviewPlanInfo).toHaveBeenCalledWith('job_1');
    expect(r.stages).toEqual([
      { id: 'stage_ai', title: 'Bot Screening' },
      { id: 'stage_ta', title: 'TA Screen' },
    ]);
    expect(r.empty).toBe(false);
  });

  it('reports empty rather than inventing stages', async () => {
    const r = await probeJobStages('job_1', { jobInterviewPlanInfo: async () => ({ results: {} }) } as never);
    expect(r.stages).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it('propagates a tenant failure instead of defaulting anything to enabled', async () => {
    const reader = { jobInterviewPlanInfo: async () => { throw new Error('403 forbidden'); } };
    await expect(probeJobStages('job_1', reader as never)).rejects.toThrow();
  });
});

describe('extractStages — copies ids and titles ONLY', () => {
  it('never copies sibling fields that could carry candidate data', () => {
    const stages = extractStages({
      interviewStages: [{
        id: 'stage_ai',
        title: 'Bot Screening',
        candidateEmail: 'leak@example.invalid',
        candidateName: 'Leaky Person',
        resumeUrl: 'https://files.example/leak.pdf',
        feedback: 'sensitive feedback text',
      }],
    });
    expect(stages).toEqual([{ id: 'stage_ai', title: 'Bot Screening' }]);
    const serialized = JSON.stringify(stages);
    for (const leak of ['leak@example.invalid', 'Leaky Person', 'files.example', 'sensitive feedback']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('reads the plausible tenant shapes without locking one speculatively', () => {
    expect(extractStages([{ id: 'a' }])).toEqual([{ id: 'a', title: null }]);
    expect(extractStages({ stages: [{ id: 'b' }] })).toEqual([{ id: 'b', title: null }]);
    expect(extractStages({ jobInterviewPlan: { interviewStages: [{ id: 'c' }] } }))
      .toEqual([{ id: 'c', title: null }]);
    expect(extractStages({ interviewStages: [{ interviewStageId: 'd' }] }))
      .toEqual([{ id: 'd', title: null }]);
  });

  it('rejects ids that are not opaque-id shaped', () => {
    expect(extractStages({ stages: [{ id: 'has space' }, { id: '' }, { id: 'x'.repeat(300) }, { id: 42 }] }))
      .toEqual([]);
  });

  it('strips control characters and bounds the title', () => {
    const stages = extractStages({ stages: [{ id: 's1', title: 'Bot\u0007Screen\u0000ing' }] });
    // Control characters become spaces; the value is bounded and printable.
    expect(stages[0].title).toBe('Bot Screen ing');
    const long = extractStages({ stages: [{ id: 's2', title: 'x'.repeat(500) }] });
    expect(long[0].title!.length).toBeLessThanOrEqual(120);
  });

  it('de-duplicates and bounds the number of stages', () => {
    expect(extractStages({ stages: [{ id: 'a' }, { id: 'a' }] })).toHaveLength(1);
    const many = Array.from({ length: 500 }, (_, i) => ({ id: `s${i}` }));
    expect(extractStages({ stages: many }).length).toBeLessThanOrEqual(100);
  });

  it('is defensive about malformed payloads', () => {
    for (const bad of [null, undefined, 42, 'string', [], {}, { stages: 'nope' }]) {
      expect(extractStages(bad)).toEqual([]);
    }
  });
});

describe('probe module has no write capability', () => {
  it('exports no upsert/write/mutate helper', async () => {
    const mod = await import('../integrations/ashby/probe.js');
    const names = Object.keys(mod);
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(/upsert|write|create|update|delete|mutate|enable/);
    }
    // It proposes stage ids; applying them is a separate admin action.
    expect(names.sort()).toEqual(['PROBE_READ_OPERATIONS', 'assertReadOnly', 'extractStages', 'probeJobStages']);
  });
});
