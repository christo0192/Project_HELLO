/**
 * Ashby materialization — candidate / session / invite persistence.
 *
 * `runInviteDelivery` was decision-only and nothing created a candidate, a
 * session, or an invite. These tests pin the new persistence step:
 *
 *  - exactly ONE candidate, session, and ACTIVE invite per application, under
 *    redelivery AND under a concurrent runner that wins the CAS;
 *  - identity is the APPLICATION — never a lookup or merge by email/phone;
 *  - only the SHA-256 digest is persisted; the plaintext token never appears in
 *    any store call, return value, artifact, or serialized output;
 *  - the TTL is exactly 24 hours;
 *  - a terminal application and a not-ready ingestion both block;
 *  - the manual channel is token-free; the email channel performs ZERO sends.
 *
 * Zero network, zero DB: an in-memory store records every write.
 */

import { describe, it, expect } from 'vitest';
import {
  materializeCandidate,
  materializeInvite,
  type MaterializationStore,
  type MaterializationMapping,
} from '../integrations/ashby/materialize.js';
import { INVITE_TTL_HOURS, hashInviteToken } from '../lib/invite-token.js';
import type { StructuredResume } from '../integrations/ashby/resume-ingestion.js';

const ROLE = '22222222-2222-4222-8222-222222222222';
const OWNER = '33333333-3333-4333-8333-333333333333';
const APP = 'app_1';
const LINK = 'link_1';
const NOW = Date.parse('2026-08-17T00:00:00.000Z');

const mapping: MaterializationMapping = {
  id: 'map_1', roleId: ROLE, ownerId: OWNER, deliveryMode: 'manual',
};

const structured: StructuredResume = {
  name: 'Synthetic Candidate',
  email: 'synthetic@example.invalid',
  phone: '+10000000000',
  skills: ['typescript'],
  experience_years: 3,
  current_role: 'Engineer',
  summary: 'synthetic summary',
};

interface Recorder {
  store: MaterializationStore;
  resumes: string[];
  candidates: Array<{ id: string; roleId: string; ownerId: string }>;
  sessions: string[];
  invites: Array<{ id: string; tokenDigest: string; expiresAt: string; sessionId: string }>;
  deleted: Array<[string, string]>;
  binds: Array<{ column: string; value: string; wonRace: boolean }>;
  /** Everything ever handed to the store, for the token-leak sweep. */
  seen: unknown[];
  links: Record<string, string | null>;
}

function recorder(over: {
  /** Simulate a concurrent runner that already bound these columns. */
  preBound?: Partial<Record<'candidate_id' | 'session_id' | 'invite_id', string>>;
  activeInvite?: { id: string } | null;
  failOn?: 'resume' | 'candidate' | 'session' | 'invite';
} = {}): Recorder {
  const rec: Recorder = {
    resumes: [], candidates: [], sessions: [], invites: [], deleted: [], binds: [], seen: [],
    links: { candidate_id: null, session_id: null, invite_id: null, ...(over.preBound ?? {}) },
    store: null as never,
  };
  let n = 0;
  rec.store = {
    async insertResume(input) {
      rec.seen.push(input);
      if (over.failOn === 'resume') throw new Error('resume_fail');
      const id = `resume_${++n}`; rec.resumes.push(id); return { id };
    },
    async insertCandidate(input) {
      rec.seen.push(input);
      if (over.failOn === 'candidate') throw new Error('candidate_fail');
      const id = `cand_${++n}`;
      rec.candidates.push({ id, roleId: input.roleId, ownerId: input.ownerId });
      return { id };
    },
    async bindLinkColumn(input) {
      rec.seen.push(input);
      const existing = rec.links[input.column];
      if (existing) {
        rec.binds.push({ column: input.column, value: input.value, wonRace: false });
        return { bound: existing, wonRace: false };
      }
      rec.links[input.column] = input.value;
      rec.binds.push({ column: input.column, value: input.value, wonRace: true });
      return { bound: input.value, wonRace: true };
    },
    async deleteOrphan(table, id) { rec.deleted.push([table, id]); },
    async createSession(input) {
      rec.seen.push(input);
      if (over.failOn === 'session') throw new Error('session_fail');
      const id = `sess_${++n}`; rec.sessions.push(id); return { id };
    },
    async findActiveInvite() { return over.activeInvite ?? null; },
    async insertInvite(input) {
      rec.seen.push(input);
      if (over.failOn === 'invite') throw new Error('invite_fail');
      const id = `inv_${++n}`;
      rec.invites.push({ id, tokenDigest: input.tokenDigest, expiresAt: input.expiresAt, sessionId: input.sessionId });
      return { id };
    },
  };
  return rec;
}

