/**
 * ashby/resume-ingestion.ts — orchestrates ONE ephemeral resume ingestion over
 * injected ports (Wave 2 work item 4). Composes the SSRF-hardened fetch, a
 * FAIL-CLOSED malware scan BEFORE any parse, the magic/MIME guard, the bounded
 * parser, and the deterministic fallback, advancing the 0029 ingestion state
 * machine (queued → fetching → scanning → extracting → structuring → ready |
 * failed_review | cancelled) and recording hash/version provenance only.
 *
 * Security posture:
 *  - The original Ashby bytes are EPHEMERAL: they live in one Buffer, are wiped
 *    (`.fill(0)`) on EVERY terminal path (success, any failure, cancellation,
 *    or a thrown port), and are NEVER written to the resume bucket.
 *  - The malware scan is fail-closed: a not-safe or errored scan blocks the
 *    parse and moves to failed_review — nothing untrusted is ever parsed.
 *  - Structuring is deterministic (regex fallback / bounded parser) — no
 *    provider text can trigger tools or instructions (no LLM in this path).
 *  - Only opaque provenance (content sha256, extractor/structurer versions) and
 *    approved structured fields are surfaced for persistence; raw bytes, the
 *    presigned URL, and any token never cross this boundary.
 *
 * Pure orchestration: DB/network/scanner/parser are all injected, so the whole
 * fetch/scan/parse/fallback/cleanup matrix is deterministically unit-tested.
 */

import type { UrlPolicy } from './ssrf.js';
import type { ResumeFetchOutcome } from './resume-fetch.js';

/** Restart-safe ingestion states (parity with ashby_resume_ingestions). */
export type IngestionState =
  | 'queued' | 'fetching' | 'scanning' | 'extracting' | 'structuring' | 'ready' | 'failed_review' | 'cancelled';

/** Structured resume fields (approved, PII-bearing — persisted to the sensitive model only). */
export interface StructuredResume {
  name: string | null;
  email: string | null;
  phone: string | null;
  skills: string[];
  experience_years: number | null;
  current_role: string | null;
  summary: string | null;
}

/** Scanner verdict shape (subset of the repo malware-scanner ScanResult). */
export interface IngestionScanResult {
  safe: boolean;
  status: string;
}

/**
 * How a not-safe scan status should be treated (see `classifyScanStatus` in
 * lib/malware-scanner). Injected rather than imported so this module stays a
 * pure domain orchestrator with no scanner dependency.
 *
 * `verdict`      → the file was screened; a not-safe verdict is TERMINAL.
 * anything else  → the file was NOT screened; the ingestion DEFERS.
 */
export type ScanClassifier = (status: string) => 'verdict' | 'availability' | 'transient';

/**
 * Default classifier used when a caller injects none: treat every not-safe
 * status as a verdict, i.e. the pre-repair behaviour.
 *
 * Fail-safe in the direction that matters. An unclassified status closes the
 * ingestion out loudly instead of deferring it invisibly, so forgetting to
 * wire the classifier can never create a silent unbounded wait — the failure
 * mode the deferral itself has to be careful about.
 */
export const DEFAULT_SCAN_CLASSIFIER: ScanClassifier = () => 'verdict';

/**
 * How a PARSE failure should be treated.
 *
 * `verdict`    → the parser reached a conclusion ABOUT THIS DOCUMENT (it could
 *                not be extracted, produced no/garbled output, or exceeded a
 *                bound). Retrying re-burns attempts on a file that will fail
 *                identically, so it is TERMINAL.
 * `transient`  → the parser was UNAVAILABLE, not unwilling: it was killed by
 *                the wall-clock timeout on a contended CPU, or the bounded
 *                pool refused the submission. Nothing was learned about the
 *                file, so writing `failed_review` records a wait as a verdict.
 */
export type ParseClassifier = (code: string) => 'verdict' | 'transient';

/**
 * The ONLY parse codes that may defer automatically.
 *
 * Deliberately two, and deliberately not "everything that is not a document
 * verdict": `parse_spawn_error`, `parse_child_exit` and `parse_asset_missing`
 * describe a broken deployment, and a broken deployment that quietly waits is
 * a broken deployment nobody is paged for. Those rest loudly in
 * `failed_review` and are recoverable through the audited admin path.
 */
export const PARSE_TRANSIENT_CODES: ReadonlySet<string> = new Set(['parse_timeout', 'parse_overload']);

