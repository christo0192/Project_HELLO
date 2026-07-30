#!/usr/bin/env node
/**
 * resume-parser-child.mjs — Isolated child process for resume text extraction.
 *
 * Production entry-point. Run with `process.execPath` (vanilla Node.js, no tsx).
 * This file:
 *  - Reads a base64-encoded buffer from stdin.
 *  - Extracts text using the appropriate parser (pdf-parse, mammoth, utf-8).
 *  - Writes a single JSON line to stdout: { ok: true, text: "..." } or { ok: false, error: "..." }.
 *
 * No shell interpolation — the parent passes data via stdin, not argv.
 * The validated MIME type is passed as argv[2] (guaranteed by upload-guard).
 *
 * This file has NO relative imports to TypeScript source files so it runs
 * in compiled / production layouts without tsx.
 */

// @ts-check

function handleError(code, message) {
  const result = JSON.stringify({ ok: false, error: code, message });
  process.stdout.write(result + '\n');
  console.error('[resume-parser-child]', code, message);
  process.exit(0); // exit cleanly so parent can read the error
}

function parseBase64Stdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding('utf-8');

    process.stdin.on('data', (chunk) => {
      chunks.push(chunk);
    });

    process.stdin.on('end', () => {
      const raw = chunks.join('').trim();
      if (!raw) {
        reject(new Error('No input data received'));
        return;
      }
      try {
        const buf = Buffer.from(raw, 'base64');
        resolve(buf);
      } catch (err) {
        reject(new Error(`Base64 decode failed: ${err.message}`));
      }
    });

    process.stdin.on('error', (err) => reject(err));
  });
}

async function extractText(buf, mime) {
  if (mime === 'application/pdf') {
    // Dynamic import to avoid pdf-parse's debug self-test at module level
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

  throw new Error(`Unsupported MIME type: ${mime}`);
}

async function main() {
  try {
    const mime = process.argv[2] ?? '';
    if (!mime) {
      handleError('NO_MIME', 'No MIME type provided');
      return;
    }

    const buf = await parseBase64Stdin();
    const text = await extractText(buf, mime);

    const result = JSON.stringify({ ok: true, text });
    process.stdout.write(result + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    handleError('PARSE_FAILED', msg);
  }
}

main();
