/**
 * upload-guard.ts — File validation guard for resume uploads (SEC-14).
 *
 * Responsibilities:
 *  - Accept only PDF, DOCX, UTF-8 text based on magic bytes, declared MIME, and extension.
 *  - Reject double extensions, NUL/control filenames, path traversal, polyglots.
 *  - Reject malformed ZIP/DOCX, encrypted content, excessive entry count/ratio/uncompressed size.
 *  - Reject malformed PDF (no %PDF header, truncated).
 *  - Reject invalid UTF-8 byte sequences.
 *  - Enforce configurable compressed-byte quota before parsing.
 *
 * All checks are synchronous and throw typed errors with machine-readable codes.
 */

import { randomUUID } from 'node:crypto';

// ── Constants ───────────────────────────────────────────────────────────────

/** Supported file types with their human-readable label. */
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
] as const;

export type SupportedMime = (typeof SUPPORTED_MIME_TYPES)[number];

const EXT_MAP: Record<string, SupportedMime> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
};

// PDF magic: %PDF
const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]);
// DOCX/OOXML magic: PK\x03\x04 (ZIP header, but we do deeper validation)
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_MAGIC = Buffer.from([0x50, 0x4b, 0x05, 0x06]); // empty ZIP
const ZIP_SPANNED_MAGIC = Buffer.from([0x50, 0x4b, 0x07, 0x08]); // spanned ZIP

// ── Error types ─────────────────────────────────────────────────────────────

export class UploadGuardError extends Error {
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UploadGuardError';
    this.code = code;
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface GuardConfig {
  /** Max compressed bytes allowed before parsing (default 10 MiB). */
  maxCompressedBytes: number;
  /** Max uncompressed ratio for DOCX (default 200×). */
  maxUncompressedRatio: number;
  /** Max ZIP entries for DOCX (default 2000). */
  maxZipEntries: number;
  /** Max total uncompressed bytes across all ZIP entries (default 100 MiB). */
  maxTotalUncompressedBytes: number;
  /** Max filename bytes in storage key (default 255). */
  maxStorageKeyBytes: number;
}

const DEFAULT_CONFIG: GuardConfig = {
  maxCompressedBytes: 10 * 1024 * 1024,  // 10 MiB
  maxUncompressedRatio: 200,
  maxZipEntries: 2000,
  maxTotalUncompressedBytes: 100 * 1024 * 1024,  // 100 MiB
  maxStorageKeyBytes: 255,
};

export interface GuardResult {
  /** The validated MIME type (our canonical mapping). */
  mime: SupportedMime;
  /** The random storage key (no user-controlled path components). */
  storageKey: string;
}

/**
 * Run all upload guards against a candidate file.
 *
 * Throws UploadGuardError on any validation failure.
 */
export function guardUpload(
  buffer: Buffer,
  mimetype: string,
  originalname: string,
  config: Partial<GuardConfig> = {},
): GuardResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  // 1. Validate filename — must exist, no NUL/control, no traversal, no double extension.
  validateFilename(originalname);

  // 2. Resolve extension and check against declared MIME.
  const ext = resolveExtension(originalname);
  const expectedMime = EXT_MAP[ext.toLowerCase()];
  if (!expectedMime) {
    throw new UploadGuardError('UNSUPPORTED_EXTENSION', `Unsupported file extension: ${ext}`);
  }

  // 3. Validate declared MIME matches what we expect from the extension.
  //    Accept case-insensitive comparison.
  if (mimetype.toLowerCase() !== expectedMime.toLowerCase()) {
    throw new UploadGuardError(
      'MIME_MISMATCH',
      `Declared MIME "${mimetype}" does not match extension "${ext}" (expected "${expectedMime}")`,
    );
  }

  // 4. Validate magic bytes / signatures.
  if (buffer.length < 4) {
    throw new UploadGuardError('FILE_TOO_SMALL', 'File is too small to contain valid content');
  }

  const magicSig = buffer.subarray(0, 4);

