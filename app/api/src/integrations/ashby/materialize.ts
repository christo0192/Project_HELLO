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
  | 'invalid_reissue_path'
  /** The store predates the shell seam — fail-closed, never a silent skip. */
  | 'shell_unsupported';

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
   * Insert a PII-MINIMAL candidate shell: ownership and provenance only.
   *
   * `name`, `email`, `phone_raw`, `parsed` and `resume_id` stay NULL. A
   * candidate that exists because an application was imported holds no
   * candidate contact data until a resume has actually been parsed, so a
   * `failed_review` application is visible without ever having disclosed
   * anything about the person. No external/provider identifier is written as
   * identity: the link owns that relationship.
   *
   * Optional ONLY so a store written before this seam existed still type-checks;
   * {@link materializeCandidateShell} FAILS CLOSED when it is absent rather
   * than pretending the shell was not needed.
   */
  insertCandidateShell?(input: { roleId: string; ownerId: string }): Promise<{ id: string }>;

  /**
   * Populate an existing shell from a successful parse, under a CAS on
   * `resume_id is null`.
   *
   * Returns false when another runner already populated it — the caller then
   * removes the resume row it created and reports `reused`, so a second run of
   * the ready path can never leave a duplicate resume behind.
   *
   * Implementations MUST NOT write `role_id`, `owner_id`, `status`, or
   * `ats_source`: the shell's ownership and funnel position were decided at
   * import and a parse is not an event that may change either.
   */
  updateCandidateFromParse?(input: {
    candidateId: string;
    resumeId: string;
    parsed: StructuredResume;
  }): Promise<{ updated: boolean }>;

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
  /** `updated` = an existing PII-minimal shell was populated by this parse. */
  | { status: 'created' | 'reused' | 'updated'; candidateId: string }
  | { status: 'skipped'; reason: MaterializeReason };

/** Outcome of binding the PII-minimal shell at import time. */
export type MaterializeShellResult =
  | { status: 'created' | 'reused'; candidateId: string }
  /** Nothing to do, and nothing wrong (terminal application). */
  | { status: 'skipped'; reason: MaterializeReason }
  /**
   * The shell could NOT be bound. Distinct from `skipped` on purpose: the
   * caller must treat this as retryable work that has not happened, never as
   * an import that is finished.
   */
  | { status: 'failed'; reason: MaterializeReason };

export interface MaterializeShellDeps {
  store: MaterializationStore;
  mapping: MaterializationMapping;
  /** Terminal check re-read at the moment of the write. */
  isTerminal: boolean;
  /** Already-bound candidate for this link, if any. */
  existingCandidateId: string | null;
}

/**
 * Bind exactly one PII-minimal `queued` candidate shell to an application link.
 *
 * WHY AT IMPORT, AND WHY IT MAY NOT BE SWALLOWED
 * ----------------------------------------------
 * Before this, the ONLY thing that created an Ashby candidate was the ingestion
 * job reaching `ready`. An application whose resume failed to parse therefore
 * produced a link, an ingestion row and a queued invite operation — and no row
 * anywhere a recruiter looks. The application was invisible, and invisible is
 * indistinguishable from "never arrived".
 *
 * Binding it here fixes that only if a failure to bind is LOUD. A swallowed
 * failure recreates the invisible-candidate defect precisely, in the one code
 * path added to prevent it, so this reports `failed` and the import job it runs
 * under must not complete on it. Every step of the import is idempotent, so the
 * retry is safe.
 *
 * IDENTITY is unchanged: the shell is bound through the SAME
 * `bindLinkColumn('candidate_id', …)` CAS `materializeCandidate` uses, and is
 * never looked up or merged by email or phone — the shell has no email to
 * merge on, which is a property of the design rather than a coincidence.
 */
export async function materializeCandidateShell(
  applicationLinkId: string,
  deps: MaterializeShellDeps,
): Promise<MaterializeShellResult> {
  // A withdrawn/deleted application must not gain a candidate. This is not a
  // failure: there is genuinely no work.
  if (deps.isTerminal) return { status: 'skipped', reason: 'blocked_terminal' };
  if (deps.existingCandidateId) {
    return { status: 'reused', candidateId: deps.existingCandidateId };
  }
  const insertShell = deps.store.insertCandidateShell;
  if (!insertShell) {
    // Fail CLOSED. A store without the seam cannot bind a shell, and reporting
    // that as "skipped" would be the swallow this function exists to refuse.
    return { status: 'failed', reason: 'shell_unsupported' };
  }

  let candidateId: string | null = null;
  try {
    const created = await insertShell.call(deps.store, {
      roleId: deps.mapping.roleId,
      ownerId: deps.mapping.ownerId,
    });
    candidateId = created.id;
    const bound = await deps.store.bindLinkColumn({
      applicationLinkId,
      column: 'candidate_id',
      value: candidateId,
    });
    if (!bound.wonRace) {
      // A concurrent import bound first. Adopt the winner and delete our own
      // row so a lost race can never leave an orphan candidate behind.
      await deps.store.deleteOrphan('candidates', candidateId).catch(() => {});
      return { status: 'reused', candidateId: bound.bound };
    }
    return { status: 'created', candidateId };
  } catch {
    if (candidateId) await deps.store.deleteOrphan('candidates', candidateId).catch(() => {});
    return { status: 'failed', reason: 'persist_failed' };
  }
}

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
 * What populating an already-bound candidate needs.
 *
 * Deliberately NARROWER than {@link MaterializeCandidateDeps}: populating a
 * shell needs no mapping, because ownership and role were decided at import
 * and this step may not revise them. That is not a technicality — it is what
 * lets a shell still be populated when its mapping was paused between the
 * import and the parse, instead of being stranded blank.
 */
