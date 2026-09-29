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
  probeJobDirectory,
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

// ── Job directory (the Add-mapping picker) ─────────────────────────────────

interface JobPage {
  results: unknown;
  moreDataAvailable?: boolean;
  nextCursor?: string;
}

/**
 * A job that says, literally, `confidential: false` — the ONLY shape the
 * directory lists (fail-closed). Fixtures spell the flag out through this so
 * every listed job visibly carries it.
 */
function listed<T extends Record<string, unknown>>(job: T): T & { confidential: false } {
  return { ...job, confidential: false };
}

/**
 * A `job.list` recorder that answers the scripted pages in order and FAILS the
 * test if asked for a page it was not given — a runaway walk is a bug, not a
 * silently repeated last page.
 */
function pagedReader(pages: JobPage[]) {
  const calls: Array<Record<string, unknown>> = [];
  const jobList = vi.fn(async (params?: Record<string, unknown>) => {
    calls.push({ ...(params ?? {}) });
    const page = pages[calls.length - 1];
    if (!page) throw new Error(`unexpected job.list page ${calls.length}`);
    return { results: page.results, moreDataAvailable: page.moreDataAvailable ?? false, nextCursor: page.nextCursor };
  });
  return { reader: { jobList } as never, jobList, calls };
}

/** An endless directory: every page has more data behind a fresh cursor. */
function endlessReader(pageSize: number) {
  let n = 0;
  const jobList = vi.fn(async () => {
    const page = n++;
    const results = Array.from({ length: pageSize }, (_, i) => listed({ id: `job_${page}_${i}`, title: `Job ${page}-${i}`, status: 'Open' }));
    return { results, moreDataAvailable: true, nextCursor: `cursor_${page}` };
  });
  return { reader: { jobList } as never, jobList };
}

/** The params of each recorded call, minus the (timing-dependent) deadline. */
function withoutDeadline(calls: Array<Record<string, unknown>>) {
  return calls.map(({ deadlineAt: _deadline, ...rest }) => rest);
}

describe('job.list is an allowlisted, non-mutating probe read', () => {
  it('is in the probe allowlist, registered as a read, and passes assertReadOnly', () => {
    expect(PROBE_READ_OPERATIONS).toContain('job.list');
    expect(ASHBY_OPERATIONS['job.list']).toEqual({ path: '/job.list', mutation: false });
    expect(() => assertReadOnly('job.list')).not.toThrow();
  });
});