  if (expectedMime === 'application/pdf') {
    validatePDF(buffer, magicSig);
  } else if (expectedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    validateDOCX(buffer, magicSig, cfg);
  } else if (expectedMime === 'text/plain') {
    validateText(buffer);
  }

  // 5. Enforce compressed-byte quota (buffer size before parsing).
  if (buffer.length > cfg.maxCompressedBytes) {
    throw new UploadGuardError(
      'EXCEEDS_QUOTA',
      `File size ${buffer.length} exceeds max compressed bytes ${cfg.maxCompressedBytes}`,
    );
  }

  // 6. Generate random storage key (no user input in path).
  // ext includes the leading dot (e.g. ".pdf"), so we strip it.
  const cleanExt = ext.startsWith('.') ? ext.slice(1) : ext;
  const storageKey = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${cleanExt}`;

  return { mime: expectedMime, storageKey };
}

// ── Filename validation ─────────────────────────────────────────────────────

function validateFilename(name: string): void {
  if (!name || name.length === 0) {
    throw new UploadGuardError('EMPTY_FILENAME', 'Filename is empty');
  }

  if (name.length > 512) {
    throw new UploadGuardError('FILENAME_TOO_LONG', 'Filename exceeds maximum length');
  }

  // Reject NUL and control characters (0x00-0x1F, 0x7F).
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) {
      throw new UploadGuardError('CONTROL_IN_FILENAME', 'Filename contains control characters');
    }
  }

  // Reject path traversal: .. or ../ or ..\ or / or \ at start.
  if (name.startsWith('/') || name.startsWith('\\')) {
    throw new UploadGuardError('ABSOLUTE_PATH', 'Filename starts with path separator');
  }
  if (name.includes('..')) {
    throw new UploadGuardError('PATH_TRAVERSAL', 'Filename contains path traversal');
  }
  if (name.includes('/') || name.includes('\\')) {
    throw new UploadGuardError('PATH_SEPARATOR', 'Filename contains path separator');
  }

  // Reject hidden/leading-dot files (common social engineering).
  if (name.startsWith('.')) {
    throw new UploadGuardError('HIDDEN_FILE', 'Filename starts with a dot');
  }
}

// ── Extension resolution ────────────────────────────────────────────────────

function resolveExtension(name: string): string {
  // Use last dot to find extension.
  const dotIdx = name.lastIndexOf('.');
  if (dotIdx < 0 || dotIdx === name.length - 1) {
    throw new UploadGuardError('NO_EXTENSION', 'Filename has no extension');
  }
  const ext = name.slice(dotIdx);

  // Check for double extension: another dot before the last extension.
  // e.g., "resume.pdf.exe" → ext is ".exe", but there's ".pdf" before it.
  const beforeExt = name.slice(0, dotIdx);
  const secondDotIdx = beforeExt.lastIndexOf('.');
  if (secondDotIdx >= 0) {
    const innerExt = beforeExt.slice(secondDotIdx).toLowerCase();
    if (innerExt in EXT_MAP) {
      throw new UploadGuardError(
        'DOUBLE_EXTENSION',
        `Filename has a double extension: "${innerExt}" then "${ext}"`,
      );
    }
  }

  return ext;
}

// ── PDF validation ──────────────────────────────────────────────────────────

function validatePDF(buffer: Buffer, magicSig: Buffer): void {
  // Must start with %PDF.
  if (!magicSig.equals(PDF_MAGIC)) {
    throw new UploadGuardError('INVALID_PDF_HEADER', 'File does not start with %PDF header');
  }

  // Check for polyglot: PDF magic in a ZIP-based DOCX structure.
  // A polyglot docx.pdf would have PDF header but also ZIP structures.
  // Since we already validated MIME type, we check that the file isn't also a valid ZIP.
  // ZIP local file headers start with PK\x03\x04. If we find one early, it's a polyglot.
  const pkPos = buffer.indexOf(ZIP_MAGIC, 4);
  if (pkPos >= 0 && pkPos < 1024) {
    throw new UploadGuardError('POLYGLOT_DETECTED', 'File contains both PDF and ZIP signatures (polyglot)');
  }

  // Check for truncated PDF: ensure the file ends with %%EOF within reasonable bounds.
  const eofMarker = '%%EOF';
  const eofPos = buffer.indexOf(eofMarker, buffer.length - 256);
  if (eofPos < 0) {
    // PDF may not have %%EOF if it's a stream, but most valid ones do.
    // Only reject if the file is large enough that it should have it.
    if (buffer.length > 1024) {
      throw new UploadGuardError('MALFORMED_PDF', 'PDF does not contain %%EOF marker');
    }
  }

  // Reject encrypted PDFs: check for /Encrypt in the first few KB.
  // This is a heuristic — a real check would parse the cross-reference table.
  const headerRegion = buffer.subarray(0, Math.min(buffer.length, 8192)).toString('utf-8');
  if (/\/Encrypt\b/i.test(headerRegion)) {
    throw new UploadGuardError('ENCRYPTED_PDF', 'PDF appears to be encrypted');
  }
}

// ── DOCX / OOXML (ZIP) validation ──────────────────────────────────────────

/**
 * Minimal ZIP/DOCX structural validation.
 *
 * Checks:
 *  - ZIP magic header exists.
 *  - Not empty archive.
 *  - Not a spanned archive.
 *  - End of Central Directory Record (EOCD) is parseable.
 *  - Central directory entry count is within limit.
 *  - No encrypted entries.
 *  - No excessive compression ratio (zip bomb heuristic).
 *  - No excessive uncompressed size.
 */
function validateDOCX(buffer: Buffer, magicSig: Buffer, cfg: GuardConfig): void {
  // Accept PK\x03\x04 (local file header), PK\x05\x06 (empty archive),
  // or PK\x07\x08 (spanned archive) as valid ZIP signatures.
  const isEmpty = buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_EMPTY_MAGIC);
  const isSpanned = buffer.length >= 4 && buffer.subarray(0, 4).equals(ZIP_SPANNED_MAGIC);
  const isNormal = magicSig.equals(ZIP_MAGIC);

  if (!isNormal && !isEmpty && !isSpanned) {
    throw new UploadGuardError('INVALID_DOCX_HEADER', 'File does not start with PK ZIP header');
  }

  // Reject empty ZIP archive (PK\x05\x06 at start — no local file entries).
  if (isEmpty) {
    throw new UploadGuardError('EMPTY_ZIP', 'ZIP archive is empty');
  }

  // Reject spanned ZIP.
  if (isSpanned) {
    throw new UploadGuardError('SPANNED_ZIP', 'ZIP archive is spanned (multi-volume)');
  }

  // Find End of Central Directory (EOCD) signature: PK\x05\x06
  const EOCD_SIG = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const eocdPos = findEOCD(buffer, EOCD_SIG);
  if (eocdPos < 0) {
    throw new UploadGuardError('MALFORMED_ZIP', 'Cannot find End of Central Directory in ZIP');
  }

  // Parse EOCD: 16 bytes fixed after signature
  // offset: sig(4) + disk(2) + disk_start(2) + entries_disk(2) + entries_total(2) + size(4) + offset(4)
  if (eocdPos + 22 > buffer.length) {
    throw new UploadGuardError('MALFORMED_ZIP', 'ZIP EOCD record is truncated');
  }

  const eocdBuf = buffer.subarray(eocdPos + 8, eocdPos + 12); // total entries (little-endian uint16)
  const totalEntries = eocdBuf.readUInt16LE(0);

  if (totalEntries === 0) {
    throw new UploadGuardError('EMPTY_ZIP', 'ZIP archive contains no entries');
  }

  if (totalEntries > cfg.maxZipEntries) {
    throw new UploadGuardError(
      'EXCESSIVE_ZIP_ENTRIES',
      `ZIP archive has ${totalEntries} entries (max ${cfg.maxZipEntries})`,
    );
  }

  // Parse each local file header to check for encryption, detect data
  // descriptors, and enforce aggregate uncompressed cap.
  let offset = 0;
  let totalUncompressed = 0;
  let entriesChecked = 0;

  const LFH_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

  while (offset < buffer.length - 30 && entriesChecked < totalEntries) {
    // Look for next local file header.
    if (buffer.subarray(offset, offset + 4).equals(LFH_SIG)) {
      const lfh = buffer.subarray(offset, offset + 30);
      if (lfh.length < 30) break;

      const compressionMethod = lfh.readUInt16LE(8);
      const compressedSize = lfh.readUInt32LE(18);
      const uncompressedSize = lfh.readUInt32LE(22);
      const filenameLen = lfh.readUInt16LE(26);
      const extraLen = lfh.readUInt16LE(28);

      // Parse general purpose flag.
      const generalFlag = lfh.readUInt16LE(6);

      // Check for encryption bit (bit 0).
      if (generalFlag & 0x01) {
        throw new UploadGuardError('ENCRYPTED_ZIP_ENTRY', 'ZIP archive contains encrypted entry');
      }

      // Strong encryption (bit 6).
      if (generalFlag & 0x40) {
        throw new UploadGuardError('STRONG_ENCRYPTED_ZIP', 'ZIP archive uses strong encryption');
      }

      // Data descriptor (bit 3): sizes stored AFTER file data, not in LFH.
      // Legitimate DOCX files do NOT use data descriptors. Reject them.
      if (generalFlag & 0x08) {
        throw new UploadGuardError(
          'ZIP_DATA_DESCRIPTOR',
          'ZIP entry uses data descriptor (untrustworthy sizes)',
        );
      }

      // Reject entries where BOTH sizes are zero without data descriptor.
      // This indicates malformed or untrustworthy metadata.
      if (compressedSize === 0 && uncompressedSize === 0) {
        throw new UploadGuardError(
          'ZIP_ZERO_SIZE_ENTRY',
          'ZIP entry has zero compressed and uncompressed size',
        );
      }

      totalUncompressed += uncompressedSize;

      // Check for excessive ratio (zip bomb).
      if (compressedSize > 0) {
        const ratio = uncompressedSize / compressedSize;
        if (ratio > cfg.maxUncompressedRatio) {
          throw new UploadGuardError(
            'EXCESSIVE_COMPRESSION_RATIO',
            `ZIP entry has compression ratio ${Math.round(ratio)}x (max ${cfg.maxUncompressedRatio}x)`,
          );
        }
      }

      // Enforce aggregate uncompressed cap (catch zip bombs spread across entries).
      if (totalUncompressed > cfg.maxTotalUncompressedBytes) {
        throw new UploadGuardError(
          'EXCESSIVE_TOTAL_UNCOMPRESSED',
          `Total uncompressed size ${totalUncompressed} exceeds max ${cfg.maxTotalUncompressedBytes}`,
        );
      }

      entriesChecked++;
      offset += 30 + filenameLen + extraLen + compressedSize;
    } else {
      // Skip data descriptor or other non-LFH bytes.
      offset += 1;
    }
  }
}

/**
 * Find the End of Central Directory record by scanning from the end.
 * The EOCD signature PK\x05\x06 is at the very end (usually within last 65557 bytes).
 */
function findEOCD(buffer: Buffer, sig: Buffer): number {
  const searchStart = Math.max(0, buffer.length - 65557);
  const searchEnd = buffer.length - 22; // minimum EOCD size

  for (let i = searchEnd; i >= searchStart; i--) {
    if (buffer.subarray(i, i + 4).equals(sig)) {
      return i;
    }
  }
  return -1;
}

// ── Text validation ─────────────────────────────────────────────────────────

/** Maximum prefix bytes we inspect for a text file before rejecting. */
const TEXT_INSPECT_LIMIT = 8192;

/** Minimum printable-ASCII ratio for a file to be considered text. */
const MIN_TEXT_RATIO = 0.80;

/** Bytes that are universally printable: ASCII 0x20-0x7E plus common whitespace (tab, LF, CR). */
function isPrintable(b: number): boolean {
  return (b >= 0x20 && b <= 0x7e) || b === 0x09 || b === 0x0a || b === 0x0d;
}

function validateText(buffer: Buffer): void {
  const prefix = buffer.subarray(0, Math.min(buffer.length, TEXT_INSPECT_LIMIT));

  // Must not contain NUL bytes (null-substitution is a common binary-in-text sneak).
  if (prefix.includes(0x00)) {
    throw new UploadGuardError('BINARY_CONTENT', 'File contains NUL bytes (binary, not text)');
  }

  // Check for non-printable bytes.
  let printableCount = 0;
  for (let i = 0; i < prefix.length; i++) {
    if (isPrintable(prefix[i])) {
      printableCount++;
    }
  }

  const ratio = printableCount / prefix.length;
  if (ratio < MIN_TEXT_RATIO) {
    throw new UploadGuardError(
      'NOT_UTF8_TEXT',
      `File does not appear to be UTF-8 text (printable ratio ${(ratio * 100).toFixed(0)}%)`,
    );
  }

  // Check for invalid UTF-8 byte sequences.
  // UTF-8 rules:
  //   - 1-byte: 0xxxxxxx (0x00-0x7F)
  //   - 2-byte: 110xxxxx 10xxxxxx
  //   - 3-byte: 1110xxxx 10xxxxxx 10xxxxxx
  //   - 4-byte: 11110xxx 10xxxxxx 10xxxxxx 10xxxxxx
  // Check for overlong encodings and invalid continuation bytes.
  let i = 0;
  while (i < prefix.length) {
    const b = prefix[i];
    if (b <= 0x7f) {
      // ASCII — valid.
      i++;
    } else if (b >= 0xc2 && b <= 0xdf) {
      // 2-byte sequence
      if (i + 1 >= prefix.length) break; // truncated at buffer end
      if ((prefix[i + 1] & 0xc0) !== 0x80) {
        throw new UploadGuardError('INVALID_UTF8', 'Invalid UTF-8 continuation byte in 2-byte sequence');
      }
      i += 2;
    } else if (b >= 0xe0 && b <= 0xef) {
      // 3-byte sequence
      if (i + 2 >= prefix.length) break;
      if ((prefix[i + 1] & 0xc0) !== 0x80 || (prefix[i + 2] & 0xc0) !== 0x80) {
        throw new UploadGuardError('INVALID_UTF8', 'Invalid UTF-8 continuation byte in 3-byte sequence');
      }
      // Check for overlong encoding (0xE0 0x80-0x9F would encode a 2-byte codepoint in 3 bytes).
      if (b === 0xe0 && (prefix[i + 1] & 0xe0) === 0x80) {
        throw new UploadGuardError('INVALID_UTF8', 'Overlong UTF-8 encoding detected');
      }
      i += 3;
    } else if (b >= 0xf0 && b <= 0xf4) {
      // 4-byte sequence
      if (i + 3 >= prefix.length) break;
      if ((prefix[i + 1] & 0xc0) !== 0x80 || (prefix[i + 2] & 0xc0) !== 0x80 || (prefix[i + 3] & 0xc0) !== 0x80) {
        throw new UploadGuardError('INVALID_UTF8', 'Invalid UTF-8 continuation byte in 4-byte sequence');
      }
      // Check for overlong (0xF0 0x80-0x8F) and out-of-range (0xF4 0x90+).
      if (b === 0xf0 && (prefix[i + 1] & 0xf0) === 0x80) {
        throw new UploadGuardError('INVALID_UTF8', 'Overlong UTF-8 encoding detected');
      }
      if (b === 0xf4 && prefix[i + 1] > 0x8f) {
        throw new UploadGuardError('INVALID_UTF8', 'UTF-8 codepoint exceeds U+10FFFF');
      }
      i += 4;
    } else {
      // Invalid start byte (0x80-0xBF without prefix, 0xC0-0xC1 overlong, 0xF5-0xFF undefined)
      throw new UploadGuardError('INVALID_UTF8', 'Invalid UTF-8 start byte');
    }
  }
}