export interface PopulateCandidateDeps {
  store: MaterializationStore;
  /** Bounded extracted text for the resume row, or null to store none. */
  textExtracted?: string | null;
}

/**
 * Populate an already-bound candidate (normally the import-time shell) from a
 * successful parse.
 *
 * IDEMPOTENT BY CAS, not by hope. The update only applies while the candidate
 * still has no resume, so running the ready path twice writes once: the second
 * run's resume row is deleted and the call reports `reused`. Without that a
 * repeat would accumulate a resume row per run.
 *
 * BACKWARD COMPATIBLE. A store with no `updateCandidateFromParse` — or a link
 * bound before the shell existed — takes `reused`, i.e. exactly the behaviour
 * that shipped before this change. Nothing regresses to "no candidate".
 */
export async function populateExistingCandidate(
  candidateId: string,
  structured: StructuredResume,
  deps: PopulateCandidateDeps,
): Promise<MaterializeCandidateResult> {
  const update = deps.store.updateCandidateFromParse;
  if (!update) return { status: 'reused', candidateId };

  let resumeId: string | null = null;
  try {
    const resume = await deps.store.insertResume({
      textExtracted: deps.textExtracted ?? null,
      parsed: structured,
    });
    resumeId = resume.id;
    const res = await update.call(deps.store, { candidateId, resumeId, parsed: structured });
    if (!res.updated) {
      // Already populated (a repeat run, or a concurrent winner). Drop the
      // resume row we just created; the candidate is authoritative.
      await deps.store.deleteOrphan('resumes', resumeId).catch(() => {});
      return { status: 'reused', candidateId };
    }
    return { status: 'updated', candidateId };
  } catch {
    if (resumeId) await deps.store.deleteOrphan('resumes', resumeId).catch(() => {});
    // The candidate itself is NOT deleted: it is the durable shell created at
    // import and it must survive a failed population.
    return { status: 'skipped', reason: 'persist_failed' };
  }
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
    // The link already carries a candidate — since the import step, that is
    // normally the PII-MINIMAL SHELL, and this is the moment its fields become
    // knowable. Populate it in place rather than creating a second identity.
    return populateExistingCandidate(deps.existingCandidateId, structured, deps);
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
      // A concurrent runner bound a candidate first — in practice, the import
      // binding its PII-MINIMAL SHELL while this ingestion was downloading,
      // scanning and parsing. Adopt theirs and remove our own candidate so the
      // application never ends up with two identities.
      await deps.store.deleteOrphan('candidates', candidateId).catch(() => {});

      // ...and then POPULATE the winner with what we just parsed.
      //
      // Simply returning `reused` here would be the quiet failure: the parse
      // succeeded, the fields exist in memory, and the surviving candidate
      // would nevertheless stay empty forever — a candidate with no name that
      // no later run can fill, because `ready` is terminal in the 0029 machine
      // and this path never runs again. The same CAS on `resume_id is null`
      // keeps it idempotent.
      const winner = bound.bound;
      const update = deps.store.updateCandidateFromParse;
      if (update) {
        let res: { updated: boolean };
        try {
          res = await update.call(deps.store, { candidateId: winner, resumeId, parsed: structured });
        } catch {
          // The population THREW. Distinguished from "already populated"
          // deliberately: reporting `reused` here would tell the caller the
          // parse was persisted when it was not, and the caller would then
          // write the terminal `ready` over a blank winner — the exact defect
          // the pre-`ready` ordering exists to prevent. Report the failure so
          // the row rests recoverably instead.
          await deps.store.deleteOrphan('resumes', resumeId).catch(() => {});
          return { status: 'skipped', reason: 'persist_failed' };
        }
        if (res.updated) return { status: 'updated', candidateId: winner };
      }
      // Either the winner was ALREADY populated (a repeat run — the CAS
      // matched zero rows), or the store predates the populate seam. Both mean
      // the winner is authoritative and our resume row is surplus.
      await deps.store.deleteOrphan('resumes', resumeId).catch(() => {});
      return { status: 'reused', candidateId: winner };
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
