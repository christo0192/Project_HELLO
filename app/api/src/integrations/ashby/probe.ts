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

// ════════════════════════════════════════════════════════════════════════════
//  Feedback-form schema discovery
//
//  WHY: HR builds a feedback form in the Ashby UI, but that UI never shows the
//  internal form/section/field ids. `bindFeedbackForm` (scorecard.ts) fails
//  closed without those ids, so there is no way to even *review* what a tenant
//  form looks like without direct provider access. This is the read-only
//  discovery half of that gap — it produces a sanitized schema an admin reads
//  and copies by hand into an approved configuration process. It binds nothing
//  and persists nothing.
//
//  SCOPE — deliberately one operation:
//    * The ONLY read is the already-allowlisted `jobInterviewPlan.info`.
//    * `applicationFeedback.list` is NEVER called. No feedback CONTENT — no
//      answer, score, comment, rating, or interviewer note — is read anywhere
//      in this module. Only form STRUCTURE crosses the boundary.
//
//  HOW IT STAYS SANITIZED: the walk is a fixed-shape descent through an
//  explicit container-key allowlist and it never enumerates a provider
//  object's own keys. A field is copied key-by-key from a second allowlist. A
//  sibling the provider adds later — `candidateEmail`, `answers`,
//  `submittedValue` — is therefore unreachable, not merely filtered.
//  `descriptionHtml` is read by nobody: it is unbounded tenant HTML, and
//  understanding a scale never needs it.
// ════════════════════════════════════════════════════════════════════════════

/** One selectable value of a rating/select field — the scale, not an answer. */
export interface ProbeFormOption {
  /** Stored value the provider expects on submit. */
  value: string | null;
  /** Human label shown in the Ashby UI. */
  label: string | null;
}

/** One sanitized form field. `id` is the opaque id a binding would need. */
export interface ProbeFormField {
  id: string;
  title: string | null;
  /** Provider field path (e.g. `overall_recommendation`), when present. */
  path: string | null;
  /** Provider input type (e.g. `ValueSelect`, `String`), when present. */
  type: string | null;
  /** From `isRequired` only. `null` means the payload did not say — never inferred. */
  required: boolean | null;
  /** Bounded scale metadata; empty for free-text fields. */
  options: ProbeFormOption[];
  /** True when this field's options hit the per-field bound. */
  optionsTruncated: boolean;
}

export interface ProbeFormSection {
  /** Opaque section id when the payload carries one. */
  id: string | null;
  title: string | null;
  fields: ProbeFormField[];
}

export interface ProbeFeedbackForm {
  /** Opaque feedback-form definition id. */
  formDefinitionId: string;
  title: string | null;
  /** Interview this form is attached to, when the plan says so. */
  interviewId: string | null;
  interviewTitle: string | null;
  /** Interview-plan stage the interview sits in, when the plan says so. */
  stageId: string | null;
  stageTitle: string | null;
  sections: ProbeFormSection[];
  fieldCount: number;
  /**
   * FALSE means the plan payload named this form but carried no field-level
   * schema — the id is real, and the empty `sections` is NOT a claim that the
   * form has no fields. Reading fields needs `feedbackFormDefinition.info`,
   * which is not in this integration's operation registry.
   */
  schemaAvailable: boolean;
}

export interface ProbeFormsResult {
  forms: ProbeFeedbackForm[];
  /** True when the tenant answered but named no feedback form at all. */
  empty: boolean;
  /** True when any bound clipped the result — the view is partial, not whole. */
  truncated: boolean;
}

const MAX_FORMS = 50;
const MAX_SECTIONS_PER_FORM = 50;
const MAX_FIELDS_PER_FORM = 200;
const MAX_OPTIONS_PER_FIELD = 40;
const MAX_LIST_ITEMS = 200;
const MAX_PATH_LEN = 160;
const MAX_TYPE_LEN = 64;
const MAX_OPTION_TEXT_LEN = 120;
/** Provider input types are identifiers; anything else fails closed to null. */
const TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Replace C0/DEL control characters with a space. Explicit, no escapes. */
function stripControl(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out;
}

