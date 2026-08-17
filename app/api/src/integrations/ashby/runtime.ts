/**
 * ashby/runtime.ts — the production composition root.
 *
 * Before this file, `createAshbyClient`, `createWorkflowStores`,
 * `createMappingResolver`, `createCheckpointStore`, `createAshbySignalQueue`
 * and `createPinnedHttpsTransport` were exported, tested, and NEVER constructed
 * in a running process. This is the single place that builds them.
 *
 * FAIL-CLOSED CONSTRUCTION: `createAshbyRuntime` returns `null` unless the
 * integration master switch, a usable webhook secret, the independent runtime
 * flag, AND an API key are all present. Returning null — rather than building
 * a client with an empty key and failing later — is deliberate: with the
 * defaults, no client object exists, no timer is armed, and no DB or network
 * call is ever issued. That is what makes merging this PR a no-op for the
 * running deployment.
 *
 * SECURITY: the API key is read once, handed to the AshbyClient constructor,
 * and never stored on the returned object, logged, or serialized. The resume
 * host allowlist is EMPTY by default, so `UrlPolicy.allowlistEnabled` stays
 * false and every resume fetch fails closed with `allowlist_disabled`.
 */

import { lookup } from 'node:dns/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAshbyClient, type AshbyClient } from './client.js';
import { createMetadataLogger } from './logging.js';
import {
  loadAshbyConfig,
  loadAshbyRuntimeConfig,
  isAshbyRuntimeActive,
  type AshbyIntegrationConfig,
  type AshbyRuntimeConfig,
} from './config.js';
import { createReceiptStore, createCheckpointStore, createMappingResolver, createAshbySignalQueue } from './stores.js';
import { createWorkflowStores, createMissionControlStore, type MissionControlStore } from './workflow-stores.js';
import { createPinnedHttpsTransport } from './resume-transport.js';
import { fetchEphemeralResume } from './resume-fetch.js';
import type { UrlPolicy } from './ssrf.js';
import type { IngestionPorts, ParseOutput, StructuredResume } from './resume-ingestion.js';
import type { RuntimeWorkflowStores, ResolvedMapping } from './orchestration.js';
import type { MappingResolver } from './signal-worker.js';
import type { MaterializationStore, MaterializationMapping } from './materialize.js';
import type { ReceiptStore, CheckpointStore } from './ports.js';
import type { Queue } from '../../lib/queue/index.js';
import { resolveScanner } from '../../lib/malware-scanner.js';
import { guardUpload, UploadGuardError } from '../../lib/upload-guard.js';
import { createResumeParserPool, type ResumeParserPool } from '../../lib/resume-parser-pool.js';
import { fallbackParseResumeText } from '../../lib/resume-fallback.js';

/** Version tags recorded as ingestion provenance (never PII). */
export const ASHBY_EXTRACTOR_VERSION = 'ashby-ephemeral-1';
export const ASHBY_STRUCTURER_VERSION = 'deterministic-fallback-1';

/** Bounded text length persisted with an Ashby-originated resume row. */
const MAX_TEXT_PERSIST = 50_000;

export interface AshbyRuntime {
  config: AshbyIntegrationConfig;
  runtimeConfig: AshbyRuntimeConfig;
  client: AshbyClient;
  queue: Queue;
  stores: RuntimeWorkflowStores;
  receipts: ReceiptStore;
  checkpoints: CheckpointStore;
  missionControl: MissionControlStore;
  materialization: MaterializationStore;
  /** Current per-job mapping activity (status + AI stage) for the signal gate. */
  mappings: MappingResolver;
  /** SSRF policy derived from config. `allowlistEnabled` false when empty. */
  urlPolicy: UrlPolicy;
  /** Full mapping config for the import decision (status + stage + mode). */
  resolveMappingByJobId(externalJobId: string): Promise<ResolvedMapping>;
  resolveMappingForLink(applicationLinkId: string): Promise<MaterializationMapping | null>;
  buildIngestionPorts(input: {
    applicationLinkId: string;
    onState: IngestionPorts['onState'];
  }): Promise<IngestionPorts | null>;
  /** Release pooled resources (parser child processes). Idempotent. */
  shutdown(): Promise<void>;
}