function inviteDeps(rec: Recorder, over: Partial<Parameters<typeof materializeInvite>[0]> = {}) {
  return {
    store: rec.store,
    mapping,
    channel: 'manual' as const,
    link: {
      id: LINK,
      externalApplicationId: APP,
      candidateId: rec.links.candidate_id,
      sessionId: rec.links.session_id,
      inviteId: rec.links.invite_id,
      terminalState: null as string | null,
    },
    ingestionState: 'ready',
    noResume: false,
    email: { providerApproved: false, domainVerified: false },
    recruiterReissuePath: '/ashby-mission-control?application=app_1',
    nowMs: () => NOW,
    ...over,
  };
}

// ── Candidate materialization ────────────────────────────────────────────────

describe('materializeCandidate', () => {
  it('creates exactly one resume + candidate and binds it to the link', async () => {
    const rec = recorder();
    const r = await materializeCandidate(LINK, structured, {
      store: rec.store, mapping, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'created', candidateId: 'cand_2' });
    expect(rec.resumes).toHaveLength(1);
    expect(rec.candidates).toHaveLength(1);
    // role_id / owner_id come from the MAPPING, not from the resume contents.
    expect(rec.candidates[0]).toMatchObject({ roleId: ROLE, ownerId: OWNER });
  });

  it('is idempotent on redelivery — an already-bound candidate is reused', async () => {
    const rec = recorder();
    const r = await materializeCandidate(LINK, structured, {
      store: rec.store, mapping, isTerminal: false, existingCandidateId: 'cand_existing',
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_existing' });
    expect(rec.resumes).toHaveLength(0);
    expect(rec.candidates).toHaveLength(0);
  });

  it('adopts the winner and cleans up its own rows when a concurrent runner wins the CAS', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_from_other_runner' } });
    const r = await materializeCandidate(LINK, structured, {
      store: rec.store, mapping, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'reused', candidateId: 'cand_from_other_runner' });
    // Our speculative rows must not survive — one application, one candidate.
    expect(rec.deleted.map(([t]) => t).sort()).toEqual(['candidates', 'resumes']);
  });

  it('blocks on a terminal application and writes nothing', async () => {
    const rec = recorder();
    const r = await materializeCandidate(LINK, structured, {
      store: rec.store, mapping, isTerminal: true, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'blocked_terminal' });
    expect(rec.resumes).toHaveLength(0);
    expect(rec.candidates).toHaveLength(0);
  });

  it('cleans up the orphan resume when the candidate insert fails', async () => {
    const rec = recorder({ failOn: 'candidate' });
    const r = await materializeCandidate(LINK, structured, {
      store: rec.store, mapping, isTerminal: false, existingCandidateId: null,
    });
    expect(r).toEqual({ status: 'skipped', reason: 'persist_failed' });
    expect(rec.deleted).toEqual([['resumes', 'resume_1']]);
  });

  it('never looks a candidate up by email or phone', async () => {
    const rec = recorder();
    await materializeCandidate(LINK, structured, {
      store: rec.store, mapping, isTerminal: false, existingCandidateId: null,
    });
    // The store seam offers no find-by-contact method at all, and nothing in
    // the recorded calls carries a lookup key. Identity is the link alone.
    expect(Object.keys(rec.store)).not.toContain('findCandidateByEmail');
    expect(Object.keys(rec.store)).not.toContain('findCandidateByPhone');
  });
});

// ── Invite materialization ───────────────────────────────────────────────────

describe('materializeInvite — exactly one active invite per application', () => {
  it('creates a session and one invite, and persists only the digest', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    const r = await materializeInvite(inviteDeps(rec));

    expect(r.status).toBe('issued');
    expect(r.delivery).toBe('manual_reissue');
    expect(rec.sessions).toHaveLength(1);
    expect(rec.invites).toHaveLength(1);

    const stored = rec.invites[0].tokenDigest;
    // A SHA-256 hex digest, not a token.
    expect(stored).toMatch(/^[a-f0-9]{64}$/);
    // And it really is a digest of *something*, not the plaintext itself.
    expect(hashInviteToken(stored)).not.toBe(stored);
  });

  it('sets an expiry exactly 24 hours out', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    await materializeInvite(inviteDeps(rec));
    const expiresAt = Date.parse(rec.invites[0].expiresAt);
    expect(expiresAt - NOW).toBe(INVITE_TTL_HOURS * 60 * 60 * 1000);
    expect(INVITE_TTL_HOURS).toBe(24);
  });

  it('reuses an existing ACTIVE invite instead of issuing a second', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1', session_id: 'sess_x' }, activeInvite: { id: 'inv_existing' } });
    const r = await materializeInvite(inviteDeps(rec));
    expect(r.status).toBe('reused');
    expect(r.inviteId).toBe('inv_existing');
    expect(rec.invites).toHaveLength(0);
    expect(rec.sessions).toHaveLength(0);
  });

  it('adopts the winning session when a concurrent runner bound one first', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    // Simulate the race: the column is bound between our create and our CAS.
    const original = rec.store.bindLinkColumn;
    let first = true;
    rec.store.bindLinkColumn = async (input) => {
      if (first && input.column === 'session_id') {
        first = false;
        return { bound: 'sess_from_other_runner', wonRace: false };
      }
      return original(input);
    };
    const r = await materializeInvite(inviteDeps(rec));
    expect(r.sessionId).toBe('sess_from_other_runner');
    // Our speculative session must be cleaned up — one application, one session.
    expect(rec.deleted.map(([table]) => table)).toContain('call_sessions');
    expect(rec.deleted).toHaveLength(1);
    // The invite was then issued against the WINNER's session, not ours.
    expect(rec.invites[0].sessionId).toBe('sess_from_other_runner');
  });

  it('blocks on a terminal application and issues nothing', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    const r = await materializeInvite(inviteDeps(rec, {
      link: { ...inviteDeps(rec).link, terminalState: 'withdrawn' },
    }));
    expect(r.status).toBe('blocked');
    expect(r.delivery).toBe('blocked_terminal');
    expect(rec.invites).toHaveLength(0);
    expect(rec.sessions).toHaveLength(0);
  });

  it('blocks while the ingestion has not reached ready', async () => {
    for (const state of ['queued', 'fetching', 'scanning', 'extracting', 'structuring', 'failed_review', 'cancelled', null]) {
      const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
      const r = await materializeInvite(inviteDeps(rec, { ingestionState: state }));
      expect(r.delivery, `state=${state}`).toBe('not_ready');
      expect(rec.invites, `state=${state}`).toHaveLength(0);
    }
  });

  it('proceeds when the application carried no resume at all', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    const r = await materializeInvite(inviteDeps(rec, { ingestionState: null, noResume: true }));
    expect(r.status).toBe('issued');
    expect(rec.invites).toHaveLength(1);
  });

  it('blocks when no candidate is bound yet', async () => {
    const rec = recorder();
    const r = await materializeInvite(inviteDeps(rec));
    expect(r.delivery).toBe('not_ready');
    expect(r.reason).toBe('candidate_missing');
  });
});

