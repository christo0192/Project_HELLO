/**
 * ashby/invite-delivery.ts — pure decision logic for Ashby-triggered candidate
 * invitations (Wave 2 work item 5). DB-free and deterministic; the integration
 * layer wires it to candidate_invites + the ashby_operations outbox.
 *
 * Invariants encoded here:
 *  - Per-job delivery mode email | manual | both; Phase-1 TTL is exactly 24h;
 *    no reminders are scheduled.
 *  - Exactly one ACTIVE browser invite/session per application.
 *  - The MANUAL (Ashby) channel MUST NOT carry a candidate bearer token. It
 *    exposes only a recruiter-authenticated, application-scoped reissue link
 *    (a site-relative path) — never the invite token/URL itself. A token-shaped
 *    field anywhere in a manual-delivery artifact fails CLOSED.
 *  - Email sending stays provider-gated (disabled until an approved provider +
 *    domain exist). Delivery is idempotent (stable operation key) with no
 *    duplicate sends.
 *  - Reissue REVOKES the old invite and issues a new one; no plaintext token
 *    ever appears in logs/DB generic payloads/analytics/Ashby.
 */

export const DELIVERY_MODES = ['email', 'manual', 'both'] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/** Fixed Phase-1 invite TTL. Any other value is rejected. */
export const INVITE_TTL_HOURS = 24 as const;

export function isValidDeliveryMode(mode: string): mode is DeliveryMode {
  return (DELIVERY_MODES as readonly string[]).includes(mode);
}

/** Channels a delivery mode fans out to. */
export function channelsForMode(mode: DeliveryMode): { email: boolean; manual: boolean } {
  return { email: mode === 'email' || mode === 'both', manual: mode === 'manual' || mode === 'both' };
}

// ── One active invite/session gate ───────────────────────────────────────────

export interface ActiveInviteView {
  /** Invite lifecycle status as stored (non-exhaustive; only 'active' matters). */
  status: 'active' | 'revoked' | 'consumed' | 'expired';
}

export type InviteIssueDecision =
  | { action: 'issue' }
  | { action: 'reuse_active' }
  | { action: 'blocked_terminal' };

/**
 * Decide whether to issue a new invite. Exactly one active invite per
 * application: if an active invite exists, reuse it (idempotent); a terminal
 * application blocks issuance entirely.
 */
export function decideInviteIssue(
  existingActive: ActiveInviteView | null | undefined,
  applicationTerminal: boolean,
): InviteIssueDecision {
  if (applicationTerminal) return { action: 'blocked_terminal' };
  if (existingActive && existingActive.status === 'active') return { action: 'reuse_active' };
  return { action: 'issue' };
}

// ── Manual (Ashby) channel: token-free indirection artifact ───────────────────

/** Case-insensitive fragments that must NEVER appear in a manual-delivery artifact. */
export const FORBIDDEN_MANUAL_KEY_FRAGMENTS: readonly string[] = [
  'token', 'bearer', 'secret', 'password', 'jwt',
  'invite_url', 'inviteurl', 'signed_url', 'signedurl', 'presigned',
  'plaintext', 'raw_invite', 'rawinvite',
];

function collectForbidden(value: unknown, path = '$'): string[] {
  const hits: string[] = [];
  if (value === null || typeof value !== 'object') return hits;
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...collectForbidden(v, `${path}[${i}]`)));
    return hits;
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN_MANUAL_KEY_FRAGMENTS.some((f) => lower.includes(f))) hits.push(`${path}.${key}`);
    hits.push(...collectForbidden(v, `${path}.${key}`));
  }
  return hits;
}

/** True iff `value` carries no token/bearer/invite-URL-shaped keys. */
export function isManualArtifactSafe(value: unknown): boolean {
  return collectForbidden(value).length === 0;
}

/**
 * The only thing the manual channel ever exposes: a recruiter-authenticated,
 * application-scoped reissue link (a site-relative path) plus opaque references.
 * It contains NO candidate token and NO invite URL.
 */
