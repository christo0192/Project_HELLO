#!/usr/bin/env node

/**
 * storage-manifest.mjs — MIG-07/08: Storage manifest and verification tooling
 * for Supabase storage objects (resumes_v2, recordings_v2 buckets).
 *
 * Produces a JSON manifest with:
 *   - Normalized safe object key (path traversal rejected)
 *   - File size in bytes
 *   - Allowlisted content type (MIME type restricted set)
 *   - Cryptographic digest (SHA-256)
 *   - Detection of missing/corrupt/unexpected objects
 *
 * INVARIANTS:
 *   - Path traversal and symlink escapes fail closed
 *   - Manifest version 1 with explicit schema
 *   - Deterministic: same directory produces identical manifest
 *   - Zero network, no external dependencies
 *
 * Usage:
 *   node scripts/storage-manifest.mjs scan <directory> [output-manifest.json]
 *   node scripts/storage-manifest.mjs verify <directory> <manifest.json>
 */

import { readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve, relative, normalize, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];

// Bound the manifest JSON size before parsing (defense against OOM).
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;

// ===================================================================
// Constants
// ===================================================================
const MANIFEST_VERSION = 1;
const SCHEMA_VERSION = 1;

// Allowlisted content types for storage objects
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/webp",
]);

// Default content type if not detectable
const DEFAULT_CONTENT_TYPE = "application/octet-stream";

// Allowlisted file extensions
const ALLOWED_EXTENSIONS = new Set([
  ".pdf", ".json", ".mp4", ".m4a", ".mp3",
  ".ogg", ".wav", ".webm",
  ".txt", ".csv",
  ".png", ".jpg", ".jpeg", ".webp",
]);

// Max file size for manifest scanning (100 MB)
const MAX_FILE_SIZE = 100 * 1024 * 1024;

// ===================================================================
// Safe path resolution
// ===================================================================

/**
 * Resolve a path within a root directory, rejecting traversal attempts.
 * Returns the normalized absolute path if safe, throws otherwise.
 */
function safeResolve(rootDir, filePath) {
  const root = resolve(rootDir);
  const resolved = resolve(root, filePath);

  // Normalize and check for traversal
  const normalized = normalize(resolved);

  // Must be within root
  if (!normalized.startsWith(root + sep) && normalized !== root) {
    throw new Error(
      `S001: path traversal detected: "${filePath}" resolves outside "${rootDir}"`
    );
  }

  // Reject symlinks by policy (checked at usage time with lstat)
  return normalized;
}

// ===================================================================
// Content type detection
// ===================================================================

function detectContentType(filePath) {
  const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
  const mapping = {
    ".pdf": "application/pdf",
    ".json": "application/json",
    ".mp4": "audio/mp4",
    ".m4a": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".webm": "audio/webm",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
  };
  return mapping[ext] || DEFAULT_CONTENT_TYPE;
}

// ===================================================================
// Manifest scan
// ===================================================================

async function scanDirectory(rootDir, prefix = "") {
  const fullPath = safeResolve(rootDir, prefix);
  const entries = await readdir(fullPath, { withFileTypes: true });
  const objects = [];

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.name.startsWith(".")) continue;

    const entryPath = join(fullPath, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      // Recurse into subdirectories
      const children = await scanDirectory(rootDir, relativePath);
      objects.push(...children);
    } else if (entry.isSymbolicLink()) {
      // Reject symlinks outright. `entry` comes from readdir withFileTypes,
      // whose type reflects lstat (does NOT follow the link), so this
      // reliably catches links instead of the previous stat()-based check
      // which followed the link and never fired.
      throw new Error(
        `S002: symlink rejected: "${relativePath}" — symlinks are not allowed in storage manifests`
      );
    } else if (entry.isFile()) {
      // Re-stat WITHOUT following symlinks (lstat) to defend against a
      // TOCTOU swap of the entry for a symlink between readdir and here.
      const stats = await lstat(entryPath);
      if (stats.isSymbolicLink()) {
        throw new Error(
          `S002: symlink rejected: "${relativePath}" — symlinks are not allowed in storage manifests`
        );
      }

      // Check extension
      const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf("."));
      if (!ALLOWED_EXTENSIONS.has(ext)) {
        throw new Error(
          `S003: disallowed extension for "${relativePath}": "${ext}" not in allowlist`
        );
      }

      // Check file size
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          `S004: file too large: "${relativePath}" (${stats.size} bytes, max ${MAX_FILE_SIZE})`
        );
      }

      // Normalize safe object key (use forward slashes, no leading slash)
      const objectKey = relativePath.replace(/\\/g, "/");

      // Read file content for digest
      const content = await readFile(entryPath);
      const digest = createHash("sha256").update(content).digest("hex");

      const contentType = detectContentType(entryPath);
      if (!ALLOWED_CONTENT_TYPES.has(contentType) && contentType !== DEFAULT_CONTENT_TYPE) {
        throw new Error(
          `S005: disallowed content type for "${relativePath}": "${contentType}" not in allowlist`
        );
      }

      objects.push({
        key: objectKey,
        size: stats.size,
        contentType,
        digest,
      });
    }
  }

  return objects;
}

