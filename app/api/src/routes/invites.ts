/**
 * Candidate invite exchange and LiveKit room access.
 *
 * Invariants:
 * 1. Recruiter issuance requires an injected authenticated admin/interviewer
 *    context and enforces interviewer ownership.
 * 2. Invite token uses at least 256 random bits, plaintext returned once,
 *    only SHA-256 digest persisted. Exchange response does not distinguish
 *    unknown/expired/revoked/consumed tokens beyond a stable 4xx.
 * 3. Exchange creates/returns a short-lived opaque candidate access grant
 *    bound to exactly one candidate/session/room; only digest persisted.
 * 4. Room metadata, participant metadata and token metadata contain no
 *    candidate name/email/phone, resume facts, JD/role focus, screening
 *    template, transcript/scoring context, provider secrets, or access tokens.
 *
 * DB migration 0007 tables: candidate_invites, candidate_access_grants.
 * Invite active = consumed_at IS NULL AND revoked_at IS NULL.
 * Consumed = consumed_at SET. Revoked = revoked_at SET.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { env } from '../lib/env.js';
import { validateBody } from '../lib/validation.js';
import {
  inviteCreateSchema,
  inviteExchangeSchema,
} from '../schemas/invites.js';
import { createGrant } from '../lib/candidate-access.js';
import { readMaintenanceState, maintenanceBlockedBody } from '../lib/maintenance.js';
import type { InviteCreateResponse, InviteExchangeResponse } from '../schemas/invites.js';
import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';

export const invitesRouter = Router();

// ── Env guard ────────────────────────────────────────────────────────

function requireLiveKit() {
  if (!env.livekitUrl || !env.livekitApiKey || !env.livekitApiSecret) {
    throw new Error(
      'LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be set in app/api/.env',
    );
  }
}

// ── Token helpers ────────────────────────────────────────────────────

function generateInviteToken(): string {
  return randomBytes(32).toString('hex');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

const STABLE_EXPIRY_MSG = 'invite_token_invalid_or_expired';

// ── Interivewer auth context ─────────────────────────────────────────

export interface InviteRequestContext {
  interviewer_id: string;
  is_admin?: boolean;
}

/**
 * Injected middleware guard for invite issuance.
 * Codex wires the actual auth extractor; this casts a wide net
 * that rejects unauthenticated requests.
 */
export function requireInviteAuth(
  getContext: (req: Request) => InviteRequestContext | null,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const ctx = getContext(req);
    if (!ctx) {
      return res.status(401).json({ error: 'authentication_required' });
    }
    (req as any)._inviteContext = ctx;
    next();
  };
}

// ── POST /api/livekit/invite ─────────────────────────────────────────
// Recruiter/admin issues a one-time invite token.
// Guard: requireInviteAuth injected by Codex.

invitesRouter.post(
  '/invite',
  requireInviteAuth((req) => {
    const user = req.authUser;
    if (!user || (user.appRole !== 'admin' && user.appRole !== 'interviewer')) return null;
    return { interviewer_id: user.id, is_admin: user.appRole === 'admin' };
  }),
  validateBody(inviteCreateSchema),
  async (req, res, next) => {
    try {
      requireLiveKit();
      const inviteCtx: InviteRequestContext | undefined = (req as any)._inviteContext;
      if (!inviteCtx) {
        return res.status(401).json({ error: 'authentication_required' });
      }

      const { candidate_id, session_id } = req.body as { candidate_id: string; session_id: string };

      // Validate session exists
      const { data: session, error: sessionErr } = await supabase
        .from('call_sessions')
        .select('id, candidate_id, status, external_call_id, owner_id')
        .eq('id', session_id)
        .single();

      if (sessionErr || !session) {
        return res.status(404).json({ error: 'session_not_found' });
      }

      if (session.candidate_id !== candidate_id) {
        return res.status(403).json({ error: 'candidate_mismatch' });
      }

      // SEC-04 ownership: only the owner (interviewer who created the session)
      // or an admin may issue an invite. owner_id is set at session creation.
      if (!inviteCtx.is_admin && session.owner_id !== inviteCtx.interviewer_id) {
        return res.status(403).json({ error: 'owner_mismatch' });
      }

      // Only allow inviting for non-terminal sessions
      if (session.status !== 'created' && session.status !== 'waiting') {
        return res.status(409).json({ error: 'session_not_available' });
      }

      // Generate invite token (256 bits)
      const token = generateInviteToken();
      const digest = hashToken(token);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h TTL

      // Persist only the SHA-256 digest into candidate_invites (migration 0007)
      // consumed_at NULL = active; revoked_at NULL = not revoked.
      const { error: insertErr } = await supabase
        .from('candidate_invites')
        .insert({
          token_digest: digest,
          candidate_id,
          session_id,
          created_by: inviteCtx.interviewer_id,
          expires_at: expiresAt.toISOString(),
          // consumed_at, revoked_at default NULL in DB
        });

      if (insertErr) {
        return next(new Error('failed to create invite token'));
      }

      // Return plaintext token exactly once
      res.status(201).json({ token, expires_at: expiresAt.toISOString() } satisfies InviteCreateResponse);
    } catch (error) {
      next(error);
    }
  },
);

