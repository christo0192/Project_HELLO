/**
 * GOV-03/GOV-08/GOV-09/GOV-10: Consent and privacy notice routes.
 *
 * INVARIANTS:
 * 1. Consent is versioned — each record carries a template version string.
 * 2. Legal copy is unapproved — templates are placeholder only.
 * 3. GOV-09: Decline → join fails, AI/recording blocked.
 * 4. GOV-10: job_application consent_type alone CANNOT unlock ai_interview
 *    or recording. Consumer-side guards enforce this via hasConsentFor().
 * 5. All consent records are append-only. Withdrawal inserts a new
 *    record with status='withdrawn'.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateQuery } from '../lib/validation.js';
import { createLogger } from '../lib/logger.js';
import {
  consentSubmitSchema,
  consentStatusQuerySchema,
  consentCheckSchema,
  consentWithdrawSchema,
  CONSENT_TYPES,
  type ConsentType,
  type ConsentSubmitResponse,
  type ConsentStatusResponse,
  type ConsentCheckResponse,
  type ConsentTemplateResponse,
  type ConsentWithdrawResponse,
} from '../schemas/consent.js';

const consentLogger = createLogger('consent');

export const consentRouter = Router();

// ── Helpers ─────────────────────────────────────────────────────────

const AI_RECORDING_TYPES: ConsentType[] = ['ai_interview', 'recording'];

/**
 * GOV-10: Check if a candidate has granted ALL required consent types.
 * job_application alone is NOT sufficient for ai_interview or recording.
 *
 * Returns the list of missing consent types.
 */
export async function hasConsentFor(
  candidateId: string,
  required: ConsentType[],
): Promise<{ ok: boolean; missing: ConsentType[] }> {
  // Fetch the LATEST consent record for this candidate REGARDLESS of status.
  // A later declined/withdrawn/expired record overrides an older grant, so
  // the status filter is deliberately applied in code, not in the query.
  const { data, error } = await supabase
    .from('consent_records')
    .select('consents, status, expires_at')
    .eq('candidate_id', candidateId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) {
    // No consent record at all → all types are missing
    return { ok: false, missing: required };
  }

  // Defense-in-depth: the latest record must be an active grant. A declined
  // or withdrawn record must never unlock any consent type, even if one
  // reaches this code path. GOV-09: decline/withdraw fail closed.
  if (data.status !== 'granted') {
    return { ok: false, missing: required };
  }

  // Check expiry
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return { ok: false, missing: required };
  }

  const granted: ConsentType[] = data.consents as ConsentType[];

  // GOV-10: If granted only contains job_application, it cannot unlock ai_interview/recording
  const hasOnlyJobApplication =
    granted.length === 1 && granted[0] === 'job_application';

  const missing = required.filter((t) => {
    // job_application alone cannot substitute for AI/recording types
    if (hasOnlyJobApplication && AI_RECORDING_TYPES.includes(t)) {
      return true;
    }
    return !granted.includes(t);
  });

  return { ok: missing.length === 0, missing };
}

// ── POST /api/consent/submit ─────────────────────────────────────────
// Submit a consent record (accept or decline specific consent types).