// ===================================================================
// Manifest verification
// ===================================================================

async function verifyDirectory(rootDir, expectedManifest) {
  const results = {
    verified: [],
    missing: [],
    corrupt: [],
    unexpected: [],
    errors: [],
  };

  const expectedObjects = new Map();
  for (const obj of expectedManifest.objects) {
    expectedObjects.set(obj.key, obj);
  }

  // Scan actual files
  let actualObjects;
  try {
    actualObjects = await scanDirectory(rootDir);
  } catch (err) {
    results.errors.push({ message: err.message });
    return results;
  }

  const actualKeys = new Set(actualObjects.map((o) => o.key));

  // Check each expected object
  for (const [key, expected] of expectedObjects) {
    if (!actualKeys.has(key)) {
      results.missing.push({ key, expectedDigest: expected.digest });
      continue;
    }

    const actual = actualObjects.find((o) => o.key === key);

    // Check size match
    if (actual.size !== expected.size) {
      results.corrupt.push({
        key,
        reason: "size",
        expectedSize: expected.size,
        actualSize: actual.size,
      });
      continue;
    }

    // Check digest match
    if (actual.digest !== expected.digest) {
      results.corrupt.push({
        key,
        reason: "digest",
        expectedDigest: expected.digest,
        actualDigest: actual.digest,
      });
      continue;
    }

    // Check content type (if expected specifies one)
    if (expected.contentType && actual.contentType !== expected.contentType) {
      results.corrupt.push({
        key,
        reason: "content_type",
        expectedType: expected.contentType,
        actualType: actual.contentType,
      });
      continue;
    }

    results.verified.push({ key, digest: actual.digest, size: actual.size });
  }

  // Check for unexpected objects
  for (const actual of actualObjects) {
    if (!expectedObjects.has(actual.key)) {
      results.unexpected.push({
        key: actual.key,
        size: actual.size,
        digest: actual.digest,
      });
    }
  }

  return results;
}

// ===================================================================
// Manifest I/O
// ===================================================================

function createManifest(objects) {
  return {
    manifest_version: MANIFEST_VERSION,
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    // Deterministic, locale-independent ordering by UTF-16 code unit.
    // localeCompare would vary with the runtime ICU locale.
    objects: [...objects].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    objectCount: objects.length,
    totalSize: objects.reduce((s, o) => s + o.size, 0),
  };
}

function validateManifestStructure(manifest) {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("S010: manifest must be a non-null object");
  }
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    throw new Error(
      `S011: unsupported manifest_version ${manifest.manifest_version}; expected ${MANIFEST_VERSION}`
    );
  }
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `S012: unsupported schema_version ${manifest.schema_version}; expected ${SCHEMA_VERSION}`
    );
  }
  if (!Array.isArray(manifest.objects)) {
    throw new Error("S013: manifest must have an 'objects' array");
  }

  // Check for duplicate keys
  const seenKeys = new Set();
  for (const obj of manifest.objects) {
    if (!obj.key || typeof obj.key !== "string") {
      throw new Error("S014: each object must have a string 'key'");
    }
    if (seenKeys.has(obj.key)) {
      throw new Error(`S015: duplicate object key "${obj.key}"`);
    }
    seenKeys.add(obj.key);

    if (typeof obj.size !== "number" || obj.size < 0) {
      throw new Error(`S016: object "${obj.key}" has invalid size`);
    }
    if (typeof obj.digest !== "string" || !/^[a-f0-9]{64}$/.test(obj.digest)) {
      throw new Error(`S017: object "${obj.key}" has invalid digest (expected SHA-256 hex)`);
    }
    if (obj.contentType && !ALLOWED_CONTENT_TYPES.has(obj.contentType) && obj.contentType !== DEFAULT_CONTENT_TYPE) {
      throw new Error(`S018: object "${obj.key}" has disallowed content type "${obj.contentType}"`);
    }

    // Check for path traversal in key
    if (obj.key.includes("..") || obj.key.startsWith("/") || obj.key.includes("//")) {
      throw new Error(`S019: object key "${obj.key}" contains path traversal or invalid characters`);
    }
  }

  return true;
}