describe('probeJobDirectory — copies id/title/status/openedAt ONLY', () => {
  it('never copies hiring-team emails, custom fields, or any other sibling field', async () => {
    const { reader } = pagedReader([{
      results: [{
        id: 'job_1',
        title: 'Senior Engineer',
        status: 'Open',
        openedAt: '2026-09-01T10:00:00Z',
        confidential: false,
        hiringTeam: [{ email: 'recruiter@example.invalid', firstName: 'Leaky', role: 'Recruiter' }],
        customFields: [{ title: 'Comp band', value: 'secret-comp-band' }],
        candidateEmail: 'candidate@example.invalid',
        location: { name: 'Leakville' },
      }],
    }]);
    const r = await probeJobDirectory(reader);

    expect(r).toEqual({
      jobs: [{ id: 'job_1', title: 'Senior Engineer', status: 'Open', openedAt: '2026-09-01T10:00:00.000Z' }],
      truncated: false,
      withheld: 0,
      timedOut: false,
    });
    expect(Object.keys(r.jobs[0]).sort()).toEqual(['id', 'openedAt', 'status', 'title']);
    const serialized = JSON.stringify(r);
    for (const leak of ['recruiter@example.invalid', 'Leaky', 'secret-comp-band', 'Comp band', 'candidate@example.invalid', 'Leakville', 'confidential']) {
      expect(serialized, `must not carry ${leak}`).not.toContain(leak);
    }
  });

  it('lists a job ONLY when it is literally `confidential: false` — every other flag, and NO flag, withholds (fail-closed)', async () => {
    const { reader } = pagedReader([{
      results: [
        { id: 'job_secret', title: 'Replacement for the CFO', status: 'Open', confidential: true },
        { id: 'job_string', title: 'String flag', status: 'Open', confidential: 'false' },
        { id: 'job_null', title: 'Null flag', status: 'Open', confidential: null },
        { id: 'job_zero', title: 'Zero flag', status: 'Open', confidential: 0 },
        { id: 'job_absent', title: 'Flag key absent', status: 'Open' },
        { id: 'job_public', title: 'Public role', status: 'Open', confidential: false },
      ],
    }]);
    const r = await probeJobDirectory(reader);

    expect(r.jobs.map((j) => j.id)).toEqual(['job_public']);
    expect(r.withheld).toBe(5);
    const serialized = JSON.stringify(r);
    for (const leak of ['Replacement for the CFO', 'job_absent', 'Flag key absent', 'job_secret']) {
      expect(serialized, `must not carry ${leak}`).not.toContain(leak);
    }
  });

  it('counts withheld jobs by DISTINCT id — a job seen on two pages is one', async () => {
    const { reader } = pagedReader([
      { results: [{ id: 'job_a', title: 'A', confidential: true }, { id: 'job_b', title: 'B' }], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [{ id: 'job_a', title: 'A', confidential: true }, { id: 'job_b', title: 'B' }, listed({ id: 'job_c', title: 'C' })] },
    ]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs.map((j) => j.id)).toEqual(['job_c']);
    expect(r.withheld).toBe(2);
  });

  it('keeps an id withheld once it has been seen withheld, in either page order', async () => {
    const { reader } = pagedReader([
      {
        results: [
          { id: 'job_a', title: 'A', confidential: true },
          { id: 'job_b', title: 'B', confidential: false },
        ],
        moreDataAvailable: true,
        nextCursor: 'c1',
      },
      {
        results: [
          { id: 'job_a', title: 'A', confidential: false },
          { id: 'job_b', title: 'B', confidential: true },
          listed({ id: 'job_c', title: 'C' }),
        ],
      },
    ]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs.map((j) => j.id)).toEqual(['job_c']);
    expect(r.withheld).toBe(2);
  });

  it('skips items whose id is not opaque-id shaped, and non-object items', async () => {
    const { reader } = pagedReader([{
      results: [
        listed({ id: 'has space', title: 'x' }),
        listed({ id: '', title: 'x' }),
        listed({ id: 'x'.repeat(300), title: 'x' }),
        listed({ id: 42, title: 'x' }),
        listed({ title: 'no id at all' }),
        null,
        'job_as_string',
        ['job_in_array'],
        listed({ id: 'job_ok', title: 'Kept' }),
      ],
    }]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs).toEqual([{ id: 'job_ok', title: 'Kept', status: null, openedAt: null }]);
    // An item with no usable id is not a job at all — it is not counted as withheld.
    expect(r.withheld).toBe(0);
  });

  it('coerces status to the four-value enum, anything else to null', async () => {
    const { reader } = pagedReader([{
      results: [
        listed({ id: 'j1', title: 'a', status: 'Draft' }),
        listed({ id: 'j2', title: 'b', status: 'Open' }),
        listed({ id: 'j3', title: 'c', status: 'Closed' }),
        listed({ id: 'j4', title: 'd', status: 'Archived' }),
        listed({ id: 'j5', title: 'e', status: 'open' }),
        listed({ id: 'j6', title: 'f', status: 'Paused' }),
        listed({ id: 'j7', title: 'g', status: 1 }),
        listed({ id: 'j8', title: 'h' }),
      ],
    }]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs.map((j) => j.status)).toEqual(['Draft', 'Open', 'Closed', 'Archived', null, null, null, null]);
  });

  it('normalises a parseable openedAt to ISO-8601 and never guesses one', async () => {
    const { reader } = pagedReader([{
      results: [
        listed({ id: 'j1', title: 'a', openedAt: '2026-09-01T10:00:00Z' }),
        listed({ id: 'j2', title: 'b', openedAt: '2026-09-01' }),
        listed({ id: 'j3', title: 'c', openedAt: 'not a date' }),
        listed({ id: 'j4', title: 'd', openedAt: 1_756_720_800_000 }),
        listed({ id: 'j5', title: 'e', openedAt: '' }),
        listed({ id: 'j6', title: 'f', openedAt: '2026-09-01T10:00:00Z' + ' '.repeat(80) }),
        listed({ id: 'j7', title: 'g' }),
      ],
    }]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs.map((j) => j.openedAt)).toEqual([
      '2026-09-01T10:00:00.000Z', '2026-09-01T00:00:00.000Z', null, null, null, null, null,
    ]);
  });

  it('strips control characters from and bounds the title', async () => {
    const { reader } = pagedReader([{
      results: [
        listed({ id: 'j1', title: 'Bot\u0007Engin\u0000eer' }),
        listed({ id: 'j2', title: 'x'.repeat(500) }),
        listed({ id: 'j3', title: 42 }),
      ],
    }]);
    const r = await probeJobDirectory(reader);
    const byId = new Map(r.jobs.map((j) => [j.id, j] as const));
    expect(byId.get('j1')!.title).toBe('Bot Engin eer');
    expect(byId.get('j2')!.title!.length).toBeLessThanOrEqual(120);
    expect(byId.get('j3')!.title).toBeNull();
  });

  it('sorts by title case/accent-insensitively, untitled last, id breaking ties', async () => {
    const { reader } = pagedReader([{
      results: [
        listed({ id: 'j_zeta', title: 'Zeta' }),
        listed({ id: 'j_none', title: null }),
        listed({ id: 'j_b', title: 'beta' }),
        listed({ id: 'j_alpha2', title: 'ALPHA' }),
        listed({ id: 'j_eclair', title: 'Éclair' }),
        listed({ id: 'j_alpha1', title: 'alpha' }),
        listed({ id: 'j_blank', title: '   ' }),
      ],
    }]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs.map((j) => j.id)).toEqual(['j_alpha1', 'j_alpha2', 'j_b', 'j_eclair', 'j_zeta', 'j_blank', 'j_none']);
  });

  it('de-duplicates by id within and across pages — the first sighting wins', async () => {
    const { reader } = pagedReader([
      { results: [listed({ id: 'j1', title: 'First' }), listed({ id: 'j1', title: 'Second' })], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [listed({ id: 'j1', title: 'Third' }), listed({ id: 'j2', title: 'Other' })] },
    ]);
    const r = await probeJobDirectory(reader);
    expect(r.jobs).toEqual([
      { id: 'j1', title: 'First', status: null, openedAt: null },
      { id: 'j2', title: 'Other', status: null, openedAt: null },
    ]);
  });

  it('propagates a provider failure instead of presenting an empty directory', async () => {
    const reader = { jobList: async () => { throw new Error('403 forbidden: missing jobsRead'); } };
    await expect(probeJobDirectory(reader as never)).rejects.toThrow('403 forbidden');
  });

  it('reads a non-array results payload as an empty page, not a guess', async () => {
    const { reader } = pagedReader([{ results: { jobs: [listed({ id: 'j1', title: 'Nested' })] } }]);
    expect(await probeJobDirectory(reader)).toEqual({ jobs: [], truncated: false, withheld: 0, timedOut: false });
  });

  it('touches no member of the client other than jobList', async () => {
    const touched: string[] = [];
    const reader = new Proxy({ jobList: async () => ({ results: [listed({ id: 'j1', title: 'x' })], moreDataAvailable: false }) } as Record<string, unknown>, {
      get(target, prop: string) {
        touched.push(String(prop));
        if (prop in target) return target[prop];
        throw new Error(`directory probe reached for a forbidden member: ${String(prop)}`);
      },
    });
    await probeJobDirectory(reader as never);
    expect(touched.filter((p) => p !== 'then')).toEqual(['jobList']);
  });
});