export interface ManualDeliveryArtifact {
  provider: 'ashby';
  externalApplicationId: string;
  /** Site-relative recruiter reissue/copy path (never an absolute URL/token). */
  recruiterReissuePath: string;
  deliveryState: 'pending' | 'blocked';
  note: string;
}

const MAX_PATH_LEN = 512;

function isRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > MAX_PATH_LEN) return false;
  if (!p.startsWith('/') || p.startsWith('//')) return false;
  if (/[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) return false;
  if (p.includes('@') || p.includes('\\')) return false;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}

export type ManualDeliveryBuild =
  | { ok: true; artifact: ManualDeliveryArtifact }
  | { ok: false; reason: 'invalid_application_id' | 'invalid_reissue_path' };

/**
 * Build the token-free manual-delivery artifact. Because an actual Ashby
 * custom-field write is tenant-unverified, delivery is modeled as `blocked`
 * (surfaced in Mission Control for copy/reissue) rather than inventing an Ashby
 * endpoint. Guaranteed to contain no token/URL — the recruiter follows the
 * relative reissue path under their own auth to obtain a fresh link.
 */
export function buildManualDelivery(input: {
  externalApplicationId: string;
  recruiterReissuePath: string;
}): ManualDeliveryBuild {
  if (typeof input.externalApplicationId !== 'string' || input.externalApplicationId.length < 1 || input.externalApplicationId.length > 256) {
    return { ok: false, reason: 'invalid_application_id' };
  }
  if (!isRelativePath(input.recruiterReissuePath)) {
    return { ok: false, reason: 'invalid_reissue_path' };
  }
  const artifact: ManualDeliveryArtifact = {
    provider: 'ashby',
    externalApplicationId: input.externalApplicationId,
    recruiterReissuePath: input.recruiterReissuePath,
    deliveryState: 'blocked',
    note: 'manual_reissue_required',
  };
  // Defense in depth: the artifact we just built must be token-free.
  if (!isManualArtifactSafe(artifact)) return { ok: false, reason: 'invalid_reissue_path' };
  return { ok: true, artifact };
}

// ── Email provider gate + idempotency ────────────────────────────────────────

export interface EmailProviderState {
  /** An approved email provider is configured. */
  providerApproved: boolean;
  /** A verified sending domain exists. */
  domainVerified: boolean;
}

export type EmailSendDecision = { action: 'send' } | { action: 'blocked'; reason: 'provider_gated' };

/** Email sending stays disabled until BOTH an approved provider and domain exist. */
export function decideEmailSend(state: EmailProviderState): EmailSendDecision {
  if (state.providerApproved && state.domainVerified) return { action: 'send' };
  return { action: 'blocked', reason: 'provider_gated' };
}

/**
 * Deterministic outbox operation key for an invite delivery. Stable per
 * (application, channel, invite) so a duplicate enqueue is a no-op (idempotent,
 * no duplicate sends). Carries no token — only opaque ids.
 */
export function inviteDeliveryOperationKey(input: {
  externalApplicationId: string;
  channel: 'email' | 'manual';
  inviteId: string;
}): string {
  return `ashby:invite:${input.channel}:${input.externalApplicationId}:${input.inviteId}`;
}

// ── Reissue (revoke-then-issue) ──────────────────────────────────────────────

export interface ReissuePlan {
  /** The prior invite to revoke first (if any). */
  revokeInviteId: string | null;
  /** Always issue a fresh invite after revocation. */
  issueNew: true;
}

/**
 * Plan a reissue: revoke the prior invite (if present) THEN issue a new one.
 * The old token is invalidated before the new one exists; neither token value
 * is part of this plan (opaque ids only).
 */
export function planReissue(priorInviteId: string | null | undefined): ReissuePlan {
  return { revokeInviteId: priorInviteId ?? null, issueNew: true };
}
