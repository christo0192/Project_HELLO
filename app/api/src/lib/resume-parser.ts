/**
 * resume-parser.ts — Isolated resume text extraction via child process (SEC-14).
 *
 * Design:
 *  - Spawns a child process using Node's own binary (`process.execPath`) to run
 *    `resume-parser-child.mjs`. Production fails CLOSED when the compiled `.mjs`
 *    asset is missing: it throws a stable {@link ParserAssetMissingError} BEFORE
 *    spawning or sending any file bytes, and never silently falls back to tsx.
 *    A `.ts`/tsx fallback is only used when a caller explicitly opts in
 *    (`allowTsxFallback: true`) for development/test.
 *  - The raw file bytes are streamed to the child via BINARY stdin (no base64
 *    expansion), never via argv/logs. The validated MIME type (a fixed enum from
 *    upload-guard) is argv[2]; bounded input/output caps are argv[3]/argv[4].
 *  - Timeout is enforced by the parent (SIGKILL). stdout is bounded by Buffer
 *    BYTE length (not JS character count). Errors are stable and sanitized — no
 *    resume text, contact fields, file bytes/paths, child stderr, or dynamic
 *    library messages leak into logs or thrown errors.
 *
 * This module is the single-document execution primitive. Bounded concurrency
 * across many documents is provided separately by resume-parser-pool.ts.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createLogger } from './logger.js';

const parserLogger = createLogger('resume-parser');

// ── Constants ───────────────────────────────────────────────────────────────

/** Maximum characters of extracted text we keep (matches original 50k limit). */
const DEFAULT_MAX_TEXT_LENGTH = 50_000;
/** Default timeout in ms for the child parser process. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Maximum bytes of stdout we accept from the child before killing it. */
const DEFAULT_MAX_OUTPUT_BYTES = 512_000; // 500 KiB
/** Maximum bytes of input the child will read before failing closed. */
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MiB, matches upload cap

// ── Types ───────────────────────────────────────────────────────────────────

/** Stage timing hook payload — metadata only (never candidate data). */
export interface ParserStageTimings {
  /** ms from spawn to first stdout byte. */
  firstByteMs?: number;
  /** ms from spawn to child close. */
  totalMs: number;
  /** stdout bytes received (Buffer byte length). */
  outputBytes: number;
}

export interface ParserConfig {
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum extracted text length in characters. */
  maxTextLength?: number;
  /** Maximum stdout bytes from child process. */
  maxOutputBytes?: number;
  /** Maximum input bytes the child will accept before failing closed. */
  maxInputBytes?: number;
  /** Path to tsx binary (only used when allowTsxFallback is set). */
  tsxBin?: string;
  /** Explicit child script path (for testing). */
  childScript?: string;
  /** Explicit Node executable path (default: process.execPath). */
  nodeBin?: string;
  /**
   * Development/test ONLY: permit a `.ts` child via tsx when the `.mjs` asset
   * is absent. Defaults to false so production fails closed.
   */
  allowTsxFallback?: boolean;
  /** Optional metadata-only stage-timing hook. */
  onTimings?: (t: ParserStageTimings) => void;
}

export interface ParserResult {
  /** The extracted text, truncated to maxTextLength. */
  text: string;
  /** Total extracted length before truncation. */
  totalLength: number;
  /** Whether the text was truncated. */
  truncated: boolean;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract text from a resume buffer using an isolated child process.
 *
 * @throws ParserAssetMissingError  if the production `.mjs` child is absent and
 *                                   no explicit tsx fallback is permitted (fails
 *                                   BEFORE any bytes are sent).
 * @throws ParserTimeoutError        if the child times out.
 * @throws ParserOutputExceededError if the child produces too much output.
 * @throws ParserError               for any other (sanitized) failure.
 */
export async function parseResume(
  buf: Buffer,
  mime: string,
  config: ParserConfig = {},
): Promise<ParserResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const maxInputBytes = config.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES;

  // Resolve the child script FAIL-CLOSED before spawning or touching input.
  const libDir = dirname(fileURLToPath(import.meta.url));
  const resolved = resolveChildScript(libDir, config);
  const nodeBin = config.nodeBin ?? process.execPath;
  const tsxBin = config.tsxBin ?? 'tsx';

  return new Promise((resolvePromise, reject) => {
    const command = resolved.useTsx ? tsxBin : nodeBin;
    const args = [resolved.path, mime, String(maxInputBytes), String(maxTextLength)];
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false, // No shell — prevents shell injection entirely.
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=256' },
    });

    const startedAt = Date.now();
    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let firstByteMs: number | undefined;
    let settled = false;
    let timedOut = false;
    let outputExceeded = false;

