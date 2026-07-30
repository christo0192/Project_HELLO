/**
 * resume-parser.ts — Isolated resume text extraction via child process (SEC-14).
 *
 * Design:
 *  - Spawns a child process using Node's own binary (`process.execPath`)
 *    to run `resume-parser-child.mjs`. If the `.mjs` file is not found
 *    (development / source layout) it falls back to `tsx` with the `.ts` source.
 *  - Buffer is passed via stdin (base64-encoded), NOT via argv (no shell
 *    interpolation risk).
 *  - Timeout enforced by parent: child is killed (SIGKILL) on timeout.
 *  - Bounded output: parent monitors stdout size and kills child if exceeded.
 *  - Extracted text has a strict cap (configurable, default 50,000 chars).
 *  - The extracted text is treated as untrusted data (it goes into the LLM
 *    prompt already — this is unchanged from the original design).
 *
 * The validated MIME type is passed as argv[2] (safe because upload-guard
 * guarantees it's from a fixed enum of allowed values).
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

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParserConfig {
  /** Timeout in milliseconds. */
  timeoutMs?: number;
  /** Maximum extracted text length in characters. */
  maxTextLength?: number;
  /** Maximum stdout bytes from child process. */
  maxOutputBytes?: number;
  /** Path to tsx binary (fallback when .mjs not found; default: 'tsx'). */
  tsxBin?: string;
  /** Explicit child script path (for testing). */
  childScript?: string;
  /** Explicit Node executable path (default: process.execPath). */
  nodeBin?: string;
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
 * @param buf      The raw file buffer.
 * @param mime     The validated MIME type (one of the supported types).
 * @param config   Optional configuration overrides.
 * @returns        A ParserResult with the extracted text.
 * @throws         ParserTimeoutError if the child process times out.
 * @throws         ParserOutputExceededError if the child produces too much output.
 * @throws         ParserError if the child process fails for any other reason.
 */
export async function parseResume(
  buf: Buffer,
  mime: string,
  config: ParserConfig = {},
): Promise<ParserResult> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTextLength = config.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  // Resolve child script: prefer .mjs (production layout), fall back to .ts (source layout).
  const libDir = dirname(fileURLToPath(import.meta.url));
  const childScript = config.childScript ?? resolveChildScript(libDir);
  const nodeBin = config.nodeBin ?? process.execPath;
  const tsxBin = config.tsxBin ?? 'tsx';
  const useTsx = childScript.endsWith('.ts');

  return new Promise((resolve, reject) => {
    const command = useTsx ? tsxBin : nodeBin;
    const args = useTsx ? [childScript, mime] : [childScript, mime];
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // No shell — prevents shell injection entirely.
      shell: false,
      // Limit child's max old space to 256 MB (bounded memory).
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=256',
      },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let outputExceeded = false;

    // ── Timeout ─────────────────────────────────────────────────────
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill whole process tree.
      try { child.kill('SIGKILL'); } catch { /* best-effort */ }
      parserLogger.warn('unknown_event', { error_category: 'parse_timeout', error_type: 'child_killed' });
      reject(new ParserTimeoutError(`Parser child process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    // ── Stdout with output cap ──────────────────────────────────────
    child.stdout!.on('data', (chunk: Buffer) => {
      if (outputExceeded || timedOut) return;
      stdout += chunk.toString('utf-8');
      if (stdout.length > maxOutputBytes) {
        outputExceeded = true;
        try { child.kill('SIGKILL'); } catch { /* best-effort */ }
        clearTimeout(timer);
        parserLogger.warn('unknown_event', { error_category: 'parse_output_exceeded', error_type: 'child_killed' });
        reject(new ParserOutputExceededError(`Parser output exceeded ${maxOutputBytes} bytes`));
      }
    });

    // ── Stderr (collect but don't expose to caller) ──────────────────
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
      // Truncate stderr collection to avoid memory leak.
      if (stderr.length > 10_000) {
        stderr = stderr.slice(-10_000);
      }
    });

    // ── Process exit ────────────────────────────────────────────────
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut || outputExceeded) return; // already rejected

      if (code !== 0 && code !== null) {
        parserLogger.warn('unknown_event', {
          error_category: 'parse_child_exit',
          error_type: `exit_code_${code}`,
        });
        reject(new ParserError(`Parser child process exited with code ${code}`));
        return;
      }

      // Parse the JSON result from stdout.
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new ParserError('Parser produced no output'));
        return;
      }

      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.ok) {
          reject(new ParserError(parsed.message ?? 'Parser reported an error'));
          return;
        }

        const totalLength = (parsed.text as string)?.length ?? 0;
        const truncated = totalLength > maxTextLength;
        const text = truncated ? (parsed.text as string).slice(0, maxTextLength) : (parsed.text as string);

        resolve({ text, totalLength, truncated });
      } catch (err) {
        reject(new ParserError(`Failed to parse child output: ${(err as Error).message}`));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ParserError(`Child process error: ${err.message}`));
    });

    // ── Send buffer via stdin ───────────────────────────────────────
    const base64Buf = buf.toString('base64');
    child.stdin!.write(base64Buf);
    child.stdin!.end();
  });
}

// ── Error types ────────────────────────────────────────────────────────────

export class ParserError extends Error {
  readonly code = 'PARSER_ERROR';
  constructor(message: string) {
    super(message);
    this.name = 'ParserError';
  }
}

export class ParserTimeoutError extends Error {
  readonly code = 'PARSER_TIMEOUT';
  constructor(message: string) {
    super(message);
    this.name = 'ParserTimeoutError';
  }
}

export class ParserOutputExceededError extends Error {
  readonly code = 'PARSER_OUTPUT_EXCEEDED';
  constructor(message: string) {
    super(message);
    this.name = 'ParserOutputExceededError';
  }
}

// ── Child script resolution ───────────────────────────────────────────────

/**
 * Resolve the child parser script path.
 *
 * Resolution order:
 *  1. Look for `resume-parser-child.mjs` (production / compiled layout).
 *  2. Fall back to `resume-parser-child.ts` (source layout, requires tsx).
 *
 * This allows the parser to run in production without tsx while still working
 * in development where only the TypeScript source exists.
 */
function resolveChildScript(libDir: string): string {
  const mjsPath = resolve(libDir, 'resume-parser-child.mjs');
  if (existsSync(mjsPath)) {
    return mjsPath;
  }
  // Fall back to .ts source (requires tsx runtime)
  return resolve(libDir, 'resume-parser-child.ts');
}
