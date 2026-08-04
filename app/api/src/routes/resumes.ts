/**
 * resumes.ts — Resume upload and ingestion route (SEC-14).
 *
 * Hardening:
 *  - Injectable recruiter authorization guard contract (fails closed in production).
 *  - Upload guard validates MIME, magic bytes, filename, structure (no polyglot/
 *    encrypted/malformed/traversal/double-ext).
 *  - Malware scanner runs before parsing (EICAR always rejected; production fails closed).
 *  - Parsing is isolated in a child process with timeout and bounded memory/output.
 *  - Raw object storage is private, random-keyed; no signed URL persisted.
 *  - No raw parser errors stored. Fixed safe error on downstream failure + orphan cleanup.
 *  - Unknown multipart fields/files rejected.
 *  - Role/candidate identifiers schema-validated.
 */

import { Router } from 'express';
import multer from 'multer';
import { supabase, RESUME_BUCKET } from '../lib/supabase.js';
import { runClaudeJSON } from '../lib/claude.js';
import { buildExtractionPrompt } from '../lib/prompts.js';
import { normalizePhone } from '../lib/phone.js';
import { requireUploadedFile, validateBodyFields } from '../lib/validation.js';
import { guardUpload, UploadGuardError } from '../lib/upload-guard.js';
import { parseResume } from '../lib/resume-parser.js';
import { fallbackParseResumeText, hasUsefulFallbackResume } from '../lib/resume-fallback.js';
import { resolveScanner } from '../lib/malware-scanner.js';
import { uploadResumeBodySchema, type RecruiterAuthGuard } from '../schemas/candidates.js';
import { createLogger } from '../lib/logger.js';
import type { ParsedResume } from '../lib/types.js';

const resumesLogger = createLogger('resumes');

function boundedEnvInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
}

const RESUME_MAX_COMPRESSED_BYTES = boundedEnvInt(
  process.env.RESUME_MAX_COMPRESSED_BYTES, 10 * 1024 * 1024, 1024, 25 * 1024 * 1024,
);
const RESUME_PARSER_TIMEOUT_MS = boundedEnvInt(
  process.env.RESUME_PARSER_TIMEOUT_MS, 30_000, 1000, 120_000,
);
const RESUME_MAX_TEXT_LENGTH = boundedEnvInt(
  process.env.RESUME_MAX_TEXT_LENGTH, 50_000, 1000, 200_000,
);

// ── Multer setup ────────────────────────────────────────────────────────────

/**
 * Maximum multipart parts: file(1) + body fields(10 max) + multipart overhead.
 * We intentionally limit fields to only those in our schema.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: RESUME_MAX_COMPRESSED_BYTES,
    fields: 5,                   // only role_id (1), plus some margin
    files: 1,                    // exactly one file
    parts: 8,                    // file(1) + fields(5) + overhead
  },
});

// ── Auth guard injection ────────────────────────────────────────────────────

/** Default guard consumes the app-level verified recruiter context. */
const appAuthGuard: RecruiterAuthGuard = {
  name: 'app-auth',
  async authorize(req) {
    const user = req.authUser;
    if (!user || (user.appRole !== 'admin' && user.appRole !== 'interviewer')) return null;
    return user.id;
  },
};

// ── Router factory with injectable dependencies ─────────────────────────────

export interface ResumesRouterDeps {
  /** Recruiter authorization guard (injectable for Codex). */
  authGuard?: RecruiterAuthGuard;
  /** NODE_ENV override for deterministic testing. */
  nodeEnv?: string;
  /** Allow EICAR in non-production (default false; tests set to true). */
  allowEicar?: boolean;
}

