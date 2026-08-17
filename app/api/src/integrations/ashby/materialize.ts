/**
 * ashby/materialize.ts — the persistence sibling the merged code was missing.
 *
 * `runInviteDelivery` in orchestration.ts is a PURE decision function: it
 * returns {status, channel, delivery} and writes nothing. Nothing anywhere
 * created a candidate, a session, or an invite from an Ashby import. This
 * module is that step, split in two so resume bytes stay ephemeral:
 *
 *   materializeCandidate()  — called by the ingestion job the instant the
 *                             ephemeral parse reaches `ready`, with the
 *                             structured fields IN MEMORY. The original bytes
 *                             are never persisted; only the approved
 *                             structured fields and a null-file_path resume
 *                             row land, exactly as the recruiter upload path
 *                             does minus the stored object.
 *   materializeInvite()     — called by the operation worker under an
 *                             `invite_delivery` lease.
 *
 * IDENTITY (invariant): the workflow identity is the Ashby APPLICATION id.
 * A candidate is bound to a link via `ashby_application_links.candidate_id`
 * and is NEVER looked up or merged by email/phone. Two applications from the
 * same human are two workflows — that is deliberate, and reversing it would
 * silently cross-link candidates.
 *
 * IDEMPOTENCY under redelivery AND concurrency: every back-fill is a
 * compare-and-set (`... where id = $link and <col> is null`). When the CAS
 * matches zero rows another runner already won, so we re-read and adopt the
 * winner's row instead of creating a second. Combined with the per-operation
 * lease and the unique `operation_key`, this yields exactly one candidate,
 * one session, and one active invite per application.
 *
 * TOKEN SAFETY: the plaintext invite token exists only as a local in this
 * module. Only its SHA-256 digest is persisted. It is never logged, never
 * audited, never placed in a queue payload, never returned from the operation
 * worker, and never sent to Ashby — the manual channel carries only a
 * recruiter-authenticated, application-scoped reissue path.
 */

import {
  generateInviteToken,
  hashInviteToken,
  inviteExpiresAt,
  INVITE_TTL_HOURS,
} from '../../lib/invite-token.js';
import {
  decideInviteIssue,
  buildManualDelivery,
  decideEmailSend,
  isManualArtifactSafe,
  type ActiveInviteView,
  type EmailProviderState,
  type ManualDeliveryArtifact,
} from './invite-delivery.js';
import type { StructuredResume } from './resume-ingestion.js';

/** Sanitized outcome codes. Stable, greppable, never provider text. */
export type MaterializeReason =
  | 'blocked_terminal'
  | 'ingestion_not_ready'
  | 'no_mapping'
  | 'candidate_missing'
  | 'persist_failed'
  | 'unsafe_manual_artifact'
  | 'invalid_reissue_path';

/** The mapping fields materialization needs. Opaque ids only. */
export interface MaterializationMapping {
  id: string;
  /** Internal role the Ashby job maps to (candidates/sessions require it). */
  roleId: string;
  /** Recruiter/admin who owns rows created for this mapping. */
  ownerId: string;
  deliveryMode: 'email' | 'manual' | 'both';
}

/** Narrow persistence seam — production wires service-role Supabase. */
export interface MaterializationStore {
  /** Insert a resume row holding NO stored object (file_path stays null). */
  insertResume(input: {
    textExtracted: string | null;
    parsed: StructuredResume;
  }): Promise<{ id: string }>;

  /** Insert a candidate row. Never deduplicated by email/phone. */
  insertCandidate(input: {
    roleId: string;
    ownerId: string;
    resumeId: string | null;
    parsed: StructuredResume;
  }): Promise<{ id: string }>;

  /**
   * CAS back-fill of a link column. Returns the winning value: either the one
   * just written, or the value another concurrent runner already stored.
   */
  bindLinkColumn(input: {
    applicationLinkId: string;
    column: 'candidate_id' | 'session_id' | 'invite_id';
    value: string;
  }): Promise<{ bound: string; wonRace: boolean }>;

  /** Delete an orphaned row created by a step that later failed. */
  deleteOrphan(table: 'resumes' | 'candidates' | 'call_sessions', id: string): Promise<void>;

  /** Create a `created`-state browser session for the candidate. */
  createSession(input: { candidateId: string; roleId: string; ownerId: string }): Promise<{ id: string }>;

  /** Current ACTIVE invite for the session, if any (never returns a token). */
  findActiveInvite(sessionId: string, nowIso: string): Promise<{ id: string } | null>;

  /** Persist an invite by DIGEST only. The plaintext never reaches this seam. */
  insertInvite(input: {
    tokenDigest: string;
    candidateId: string;
    sessionId: string;
    createdBy: string;
    expiresAt: string;
  }): Promise<{ id: string }>;
}

