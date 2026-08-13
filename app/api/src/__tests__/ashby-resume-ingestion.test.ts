/**
 * Ashby ephemeral resume ingestion orchestration (Wave 2 work item 4).
 *
 * Proves the state machine + security invariants over injected ports:
 *  - fail-closed malware scan BLOCKS the parse (scan runs before parse);
 *  - the original bytes are wiped on every terminal path and never persisted;
 *  - fetch/guard/parse failures map to failed_review with sanitized reasons;
 *  - the deterministic fallback is used when the parser yields nothing;
 *  - a cancellation (terminal link) aborts remaining work;
 *  - a thrown port fails closed with the bytes wiped.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  runResumeIngestion,
  type IngestionPorts,
  type ParseOutput,
  type StructuredResume,
  type IngestionState,
} from '../integrations/ashby/resume-ingestion.js';
import type { ResumeFetchOutcome } from '../integrations/ashby/resume-fetch.js';
import type { UrlPolicy } from '../integrations/ashby/ssrf.js';

const policy: UrlPolicy = { allowlistEnabled: true, allowedHosts: ['files.ashby.example'] };
const GOOD: StructuredResume = {
  name: 'Jamie Rivera',
  email: 'jamie@example.com',
  phone: null,
  skills: ['sales'],
  experience_years: 4,
  current_role: 'Advisor',
  summary: 'Experienced advisor.',
};
const EMPTY: StructuredResume = { name: null, email: null, phone: null, skills: [], experience_years: null, current_role: null, summary: null };

function makePorts(over: Partial<IngestionPorts> & { bytes?: Buffer } = {}): { ports: IngestionPorts; states: IngestionState[]; bytesRef: Buffer } {
  const states: IngestionState[] = [];
  const bytesRef = over.bytes ?? Buffer.from('%PDF-1.4 resume content %%EOF');
  const okFetch: ResumeFetchOutcome = { ok: true, bytes: bytesRef, contentType: 'application/pdf', sha256: 'a'.repeat(64), finalHost: 'files.ashby.example', hops: 0 };
  const ports: IngestionPorts = {
    presignedUrl: 'https://files.ashby.example/r.pdf',
    policy,
    fetch: over.fetch ?? (async () => okFetch),
    scan: over.scan ?? (async () => ({ safe: true, status: 'clean' })),
    guard: over.guard ?? (() => ({ ok: true, mime: 'application/pdf' })),
    parse: over.parse ?? (async (): Promise<ParseOutput> => ({ text: 'Jamie Rivera resume', structured: GOOD, structurerVersion: 'p1' })),
    fallbackFromText: over.fallbackFromText ?? (() => GOOD),
    onState: over.onState ?? ((s) => { states.push(s); }),
    extractorVersion: 'x1',
  };
  return { ports, states, bytesRef };
}

describe('runResumeIngestion — happy path', () => {
  it('walks queued→...→ready and wipes bytes before ready', async () => {
    const { ports, states, bytesRef } = makePorts();
    const out = await runResumeIngestion(ports);
    expect(out.state).toBe('ready');
    if (out.state === 'ready') {
      expect(out.structured.email).toBe('jamie@example.com');
      expect(out.provenance.contentSha256).toBe('a'.repeat(64));
      expect(out.provenance.extractorVersion).toBe('x1');
    }
    expect(states).toEqual(['fetching', 'scanning', 'extracting', 'structuring', 'ready']);
    // Bytes were wiped (buffer zeroed).
    expect(bytesRef.every((b) => b === 0)).toBe(true);
  });
});

describe('runResumeIngestion — fail-closed scan before parse', () => {
  it('an infected scan blocks the parse and wipes bytes', async () => {
    const parse = vi.fn(async (): Promise<ParseOutput> => ({ text: 't', structured: GOOD, structurerVersion: 'p1' }));
    const { ports, states, bytesRef } = makePorts({ scan: async () => ({ safe: false, status: 'infected' }), parse });
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: 'scan_infected' });
    expect(parse).not.toHaveBeenCalled();
    expect(states).toEqual(['fetching', 'scanning', 'failed_review']);
    expect(bytesRef.every((b) => b === 0)).toBe(true);
  });

  it('a scanner outage (not safe) fails closed too', async () => {
    const { ports } = makePorts({ scan: async () => ({ safe: false, status: 'scanner_unavailable' }) });
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: 'scan_scanner_unavailable' });
  });
});

describe('runResumeIngestion — fetch/guard/parse failures', () => {
  it('maps a fetch failure to failed_review with a sanitized reason', async () => {
    const { ports } = makePorts({ fetch: async (): Promise<ResumeFetchOutcome> => ({ ok: false, reason: 'blocked_address', hops: 0 }) });
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: 'fetch_blocked_address' });
  });

  it('maps a guard rejection to failed_review', async () => {
    const { ports, bytesRef } = makePorts({ guard: () => ({ ok: false, reason: 'polyglot' }) });
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: 'guard_polyglot' });
    expect(bytesRef.every((b) => b === 0)).toBe(true);
  });

  it('maps a parser throw to failed_review parse_error', async () => {
    const { ports } = makePorts({ parse: async () => { throw new Error('boom'); } });
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: 'parse_error' });
  });
});

describe('runResumeIngestion — deterministic fallback', () => {
  it('uses the fallback when the parser yields nothing useful', async () => {
    const { ports, states } = makePorts({
      parse: async (): Promise<ParseOutput> => ({ text: 'raw text', structured: EMPTY, structurerVersion: 'p1' }),
      fallbackFromText: () => GOOD,
    });
    const out = await runResumeIngestion(ports);
    expect(out.state).toBe('ready');
    if (out.state === 'ready') expect(out.provenance.structurerVersion).toBe('p1+fallback');
    expect(states).toContain('structuring');
  });

  it('fails review when neither parser nor fallback extract anything', async () => {
    const { ports } = makePorts({
      parse: async (): Promise<ParseOutput> => ({ text: '', structured: EMPTY, structurerVersion: 'p1' }),
      fallbackFromText: () => EMPTY,
    });
    const out = await runResumeIngestion(ports);
    expect(out).toEqual({ state: 'failed_review', reason: 'no_extractable_fields' });
  });
});

describe('runResumeIngestion — cancellation + hard failure', () => {
  it('cancels before fetch when the link is already terminal', async () => {
    const fetch = vi.fn(async (): Promise<ResumeFetchOutcome> => ({ ok: false, reason: 'timeout', hops: 0 }));
    const { ports, states } = makePorts({ fetch });
    const out = await runResumeIngestion(ports, () => true);
    expect(out).toEqual({ state: 'cancelled', reason: 'cancelled_before_fetch' });
    expect(fetch).not.toHaveBeenCalled();
    expect(states).toEqual(['cancelled']);
  });

  it('cancels after fetch and wipes bytes', async () => {
    let calls = 0;
    const { ports, bytesRef } = makePorts();
    const out = await runResumeIngestion(ports, () => {
      calls += 1;
      return calls >= 2; // allow the pre-fetch check, cancel after fetch
    });
    expect(out).toEqual({ state: 'cancelled', reason: 'cancelled_after_fetch' });
    expect(bytesRef.every((b) => b === 0)).toBe(true);
  });

  it('a thrown onState fails closed with bytes wiped', async () => {
    const { ports, bytesRef } = makePorts({
      onState: (s: IngestionState) => { if (s === 'scanning') throw new Error('db down'); },
    });
    const out = await runResumeIngestion(ports);
    expect(out.state).toBe('failed_review');
    expect(bytesRef.every((b) => b === 0)).toBe(true);
  });
});
