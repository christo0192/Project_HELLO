/**
 * CSP violation report endpoint.
 *
 * SEC-07: Bounded at 64 KiB. Validates legacy (csp-report) and
 * Reporting API (reports[]) shapes with meaningful field requirements.
 * Oversized → 413 under stable error contract.
 * Malformed JSON → 400 under stable error contract.
 * Structured JSON log event, URL origins only, no raw bodies.
 *
 * This is an unauthenticated endpoint by design (browser CSP reports
 * cannot carry auth headers). It is bounded and safe by construction.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';

export const cspReportRouter = Router();

// ── Payload shape validators (require enough fields for real violations) ─

/** Legacy CSP report: { 'csp-report': { ... } } — must have at least
 *  document-uri AND either violated-directive or blocked-uri. */
const legacyReportSchema = z.object({
  'csp-report': z.object({
    'document-uri': z.string().min(1),
    'referrer': z.string().optional(),
    'violated-directive': z.string().optional(),
    'effective-directive': z.string().optional(),
    'original-policy': z.string().optional(),
    'blocked-uri': z.string().optional(),
    'line-number': z.number().optional(),
    'column-number': z.number().optional(),
    'source-file': z.string().optional(),
    'status-code': z.number().optional(),
    'script-sample': z.string().optional(),
  }).passthrough().refine(
    (r) => (r['violated-directive'] || r['blocked-uri']),
    { message: 'legacy report must include at least violated-directive or blocked-uri' },
  ),
});

/** Reporting API: [{ type: 'csp-violation', body: { ... } }] */
const reportingApiEntrySchema = z.object({
  type: z.literal('csp-violation'),
  body: z.object({
    documentURL: z.string().min(1),
    referrer: z.string().optional(),
    violatedDirective: z.string().optional(),
    effectiveDirective: z.string().optional(),
    originalPolicy: z.string().optional(),
    blockedURL: z.string().optional(),
    lineNumber: z.number().optional(),
    columnNumber: z.number().optional(),
    sourceFile: z.string().optional(),
    statusCode: z.number().optional(),
    sample: z.string().optional(),
  }).passthrough().refine(
    (b) => (b.violatedDirective || b.blockedURL),
    { message: 'Reporting API entry must include at least violatedDirective or blockedURL' },
  ),
});

const reportingApiSchema = z.array(reportingApiEntrySchema).min(1);

// ── Structured log helper ────────────────────────────────────────────

/** Strip control characters (0x00–0x1F, 0x7F) from a string.
 *  Any text after the first control character is also stripped
 *  to prevent log injection across control boundaries. */
function stripControlChars(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return s.slice(0, i);
  }
  return s;
}

/** Extract origin from a URL string.  Returns "unknown" if
 *  unparseable, contains credentials, or otherwise unsafe. */
function urlOrigin(raw: string): string {
  try {
    const cleaned = raw.split('?')[0].split('#')[0];
    const u = new URL(cleaned);
    // Reject embedded credentials — never log them.
    if (u.username || u.password) return 'unknown';
    return stripControlChars(u.origin);
  } catch {
    return 'unknown';
  }
}

/** Truncate and sanitize directive text. Max 256 chars, no control chars. */
function sanitizeDirective(raw: string): string {
  const cleaned = stripControlChars(raw);
  return cleaned.length > 256 ? cleaned.slice(0, 253) + '...' : cleaned;
}

function emitViolationLog(shape: string, fields: Record<string, string>) {
  // Structured JSON via console.warn — the established project
  // pattern for operational events that are not debug noise.
  const event = {
    event: 'csp_violation',
    shape,
    ...fields,
    timestamp: new Date().toISOString(),
  };
  console.warn(JSON.stringify(event));
}

// ── Route ─────────────────────────────────────────────────────────────

cspReportRouter.post('/', (req: Request, res: Response) => {
  // Always return 204 — browsers do not retry on failure, and the
  // response must not leak any information about server state.
  res.status(204).end();

  try {
    const body = req.body;

    if (!body || typeof body !== 'object') return;

    // Try legacy format first
    const legacy = legacyReportSchema.safeParse(body);
    if (legacy.success) {
      const r = legacy.data['csp-report'];
      emitViolationLog('legacy', {
        document_origin: urlOrigin(r['document-uri']),
        violated_directive: r['violated-directive'] ? sanitizeDirective(r['violated-directive']) : '',
        effective_directive: r['effective-directive'] ? sanitizeDirective(r['effective-directive']) : '',
        blocked_origin: r['blocked-uri'] ? urlOrigin(r['blocked-uri']) : '',
      });
      return;
    }

    // Try Reporting API format
    if (Array.isArray(body)) {
      const api = reportingApiSchema.safeParse(body);
      if (api.success) {
        for (const entry of api.data) {
          const b = entry.body;
          emitViolationLog('reporting-api', {
            document_origin: urlOrigin(b.documentURL),
            violated_directive: b.violatedDirective ? sanitizeDirective(b.violatedDirective) : '',
            effective_directive: b.effectiveDirective ? sanitizeDirective(b.effectiveDirective) : '',
            blocked_origin: b.blockedURL ? urlOrigin(b.blockedURL) : '',
          });
        }
        return;
      }
    }
  } catch {
    // Never crash
  }
});