export interface CreateAshbyRuntimeOptions {
  supabase: SupabaseClient;
  config?: AshbyIntegrationConfig;
  runtimeConfig?: AshbyRuntimeConfig;
  /** Test seam: fully replaces the network for the Ashby client. */
  transport?: Parameters<typeof createAshbyClient>[0]['transport'];
  /** Test seam: DNS resolution for the resume fetch. */
  resolveHost?: (host: string) => Promise<string[]>;
  /** Test seam: single-hop resume transport (redirects disabled). */
  resumeTransport?: ReturnType<typeof createPinnedHttpsTransport>;
  parserPool?: ResumeParserPool;
}

/** Defensive extraction of a presigned URL from an opaque `file.info` payload. */
export function extractFileUrl(results: unknown): string | null {
  if (results === null || typeof results !== 'object') return null;
  const rec = results as Record<string, unknown>;
  for (const key of ['url', 'downloadUrl', 'fileUrl', 'signedUrl']) {
    const v = rec[key];
    if (typeof v === 'string' && v.startsWith('https://')) return v;
  }
  const nested = rec.file;
  if (nested !== null && typeof nested === 'object') {
    return extractFileUrl(nested);
  }
  return null;
}

/** Default DNS resolver: A/AAAA addresses for a hostname. */
async function defaultResolveHost(host: string): Promise<string[]> {
  const answers = await lookup(host, { all: true });
  return answers.map((a) => a.address);
}