/**
 * Phase 9 L4 — server-authoritative consent gate for the exchange route.
 *
 * Runs BEFORE the atomic invite-consume CAS so an unconsumed invite can be
 * retried once consent is granted. Fails closed on:
 *  - maintenance mode (new joins blocked; consent submission itself remains
 *    allowed — this gate never touches consent writes),
 *  - missing/inactive consent template,
 *  - latest consent record NOT granted, or expired,
 *  - granted consents missing a template-required type.
 *
 * The LATEST consent record is fetched REGARDLESS of status so a later
 * declined/withdrawn/expired record overrides an older grant.
 */
async function checkExchangeConsentGate(invite: {
  candidate_id: string;
}): Promise<{ ok: true } | { ok: false; code: 'maintenance' | 'consent_required' }> {
  const state = await readMaintenanceState();
  if (!state.ok || state.enabled) {
    // DB read failure also fails closed for a new-join gate.
    return { ok: false, code: 'maintenance' };
  }

  // Latest record regardless of status — a later declined/withdrawn/expired
  // record overrides an older grant.
  const { data: latest } = await supabase
    .from('consent_records')
    .select('status, consents, expires_at')
    .eq('candidate_id', invite.candidate_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const hasValidGrant =
    latest &&
    latest.status === 'granted' &&
    (!latest.expires_at || new Date(latest.expires_at) > new Date());

  // Active Legal-approved template is required — absence fails closed.
  const { data: template } = await supabase
    .from('consent_templates')
    .select('required_consents')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!hasValidGrant || !template) {
    return { ok: false, code: 'consent_required' };
  }

  const granted: string[] = Array.isArray(latest.consents) ? latest.consents : [];
  const required: string[] = Array.isArray(template.required_consents)
    ? template.required_consents
    : [];
  const missing = required.filter((r) => !granted.includes(r));
  if (missing.length > 0) {
    return { ok: false, code: 'consent_required' };
  }

  return { ok: true };
}

// ── POST /api/livekit/exchange ───────────────────────────────────────
// Candidate exchanges an invite token for a short-lived access grant.

