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
    await ports.onState('scanning', { contentSha256 });
    const scan = await ports.scan(bytes);
    if (!scan.safe) {
      wipe();
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
    } catch {
      wipe();
      await ports.onState('failed_review', { contentSha256, extractorVersion: ports.extractorVersion, failedReason: 'parse_error' });
      return { state: 'failed_review', reason: 'parse_error' };
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