/**
 * Default classifier used when a caller injects none: every parse failure is a
 * verdict, i.e. the pre-repair behaviour, byte for byte.
 *
 * Fail-safe in the direction that matters, exactly as {@link DEFAULT_SCAN_CLASSIFIER}
 * is: forgetting to wire the classifier closes an ingestion out loudly instead
 * of parking it in an invisible wait.
 */
export const DEFAULT_PARSE_CLASSIFIER: ParseClassifier = () => 'verdict';

/** The classifier production wires: availability defers, everything else rests. */
export const PARSE_CLASSIFIER: ParseClassifier = (code) =>
  PARSE_TRANSIENT_CODES.has(code) ? 'transient' : 'verdict';

/**
 * Stable codes the parser boundary may emit. `parse_error` is retained as the
 * honest UNKNOWN: an error this module cannot recognise must not be dressed up
 * as a diagnosis it did not make.
 *
 * Every member satisfies the 0029 `failed_reason` shape (`^[a-z0-9_.:-]{1,64}$`).
 */
export const PARSE_FAILURE_CODES = [
  'parse_timeout',
  'parse_overload',
  'parse_output_exceeded',
  'parse_asset_missing',
  'parse_spawn_error',
  'parse_child_exit',
  'parse_no_output',
  'parse_bad_output',
  'parse_extract_failed',
  'parse_error',
] as const;

export type ParseFailureCode = (typeof PARSE_FAILURE_CODES)[number];

/** Stable `code` literals carried by the parser's error classes. */
const PARSER_CODE_MAP: Readonly<Record<string, ParseFailureCode>> = {
  PARSER_TIMEOUT: 'parse_timeout',
  PARSER_OVERLOAD: 'parse_overload',
  PARSER_OUTPUT_EXCEEDED: 'parse_output_exceeded',
  PARSER_ASSET_MISSING: 'parse_asset_missing',
};

/** Stable `detail` literals carried by the generic `ParserError`. */
const PARSER_DETAIL_MAP: Readonly<Record<string, ParseFailureCode>> = {
  spawn_error: 'parse_spawn_error',
  child_exit: 'parse_child_exit',
  no_output: 'parse_no_output',
  bad_output: 'parse_bad_output',
  extract_failed: 'parse_extract_failed',
};

/**
 * Map a thrown parser failure onto ONE stable code.
 *
 * Reads only the parser's fixed `code`/`detail` literals through two closed
 * allowlists — never `err.message`, never `err.stack`, never child `stderr`,
 * never any provider or document text. A value that is not in an allowlist is
 * not "nearly" classified: it collapses to `parse_error`, which is what the
 * durable row said before this function existed.
 *
 * Read STRUCTURALLY rather than with `instanceof` on purpose: this module is a
 * pure domain orchestrator with no dependency on `lib/resume-parser.ts` (which
 * pulls in `node:child_process`), and the classification must not become a
 * reason to import a process spawner into it.
 */
export function classifyParserFailure(err: unknown): ParseFailureCode {
  if (!(err instanceof Error)) return 'parse_error';
  const rec = err as unknown as { code?: unknown; detail?: unknown };
  if (typeof rec.code === 'string') {
    const byCode = PARSER_CODE_MAP[rec.code];
    if (byCode) return byCode;
    if (rec.code === 'PARSER_ERROR' && typeof rec.detail === 'string') {
      const byDetail = PARSER_DETAIL_MAP[rec.detail];
      if (byDetail) return byDetail;
    }
  }
  return 'parse_error';
}

/** A parsed document: extracted text + structured fields + a structurer tag. */
export interface ParseOutput {
  text: string;
  structured: StructuredResume;
  structurerVersion: string;
}