/** Bound + strip control characters from a tenant string. Finite numbers are safe. */
function sanitizeText(raw: unknown, max: number): string | null {
  const source = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  if (typeof source !== 'string') return null;
  const cleaned = stripControl(source).trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/** Accept an opaque provider id, or nothing. Never fabricates one. */
function opaqueId(raw: unknown): string | null {
  return typeof raw === 'string' && ID_RE.test(raw) ? raw : null;
}

/** Where a form was found in the plan. All fields optional — never guessed. */
interface FormAnchor {
  stageId: string | null;
  stageTitle: string | null;
  interviewId: string | null;
  interviewTitle: string | null;
}

const NO_ANCHOR: FormAnchor = { stageId: null, stageTitle: null, interviewId: null, interviewTitle: null };

/**
 * Pull feedback-form schema metadata out of an opaque `jobInterviewPlan.info`
 * payload. Pure: no I/O, no logging, and the input is never mutated.
 *
 * Ashby's documented plan shape is
 * `results.stages[].activities[].interviews[]`; overlay/older variants nest
 * under `results.jobInterviewPlan` or expose `interviewStages`/`interviews`
 * directly. Those are read defensively; every other shape yields nothing
 * rather than a guess.
 */
export function extractFeedbackForms(results: unknown): ProbeFormsResult {
  const forms = new Map<string, ProbeFeedbackForm>();
  /** Cycle safety: a self-referential payload must terminate, not hang. */
  const visited = new WeakSet<object>();
  let truncated = false;

  const asRecord = (node: unknown): Record<string, unknown> | null =>
    node !== null && typeof node === 'object' && !Array.isArray(node)
      ? (node as Record<string, unknown>)
      : null;

  /** Bounded array read. A non-array (or an over-long one) never runs wild. */
  const asList = (node: unknown): unknown[] => {
    if (!Array.isArray(node)) return [];
    if (node.length > MAX_LIST_ITEMS) truncated = true;
    return node.slice(0, MAX_LIST_ITEMS);
  };

  /** Visit each object once. False when already seen (or not an object). */
  const enter = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false;
    if (visited.has(node as object)) return false;
    visited.add(node as object);
    return true;
  };

  const extractOptions = (raw: unknown): { options: ProbeFormOption[]; clipped: boolean } => {
    const options: ProbeFormOption[] = [];
    let clipped = false;
    for (const entry of asList(raw)) {
      if (options.length >= MAX_OPTIONS_PER_FIELD) { clipped = true; break; }
      const rec = asRecord(entry);
      if (rec) {
        // ONLY `label` and `value` — the two keys that describe a scale point.
        const label = sanitizeText(rec.label, MAX_OPTION_TEXT_LEN);
        const value = sanitizeText(rec.value, MAX_OPTION_TEXT_LEN);
        if (label === null && value === null) continue;
        options.push({ value, label });
        continue;
      }
      // Some scales arrive as bare scalars rather than {label,value} pairs.
      const scalar = sanitizeText(entry, MAX_OPTION_TEXT_LEN);
      if (scalar !== null) options.push({ value: scalar, label: null });
    }
    return { options, clipped };
  };

  /**
   * Read a form definition's sections/fields. Ashby wraps each field as
   * `{ isRequired, field: {...} }`; flat variants are accepted too. A field
   * without a usable opaque id is dropped — an id is never invented.
   */
  const extractSections = (
    definition: Record<string, unknown>,
  ): { sections: ProbeFormSection[]; fieldCount: number } => {
    const sections: ProbeFormSection[] = [];
    const seenFieldIds = new Set<string>();
    let budget = MAX_FIELDS_PER_FORM;

    for (const rawSection of asList(definition.sections)) {
      if (sections.length >= MAX_SECTIONS_PER_FORM) { truncated = true; break; }
      const section = asRecord(rawSection);
      if (!section || !enter(section)) continue;

      const fields: ProbeFormField[] = [];
      for (const rawField of asList(section.fields)) {
        if (budget <= 0) { truncated = true; break; }
        const wrapper = asRecord(rawField);
        if (!wrapper) continue;
        const inner = asRecord(wrapper.field) ?? wrapper;
        const id = opaqueId(inner.id);
        if (id === null || seenFieldIds.has(id)) continue;
        seenFieldIds.add(id);
        budget -= 1;

        // `isRequired` is authoritative. `isNullable` is deliberately NOT
        // folded in: inverting it would be an inference, and a human reads
        // this surface to decide a real configuration.
        const required =
          typeof wrapper.isRequired === 'boolean' ? wrapper.isRequired
            : typeof inner.isRequired === 'boolean' ? inner.isRequired
              : null;

        // Read ONE char past the bound so an over-long value fails TYPE_RE and
        // becomes null, rather than a 64-char stub that reads like a real type.
        const rawType = sanitizeText(inner.type, MAX_TYPE_LEN + 1);
        const { options, clipped } = extractOptions(inner.selectableValues);
        if (clipped) truncated = true;

        fields.push({
          id,
          title: sanitizeTitle(inner.title),
          path: sanitizeText(inner.path, MAX_PATH_LEN),
          type: rawType !== null && TYPE_RE.test(rawType) ? rawType : null,
          required,
          options,
          optionsTruncated: clipped,
        });
      }
      sections.push({ id: opaqueId(section.id), title: sanitizeTitle(section.title), fields });
    }
    return { sections, fieldCount: seenFieldIds.size };
  };

  /**
   * Record one discovered form. Deduped by opaque id (a form reused across
   * interviews is one row). The FIRST sighting owns the anchor; a later
   * sighting only ever upgrades a bare reference into a schema, never
   * downgrades one.
   */
  const addForm = (
    formDefinitionId: string,
    title: string | null,
    schema: { sections: ProbeFormSection[]; fieldCount: number } | null,
    anchor: FormAnchor,
  ): void => {
    const existing = forms.get(formDefinitionId);
    if (existing) {
      if (!existing.schemaAvailable && schema !== null) {
        existing.sections = schema.sections;
        existing.fieldCount = schema.fieldCount;
        existing.schemaAvailable = true;
      }
      if (existing.title === null && title !== null) existing.title = title;
      return;
    }
    if (forms.size >= MAX_FORMS) { truncated = true; return; }
    forms.set(formDefinitionId, {
      formDefinitionId,
      title,
      interviewId: anchor.interviewId,
      interviewTitle: anchor.interviewTitle,
      stageId: anchor.stageId,
      stageTitle: anchor.stageTitle,
      sections: schema?.sections ?? [],
      fieldCount: schema?.fieldCount ?? 0,
      schemaAvailable: schema !== null,
    });
  };

  /** An embedded definition: `{ id, title, formDefinition: { sections } }`. */
  const visitDefinition = (node: unknown, anchor: FormAnchor): void => {
    const rec = asRecord(node);
    if (!rec || !enter(rec)) return;
    const id = opaqueId(rec.id) ?? opaqueId(rec.feedbackFormDefinitionId);
    if (id === null) return;
    const body = asRecord(rec.formDefinition) ?? rec;
    const schema = Array.isArray(body.sections) ? extractSections(body) : null;
    addForm(id, sanitizeTitle(rec.title), schema, anchor);
  };

  /** Any node may name a form by id and/or embed its definition. */
  const visitFormBearer = (rec: Record<string, unknown>, anchor: FormAnchor): void => {
    const refId = opaqueId(rec.feedbackFormDefinitionId) ?? opaqueId(rec.feedbackFormId);
    if (refId !== null) addForm(refId, null, null, anchor);
    visitDefinition(rec.feedbackFormDefinition, anchor);
    visitDefinition(rec.feedbackForm, anchor);
  };

  const visitInterview = (node: unknown, stage: FormAnchor): void => {
    const rec = asRecord(node);
    if (!rec || !enter(rec)) return;
    const anchor: FormAnchor = {
      stageId: stage.stageId,
      stageTitle: stage.stageTitle,
      interviewId: opaqueId(rec.interviewId) ?? opaqueId(rec.id),
      interviewTitle: sanitizeTitle(rec.title ?? rec.name),
    };
    visitFormBearer(rec, anchor);
  };

  const visitStage = (node: unknown): void => {
    const rec = asRecord(node);
    if (!rec || !enter(rec)) return;
    const stage: FormAnchor = {
      stageId: opaqueId(rec.id) ?? opaqueId(rec.interviewStageId) ?? opaqueId(rec.stageId),
      stageTitle: sanitizeTitle(rec.title ?? rec.name),
      interviewId: null,
      interviewTitle: null,
    };
    // A stage itself may name a form (some plan variants hang it here).
    visitFormBearer(rec, stage);
    for (const rawActivity of asList(rec.activities)) {
      const activity = asRecord(rawActivity);
      if (!activity || !enter(activity)) continue;
      for (const interview of asList(activity.interviews)) visitInterview(interview, stage);
    }
    // Defensive: a variant that skips the `activities` level.
    for (const interview of asList(rec.interviews)) visitInterview(interview, stage);
  };

  // ── Roots ────────────────────────────────────────────────────────────────
  if (Array.isArray(results)) {
    for (const stage of asList(results)) visitStage(stage);
  } else {
    const root = asRecord(results);
    const roots: Record<string, unknown>[] = [];
    if (root) {
      roots.push(root);
      for (const key of ['jobInterviewPlan', 'interviewPlan'] as const) {
        const nested = asRecord(root[key]);
        if (nested) roots.push(nested);
      }
    }
    for (const node of roots) {
      if (!enter(node)) continue;
      for (const stage of asList(node.stages)) visitStage(stage);
      for (const stage of asList(node.interviewStages)) visitStage(stage);
      for (const interview of asList(node.interviews)) visitInterview(interview, NO_ANCHOR);
      for (const definition of asList(node.feedbackFormDefinitions)) visitDefinition(definition, NO_ANCHOR);
      visitFormBearer(node, NO_ANCHOR);
    }
  }

  const out = [...forms.values()];
  return { forms: out, empty: out.length === 0, truncated };
}

/**
 * Discover the feedback-form schema metadata reachable from one job's
 * interview plan. Performs exactly one allowlisted READ and returns only
 * sanitized schema — never a form ANSWER, and never `applicationFeedback.list`.
 */
export async function probeJobFeedbackForms(
  externalJobId: string,
  reader: ProbeReader,
): Promise<ProbeFormsResult> {
  assertReadOnly('jobInterviewPlan.info');
  const res = await reader.jobInterviewPlanInfo(externalJobId);
  return extractFeedbackForms(res.results);
}
