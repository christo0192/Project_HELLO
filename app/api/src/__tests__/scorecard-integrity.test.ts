/**
 * integrity.ts — supplementary résumé-integrity + role-fit analysis for a v2
 * screening. Proves it parses a well-formed model output into the v1-shaped
 * role_fit / resume_conflicts, bounds/clamps adversarial output, treats an
 * empty analysis as absent, and — crucially — is FAIL-SOFT: any provider error
 * or malformed output returns EMPTY and NEVER throws, so it can never block a
 * scorecard. The inference boundary is injected, so no network call happens.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  analyzeResumeIntegrity,
  buildResumeIntegrityPrompt,
} from '../lib/scorecards/integrity.js';
import type { TranscriptTurn } from '../lib/types.js';

const transcript: TranscriptTurn[] = [
  { speaker: 'bot', text: 'Tell me about your experience.' },
  { speaker: 'candidate', text: 'I was a software engineer at Amazon for 11 years.' },
];

function input(overrides: Partial<Parameters<typeof analyzeResumeIntegrity>[1]> = {}) {
  return {
    roleTitle: 'Software Engineer',
    candidateName: 'Christo',
    transcript,
    resumeFacts: 'Current role: Proprietary Trader. No Amazon role listed.',
    ...overrides,
  };
}

function inferReturning(value: unknown) {
  return vi.fn(async (_prompt: string) => value);
}

describe('analyzeResumeIntegrity — well-formed output', () => {
  it('parses role_fit (v1 snake shape) and resume_conflicts', async () => {
    const infer = inferReturning({
      role_fit: {
        score: 4,
        matched_skills: ['Python', 'Java'],
        gaps: ['No verifiable SWE role on resume'],
        red_flags: ['Claimed 11 years at Amazon, resume lists no such role'],
        notes: 'Fit is weak; strong claims unverifiable.',
      },
      resume_conflicts: [
        {
          topic: 'Amazon tenure',
          resume_says: 'No Amazon role',
          candidate_said: '11 years at Amazon',
          resolved: false,
          note: 'Large discrepancy',
        },
      ],
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out.roleFit).toEqual({
      score: 4,
      matched_skills: ['Python', 'Java'],
      gaps: ['No verifiable SWE role on resume'],
      red_flags: ['Claimed 11 years at Amazon, resume lists no such role'],
      notes: 'Fit is weak; strong claims unverifiable.',
    });
    expect(out.resumeConflicts).toHaveLength(1);
    expect(out.resumeConflicts[0]).toEqual({
      topic: 'Amazon tenure',
      resume_says: 'No Amazon role',
      candidate_said: '11 years at Amazon',
      resolved: false,
      note: 'Large discrepancy',
    });
  });

  it('clamps score to 0..10 and coerces resolved to a strict boolean', async () => {
    const infer = inferReturning({
      role_fit: { score: 99, matched_skills: ['x'], gaps: [], red_flags: [], notes: '' },
      resume_conflicts: [
        { topic: 't', resume_says: 'a', candidate_said: 'b', resolved: 'yes', note: '' },
      ],
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out.roleFit?.score).toBe(10);
    // 'yes' (a truthy non-true value) must NOT be treated as resolved.
    expect(out.resumeConflicts[0].resolved).toBe(false);
  });
});

describe('analyzeResumeIntegrity — empty / absent', () => {
  it('returns roleFit=null when role_fit has no tags and no notes', async () => {
    const infer = inferReturning({
      role_fit: { score: 5, matched_skills: [], gaps: [], red_flags: [], notes: '' },
      resume_conflicts: [],
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out.roleFit).toBeNull();
    expect(out.resumeConflicts).toEqual([]);
  });

  it('keeps a notes-only role_fit (arrays default to empty)', async () => {
    const infer = inferReturning({
      role_fit: { notes: 'Too little was said to judge fit.' },
      resume_conflicts: [],
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out.roleFit).toEqual({
      score: 0,
      matched_skills: [],
      gaps: [],
      red_flags: [],
      notes: 'Too little was said to judge fit.',
    });
  });

  it('drops conflict entries with no substance and non-string tags', async () => {
    const infer = inferReturning({
      role_fit: { matched_skills: ['Python', 42, null, 'Java'], gaps: [], red_flags: [], notes: '' },
      resume_conflicts: [
        { topic: '', resume_says: '', candidate_said: '', resolved: false, note: '' },
        { topic: 'Real', resume_says: 'x', candidate_said: 'y', resolved: true, note: '' },
        'not-an-object',
      ],
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out.roleFit?.matched_skills).toEqual(['Python', 'Java']);
    expect(out.resumeConflicts).toHaveLength(1);
    expect(out.resumeConflicts[0].topic).toBe('Real');
  });

  it('bounds an adversarial output (item count + string length)', async () => {
    const infer = inferReturning({
      role_fit: {
        score: 3,
        matched_skills: Array.from({ length: 100 }, (_, i) => `skill-${i}`),
        gaps: ['g'.repeat(5000)],
        red_flags: [],
        notes: 'n'.repeat(5000),
      },
      resume_conflicts: Array.from({ length: 100 }, () => ({
        topic: 't'.repeat(5000),
        resume_says: 'a',
        candidate_said: 'b',
        resolved: false,
        note: '',
      })),
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out.roleFit!.matched_skills.length).toBeLessThanOrEqual(20);
    expect(out.roleFit!.gaps[0].length).toBeLessThanOrEqual(200);
    expect(out.roleFit!.notes.length).toBeLessThanOrEqual(1000);
    expect(out.resumeConflicts.length).toBeLessThanOrEqual(20);
    expect(out.resumeConflicts[0].topic.length).toBeLessThanOrEqual(500);
  });
});

describe('analyzeResumeIntegrity — FAIL-SOFT (never throws)', () => {
  it('returns EMPTY when the provider call throws', async () => {
    const infer = vi.fn(async () => {
      throw new Error('provider 500');
    });
    const out = await analyzeResumeIntegrity({ infer }, input());
    expect(out).toEqual({ roleFit: null, resumeConflicts: [] });
  });

  it('returns EMPTY on a non-object / non-JSON output', async () => {
    expect(await analyzeResumeIntegrity({ infer: inferReturning('nope') }, input())).toEqual({
      roleFit: null,
      resumeConflicts: [],
    });
    expect(await analyzeResumeIntegrity({ infer: inferReturning(['a']) }, input())).toEqual({
      roleFit: null,
      resumeConflicts: [],
    });
    expect(await analyzeResumeIntegrity({ infer: inferReturning(null) }, input())).toEqual({
      roleFit: null,
      resumeConflicts: [],
    });
  });
});

describe('buildResumeIntegrityPrompt — injection hardening', () => {
  it('fences the transcript and resume with a shared per-call sentinel', () => {
    const prompt = buildResumeIntegrityPrompt(input());
    const begins = prompt.match(/\[BEGIN UNTRUSTED CANDIDATE (TRANSCRIPT|RESUME FACTS) ([0-9a-f]{18})\]/g) ?? [];
    expect(begins).toHaveLength(2);
    // Both fences carry the SAME sentinel, and it is 18 hex chars (9 random bytes).
    const sentinels = begins.map((b) => b.match(/([0-9a-f]{18})/)![1]);
    expect(sentinels[0]).toBe(sentinels[1]);
    // The output contract asks for the two supplementary signals, not metrics.
    expect(prompt).toContain('"resume_conflicts"');
    expect(prompt).toContain('"role_fit"');
  });
});
