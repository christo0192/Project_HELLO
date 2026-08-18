/**
 * ashby/probe.ts — READ-ONLY tenant discovery.
 *
 * An Ashby mapping can only ever be enabled once it carries both the AI and TA
 * screening stage ids (a DB CHECK enforces that). Those ids are tenant data
 * that nobody can type from memory, and there was no way to discover them
 * without direct SQL. This is that discovery step.
 *
 * READ-ONLY BY CONSTRUCTION, not by convention:
 *  - `PROBE_READ_OPERATIONS` is an explicit allowlist, and `assertReadOnly`
 *    rejects any operation whose registry entry is `mutation: true`.
 *  - The probe imports no mutating helper and holds no write seam. It cannot
 *    upsert a mapping: it *proposes* stage ids that an admin then applies
 *    through the separate paused-only upsert route.
 *  - There is no caller-controlled URL: the path comes from the fixed
 *    operation registry and the origin is the allowlisted Ashby origin.
 *
 * SANITIZATION: only opaque stage/interview ids and short display titles cross
 * this boundary. Candidate names, emails, phone numbers, resume handles,
 * feedback content, and raw provider bodies are never read or returned.
 */

import { ASHBY_OPERATIONS, type AshbyOperation, type OpaqueRecord } from './types.js';

/** The ONLY operations the probe may perform. Every one is `mutation: false`. */
export const PROBE_READ_OPERATIONS = ['jobInterviewPlan.info'] as const;
export type ProbeReadOperation = (typeof PROBE_READ_OPERATIONS)[number];

/**
 * Fail closed if an operation is not an allowlisted READ. Exported so a test
 * can drive every registry entry through it and prove the mutating ones are
 * unreachable from this module.
 */
export function assertReadOnly(operation: string): asserts operation is ProbeReadOperation {
  if (!(PROBE_READ_OPERATIONS as readonly string[]).includes(operation)) {
    throw new Error('ashby_probe_operation_not_allowed');
  }
  const spec = ASHBY_OPERATIONS[operation as AshbyOperation];
  if (!spec || spec.mutation) {
    throw new Error('ashby_probe_operation_not_allowed');
  }
}

/** A sanitized stage descriptor. Opaque id + bounded display title only. */
export interface ProbeStage {
  id: string;
  title: string | null;
}

export interface ProbeResult {
  /** Sanitized stage list for the job's interview plan. */
  stages: ProbeStage[];
  /** True when the tenant answered but exposed no usable stage list. */
  empty: boolean;
}

/** Narrow reader seam — satisfied by AshbyClient. Injected for tests. */
export interface ProbeReader {
  jobInterviewPlanInfo<T = OpaqueRecord>(jobId: string, extra?: OpaqueRecord): Promise<{ results: T }>;
}

const MAX_STAGES = 100;
const MAX_TITLE_LEN = 120;
const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Strip control characters and bound the length; a tenant-controlled string
  // must never reach a response or a log unbounded.
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').trim().slice(0, MAX_TITLE_LEN);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Pull stage descriptors out of an opaque `jobInterviewPlan.info` payload.
 *
 * The exact envelope shape is tenant-verifiable, so this reads defensively
 * across the plausible shapes rather than locking one speculatively, and
 * copies ONLY `id` and a display title — never any sibling field, so a payload
 * that happens to carry candidate data cannot ride along.
 */
export function extractStages(results: unknown): ProbeStage[] {
  const out: ProbeStage[] = [];
  const seen = new Set<string>();

  const consider = (node: unknown): void => {
    if (out.length >= MAX_STAGES) return;
    if (node === null || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    const id = rec.id ?? rec.interviewStageId ?? rec.stageId;
    if (typeof id === 'string' && ID_RE.test(id) && !seen.has(id)) {
      seen.add(id);
      out.push({ id, title: sanitizeTitle(rec.title ?? rec.name) });
    }
  };

  const walkList = (node: unknown): void => {
    if (!Array.isArray(node)) return;
    for (const item of node) consider(item);
  };

  if (Array.isArray(results)) {
    walkList(results);
    return out;
  }
  if (results !== null && typeof results === 'object') {
    const rec = results as Record<string, unknown>;
    walkList(rec.interviewStages);
    walkList(rec.stages);
    if (out.length === 0) {
      const plan = rec.jobInterviewPlan;
      if (plan !== null && typeof plan === 'object') {
        const p = plan as Record<string, unknown>;
        walkList(p.interviewStages);
        walkList(p.stages);
      }
    }
  }
  return out;
}

/**
 * Probe one job's interview plan. Performs exactly one allowlisted READ and
 * returns sanitized stage descriptors. Never writes anything, anywhere.
 */
export async function probeJobStages(
  externalJobId: string,
  reader: ProbeReader,
): Promise<ProbeResult> {
  assertReadOnly('jobInterviewPlan.info');
  const res = await reader.jobInterviewPlanInfo(externalJobId);
  const stages = extractStages(res.results);
  return { stages, empty: stages.length === 0 };
}