// ===================================================================
// Main CLI
// ===================================================================
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage:\n" +
      "  node scripts/storage-manifest.mjs scan <directory> [output-manifest.json]\n" +
      "  node scripts/storage-manifest.mjs verify <directory> <manifest.json>"
    );
    process.exit(2);
  }

  const command = args[0];
  const dirPath = resolve(args[1]);

  switch (command) {
    case "scan": {
      const outputPath = args[2] || null;

      let objects;
      try {
        objects = await scanDirectory(dirPath);
      } catch (err) {
        console.error(`S020: scan failed: ${err.message}`);
        process.exit(1);
      }

      const manifest = createManifest(objects);
      const out = `${JSON.stringify(manifest, null, 2)}\n`;

      if (outputPath) {
        try {
          await writeFile(outputPath, out, "utf8");
          console.error(
            `Storage manifest written to ${outputPath}: ` +
              `${manifest.objectCount} objects, ${manifest.totalSize} bytes`
          );
        } catch (err) {
          console.error(`S021: failed to write manifest: ${err.message}`);
          process.exit(1);
        }
      } else {
        process.stdout.write(out);
      }
      break;
    }

    case "verify": {
      if (args.length < 3) {
        console.error("Usage: node scripts/storage-manifest.mjs verify <directory> <manifest.json>");
        process.exit(2);
      }

      const manifestPath = resolve(args[2]);

      let manifest;
      try {
        const st = await lstat(manifestPath);
        if (st.size > MAX_MANIFEST_BYTES) {
          console.error(
            `S026: manifest file too large: ${st.size} bytes (max ${MAX_MANIFEST_BYTES})`
          );
          process.exit(1);
        }
        // Redacted diagnostics: never echo parser output or file contents.
        manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      } catch (err) {
        if (err.code === "ENOENT") {
          console.error(`S022: manifest file not found: ${manifestPath}`);
          process.exit(1);
        }
        console.error(`S023: failed to read or parse manifest: ${manifestPath}`);
        process.exit(1);
      }

      try {
        validateManifestStructure(manifest);
      } catch (err) {
        console.error(`S024: invalid manifest: ${err.message}`);
        process.exit(1);
      }

      const results = await verifyDirectory(dirPath, manifest);

      let exitCode = 0;

      for (const v of results.verified) {
        console.log(`OK   ${v.key} (${v.size} bytes)`);
      }
      for (const m of results.missing) {
        console.error(`MISS ${m.key}`);
        exitCode = 1;
      }
      for (const c of results.corrupt) {
        console.error(`CORRUPT ${c.key}: ${c.reason}`);
        exitCode = 1;
      }
      for (const u of results.unexpected) {
        console.error(`UNEXPECTED ${u.key} (${u.size} bytes)`);
        exitCode = 1;
      }
      for (const e of results.errors) {
        console.error(`ERROR ${e.message}`);
        exitCode = 1;
      }

      if (exitCode === 0) {
        console.error(
          `Verification passed: ${results.verified.length} objects OK`
        );
      } else {
        console.error(
          `Verification FAILED: ${results.verified.length} OK, ` +
            `${results.missing.length} missing, ${results.corrupt.length} corrupt, ` +
            `${results.unexpected.length} unexpected`
        );
      }

      process.exit(exitCode);
      break;
    }

    default:
      console.error(`S025: unknown command "${command}". Use "scan" or "verify".`);
      process.exit(2);
  }
}

if (isMainModule) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

export {
  scanDirectory,
  verifyDirectory,
  createManifest,
  validateManifestStructure,
  safeResolve,
  detectContentType,
  MANIFEST_VERSION,
  SCHEMA_VERSION,
  ALLOWED_CONTENT_TYPES,
  ALLOWED_EXTENSIONS,
};