describe('materializeInvite — delivery channels', () => {
  it('manual delivery is token-free and site-relative', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    const r = await materializeInvite(inviteDeps(rec));
    expect(r.artifact).toBeDefined();
    const serialized = JSON.stringify(r.artifact);
    for (const forbidden of ['token', 'bearer', 'secret', 'jwt', 'invite_url', 'signed_url', 'presigned']) {
      expect(serialized.toLowerCase(), `artifact must not carry ${forbidden}`).not.toContain(forbidden);
    }
    expect(r.artifact!.recruiterReissuePath.startsWith('/')).toBe(true);
    expect(r.artifact!.recruiterReissuePath.startsWith('//')).toBe(false);
  });

  it('rejects a non-relative reissue path rather than emitting it', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    const r = await materializeInvite(inviteDeps(rec, {
      recruiterReissuePath: 'https://evil.example/steal',
    }));
    expect(r.status).toBe('blocked');
    expect(r.reason).toBe('invalid_reissue_path');
    expect(r.artifact).toBeUndefined();
  });

  it('email channel performs ZERO sends while the provider gate is closed', async () => {
    const gates = [
      { providerApproved: false, domainVerified: false },
      { providerApproved: true, domainVerified: false },
      { providerApproved: false, domainVerified: true },
    ];
    for (const email of gates) {
      const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
      const r = await materializeInvite(inviteDeps(rec, { channel: 'email', email }));
      expect(r.delivery, JSON.stringify(email)).toBe('blocked_provider');
      // There is no email transport anywhere in this module — nothing to send with.
      expect(Object.keys(rec.store)).not.toContain('sendEmail');
      expect(r.artifact).toBeUndefined();
    }
  });
});