export function createResumesRouter(deps: ResumesRouterDeps = {}): Router {
  const router = Router();
  const nodeEnv = deps.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const authGuard: RecruiterAuthGuard = deps.authGuard ?? appAuthGuard;
  const scanner = resolveScanner(nodeEnv);

  // ── POST /api/resumes — upload resume ──────────────────────────

  router.post(
    '/',
    // Step 0: Recruiter authorization (fails closed in production)
    async (req, res, next) => {
      try {
        const recruiterId = await authGuard.authorize(req);
        if (!recruiterId) {
          resumesLogger.warn('unknown_event', { error_category: 'auth_denied', error_type: 'no_recruiter' });
          return res.status(401).json({ error: { type: 'unauthorized', message: 'Recruiter authorization required' } });
        }
        // Attach recruiter identity for auditing
        (req as any).recruiterId = recruiterId;
        next();
      } catch (err) {
        resumesLogger.warn('unknown_event', { error_category: 'auth_error', error_type: 'auth_guard_exception' });
        return res.status(401).json({ error: { type: 'unauthorized', message: 'Recruiter authorization failed' } });
      }
    },
    // Step 1: Parse multipart body
    upload.single('file'),
    // Step 2: Validate body fields (only role_id allowed)
    validateBodyFields(uploadResumeBodySchema),
    // Step 3: Require uploaded file
    requireUploadedFile,
    // Step 4: Main handler
    async (req, res, next) => {
      try {
        const file = req.file!;
        const roleId = (req.body?.role_id as string) || null;

        // ── 4a. Upload guard: validate file structural integrity ──────
        let guardResult;
        try {
          guardResult = guardUpload(file.buffer, file.mimetype, file.originalname, {
            maxCompressedBytes: RESUME_MAX_COMPRESSED_BYTES,
          });
        } catch (err) {
          if (err instanceof UploadGuardError) {
            return res.status(422).json({
              error: {
                type: 'validation_error',
                code: err.code,
                message: err.message,
              },
            });
          }
          throw err;
        }

        // ── 4b. Malware scan ─────────────────────────────────────────
        const scanResult = await scanner.scan(file.buffer);
        if (!scanResult.safe) {
          resumesLogger.warn('unknown_event', {
            error_category: 'malware_rejected',
            error_type: scanResult.status,
          });
          return res.status(422).json({
            error: {
              type: 'malware_detected',
              status: scanResult.status,
              message: scanResult.status === 'infected'
                ? 'File rejected by malware scanner'
                : 'File could not be verified as safe',
            },
          });
        }

        // ── 4c. Store raw file in private bucket ─────────────────────
        const { mime: validatedMime, storageKey } = guardResult;
        const { error: upErr } = await supabase.storage
          .from(RESUME_BUCKET)
          .upload(storageKey, file.buffer, { contentType: validatedMime, upsert: false });

        if (upErr) {
          // Storage failure — don't proceed further
          return res.status(502).json({
            error: { type: 'storage_error', message: 'Failed to store uploaded file' },
          });
        }

        // ── 4d. Parse text via isolated child process ────────────────
        let parseResult;
        try {
          parseResult = await parseResume(file.buffer, validatedMime, {
            timeoutMs: RESUME_PARSER_TIMEOUT_MS,
            maxTextLength: RESUME_MAX_TEXT_LENGTH,
          });
        } catch (err) {
          // Storage orphan cleanup (best-effort)
          await supabase.storage.from(RESUME_BUCKET).remove([storageKey]).then(() => {}, () => {});

          const errCode = (err as any)?.code ?? '';
          const errName = (err as any)?.name ?? '';
          const isTimeout = errCode === 'PARSER_TIMEOUT' || errName === 'ParserTimeoutError';
          const isOutputExceeded = errCode === 'PARSER_OUTPUT_EXCEEDED' || errName === 'ParserOutputExceededError';
          const isParseError = errCode === 'PARSER_ERROR' || errName === 'ParserError';

          if (isTimeout || isOutputExceeded || isParseError) {
            return res.status(422).json({
              error: { type: 'parse_error', message: 'Could not extract readable text from this file.' },
            });
          }
          throw err;
        }

        const text = parseResult.text;
        if (!text || text.trim().length < 20) {
          // Cleanup orphan
          await supabase.storage.from(RESUME_BUCKET).remove([storageKey]).then(() => {}, () => {});
          return res.status(422).json({
            error: { type: 'parse_error', message: 'Could not extract readable text from this file.' },
          });
        }

        // ── 4e. Parse with LLM ──────────────────────────────────────
        let parsed: ParsedResume;
        try {
          parsed = await runClaudeJSON<ParsedResume>(buildExtractionPrompt(text));
        } catch (err) {
          // LLM structuring failure should not block an otherwise safe/readable
          // resume. Fall back to deterministic extraction from the already
          // parsed text and keep the raw text_extracted for recruiter review.
          const fallback = fallbackParseResumeText(text);
          if (!hasUsefulFallbackResume(fallback)) {
            await supabase.storage.from(RESUME_BUCKET).remove([storageKey]).then(() => {}, () => {});
            return res.status(502).json({
              error: { type: 'brain_error', message: 'Failed to parse resume content.' },
            });
          }
          resumesLogger.warn('unknown_event', {
            error_category: 'resume_llm_parse_failed',
            error_type: 'deterministic_fallback_used',
          });
          parsed = fallback;
        }

        // ── 4f. Normalize phone ─────────────────────────────────────
        const phone = normalizePhone(parsed.phone);

        // ── 4g. Persist resume row ──────────────────────────────────
        const { data: resumeRow, error: rErr } = await supabase
          .from('resumes')
          .insert({
            file_path: storageKey,
            file_name: file.originalname,
            mime_type: validatedMime,
            text_extracted: text.slice(0, RESUME_MAX_TEXT_LENGTH),
            parsed,
          })
          .select()
          .single();

        if (rErr) {
          // Cleanup orphan
          await supabase.storage.from(RESUME_BUCKET).remove([storageKey]).then(() => {}, () => {});
          return res.status(502).json({
            error: { type: 'persistence_error', message: 'Failed to save resume record.' },
          });
        }

        // ── 4h. Persist candidate row ──────────────────────────────
        const now = new Date().toISOString();
        const { data: candidate, error: cErr } = await supabase
          .from('candidates')
          .insert({
            role_id: roleId,
            resume_id: resumeRow.id,
            owner_id: (req as any).recruiterId,
            name: parsed.name,
            email: parsed.email,
            phone_raw: phone.raw || parsed.phone,
            phone_e164: phone.e164,
            phone_valid: phone.valid,
            skills: parsed.skills ?? [],
            experience_years: parsed.experience_years,
            parsed,
            status: 'new',
            consent_source: 'job_application',
            consent_at: now,
          })
          .select()
          .single();

        if (cErr) {
          // Cleanup both resume row and storage
          await supabase.from('resumes').delete().eq('id', resumeRow.id).then(() => {}, () => {});
          await supabase.storage.from(RESUME_BUCKET).remove([storageKey]).then(() => {}, () => {});
          return res.status(502).json({
            error: { type: 'persistence_error', message: 'Failed to save candidate record.' },
          });
        }

        // ── 4i. Consent record ──────────────────────────────────────
        supabase.from('consent_records').insert({
          candidate_id: candidate.id,
          source: 'job_application',
          proof: { note: 'Candidate submitted resume/application for this role.', captured_at: now },
        }).then(() => {}, () => {
          // Non-fatal: consent record failure should not reject the upload
          resumesLogger.warn('unknown_event', {
            error_category: 'consent_failed',
            error_type: 'insert_error',
          });
        });

        // ── 4j. Success response — no raw parser errors, no signed URLs ──
        res.status(201).json({ candidate, resume: resumeRow, phone });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}

// ── Backward-compatible default export ──────────────────────────────────────

export const resumesRouter = createResumesRouter();