export interface IngestionPorts {
  /** Presigned URL to fetch (from file.info). May be refreshed by the caller. */
  presignedUrl: string;
  /** Host allowlist policy (disabled by default → fetch fails closed). */
  policy: UrlPolicy;
  /** SSRF-hardened ephemeral fetch. */
  fetch: (url: string, policy: UrlPolicy) => Promise<ResumeFetchOutcome>;
  /** Fail-closed malware scan; MUST NOT throw (returns not-safe on error). */
  scan: (bytes: Buffer) => Promise<IngestionScanResult>;
  /** Magic/MIME guard; returns the canonical mime or a sanitized rejection. */
  guard: (bytes: Buffer, contentType: string | null) => { ok: true; mime: string } | { ok: false; reason: string };
  /** Bounded parser (may throw); returns extracted text + structured fields. */
  parse: (bytes: Buffer, mime: string) => Promise<ParseOutput>;
  /** Deterministic fallback from extracted text when the parser yields nothing. */
  fallbackFromText: (text: string) => StructuredResume;
  /** Records a state transition + optional opaque provenance (no bytes/PII-URL). */
  onState: (state: IngestionState, provenance?: IngestionProvenance) => void | Promise<void>;
  /** Extractor version tag for provenance. */
  extractorVersion: string;
  /**
   * Classifies a not-safe scan status into verdict / availability / transient.
   * Defaults to "everything is a verdict" (see DEFAULT_SCAN_CLASSIFIER).
   */
  classifyScan?: ScanClassifier;
  /**
   * Classifies a stable parse failure code into verdict / transient.
   * Defaults to "everything is a verdict" (see DEFAULT_PARSE_CLASSIFIER).
   */
  classifyParse?: ParseClassifier;
}

/** Opaque provenance recorded alongside a state transition. */
export interface IngestionProvenance {
  contentSha256?: string;
  extractorVersion?: string;
  structurerVersion?: string;
  failedReason?: string;
}

export type IngestionOutcome =
  | { state: 'ready'; structured: StructuredResume; provenance: IngestionProvenance }
  | { state: 'failed_review'; reason: string }
  /**
   * NOT a state in the 0029 state machine, and deliberately so: the durable
   * row is left exactly where it was and carries no failure reason. This says
   * "the file was never screened — ask again later", and the CALLER decides
   * how to wait (the queue defers the job, refunding its attempt).
   *
   * Adding a ninth ingestion state would mean editing the 0029 transition
   * trigger and every legality proof built on eight, for a property that is
   * orthogonal to the state machine.
   */
  | {
      state: 'deferred';
      reason: string;
      /**
       * The status/code that caused the deferral. Named for the scan class it
       * was introduced for; for a parse deferral it carries the stable parse
       * code, and {@link IngestionOutcome.deferSource} is what distinguishes
       * them.
       */
      scanStatus: string;
      /**
       * Which step deferred. Absent means `scan` — the only deferral that
       * existed before parse deferral was added — so an older consumer keeps
       * its exact prior meaning.
       */
      deferSource?: 'scan' | 'parse';
    }
  | { state: 'cancelled'; reason: string };

/** Whether the ingestion should abort as cancelled before a step (terminal link). */
export type CancelCheck = () => boolean | Promise<boolean>;

function usefulStructured(s: StructuredResume): boolean {
  return Boolean(s.name || s.email || s.phone || s.current_role || s.summary || (s.skills && s.skills.length > 0));
}

/**
 * Run one ephemeral ingestion. `isCancelled` is polled before each externally
 * observable step so a human stage departure / withdrawal / deletion aborts the
 * remaining work (terminal-cancel). The original bytes are always wiped.
 */