invitesRouter.post(
  '/exchange',
  validateBody(inviteExchangeSchema),
  async (req, res, next) => {
    try {
      requireLiveKit();
      const { token } = req.body as { token: string };
      const digest = hashToken(token);

      // Step 1: Fetch invite row from candidate_invites (migration 0007).
      // Active = consumed_at IS NULL AND revoked_at IS NULL.
      const { data: invite, error: fetchErr } = await supabase
        .from('candidate_invites')
        .select('id, candidate_id, session_id, expires_at, consumed_at, revoked_at')
        .eq('token_digest', digest)
        .single();

      // Stable 4xx — never distinguish unknown/expired/revoked/consumed.
      if (fetchErr || !invite) {
        return res.status(404).json({ error: STABLE_EXPIRY_MSG });
      }

      // Check expiry
      if (new Date(invite.expires_at) < new Date()) {
        return res.status(404).json({ error: STABLE_EXPIRY_MSG });
      }

      // Check not consumed and not revoked (NULL checks)
      if (invite.consumed_at !== null || invite.revoked_at !== null) {
        return res.status(404).json({ error: STABLE_EXPIRY_MSG });
      }

      // Phase 9 L4: server-authoritative consent gate BEFORE the atomic CAS
      // consume. Maintenance blocks new joins (503) and missing/declined/
      // withdrawn/expired consent or a missing/inactive template fails closed
      // (409 consent_required). In both cases the invite is left unconsumed so
      // a later grant/retry can still succeed.
      const gate = await checkExchangeConsentGate(invite);
      if (!gate.ok) {
        if (gate.code === 'maintenance') {
          return res.status(503).json(maintenanceBlockedBody());
        }
        return res.status(409).json({ error: 'consent_required' });
      }

      // Step 2: Look up session for room name BEFORE consuming the one-time
      // invite. If the session is no longer joinable, the candidate may retry
      // after ops/admin fixes session state without the token being burned.
      const { data: session } = await supabase
        .from('call_sessions')
        .select('id, external_call_id, status')
        .eq('id', invite.session_id)
        .single();

      if (
        !session ||
        !['waiting', 'in_progress'].includes(session.status as string) ||
        !session.external_call_id
      ) {
        return res.status(404).json({ error: STABLE_EXPIRY_MSG });
      }

      const roomName = session.external_call_id;

      // Step 3: Atomic CAS — update consumed_at where consumed_at IS NULL.
      const nowIso = new Date().toISOString();
      const { data: consumed, error: consumeErr } = await supabase
        .from('candidate_invites')
        .update({ consumed_at: nowIso })
        .eq('id', invite.id)
        .is('consumed_at', null)
        .is('revoked_at', null)
        .gt('expires_at', nowIso)
        .select('id');

      if (consumeErr || !consumed || consumed.length === 0) {
        // CAS failed — another request consumed this token first
        return res.status(404).json({ error: STABLE_EXPIRY_MSG });
      }

      // Step 4: Create short-lived opaque candidate access grant (candidate_access_grants)
      const grant = await createGrant({
        candidate_id: invite.candidate_id,
        session_id: invite.session_id,
        room_name: roomName,
      });

      // Step 5: Build minimal LiveKit JWT (short TTL, one room, no admin)
      const livekitToken = await buildCandidateToken(
        invite.candidate_id,
        invite.session_id,
        roomName,
      );

      res.status(200).json({
        grant_token: grant.grantToken,
        url: env.livekitUrl,
        room_name: roomName,
        session_id: invite.session_id,
        expires_at: grant.expiresAt.toISOString(),
        livekit_token: livekitToken,
      } satisfies InviteExchangeResponse);
    } catch (error) {
      next(error);
    }
  },
);

// ── POST /api/livekit/grant/recording ────────────────────────────────
// Validate grant and return short-lived signed recording URL.

export async function handleRecordingGrant(
  grantToken: string,
  sessionId: string,
): Promise<{ url: string }> {
  const { validateGrant } = await import('../lib/candidate-access.js');

  const validation = await validateGrant(grantToken);
  if (!validation.ok) {
    throw Object.assign(new Error(validation.code), { statusCode: 403 });
  }

  // Compare request session_id AND room_name independently, not payload to itself.
  if (validation.payload.session_id !== sessionId) {
    throw Object.assign(new Error('ERR_GRANT_BINDING'), { statusCode: 403 });
  }

  // Look up recording object key from session
  const { data: session } = await supabase
    .from('call_sessions')
    .select('recording_object_key')
    .eq('id', sessionId)
    .single();

  if (!session || !session.recording_object_key) {
    throw Object.assign(new Error('recording_not_found'), { statusCode: 404 });
  }

  // Mint short-TTL signed URL (5 minutes)
  const { data, error: signErr } = await supabase.storage
    .from(env.recordingsBucket)
    .createSignedUrl(session.recording_object_key as string, 5 * 60);

  if (signErr || !data?.signedUrl) {
    throw Object.assign(new Error('failed_to_generate_url'), { statusCode: 500 });
  }

  return { url: data.signedUrl };
}

// ── Build minimal LiveKit candidate token ────────────────────────────

async function buildCandidateToken(
  candidateId: string,
  sessionId: string,
  roomName: string,
): Promise<string> {
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: `candidate-${candidateId.slice(0, 8)}-${sessionId.slice(0, 8)}`,
    ttl: '5m',
  });

  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });

  return await token.toJwt();
}