// ── 1. Candidate materialization (called on ingestion `ready`) ───────────────

export type MaterializeCandidateResult =
  | { status: 'created' | 'reused'; candidateId: string }
  | { status: 'skipped'; reason: MaterializeReason };

export interface MaterializeCandidateDeps {
  store: MaterializationStore;
  mapping: MaterializationMapping;
  /** Terminal check re-read at the moment of the write. */
  isTerminal: boolean;
  /** Already-bound candidate for this link, if any. */
  existingCandidateId: string | null;
  /** Bounded extracted text for the resume row, or null to store none. */
  textExtracted?: string | null;
}

/**
 * Persist the structured resume + candidate for one application link and bind
 * it to the link under a CAS. Re-entrant: a second call (redelivery, retry,
 * or a concurrent runner) reuses the bound candidate and creates nothing.
 */
export async function materializeCandidate(
  applicationLinkId: string,
  structured: StructuredResume,
  deps: MaterializeCandidateDeps,
): Promise<MaterializeCandidateResult> {
  if (deps.isTerminal) return { status: 'skipped', reason: 'blocked_terminal' };
  if (deps.existingCandidateId) {
    return { status: 'reused', candidateId: deps.existingCandidateId };
  }

  let resumeId: string | null = null;
  let candidateId: string | null = null;
  try {
    const resume = await deps.store.insertResume({
      // Bounded text only; the original bytes were wiped by the ingestion.
      textExtracted: deps.textExtracted ?? null,
      parsed: structured,
    });
    resumeId = resume.id;

    const candidate = await deps.store.insertCandidate({
      roleId: deps.mapping.roleId,
      ownerId: deps.mapping.ownerId,
      resumeId,
      parsed: structured,
    });
    candidateId = candidate.id;

    const bound = await deps.store.bindLinkColumn({
      applicationLinkId,
      column: 'candidate_id',
      value: candidateId,
    });

    if (!bound.wonRace) {
      // A concurrent runner bound a candidate first. Adopt theirs and remove
      // ours so the application never ends up with two candidate identities.
      await deps.store.deleteOrphan('candidates', candidateId).catch(() => {});
      await deps.store.deleteOrphan('resumes', resumeId).catch(() => {});
      return { status: 'reused', candidateId: bound.bound };
    }
    return { status: 'created', candidateId };
  } catch {
    // Orphan cleanup mirrors routes/resumes.ts: newest first.
    if (candidateId) await deps.store.deleteOrphan('candidates', candidateId).catch(() => {});
    if (resumeId) await deps.store.deleteOrphan('resumes', resumeId).catch(() => {});
    return { status: 'skipped', reason: 'persist_failed' };
  }
}

// ── 2. Invite materialization (called under an invite_delivery lease) ────────

export interface MaterializeInviteResult {
  status: 'issued' | 'reused' | 'blocked';
  channel: 'email' | 'manual';
  /** Sanitized delivery outcome. `blocked_provider` for the gated email path. */
  delivery: 'manual_reissue' | 'blocked_provider' | 'blocked_terminal' | 'not_ready';
  /** Opaque invite row id — NEVER the token. */
  inviteId?: string;
  sessionId?: string;
  candidateId?: string;
  /** Token-free manual artifact (absent for the email channel). */
  artifact?: ManualDeliveryArtifact;
  reason?: MaterializeReason;
}

export interface MaterializeInviteDeps {
  store: MaterializationStore;
  mapping: MaterializationMapping;
  channel: 'email' | 'manual';
  /** Live link state re-read under the lease. */
  link: {
    id: string;
    externalApplicationId: string;
    candidateId: string | null;
    sessionId: string | null;
    inviteId: string | null;
    terminalState: string | null;
  };
  /** Durable ingestion state; must be `ready` (or the link carries no resume). */
  ingestionState: string | null;
  /** True when the application had no resume handle at all — ingestion is moot. */
  noResume: boolean;
  /** Email provider gate. Stays closed until an approved provider + domain. */
  email: EmailProviderState;
  /** Site-relative recruiter reissue path for the manual channel. */
  recruiterReissuePath: string;
  /** Injectable clock (ms) for deterministic TTL assertions. */
  nowMs?: () => number;
}

/**
 * Issue (or reuse) exactly one active 24-hour invite for an application and
 * shape its delivery. Performs NO send: the email channel is provider-gated
 * and returns `blocked_provider`, and the manual channel returns a token-free
 * recruiter-reissue artifact.
 */