consentRouter.post(
  '/consent/submit',
  validateBody(consentSubmitSchema),
  async (req, res, next) => {
    try {
      const { candidate_id, version, consents, status, proof, expires_at } = req.body;

      // Verify candidate exists
      const { data: candidate, error: candErr } = await supabase
        .from('candidates')
        .select('id')
        .eq('id', candidate_id)
        .single();

      if (candErr || !candidate) {
        return res.status(404).json({ error: { type: 'not_found', message: 'Candidate not found' } });
      }

      const now = new Date().toISOString();

      // Insert consent record (append-only)
      const { data: record, error: insertErr } = await supabase
        .from('consent_records')
        .insert({
          candidate_id,
          version,
          consents,
          status,
          proof: {
            ...(proof ?? {}),
            captured_at: proof?.captured_at ?? now,
          },
          expires_at: expires_at ?? null,
          classification_level: 3, // Confidential PII (proof may contain PII)
          source: 'candidate_portal',
          ip_address: req.ip ?? null,
          user_agent: req.headers['user-agent'] ?? null,
        })
        .select('id, candidate_id, status, consents, version, created_at')
        .single();

      if (insertErr || !record) {
        // Use the allowlisted 'db_error' event; the raw DB message and
        // candidate_id are intentionally NOT logged (not allowlisted — they
        // could carry PII). error_type carries the stable failure code.
        consentLogger.error('db_error', { error_type: 'consent_insert_failed' });
        return res.status(500).json({ error: { type: 'internal_error', message: 'Failed to record consent' } });
      }

      // If declined, update candidate status to indicate consent declined
      if (status === 'declined') {
        await supabase
          .from('candidates')
          .update({ status: 'consent_declined' })
          .eq('id', candidate_id)
          .then(() => {}, () => {});
      }

      res.status(201).json({
        id: record.id,
        candidate_id: record.candidate_id,
        status: record.status,
        consents: record.consents,
        version: record.version,
        created_at: record.created_at,
      } satisfies ConsentSubmitResponse);
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/consent/:candidateId/status ────────────────────────────
// Get candidate's current consent status.

consentRouter.get(
  '/consent/:candidateId/status',
  async (req, res, next) => {
    try {
      const { candidateId } = req.params;

      // Verify candidate exists
      const { data: candidate, error: candErr } = await supabase
        .from('candidates')
        .select('id')
        .eq('id', candidateId)
        .single();

      if (candErr || !candidate) {
        return res.status(404).json({ error: { type: 'not_found', message: 'Candidate not found' } });
      }

      // Get latest consent record
      const { data: latest, error: latestErr } = await supabase
        .from('consent_records')
        .select('id, status, consents, version, expires_at, created_at')
        .eq('candidate_id', candidateId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (latestErr || !latest) {
        return res.status(200).json({
          candidate_id: candidateId,
          has_consent: false,
          has_ai_consent: false,
          has_recording_consent: false,
          latest_consent: null,
        } satisfies ConsentStatusResponse);
      }

      const granted: ConsentType[] = latest.consents as ConsentType[];
      const isExpired = latest.expires_at && new Date(latest.expires_at) < new Date();
      const isActive = latest.status === 'granted' && !isExpired;

      res.status(200).json({
        candidate_id: candidateId,
        has_consent: isActive,
        has_ai_consent: isActive && granted.includes('ai_interview'),
        has_recording_consent: isActive && granted.includes('recording'),
        latest_consent: {
          id: latest.id,
          status: latest.status as 'granted' | 'declined' | 'withdrawn',
          consents: granted,
          version: latest.version,
          created_at: latest.created_at,
        },
      } satisfies ConsentStatusResponse);
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/consent/check ─────────────────────────────────────────
// GOV-10: Check if candidate has required consent for an operation.

consentRouter.post(
  '/consent/check',
  validateBody(consentCheckSchema),
  async (req, res, next) => {
    try {
      const { candidate_id, required } = req.body;
      const result = await hasConsentFor(candidate_id, required as ConsentType[]);

      res.status(200).json({
        ok: result.ok,
        missing: result.missing,
      } satisfies ConsentCheckResponse);
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/consent/withdraw ──────────────────────────────────────
// Withdraw previously granted consent types.

consentRouter.post(
  '/consent/withdraw',
  validateBody(consentWithdrawSchema),
  async (req, res, next) => {
    try {
      const { candidate_id, consent_types, reason } = req.body;

      // Verify candidate exists
      const { data: candidate, error: candErr } = await supabase
        .from('candidates')
        .select('id')
        .eq('id', candidate_id)
        .single();

      if (candErr || !candidate) {
        return res.status(404).json({ error: { type: 'not_found', message: 'Candidate not found' } });
      }

      // Get the latest active consent record to derive the consent set
      const { data: latest, error: latestErr } = await supabase
        .from('consent_records')
        .select('id, consents, version')
        .eq('candidate_id', candidate_id)
        .eq('status', 'granted')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      if (latestErr || !latest) {
        return res.status(404).json({ error: { type: 'not_found', message: 'No active consent to withdraw' } });
      }

      const currentConsents: ConsentType[] = latest.consents as ConsentType[];
      const toRemove = consent_types ?? (currentConsents.filter(
        (t) => t !== 'job_application', // keep job_application as base
      ) as ConsentType[]);

      const remaining = currentConsents.filter((t) => !toRemove.includes(t));

      const now = new Date().toISOString();

      // Insert a withdrawal record (append-only)
      const { data: record, error: insertErr } = await supabase
        .from('consent_records')
        .insert({
          candidate_id,
          version: latest.version,
          consents: remaining,
          status: 'withdrawn',
          proof: {
            withdrawn_at: now,
            withdrawn_types: toRemove,
            reason: reason ?? null,
          },
          classification_level: 3,
          source: 'candidate_portal',
          ip_address: req.ip ?? null,
          user_agent: req.headers['user-agent'] ?? null,
        })
        .select('id, status, updated_at')
        .single();

      if (insertErr || !record) {
        consentLogger.error('db_error', { error_type: 'consent_withdraw_failed' });
        return res.status(500).json({ error: { type: 'internal_error', message: 'Failed to withdraw consent' } });
      }

      res.status(200).json({
        id: record.id,
        status: 'withdrawn',
        updated_at: record.updated_at ?? now,
      } satisfies ConsentWithdrawResponse);
    } catch (error) {
      next(error);
    }
  },
);

// ── GET /api/consent/templates ──────────────────────────────────────
// Get active privacy notice templates.

consentRouter.get(
  '/consent/templates',
  async (_req, res, next) => {
    try {
      const { data: templates, error } = await supabase
        .from('consent_templates')
        .select('*')
        .eq('is_active', true)
        .order('version', { ascending: false });

      if (error) {
        consentLogger.error('db_error', { error_type: 'templates_fetch_failed' });
        return res.status(500).json({ error: { type: 'internal_error', message: 'Failed to fetch templates' } });
      }

      res.status(200).json((templates ?? []).map((t) => ({
        id: t.id,
        version: t.version,
        locale: t.locale,
        title: t.title,
        body_md: t.body_md,
        required_consents: t.required_consents as ConsentType[],
        is_active: t.is_active,
      })) satisfies ConsentTemplateResponse[]);
    } catch (error) {
      next(error);
    }
  },
);