describe('sanitizeTitle — what a job (or stage) title may carry', () => {
  /** Run one title through the directory probe and return what it became. */
  async function titleOf(raw: unknown): Promise<string | null> {
    const { reader } = pagedReader([{ results: [listed({ id: 'j1', title: raw })] }]);
    return (await probeJobDirectory(reader)).jobs[0].title;
  }
  const cp = (...codes: number[]) => String.fromCodePoint(...codes);

  it('neutralises a bidi-override spoof, so the title reads as the text it really is', async () => {
    // U+202E RIGHT-TO-LEFT OVERRIDE would render "Engineer" + a reversed tail,
    // making one job look like another in the picker.
    const spoof = `Engineer${cp(0x202e)}reganaM tceles`;
    expect(await titleOf(spoof)).toBe('Engineer reganaM tceles');
    // Embeddings, overrides and isolates alike.
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f]) {
      expect(await titleOf(`A${cp(code)}B`), `U+${code.toString(16)}`).toBe('A B');
    }
  });

  it('turns a title made only of zero-width / format characters into null, not an empty-looking entry', async () => {
    expect(await titleOf(cp(0x200b, 0x200c, 0x200d, 0x2060, 0xfeff))).toBeNull();
    expect(await titleOf(`  ${cp(0x200b)}  ${cp(0x00ad)} `)).toBeNull();
  });

  it('REMOVES the zero-width joiners inside a word instead of splitting it with a space', async () => {
    // Persian "mi-khaham" is written with a ZWNJ between its parts; a space
    // there would turn one word into two. Same for an emoji ZWJ sequence.
    expect(await titleOf(`می${cp(0x200c)}خواهم`)).toBe('میخواهم');
    expect(await titleOf(`Dev${cp(0x200d)}Ops Lead`)).toBe('DevOps Lead');
    // Two titles differing only by a joiner come out identical, so the
    // picker's duplicate disambiguation can see them.
    expect(await titleOf(`Sales${cp(0x200c)} Advisor`)).toBe(await titleOf('Sales Advisor'));
  });

  it('replaces C0, DEL and C1 controls and the Unicode line/paragraph separators with a space', async () => {
    expect(await titleOf(`A${cp(0x0085)}B`)).toBe('A B');           // NEL (C1)
    expect(await titleOf(`A${cp(0x009b)}B`)).toBe('A B');           // CSI (C1)
    expect(await titleOf(`A${cp(0x007f)}B`)).toBe('A B');           // DEL
    expect(await titleOf(`A${cp(0x2028)}B${cp(0x2029)}C`)).toBe('A B C');
    expect(await titleOf('A\tB\nC\rD')).toBe('A B C D');
  });

  it('collapses runs of spaces left by the replacement, and trims', async () => {
    expect(await titleOf(`  Senior ${cp(0x200b)} ${cp(0x202e)}  Engineer  `)).toBe('Senior Engineer');
  });

  it('NFC-normalizes, so one look has one spelling', async () => {
    const decomposed = `Cafe${cp(0x0301)} Manager`;            // e + COMBINING ACUTE
    const title = await titleOf(decomposed);
    expect(title).toBe(`Caf${cp(0x00e9)} Manager`);
    expect(title!.length).toBe(12);
  });

  it('bounds AFTER cleaning, and never ends on half a surrogate pair', async () => {
    // 200 zero-width characters then a real title: the bound counts visible text.
    expect(await titleOf(`${cp(0x200b).repeat(200)}Engineer`)).toBe('Engineer');
    // 119 ASCII + an astral character straddling the 120 cut.
    const straddle = await titleOf(`${'x'.repeat(119)}${cp(0x1f600)}tail`);
    expect(straddle).toBe('x'.repeat(119));
    expect(straddle!.length).toBeLessThanOrEqual(120);
  });

  it('is the same sanitizer the stage probe uses', () => {
    const [stage] = extractStages({ stages: [{ id: 's1', title: `Bot${cp(0x202e)}Screen${cp(0x200b)}` }] });
    expect(stage.title).toBe('Bot Screen');
  });
});

