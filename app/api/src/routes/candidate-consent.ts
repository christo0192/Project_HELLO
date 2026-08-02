/**
 * Phase 9 L3 — candidate pre-join consent (invite-opaque).
 *
 * Invariant 1:
 * - The candidate holds an opaque invite token, NOT an access grant.
 * - Every route validates the invite (validateInvite) before any candidate
 *   DB write; failures are stable (unknown/expired/revoked/consumed are
 *   indistinguishable).
 * - Status/template responses never contain candidate_id, PII, or any
 *   token/digest material.
 * - GET template returns ONLY an active versioned template; absence fails
 *   closed (404) without pretending Legal copy exists.
 * - Submit requires the active exact template; granted must satisfy the
 *   template's required consent types; decline is append-only and does NOT
 *   consume/revoke the invite. Proof stores the safe invite id/session
 *   binding — never the token/digest.
 * - job_application alone can never unlock AI/recording: the required types
 *   are enforced from the active template.
 *
 * Router-level auth is NOT added here; L4 adds the exact PUBLIC_ROUTES
 * entries. This router validates the invite on every candidate DB write.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase.js';
import { validateBody, validateQuery } from '../lib/validation.js';
import { createLogger } from '../lib/logger.js';
import {
  consentStatusSchema,
  consentSubmitSchema,
  consentTemplateQuerySchema,
  type ConsentStatusResponse,
  type ConsentTemplateResponse,
  type ConsentSubmitResponse,
} from '../schemas/candidate-consent.js';
import { validateInvite, STABLE_INVITE_ERROR } from '../lib/invite-validation.js';

const consentLogger = createLogger('candidate-consent');

export const candidateConsentRouter = Router();

/**
 * POST /api/candidate-consent/status
 * Validates the invite and returns bounded current server consent/template
 * status — no candidate_id, no PII, no token/digest.
 */
candidateConsentRouter.post(
  '/status',
  validateBody(consentStatusSchema),
  async (req, res, next) => {
    try {
      const result = await validateInvite(req.body.invite_token);
      if (!result.ok) return res.status(404).json({ error: STABLE_INVITE_ERROR });
      const { invite } = result;

      // Latest granted consent record (not expired) for the invite-bound
      // candidate. The candidate id stays server-side only.
      const { data: latest } = await supabase
        .from('consent_records')
        .select('status, consents, version, expires_at')
        .eq('candidate_id', invite.candidate_id)
        .eq('status', 'granted')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      const hasConsent = Boolean(
        latest && (!latest.expires_at || new Date(latest.expires_at) > new Date()),
      );

      // Bounded server template status — active template only; null when no
      // active Legal template exists (never pretend Legal copy exists).
      const { data: template } = await supabase
        .from('consent_templates')
        .select('version, locale, required_consents')
        .eq('is_active', true)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      const body: ConsentStatusResponse = {
        has_consent: hasConsent,
        template_version: template?.version ?? null,
        locale: template?.locale ?? null,
        required_consents: (template?.required_consents ?? []) as string[],
      };
      res.json(body);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * GET /api/candidate-consent/template?locale=
 * Returns ONLY an active versioned template for the bounded/allowlisted
 * locale shape. Absence fails closed (404) — no pretend Legal copy.
 */
candidateConsentRouter.get(
  '/template',
  validateQuery(consentTemplateQuerySchema),
  async (req, res, next) => {
    try {
      const locale = (req.query.locale as string | undefined) ?? 'en-IN';
      const { data: template } = await supabase
        .from('consent_templates')
        .select('version, locale, title, body_md, required_consents')
        .eq('is_active', true)
        .eq('locale', locale)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!template) return res.status(404).json({ error: 'consent_template_unavailable' });

      const body: ConsentTemplateResponse = {
        version: template.version,
        locale: template.locale,
        title: template.title,
        body_md: template.body_md,
        required_consents: (template.required_consents ?? []) as string[],
      };
      res.json(body);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * POST /api/candidate-consent/submit
 * Validates the active invite + active exact template. Granted must satisfy
 * the template's required consent types; decline is append-only and never
 * consumes/revokes the invite. Proof carries only the safe invite id/session
 * binding — never the token/digest.
 */
candidateConsentRouter.post(
  '/submit',
  validateBody(consentSubmitSchema),
  async (req, res, next) => {
    try {
      const { invite_token, template_version, locale, consents, status } = req.body;

      // 1) Invite must be valid before ANY candidate DB write (fail closed).
      const result = await validateInvite(invite_token);
      if (!result.ok) return res.status(404).json({ error: STABLE_INVITE_ERROR });
      const { invite } = result;

      // 2) Active exact template required — absence fails closed (500) so we
      //    never record consent against a copy that doesn't exist.
      const { data: template } = await supabase
        .from('consent_templates')
        .select('version, required_consents')
        .eq('is_active', true)
        .eq('version', template_version)
        .eq('locale', locale)
        .maybeSingle();
      if (!template) {
        consentLogger.error('db_error', { error_type: 'consent_template_missing' });
        // Stable non-500, no raw internals: an unavailable Legal template must
        // not masquerade as a generic server crash (invariant 12). The invite
        // stays unconsumed so a later submit can succeed once a template exists.
        return res
          .status(503)
          .json({ error: { type: 'consent_template_unavailable', message: 'Consent template unavailable' } });
      }

      // 3) Granted must satisfy ALL template required consent types
      //    (job_application alone can never unlock ai_interview/recording).
      if (status === 'granted') {
        const required: string[] = (template.required_consents ?? []) as string[];
        const granted: string[] = consents as string[];
        const missing = required.filter((r) => !granted.includes(r));
        if (missing.length > 0) {
          return res
            .status(400)
            .json({ error: 'required_consents_missing', missing_consents: missing });
        }
      }

      // 4) Append-only consent record; decline does NOT consume/revoke the
      //    invite. Proof = safe invite id/session binding only.
      const { data: record, error: insertErr } = await supabase
        .from('consent_records')
        .insert({
          candidate_id: invite.candidate_id,
          version: template_version,
          consents,
          status,
          proof: {
            invite_id: invite.id,
            session_id: invite.session_id,
            captured_at: new Date().toISOString(),
          },
          classification_level: 3,
          source: 'candidate_portal',
          ip_address: req.ip ?? null,
          user_agent: req.headers['user-agent'] ?? null,
        })
        .select('id, status, consents, version, created_at')
        .single();
      if (insertErr || !record) {
        consentLogger.error('db_error', { error_type: 'consent_insert_failed' });
        return res
          .status(500)
          .json({ error: { type: 'internal_error', message: 'Failed to record consent' } });
      }

      // 5) Best-effort audit (DB-allowlisted candidate_consent_updated).
      await supabase.from('audit_events').insert({
        actor_id: invite.candidate_id,
        actor_type: 'candidate',
        action: 'candidate_consent_updated',
        target_type: 'candidate',
        target_id: invite.candidate_id,
        result: 'success',
        correlation_id: (req as { correlationId?: string | null }).correlationId ?? null,
        metadata: { consent_status: status, template_version, locale },
      });

      const body: ConsentSubmitResponse = {
        id: record.id,
        status: record.status as 'granted' | 'declined',
        consents: record.consents as string[],
        template_version: record.version,
        locale,
        created_at: record.created_at,
      };
      res.status(201).json(body);
    } catch (error) {
      next(error);
    }
  },
);