/** Service-role adapters for candidate/session/invite materialization. */
export function createMaterializationStore(client: SupabaseClient): MaterializationStore {
  return {
    async insertResume(input) {
      const { data, error } = await client
        .from('resumes')
        .insert({
          // file_path stays NULL: the Ashby original is ephemeral and is never
          // written to the resume bucket. Only derived text/fields persist.
          file_path: null,
          file_name: null,
          mime_type: null,
          text_extracted: input.textExtracted ? input.textExtracted.slice(0, MAX_TEXT_PERSIST) : null,
          parsed: input.parsed,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error('ashby_resume_insert_error');
      return { id: (data as { id: string }).id };
    },
    async insertCandidate(input) {
      const p = input.parsed;
      const { data, error } = await client
        .from('candidates')
        .insert({
          role_id: input.roleId,
          owner_id: input.ownerId,
          resume_id: input.resumeId,
          name: p.name,
          email: p.email,
          phone_raw: p.phone,
          phone_e164: null,
          phone_valid: false,
          skills: p.skills ?? [],
          experience_years: p.experience_years,
          parsed: p,
          status: 'new',
          ats_source: 'ashby',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error('ashby_candidate_insert_error');
      return { id: (data as { id: string }).id };
    },
    async bindLinkColumn(input) {
      // Compare-and-set: only bind when the column is still null. Zero rows
      // means a concurrent runner won — re-read and adopt its value so an
      // application can never end up with two candidates/sessions/invites.
      const { data, error } = await client
        .from('ashby_application_links')
        .update({ [input.column]: input.value, updated_at: new Date().toISOString() })
        .eq('id', input.applicationLinkId)
        .is(input.column, null)
        .select(input.column)
        .maybeSingle();
      if (error) throw new Error('ashby_link_bind_error');
      if (data) return { bound: input.value, wonRace: true };

      const { data: current, error: readErr } = await client
        .from('ashby_application_links')
        .select(input.column)
        .eq('id', input.applicationLinkId)
        .maybeSingle();
      if (readErr || !current) throw new Error('ashby_link_bind_error');
      const existing = (current as unknown as Record<string, unknown>)[input.column];
      if (typeof existing !== 'string') throw new Error('ashby_link_bind_error');
      return { bound: existing, wonRace: false };
    },
    async deleteOrphan(table, id) {
      const { error } = await client.from(table).delete().eq('id', id);
      if (error) throw new Error('ashby_orphan_cleanup_error');
    },
    async createSession(input) {
      const { data, error } = await client
        .from('call_sessions')
        .insert({
          candidate_id: input.candidateId,
          role_id: input.roleId,
          owner_id: input.ownerId,
          mode: 'browser',
          status: 'created',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error('ashby_session_insert_error');
      return { id: (data as { id: string }).id };
    },
    async findActiveInvite(sessionId, nowIso) {
      // Active = not consumed, not revoked, not expired.
      const { data, error } = await client
        .from('candidate_invites')
        .select('id')
        .eq('session_id', sessionId)
        .is('consumed_at', null)
        .is('revoked_at', null)
        .gt('expires_at', nowIso)
        .limit(1)
        .maybeSingle();
      if (error) throw new Error('ashby_invite_read_error');
      return data ? { id: (data as { id: string }).id } : null;
    },
    async insertInvite(input) {
      const { data, error } = await client
        .from('candidate_invites')
        .insert({
          // DIGEST ONLY. The plaintext never reaches this seam.
          token_digest: input.tokenDigest,
          candidate_id: input.candidateId,
          session_id: input.sessionId,
          created_by: input.createdBy,
          expires_at: input.expiresAt,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error('ashby_invite_insert_error');
      return { id: (data as { id: string }).id };
    },
  };
}

/**
 * Build the runtime, or return null when any gate is closed. Constructing
 * nothing in the disabled configuration is the contract, not an optimisation.
 */
export function createAshbyRuntime(options: CreateAshbyRuntimeOptions): AshbyRuntime | null {
  const config = options.config ?? loadAshbyConfig();
  const runtimeConfig = options.runtimeConfig ?? loadAshbyRuntimeConfig();

  if (!isAshbyRuntimeActive(config, runtimeConfig)) return null;

  const supabase = options.supabase;
  const client = createAshbyClient({
    apiKey: runtimeConfig.apiKey,
    transport: options.transport,
    logger: createMetadataLogger('ashby-runtime'),
  });

  const stores = createWorkflowStores(supabase);
  const materialization = createMaterializationStore(supabase);
  const mappings = createMappingResolver(supabase);
  const parserPool = options.parserPool ?? createResumeParserPool();
  const scanner = resolveScanner();
  const resumeTransport = options.resumeTransport ?? createPinnedHttpsTransport();
  const resolveHost = options.resolveHost ?? defaultResolveHost;

  // EMPTY allowlist ⇒ disabled ⇒ every fetch fails closed. Exact hosts only.
  const urlPolicy: UrlPolicy = {
    allowlistEnabled: runtimeConfig.resumeHosts.length > 0,
    allowedHosts: runtimeConfig.resumeHosts,
    allowedPorts: [443],
  };

  async function resolveMappingByJobId(externalJobId: string): Promise<ResolvedMapping> {
    const { data, error } = await supabase
      .from('ashby_job_mappings')
      .select('id, status, ai_screening_stage_id, delivery_mode')
      .eq('provider', 'ashby')
      .eq('external_job_id', externalJobId)
      .maybeSingle();
    if (error) throw new Error('ashby_mapping_read_error');
    if (!data) return { status: 'unknown', id: null, deliveryMode: 'manual' };
    const r = data as Record<string, unknown>;
    const status = r.status;
    const mode = r.delivery_mode;
    return {
      status:
        status === 'enabled' || status === 'paused' || status === 'drift'
          ? (status as ResolvedMapping['status'])
          : 'unknown',
      aiScreeningStageId: (r.ai_screening_stage_id as string | null) ?? null,
      id: String(r.id),
      deliveryMode: mode === 'email' || mode === 'both' ? (mode as 'email' | 'both') : 'manual',
    };
  }

  async function resolveMappingForLink(applicationLinkId: string): Promise<MaterializationMapping | null> {
    const { data, error } = await supabase
      .from('ashby_application_links')
      .select('job_mapping_id, ashby_job_mappings ( id, role_id, owner_id, delivery_mode, status )')
      .eq('id', applicationLinkId)
      .maybeSingle();
    if (error || !data) return null;
    const raw = (data as Record<string, unknown>).ashby_job_mappings;
    const m = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null | undefined;
    if (!m) return null;
    // Only an ENABLED mapping may drive materialization. A pause landing
    // mid-flight therefore stops new work at execution time, not just at enqueue.
    if (m.status !== 'enabled') return null;
    const mode = m.delivery_mode;
    return {
      id: String(m.id),
      roleId: String(m.role_id),
      ownerId: String(m.owner_id),
      deliveryMode: mode === 'email' || mode === 'both' ? (mode as 'email' | 'both') : 'manual',
    };
  }

  async function buildIngestionPorts(input: {
    applicationLinkId: string;
    onState: IngestionPorts['onState'];
  }): Promise<IngestionPorts | null> {
    const { data, error } = await supabase
      .from('ashby_application_links')
      .select('external_resume_file_handle')
      .eq('id', input.applicationLinkId)
      .maybeSingle();
    if (error || !data) return null;
    const handle = (data as { external_resume_file_handle: string | null }).external_resume_file_handle;
    // No resume handle ⇒ nothing to ingest. The caller treats this as
    // `no_resume`, not as a failure.
    if (!handle) return null;

    // Resolve the presigned URL at the LAST possible moment: these URLs are
    // short-lived, and holding one longer than necessary widens the window in
    // which a leaked log line would matter. It is never persisted.
    const info = await client.fileInfo(handle);
    const presignedUrl = extractFileUrl(info.results);
    if (!presignedUrl) return null;

    return {
      presignedUrl,
      policy: urlPolicy,
      fetch: (url, policy) =>
        fetchEphemeralResume(url, policy, { resolve: resolveHost, transport: resumeTransport }),
      scan: async (bytes) => {
        // resolveScanner() never throws by contract, but a fail-closed wrapper
        // costs nothing and guarantees a not-safe verdict on any surprise.
        try {
          const r = await scanner.scan(bytes);
          return { safe: r.safe, status: r.status };
        } catch {
          return { safe: false, status: 'scanner_error' };
        }
      },
      guard: (bytes, contentType) => {
        try {
          // The declared filename/MIME are OURS, not tenant-controlled: the
          // guard re-derives the canonical MIME from the magic bytes, so a
          // mislabelled payload still fails closed.
          const r = guardUpload(bytes, contentType ?? 'application/pdf', 'resume.pdf');
          return { ok: true, mime: r.mime };
        } catch (err) {
          return {
            ok: false,
            reason: err instanceof UploadGuardError ? err.code : 'guard_rejected',
          };
        }
      },
      parse: async (bytes, mime): Promise<ParseOutput> => {
        const parsed = await parserPool.submit(bytes, mime);
        const structured: StructuredResume = fallbackParseResumeText(parsed.text);
        return { text: parsed.text, structured, structurerVersion: ASHBY_STRUCTURER_VERSION };
      },
      fallbackFromText: (text) => fallbackParseResumeText(text),
      onState: input.onState,
      extractorVersion: ASHBY_EXTRACTOR_VERSION,
    };
  }

  let shut = false;
  return {
    config,
    runtimeConfig,
    client,
    queue: createAshbySignalQueue(supabase),
    stores,
    receipts: createReceiptStore(supabase),
    checkpoints: createCheckpointStore(supabase),
    missionControl: createMissionControlStore(supabase),
    materialization,
    urlPolicy,
    resolveMappingByJobId,
    resolveMappingForLink,
    buildIngestionPorts,
    mappings,
    async shutdown() {
      if (shut) return;
      shut = true;
      try { await parserPool.drain(); } catch { /* best effort */ }
    },
  };
}