describe('probeJobDirectory — bounded pagination', () => {
  it('follows cursors with a fixed page size and sends no status filter', async () => {
    const { reader, calls } = pagedReader([
      { results: [listed({ id: 'j1', title: 'a' })], moreDataAvailable: true, nextCursor: 'c1' },
      { results: [listed({ id: 'j2', title: 'b' })], moreDataAvailable: true, nextCursor: 'c2' },
      { results: [listed({ id: 'j3', title: 'c' })], moreDataAvailable: false },
    ]);
    const r = await probeJobDirectory(reader);

    expect(withoutDeadline(calls)).toEqual([{ limit: 100 }, { cursor: 'c1', limit: 100 }, { cursor: 'c2', limit: 100 }]);
    for (const call of calls) {
      expect(call).not.toHaveProperty('status');
      expect(call).not.toHaveProperty('extra');
    }
    expect(r.jobs.map((j) => j.id)).toEqual(['j1', 'j2', 'j3']);
    expect(r.truncated).toBe(false);
  });

  it('stops on moreDataAvailable:false even when a cursor is present', async () => {
    const { reader, calls } = pagedReader([
      { results: [listed({ id: 'j1', title: 'a' })], moreDataAvailable: false, nextCursor: 'dangling' },
    ]);
    const r = await probeJobDirectory(reader);
    expect(calls).toHaveLength(1);
    expect(r.truncated).toBe(false);
  });

  it('reports truncated — not an error — on a repeated cursor, keeping what it read', async () => {
    const { reader, calls } = pagedReader([
      { results: [listed({ id: 'j1', title: 'a' })], moreDataAvailable: true, nextCursor: 'loop' },
      { results: [listed({ id: 'j2', title: 'b' })], moreDataAvailable: true, nextCursor: 'loop' },
    ]);
    const r = await probeJobDirectory(reader);
    expect(calls).toHaveLength(2);
    expect(r.jobs.map((j) => j.id)).toEqual(['j1', 'j2']);
    expect(r.truncated).toBe(true);
  });

  it('reports truncated when a page says there is more but gives no cursor', async () => {
    const { reader, calls } = pagedReader([
      { results: [listed({ id: 'j1', title: 'a' })], moreDataAvailable: true },
    ]);
    const r = await probeJobDirectory(reader);
    expect(calls).toHaveLength(1);
    expect(r.jobs).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });

  it('stops at the 20-page cap with truncated:true', async () => {
    const { reader, jobList } = endlessReader(2);
    const r = await probeJobDirectory(reader);
    expect(jobList).toHaveBeenCalledTimes(20);
    expect(r.jobs).toHaveLength(40);
    expect(r.truncated).toBe(true);
    // A BOUND clipped it, not the clock: the route may cache this walk.
    expect(r.timedOut).toBe(false);
  });

  it('stops at the 2000-job cap with truncated:true, even when a provider over-fills pages', async () => {
    // 150 per page ignores the requested limit of 100: the item cap, not the
    // page cap, is what must stop this walk (14 × 150 = 2100 > 2000).
    const { reader, jobList } = endlessReader(150);
    const r = await probeJobDirectory(reader);
    expect(r.jobs).toHaveLength(2000);
    expect(jobList).toHaveBeenCalledTimes(14);
    expect(r.truncated).toBe(true);
  });

  it('lets a caller tighten the caps but never widen them', async () => {
    const tight = endlessReader(5);
    const t = await probeJobDirectory(tight.reader, { maxPages: 3 });
    expect(tight.jobList).toHaveBeenCalledTimes(3);
    expect(t.truncated).toBe(true);

    const wide = endlessReader(1);
    const w = await probeJobDirectory(wide.reader, { maxPages: 1000, maxItems: 1_000_000 });
    expect(wide.jobList).toHaveBeenCalledTimes(20);
    expect(w.truncated).toBe(true);

    const items = endlessReader(5);
    const i = await probeJobDirectory(items.reader, { maxItems: 3 });
    expect(items.jobList).toHaveBeenCalledTimes(1);
    expect(i.jobs).toHaveLength(3);
    expect(i.truncated).toBe(true);
  });

  it('is NOT truncated when the item cap is filled exactly by the final page', async () => {
    const { reader } = pagedReader([
      { results: [listed({ id: 'j1', title: 'a' }), listed({ id: 'j2', title: 'b' }), listed({ id: 'j3', title: 'c' })], moreDataAvailable: false },
    ]);
    const r = await probeJobDirectory(reader, { maxItems: 3 });
    expect(r.jobs).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });
});