export async function runResumeIngestion(
  ports: IngestionPorts,
  isCancelled: CancelCheck = () => false,
): Promise<IngestionOutcome> {
  let bytes: Buffer | null = null;
  const wipe = (): void => {
    if (bytes) {
      try { bytes.fill(0); } catch { /* best-effort scrub */ }
      bytes = null;
    }
  };

  try {
    if (await isCancelled()) {
      await ports.onState('cancelled');
      return { state: 'cancelled', reason: 'cancelled_before_fetch' };
    }

    // ── fetching ──────────────────────────────────────────────────────────
    await ports.onState('fetching');
    const fetched = await ports.fetch(ports.presignedUrl, ports.policy);
    if (!fetched.ok) {
      await ports.onState('failed_review', { failedReason: `fetch_${fetched.reason}` });
      return { state: 'failed_review', reason: `fetch_${fetched.reason}` };
    }
    bytes = fetched.bytes;
    const contentSha256 = fetched.sha256;

    if (await isCancelled()) {
      wipe();
      await ports.onState('cancelled');
      return { state: 'cancelled', reason: 'cancelled_after_fetch' };
    }

    // ── scanning (FAIL CLOSED before any parse) ──────────────────────────
    // The fail-closed posture is unchanged and must not be softened: nothing
    // unscanned is ever parsed. What changed is the DISPOSITION of a not-safe
    // result. An `infected` verdict is terminal, as it always was. A scanner
    // that could not screen at all (no signatures, busy, timed out) is not a
    // statement about this file, and writing it down as one permanently
    // condemned a resume for a machine that was not warmed up yet.
    await ports.onState('scanning', { contentSha256 });
    const scan = await ports.scan(bytes);
    if (!scan.safe) {
      const classify = ports.classifyScan ?? DEFAULT_SCAN_CLASSIFIER;
      const klass = classify(scan.status);
      // The bytes are wiped on the deferral path too. This is a NEW exit from
      // the pipeline, and the wipe-on-every-exit guarantee has to extend to it
      // or the deferral leaks the very thing the ephemeral design protects.
      wipe();
      if (klass !== 'verdict') {
        // No `onState` call at all: the row keeps its current state and gains
        // no failure reason, so nothing downstream (invite prerequisites, the
        // `operationsBlockedFailedIngestion` health counter) reads a wait as
        // work that needs a human.
        return { state: 'deferred', reason: `scan_${scan.status}`, scanStatus: scan.status };
      }
      await ports.onState('failed_review', { contentSha256, failedReason: `scan_${scan.status}` });
      return { state: 'failed_review', reason: `scan_${scan.status}` };
    }

    // ── extracting (magic/MIME guard + parse) ────────────────────────────
    await ports.onState('extracting', { contentSha256 });
    const guard = ports.guard(bytes, fetched.contentType);
    if (!guard.ok) {
      wipe();
      await ports.onState('failed_review', { contentSha256, failedReason: `guard_${guard.reason}` });
      return { state: 'failed_review', reason: `guard_${guard.reason}` };
    }

    let parsed: ParseOutput;
    try {
      parsed = await ports.parse(bytes, guard.mime);
    } catch (parseErr) {
      // The durable row is `extracting` at this point (the transition above is
      // what makes the guard/parse step observable), so this is the state the
      // deferral has to be legal FROM — not `queued`. See migration 0039.
      const code = classifyParserFailure(parseErr);
      // Wiped before either exit. The deferral is a NEW way out of the
      // pipeline and the wipe-on-every-exit guarantee extends to it, or the
      // wait leaks the very bytes the ephemeral design protects.
      wipe();
      const classifyParse = ports.classifyParse ?? DEFAULT_PARSE_CLASSIFIER;
      if (classifyParse(code) === 'transient') {
        // No `onState` at all: the row keeps `extracting` and gains no failure
        // reason, so nothing downstream (the invite prerequisite, the
        // failed-parse health counter) reads an unavailable parser as a
        // document that needs a human. The CALLER decides how to wait.
        return { state: 'deferred', reason: code, scanStatus: code, deferSource: 'parse' };
      }
      await ports.onState('failed_review', { contentSha256, extractorVersion: ports.extractorVersion, failedReason: code });
      return { state: 'failed_review', reason: code };
    }

    // ── structuring (deterministic; fallback preserved) ──────────────────
    await ports.onState('structuring', {
      contentSha256,
      extractorVersion: ports.extractorVersion,
      structurerVersion: parsed.structurerVersion,
    });
    let structured = parsed.structured;
    let structurerVersion = parsed.structurerVersion;
    if (!usefulStructured(structured)) {
      // Deterministic regex fallback — no provider text can trigger tools here.
      structured = ports.fallbackFromText(parsed.text);
      structurerVersion = `${parsed.structurerVersion}+fallback`;
    }

    if (!usefulStructured(structured)) {
      wipe();
      await ports.onState('failed_review', { contentSha256, extractorVersion: ports.extractorVersion, structurerVersion, failedReason: 'no_extractable_fields' });
      return { state: 'failed_review', reason: 'no_extractable_fields' };
    }

    // ── ready ────────────────────────────────────────────────────────────
    const provenance: IngestionProvenance = {
      contentSha256,
      extractorVersion: ports.extractorVersion,
      structurerVersion,
    };
    // Original bytes are dropped BEFORE marking ready — never uploaded anywhere.
    wipe();
    await ports.onState('ready', provenance);
    return { state: 'ready', structured, provenance };
  } catch (err) {
    // Any unexpected throw (incl. from a port or onState) fails closed with the
    // bytes wiped — never leave the original resume bytes resident.
    wipe();
    try {
      await ports.onState('failed_review', { failedReason: 'unexpected_error' });
    } catch { /* onState best-effort on the error path */ }
    void err;
    return { state: 'failed_review', reason: 'unexpected_error' };
  } finally {
    wipe();
  }
}