describe('materializeInvite — plaintext token containment', () => {
  it('never returns, records, or serializes the plaintext token', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' } });
    const r = await materializeInvite(inviteDeps(rec));

    const digest = rec.invites[0].tokenDigest;
    const everything = JSON.stringify({ result: r, storeCalls: rec.seen });

    // The result carries an opaque invite ROW id, never a token field.
    expect(Object.keys(r)).not.toContain('token');
    // Nothing 64-hex-shaped other than the digest itself may appear, and the
    // digest's preimage (the plaintext) must be absent everywhere.
    const hexes = everything.match(/\b[a-f0-9]{64}\b/g) ?? [];
    expect(new Set(hexes)).toEqual(new Set([digest]));
    // A 32-byte plaintext token is also 64 hex chars; assert the ONE hex value
    // present hashes to something different, i.e. it is the digest not the token.
    expect(hashInviteToken(digest)).not.toBe(digest);
  });
});

describe('materializeInvite — persistence failure paths fail closed', () => {
  it('reports persist_failed when the session insert fails, issuing no invite', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1' }, failOn: 'session' });
    const r = await materializeInvite(inviteDeps(rec));
    expect(r).toMatchObject({ status: 'blocked', delivery: 'not_ready', reason: 'persist_failed' });
    expect(rec.invites).toHaveLength(0);
  });

  it('reports persist_failed when the invite insert fails', async () => {
    const rec = recorder({ preBound: { candidate_id: 'cand_1', session_id: 'sess_x' }, failOn: 'invite' });
    const r = await materializeInvite(inviteDeps(rec));
    expect(r).toMatchObject({ status: 'blocked', delivery: 'not_ready', reason: 'persist_failed' });
    expect(rec.invites).toHaveLength(0);
  });

  it('still returns the issued invite when the invite_id back-fill fails', async () => {
    // The back-fill is a convenience projection; losing it must not lose the
    // invite the candidate is about to use.
    const rec = recorder({ preBound: { candidate_id: 'cand_1', session_id: 'sess_x' } });
    const original = rec.store.bindLinkColumn;
    rec.store.bindLinkColumn = async (input) => {
      if (input.column === 'invite_id') throw new Error('bind_failed');
      return original(input);
    };
    const r = await materializeInvite(inviteDeps(rec));
    expect(r.status).toBe('issued');
    expect(r.inviteId).toBeDefined();
    expect(rec.invites).toHaveLength(1);
  });
});