describe('probeJobDirectory — one ~20 s deadline for the whole walk', () => {
  const START = 1_700_000_000_000;

  /** A fake wall clock; each page read costs `pageMs` of it. */
  function slowEndless(pageMs: number) {
    let t = START;
    let n = 0;
    const calls: Array<Record<string, unknown>> = [];
    const jobList = vi.fn(async (params?: Record<string, unknown>) => {
      calls.push({ ...(params ?? {}) });
      t += pageMs;
      n += 1;
      return { results: [listed({ id: `job_${n}`, title: `Job ${n}` })], moreDataAvailable: true, nextCursor: `c${n}` };
    });
    return { reader: { jobList } as never, jobList, calls, now: () => t, advance: (ms: number) => { t += ms; } };
  }

  it('threads ONE deadline — start + 20 s — to every page read (the client never sends it to Ashby)', async () => {
    const s = slowEndless(1);
    await probeJobDirectory(s.reader, { now: s.now, maxPages: 3 });
    expect(s.calls).toHaveLength(3);
    for (const call of s.calls) expect(call.deadlineAt).toBe(START + 20_000);
  });

  it('stops with the pages it has, flagged truncated, once the deadline has passed', async () => {
    const s = slowEndless(8_000);
    const r = await probeJobDirectory(s.reader, { now: s.now });
    // Pages start at 0 s, 8 s and 16 s; a fourth would start at 24 s.
    expect(s.jobList).toHaveBeenCalledTimes(3);
    expect(r.jobs.map((j) => j.id)).toEqual(['job_1', 'job_2', 'job_3']);
    expect(r.truncated).toBe(true);
    // The CLOCK clipped it: the route must not cache this walk.
    expect(r.timedOut).toBe(true);
  });

  it('turns a page that FAILS on the deadline into a truncated partial when earlier pages were read', async () => {
    let t = START;
    const jobList = vi.fn()
      .mockImplementationOnce(async () => { t += 5_000; return { results: [listed({ id: 'job_1', title: 'One' })], moreDataAvailable: true, nextCursor: 'c1' }; })
      .mockImplementationOnce(async () => {
        t += 16_000;
        // The client's own code for a spent deadline.
        throw Object.assign(new Error('ashby_timeout'), { code: 'deadline_exceeded' });
      });
    const r = await probeJobDirectory({ jobList } as never, { now: () => t });
    expect(r).toEqual({ jobs: [{ id: 'job_1', title: 'One', status: null, openedAt: null }], truncated: true, withheld: 0, timedOut: true });
  });

  it('treats any failure once the clock is past the deadline as the deadline (a cut-short request surfaces as a timeout first)', async () => {
    let t = START;
    const jobList = vi.fn()
      .mockImplementationOnce(async () => { t += 1_000; return { results: [listed({ id: 'job_1', title: 'One' })], moreDataAvailable: true, nextCursor: 'c1' }; })
      .mockImplementationOnce(async () => { t += 25_000; throw new Error('ashby_retry_exhausted'); });
    const r = await probeJobDirectory({ jobList } as never, { now: () => t });
    expect(r.truncated).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.jobs).toHaveLength(1);
  });

  it('still propagates a failure BEFORE the deadline, even with pages in hand', async () => {
    let t = START;
    const jobList = vi.fn()
      .mockImplementationOnce(async () => { t += 1_000; return { results: [listed({ id: 'job_1', title: 'One' })], moreDataAvailable: true, nextCursor: 'c1' }; })
      .mockImplementationOnce(async () => { t += 1_000; throw new Error('403 forbidden'); });
    await expect(probeJobDirectory({ jobList } as never, { now: () => t })).rejects.toThrow('403 forbidden');
  });

  it('throws — never an empty "complete" directory — when the deadline runs out before ANY page arrives', async () => {
    let t = START;
    const jobList = vi.fn(async () => {
      t += 21_000;
      throw Object.assign(new Error('ashby_timeout'), { code: 'deadline_exceeded' });
    });
    await expect(probeJobDirectory({ jobList } as never, { now: () => t })).rejects.toThrow('ashby_timeout');
    expect(jobList).toHaveBeenCalledTimes(1);
  });

  it('lets a caller tighten the deadline but never widen it', async () => {
    const tight = slowEndless(1_000);
    const t = await probeJobDirectory(tight.reader, { now: tight.now, deadlineAt: START + 2_500 });
    expect(tight.jobList).toHaveBeenCalledTimes(3);
    expect(t.truncated).toBe(true);
    expect(tight.calls[0].deadlineAt).toBe(START + 2_500);

    const wide = slowEndless(1);
    await probeJobDirectory(wide.reader, { now: wide.now, deadlineAt: START + 10 * 60_000, maxPages: 1 });
    expect(wide.calls[0].deadlineAt).toBe(START + 20_000);
  });

  it('refuses to start at all when handed a deadline already in the past', async () => {
    const s = slowEndless(1);
    await expect(probeJobDirectory(s.reader, { now: s.now, deadlineAt: START - 1 })).rejects.toThrow('ashby_job_directory_deadline');
    expect(s.jobList).not.toHaveBeenCalled();
  });
});

describe('probe module has no write capability', () => {
  it('exports no upsert/write/mutate helper', async () => {
    const mod = await import('../integrations/ashby/probe.js');
    const names = Object.keys(mod);
    for (const name of names) {
      expect(name.toLowerCase()).not.toMatch(/upsert|write|create|update|delete|mutate|enable/);
    }
    // It proposes stage ids and reports feedback-form SCHEMA; applying either
    // is a separate admin action. The exact list is asserted so a new export
    // has to be justified here rather than appearing quietly.
    expect(names.sort()).toEqual([
      'PROBE_READ_OPERATIONS',
      'assertReadOnly',
      'extractFeedbackForms',
      // #275: one form definition's STRUCTURE (fields/types/scales), read by the
      // scorecard auto-binder and the Mission Control binding preview.
      'extractFormDefinition',
      'extractStages',
      'probeFeedbackFormDefinition',
      // The Add-mapping picker's job directory: id/title/status/openedAt only.
      'probeJobDirectory',
      'probeJobFeedbackForms',
      'probeJobStages',
    ]);
  });
});