export async function materializeInvite(
  deps: MaterializeInviteDeps,
): Promise<MaterializeInviteResult> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const channel = deps.channel;

  // Terminal is checked FIRST and again here under the lease: a withdrawal or
  // a human stage move that landed after the operation was enqueued must block
  // delivery, not race it.
  if (deps.link.terminalState) {
    return { status: 'blocked', channel, delivery: 'blocked_terminal', reason: 'blocked_terminal' };
  }

  // Ingestion gate: an invite is only issued once the ephemeral resume parse
  // reached `ready`, or when the application carried no resume at all. A
  // failed_review or in-flight ingestion must not produce an invite.
  if (!deps.noResume && deps.ingestionState !== 'ready') {
    return { status: 'blocked', channel, delivery: 'not_ready', reason: 'ingestion_not_ready' };
  }

  const candidateId = deps.link.candidateId;
  if (!candidateId) {
    return { status: 'blocked', channel, delivery: 'not_ready', reason: 'candidate_missing' };
  }

  // ── Session: reuse the bound one, else create and CAS-bind ────────────────
  let sessionId = deps.link.sessionId;
  if (!sessionId) {
    let created: { id: string };
    try {
      created = await deps.store.createSession({
        candidateId,
        roleId: deps.mapping.roleId,
        ownerId: deps.mapping.ownerId,
      });
    } catch {
      return { status: 'blocked', channel, delivery: 'not_ready', reason: 'persist_failed' };
    }
    const bound = await deps.store.bindLinkColumn({
      applicationLinkId: deps.link.id,
      column: 'session_id',
      value: created.id,
    });
    if (!bound.wonRace) {
      await deps.store.deleteOrphan('call_sessions', created.id).catch(() => {});
      sessionId = bound.bound;
    } else {
      sessionId = created.id;
    }
  }

  // ── Invite: exactly one ACTIVE invite per application ─────────────────────
  const nowIso = new Date(nowMs()).toISOString();
  const existingActive = await deps.store.findActiveInvite(sessionId, nowIso);
  const view: ActiveInviteView | null = existingActive ? { status: 'active' } : null;
  const decision = decideInviteIssue(view, false);

  let inviteId: string;
  let issued: boolean;
  if (decision.action === 'reuse_active' && existingActive) {
    inviteId = existingActive.id;
    issued = false;
  } else {
    // The plaintext lives only in this scope. Only the digest is persisted, and
    // the plaintext is deliberately NOT returned from this function.
    const token = generateInviteToken();
    const digest = hashInviteToken(token);
    const expiresAt = inviteExpiresAt(nowMs()).toISOString();
    let row: { id: string };
    try {
      row = await deps.store.insertInvite({
        tokenDigest: digest,
        candidateId,
        sessionId,
        createdBy: deps.mapping.ownerId,
        expiresAt,
      });
    } catch {
      return { status: 'blocked', channel, delivery: 'not_ready', reason: 'persist_failed' };
    }
    inviteId = row.id;
    issued = true;
    await deps.store
      .bindLinkColumn({ applicationLinkId: deps.link.id, column: 'invite_id', value: inviteId })
      .catch(() => ({ bound: inviteId, wonRace: false }));
  }

  const status: 'issued' | 'reused' = issued ? 'issued' : 'reused';

  // ── Delivery shaping (no send happens anywhere in this module) ────────────
  if (channel === 'email') {
    const send = decideEmailSend(deps.email);
    // The provider gate is closed until an approved provider AND a verified
    // domain exist. `send` is unreachable today; there is no transport wired
    // here, so even a mis-set gate cannot deliver mail from this code path.
    return {
      status: send.action === 'send' ? status : 'blocked',
      channel,
      delivery: 'blocked_provider',
      inviteId,
      sessionId,
      candidateId,
    };
  }

  const manual = buildManualDelivery({
    externalApplicationId: deps.link.externalApplicationId,
    recruiterReissuePath: deps.recruiterReissuePath,
  });
  if (!manual.ok) {
    return {
      status: 'blocked', channel, delivery: 'blocked_provider',
      inviteId, sessionId, candidateId, reason: 'invalid_reissue_path',
    };
  }
  // Defense in depth: the artifact is token-free by construction, and this
  // asserts it again before it can reach a response, a log, or Ashby.
  if (!isManualArtifactSafe(manual.artifact)) {
    return {
      status: 'blocked', channel, delivery: 'blocked_provider',
      inviteId, sessionId, candidateId, reason: 'unsafe_manual_artifact',
    };
  }

  return {
    status, channel, delivery: 'manual_reissue',
    inviteId, sessionId, candidateId, artifact: manual.artifact,
  };
}

/** Re-exported so callers assert against one TTL constant, not a literal. */
export { INVITE_TTL_HOURS };
