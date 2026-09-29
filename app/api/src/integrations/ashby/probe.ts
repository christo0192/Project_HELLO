/**
 * ashby/probe.ts — READ-ONLY tenant discovery.
 *
 * An Ashby mapping can only ever be enabled once it carries both the AI and TA
 * screening stage ids (a DB CHECK enforces that). Those ids are tenant data
 * that nobody can type from memory, and there was no way to discover them
 * without direct SQL. This is that discovery step. The same holds for the job
 * id a mapping is keyed on: the job directory read ({@link probeJobDirectory})
 * lets an admin pick a job by name instead of pasting an opaque id.
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
 * SANITIZATION: only opaque stage/interview/job ids, short display titles, and
 * a job's closed-vocabulary status and open date cross this boundary.
 * Candidate names, emails (including the hiring-team emails a job carries),
 * phone numbers, resume handles, feedback content, and raw provider bodies are
 * never read or returned.
 */

import { ASHBY_OPERATIONS, type AshbyOperation, type JobListParams, type OpaqueRecord } from './types.js';

/**
 * The ONLY operations the probe may perform. Every one is `mutation: false`.
 * `feedbackFormDefinition.info` returns a form's STRUCTURE (sections, fields,
 * types, scales) and no submitted feedback — it is what makes the scorecard
 * auto-binder and the Mission Control binding preview possible. `job.list` is
 * the job directory behind the "Add mapping" picker; the probe copies four
 * named fields off each job and nothing else (see {@link probeJobDirectory}).
 */
export const PROBE_READ_OPERATIONS = ['jobInterviewPlan.info', 'feedbackFormDefinition.info', 'job.list'] as const;
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

/** Reader seam for one form definition — satisfied by AshbyClient. */
export interface FormDefinitionReader {
  feedbackFormDefinitionInfo<T = OpaqueRecord>(
    feedbackFormDefinitionId: string,
    extra?: OpaqueRecord,
  ): Promise<{ results: T }>;
}

const MAX_STAGES = 100;
const MAX_TITLE_LEN = 120;
const ID_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

/**
 * What a display title may not carry. Each run becomes ONE space:
 *  - C0 controls, DEL and the C1 controls (U+0000–U+001F, U+007F–U+009F);
 *  - U+2028 LINE / U+2029 PARAGRAPH SEPARATOR, which break a line in a log
 *    or a UI exactly as a newline does;
 *  - every Unicode FORMAT character (`\p{Cf}`): bidi embeddings, overrides
 *    and isolates (U+202A–U+202E, U+2066–U+2069), zero-width space/joiners
 *    (U+200B–U+200D), word joiner, BOM, soft hyphen, … All invisible, and
 *    the bidi ones make a title RENDER as different text from what it is —
 *    an admin picks a job by name, so the name must be the one it looks like.
 */
const TITLE_UNSAFE_RE = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\p{Cf}]+/gu;

/**
 * Sanitize a tenant-controlled display title: NFC-normalize (one spelling per
 * look), replace unsafe characters with a space, collapse space runs, trim,
 * and only THEN bound, so the bound counts visible text. A title made of
 * nothing but invisible characters is `null`, not an empty-looking entry.
 * Shared by every probe surface (stages, forms, fields, jobs).
 */
function sanitizeTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .normalize('NFC')
    .replace(TITLE_UNSAFE_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  // A tenant-controlled string must never reach a response or a log
  // unbounded. The cut may land inside a surrogate pair; drop the orphaned
  // high half rather than emit half a character.
  const bounded = cleaned.slice(0, MAX_TITLE_LEN).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
  return bounded.length > 0 ? bounded : null;
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
   * form has no fields. The field-level schema comes from
   * `feedbackFormDefinition.info` (see {@link probeFeedbackFormDefinition}).
   */
  schemaAvailable: boolean;
  /** True when the definition itself says it is archived (definition reads only). */
  archived?: boolean;
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

/**
 * Pull ONE form definition's schema out of an opaque `feedbackFormDefinition.info`
 * payload (`results: { id, title, isArchived, formDefinition: { sections } }`).
 *
 * Reuses the same bounded, allowlisted field walk as the plan extractor (the
 * definition is wrapped in a one-form plan-shaped envelope), so the two
 * discovery paths cannot drift in what they are willing to read. Returns
 * `null` when the payload names no usable form id — an id is never invented.
 */
export function extractFormDefinition(results: unknown): ProbeFeedbackForm | null {
  if (results === null || typeof results !== 'object' || Array.isArray(results)) return null;
  const rec = results as Record<string, unknown>;
  const id = typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : null;
  if (id === null) return null;
  // Present the definition to the plan extractor as a single form-bearing root.
  const { forms } = extractFeedbackForms({ feedbackFormDefinitions: [results] });
  const form = forms.find((f) => f.formDefinitionId === id) ?? null;
  if (form === null) return null;
  // A definition that reports ZERO fields is not a form with no fields — an
  // Ashby feedback form always has some — it is a shape this extractor could
  // not read. Say "unavailable" so the caller waits and retries rather than
  // binding nothing and writing an empty card it can never rewrite.
  const usable = form.fieldCount > 0 ? form : { ...form, schemaAvailable: false };
  return rec.isArchived === true ? { ...usable, archived: true } : usable;
}

/**
 * Read one feedback form's definition. Exactly one allowlisted READ; returns
 * sanitized STRUCTURE only. `null` when the tenant answered with no usable
 * definition (the caller treats that as "cannot bind", never as a guess).
 */
export async function probeFeedbackFormDefinition(
  feedbackFormDefinitionId: string,
  reader: FormDefinitionReader,
): Promise<ProbeFeedbackForm | null> {
  assertReadOnly('feedbackFormDefinition.info');
  const res = await reader.feedbackFormDefinitionInfo(feedbackFormDefinitionId);
  return extractFormDefinition(res.results);
}

// ════════════════════════════════════════════════════════════════════════════
//  Job directory
//
//  WHY: a mapping is keyed on Ashby's opaque job id, and asking an admin to
//  paste one invites a typo that maps the wrong job. The Mission Control
//  "Add mapping" picker lists jobs BY NAME instead; this is its source.
//
//  SCOPE — one allowlisted READ (`job.list`), paged and bounded. A job in that
//  payload carries far more than a picker needs: its `hiringTeam` (people's
//  names and emails), `customFields`, locations, compensation. None of it is
//  read. Each entry is rebuilt from four named keys, so a sibling the provider
//  adds later is unreachable, not merely filtered.
//
//  CONFIDENTIAL JOBS ARE WITHHELD — FAIL-CLOSED. Ashby restricts a
//  confidential job — whose title alone can disclose a reorg or a replacement
//  hire — to the users it was explicitly shared with. The API key reads
//  straight through that restriction and every admin of this app can open the
//  picker, so listing the job here would WIDEN the audience Ashby deliberately
//  narrowed. A job is therefore listed ONLY when its payload says, literally,
//  `confidential: false`; true, null, a string, or no flag at all withholds it
//  (a payload that does not say "not confidential" is not trusted to mean it).
//  Withheld jobs are COUNTED (distinct ids, nothing else) so the UI can say
//  some jobs are not shown. POST /mappings still accepts any valid job id;
//  this surface simply never advertises a withheld one.
//
//  PARTIAL IS NOT FAILURE. A bound (pages, items, the overall deadline), a
//  repeated cursor, or a "more data" page with no cursor stops the walk with
//  `truncated: true` and returns what was read — an admin still gets a usable
//  picker, and the flag lets the UI say the list is incomplete. A provider
//  error, by contrast, propagates (as does a deadline hit before ANY page
//  arrived): the route answers 502 rather than presenting an empty directory
//  as the truth.
// ════════════════════════════════════════════════════════════════════════════

/** Ashby's job lifecycle vocabulary. Any other value is reported as `null`. */
export type ProbeJobStatus = 'Draft' | 'Open' | 'Closed' | 'Archived';

/** One sanitized directory entry: four fields, each copied by name. */
export interface ProbeJob {
  /** Opaque Ashby job id — what a mapping's `external_job_id` stores. */
  id: string;
  title: string | null;
  status: ProbeJobStatus | null;
  /** ISO-8601, or `null` when the payload carried no parseable date. */
  openedAt: string | null;
}

export interface ProbeJobDirectory {
  /** Sorted by title (case/accent-insensitive); untitled jobs last. */
  jobs: ProbeJob[];
  /** True when the walk stopped before the provider said it was done. */
  truncated: boolean;
  /**
   * How many DISTINCT jobs the walk saw and withheld because they were not
   * explicitly `confidential: false`. A count only — never an id or title.
   */
  withheld: number;
}

/** Reader seam for one `job.list` page — satisfied by AshbyClient. */
export interface JobListReader {
  jobList<T = OpaqueRecord[]>(params?: JobListParams): Promise<{
    results: T;
    moreDataAvailable: boolean;
    nextCursor?: string;
  }>;
}

const JOB_PAGE_SIZE = 100;
const MAX_JOB_PAGES = 20;
const MAX_JOBS = 2000;
/**
 * Overall budget for ONE directory walk, every page and retry included. Each
 * page already has its own client timeout; this bounds the sum, so a slow
 * tenant cannot hold an admin's request (and a shared in-flight walk) for
 * 20 pages × timeout × retries.
 */
const JOB_DIRECTORY_DEADLINE_MS = 20_000;
/** An ISO-8601 timestamp is ~30 chars; anything far longer is not a date. */
const MAX_DATE_LEN = 64;
const JOB_STATUSES: ReadonlySet<string> = new Set<ProbeJobStatus>(['Draft', 'Open', 'Closed', 'Archived']);

function jobStatus(raw: unknown): ProbeJobStatus | null {
  return typeof raw === 'string' && JOB_STATUSES.has(raw) ? (raw as ProbeJobStatus) : null;
}

/** A parseable date string, normalised to ISO-8601. Never a guess. */
function isoDate(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_DATE_LEN) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Whether a job may be LISTED. Fail-closed: only a literal `false` lists it.
 * `true`, `null`, `"false"`, any other value, and an ABSENT flag all withhold
 * — a restriction this code cannot positively read as "none" is treated as a
 * restriction.
 */
function isListable(confidential: unknown): boolean {
  return confidential === false;
}

/** Caps may only TIGHTEN a bound (tests); they can never widen one. */
function tightenCap(raw: number | undefined, ceiling: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? Math.min(raw, ceiling) : ceiling;
}

/**
 * Whether a failed page read was the walk's deadline running out: the
 * client's own `deadline_exceeded`, or any failure once the clock is past the
 * deadline (a request cut short by the shortened timeout surfaces as a
 * timeout or network error first).
 */
function isDeadlineHit(err: unknown, now: number, deadlineAt: number): boolean {
  return (err as { code?: unknown } | null)?.code === 'deadline_exceeded' || now >= deadlineAt;
}

/** Title order, case- and accent-insensitive; untitled last; id breaks ties. */
function byTitle(a: ProbeJob, b: ProbeJob): number {
  if (a.title !== null && b.title !== null) {
    const order = a.title.localeCompare(b.title, 'en', { sensitivity: 'base' });
    if (order !== 0) return order;
  } else if (a.title !== b.title) {
    return a.title === null ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * List the tenant's job directory for the mapping picker. Pages `job.list`
 * with no filter (whether the endpoint honours one is unverified), keeps only
 * id/title/status/openedAt per job, withholds (and counts) every job not
 * explicitly non-confidential, and dedupes by id. Never writes anything,
 * anywhere.
 *
 * `caps` may only TIGHTEN a bound: pages, items, and `deadlineAt` (epoch ms,
 * capped at {@link JOB_DIRECTORY_DEADLINE_MS} from the start). `now` is the
 * wall clock — injectable for tests; with a real client it must be epoch ms,
 * because the client compares the threaded `deadlineAt` against `Date.now()`.
 */
export async function probeJobDirectory(
  reader: JobListReader,
  caps: { maxPages?: number; maxItems?: number; deadlineAt?: number; now?: () => number } = {},
): Promise<ProbeJobDirectory> {
  assertReadOnly('job.list');
  const maxPages = tightenCap(caps.maxPages, MAX_JOB_PAGES);
  const maxItems = tightenCap(caps.maxItems, MAX_JOBS);
  const now = caps.now ?? Date.now;
  const ownDeadline = now() + JOB_DIRECTORY_DEADLINE_MS;
  const deadlineAt = typeof caps.deadlineAt === 'number' && Number.isFinite(caps.deadlineAt)
    ? Math.min(caps.deadlineAt, ownDeadline)
    : ownDeadline;

  const jobs = new Map<string, ProbeJob>();
  // An id seen withheld ONCE stays withheld, even if a later page (the
  // directory can shift under a paged read) shows it as `confidential: false`.
  const withheld = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let truncated = false;
  let pagesRead = 0;

  for (let page = 1; ; page += 1) {
    // ONE budget for the whole walk. Out of time with pages in hand → the
    // partial list, flagged; out of time with nothing → a failure (502).
    if (now() >= deadlineAt) {
      if (pagesRead === 0) throw new Error('ashby_job_directory_deadline');
      truncated = true;
      break;
    }
    let res: Awaited<ReturnType<JobListReader['jobList']>>;
    try {
      res = await reader.jobList(
        cursor === undefined
          ? { limit: JOB_PAGE_SIZE, deadlineAt }
          : { cursor, limit: JOB_PAGE_SIZE, deadlineAt },
      );
    } catch (err) {
      if (pagesRead > 0 && isDeadlineHit(err, now(), deadlineAt)) {
        truncated = true;
        break;
      }
      throw err;
    }
    pagesRead += 1;
    const items: unknown[] = Array.isArray(res.results) ? res.results : [];
    for (const item of items) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      const id = typeof rec.id === 'string' && ID_RE.test(rec.id) ? rec.id : null;
      if (id === null) continue;
      if (!isListable(rec.confidential)) {
        withheld.add(id);
        jobs.delete(id);
        continue;
      }
      if (withheld.has(id) || jobs.has(id)) continue;
      if (jobs.size >= maxItems) { truncated = true; break; }
      jobs.set(id, {
        id,
        title: sanitizeTitle(rec.title),
        status: jobStatus(rec.status),
        openedAt: isoDate(rec.openedAt),
      });
    }
    if (truncated || !res.moreDataAvailable) break;

    // The provider says there is more. Anything that stops us now leaves the
    // directory partial, and the flag says so.
    const next = res.nextCursor;
    if (typeof next !== 'string' || next.length === 0
        || seenCursors.has(next) || page >= maxPages || jobs.size >= maxItems) {
      truncated = true;
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }

  return { jobs: [...jobs.values()].sort(byTitle), truncated, withheld: withheld.size };
}