    const finalize = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
    };
    const fail = (err: Error): void => {
      if (settled) return;
      finalize();
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      reject(err);
    };
    const emitTimings = (): void => {
      if (!config.onTimings) return;
      try {
        config.onTimings({ firstByteMs, totalMs: Date.now() - startedAt, outputBytes: stdoutBytes });
      } catch { /* hooks must never break parsing */ }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      parserLogger.warn('unknown_event', { error_category: 'parse_timeout', error_type: 'child_killed' });
      fail(new ParserTimeoutError());
    }, timeoutMs);

    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (firstByteMs === undefined) firstByteMs = Date.now() - startedAt;
      stdoutBytes += chunk.length; // Buffer BYTE length, not character count
      if (stdoutBytes > maxOutputBytes) {
        outputExceeded = true;
        parserLogger.warn('unknown_event', { error_category: 'parse_output_exceeded', error_type: 'child_killed' });
        fail(new ParserOutputExceededError());
        return;
      }
      stdoutChunks.push(chunk);
    });

    // Drain stderr so the pipe cannot fill and block the child, but NEVER store
    // or expose it (it could echo library messages / file content).
    child.stderr!.on('data', () => { /* discarded */ });

    child.on('error', () => {
      // Spawn/exec failure (e.g., missing binary). Sanitized — no dynamic text.
      parserLogger.warn('unknown_event', { error_category: 'parse_spawn_error', error_type: 'child_error' });
      fail(new ParserError('spawn_error'));
    });

    child.on('close', (code) => {
      if (timedOut || outputExceeded || settled) return;
      finalize();
      emitTimings();

      if (code !== 0 && code !== null) {
        parserLogger.warn('unknown_event', { error_category: 'parse_child_exit', error_type: 'nonzero_exit' });
        reject(new ParserError('child_exit'));
        return;
      }

      const raw = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf-8').trim();
      if (!raw) {
        reject(new ParserError('no_output'));
        return;
      }
      let parsed: { ok?: boolean; text?: unknown; totalLength?: unknown; error?: unknown };
      try {
        parsed = JSON.parse(raw);
      } catch {
        reject(new ParserError('bad_output'));
        return;
      }
      if (!parsed || parsed.ok !== true || typeof parsed.text !== 'string') {
        // Child reported a stable error code (parsed.error) or a bad shape.
        reject(new ParserError('extract_failed'));
        return;
      }
      const reported = typeof parsed.totalLength === 'number' && Number.isFinite(parsed.totalLength)
        ? Math.max(parsed.totalLength, parsed.text.length)
        : parsed.text.length;
      const text = parsed.text.length > maxTextLength ? parsed.text.slice(0, maxTextLength) : parsed.text;
      resolvePromise({ text, totalLength: reported, truncated: reported > maxTextLength });
    });

    // Send the raw bytes via BINARY stdin (no base64). Guard against EPIPE if
    // the child died early.
    child.stdin!.on('error', () => { /* child gone; close/error handlers settle */ });
    child.stdin!.write(buf);
    child.stdin!.end();
  });
}

// ── Error types (stable codes/names; messages carry no dynamic content) ─────

export class ParserError extends Error {
  readonly code = 'PARSER_ERROR';
  /** Stable sub-category for diagnostics (never dynamic/sensitive). */
  readonly detail: string;
  constructor(detail = 'parser_error') {
    super('PARSER_ERROR');
    this.name = 'ParserError';
    this.detail = detail;
  }
}

export class ParserTimeoutError extends Error {
  readonly code = 'PARSER_TIMEOUT';
  constructor() {
    super('PARSER_TIMEOUT');
    this.name = 'ParserTimeoutError';
  }
}

export class ParserOutputExceededError extends Error {
  readonly code = 'PARSER_OUTPUT_EXCEEDED';
  constructor() {
    super('PARSER_OUTPUT_EXCEEDED');
    this.name = 'ParserOutputExceededError';
  }
}

export class ParserAssetMissingError extends Error {
  readonly code = 'PARSER_ASSET_MISSING';
  constructor() {
    super('PARSER_ASSET_MISSING');
    this.name = 'ParserAssetMissingError';
  }
}

export class ParserOverloadError extends Error {
  readonly code = 'PARSER_OVERLOAD';
  constructor() {
    super('PARSER_OVERLOAD');
    this.name = 'ParserOverloadError';
  }
}

// ── Child script resolution (fail-closed) ───────────────────────────────────

interface ResolvedChild {
  path: string;
  useTsx: boolean;
}

/**
 * Resolve the child parser script, failing CLOSED in production.
 *
 * 1. An explicit `config.childScript` is honored (test seam); `.ts` implies tsx.
 * 2. Otherwise prefer the compiled `resume-parser-child.mjs` (production).
 * 3. If the `.mjs` is absent, use `.ts` via tsx ONLY when `allowTsxFallback` is
 *    explicitly set and the `.ts` exists; otherwise throw
 *    {@link ParserAssetMissingError} before any bytes are spawned/sent.
 */
export function resolveChildScript(libDir: string, config: ParserConfig): ResolvedChild {
  if (config.childScript) {
    return { path: config.childScript, useTsx: config.childScript.endsWith('.ts') };
  }
  const mjsPath = resolve(libDir, 'resume-parser-child.mjs');
  if (existsSync(mjsPath)) {
    return { path: mjsPath, useTsx: false };
  }
  const tsPath = resolve(libDir, 'resume-parser-child.ts');
  if (config.allowTsxFallback === true && existsSync(tsPath)) {
    return { path: tsPath, useTsx: true };
  }
  // Fail closed: never invoke tsx implicitly, never proceed without the asset.
  parserLogger.error('unknown_event', { error_category: 'parse_asset_missing', error_type: 'mjs_absent' });
  throw new ParserAssetMissingError();
}
