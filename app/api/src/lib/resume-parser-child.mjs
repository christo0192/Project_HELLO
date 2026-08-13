#!/usr/bin/env node
/**
 * resume-parser-child.mjs — Isolated child process for resume text extraction.
 *
 * Production entry-point. Run with `process.execPath` (vanilla Node.js, no tsx).
 * This file:
 *  - Reads the RAW file bytes from stdin as binary (no base64 expansion),
 *    bounded by a maximum input-byte cap (argv[3]); overflow fails closed.
 *  - Extracts text using the appropriate parser (pdf-parse, mammoth, utf-8).
 *  - Truncates extracted text to a bounded character cap (argv[4]) while still
 *    reporting the pre-truncation length, then writes ONE JSON line to stdout:
 *      { ok: true, text: "...", totalLength: N }  or  { ok: false, error: CODE }
 *
 * Security:
 *  - No shell interpolation — the parent passes data via binary stdin, not argv.
 *  - The validated MIME type is passed as argv[2] (fixed enum from upload-guard).
 *  - Error output is a STABLE code only — never the file bytes/path, extracted
 *    text, contact fields, or a library's dynamic message. Nothing sensitive is
 *    written to stderr.
 *  - No relative imports to TypeScript source, so it runs in compiled/production
 *    layouts without tsx.
 */

// @ts-check

const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024; // 25 MiB
const DEFAULT_MAX_OUTPUT_CHARS = 50_000;

/** Write a stable error result and exit cleanly so the parent can read it. */
function emitError(code) {
  process.stdout.write(JSON.stringify({ ok: false, error: code }) + '\n');
  process.exit(0);
}

/** Read raw binary stdin bounded to maxBytes; overflow → null (fail closed). */
function readBinaryStdin(maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflowed = false;
    process.stdin.on('data', (chunk) => {
      if (overflowed) return;
      total += chunk.length; // Buffer byte length, not character count
      if (total > maxBytes) {
        overflowed = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => {
      if (overflowed) return;
      resolve(Buffer.concat(chunks, total));
    });
    process.stdin.on('error', (err) => reject(err));
  });
}

async function extractText(buf, mime) {
  if (mime === 'application/pdf') {
    // Dynamic import avoids pdf-parse's debug self-test at module load.
    const pdfParse = (await import('pdf-parse/lib/pdf-parse.js')).default;
    const out = await pdfParse(buf);
    return out.text;
  }
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth');
    const out = await mammoth.extractRawText({ buffer: buf });
    return out.value;
  }
  if (mime === 'text/plain') {
    return buf.toString('utf-8');
  }
  return null; // unsupported — mapped to a stable code by the caller
}

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

async function main() {
  try {
    const mime = process.argv[2] ?? '';
    const maxInputBytes = parsePositiveInt(process.argv[3], DEFAULT_MAX_INPUT_BYTES);
    const maxOutputChars = parsePositiveInt(process.argv[4], DEFAULT_MAX_OUTPUT_CHARS);
    if (!mime) return emitError('NO_MIME');

    const buf = await readBinaryStdin(maxInputBytes);
    if (buf === null) return emitError('INPUT_OVERFLOW');
    if (buf.length === 0) return emitError('EMPTY_INPUT');

    const text = await extractText(buf, mime);
    if (text === null) return emitError('UNSUPPORTED_MIME');
    if (typeof text !== 'string') return emitError('EXTRACT_FAILED');

    // Unicode-safe truncation by code unit, reporting the pre-truncation length.
    const totalLength = text.length;
    const bounded = totalLength > maxOutputChars ? text.slice(0, maxOutputChars) : text;
    process.stdout.write(JSON.stringify({ ok: true, text: bounded, totalLength }) + '\n');
  } catch {
    // Never surface a library's dynamic message (could echo file content).
    emitError('EXTRACT_FAILED');
  }
}

main();
