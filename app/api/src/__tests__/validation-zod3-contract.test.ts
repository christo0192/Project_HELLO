/**
 * The validation error contract, pinned to what zod 3 returned.
 *
 * The API moved to zod 4 (GHSA-mrhx-c7xc-m3w5). Clients still receive the
 * zod 3 shape: the same accepted inputs, the same parsed data and defaults,
 * and the same `error.details[]` ({ field, code, message }) in the same
 * order. Every expectation below is zod 3's own output for that input, so
 * this file passes unchanged against the pre-migration tree; anything that
 * fails here is a client-visible change. lib/zod-compat.ts documents how the
 * zod 3 shape is rebuilt.
 */
import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody } from '../lib/validation.js';
import { idParamSchema } from '../schemas/common.js';
import { adminAuditListQuerySchema, adminQuotaUpsertSchema } from '../schemas/admin.js';
import { appealGrantCreateSchema, appealReviewSchema } from '../schemas/appeals.js';
import { manualPhoneCallBodySchema } from '../schemas/candidates.js';
import { consentSubmitSchema } from '../schemas/consent.js';
import { correctDSARBodySchema, createDSARBodySchema, createLegalHoldBodySchema } from '../schemas/dsar.js';
import { candidateStatusUpdateSchema, noteCreateSchema } from '../schemas/notes.js';
import { phoneCalendarQuerySchema } from '../schemas/phone-api.js';
import { createRoleSchema, roleDraftSchema } from '../schemas/roles.js';

type Detail = { field: string; code: string; message: string };
type Outcome = { ok: true; data: unknown } | { ok: false; status: number; details: Detail[] };

function run(schema: unknown, body: unknown): Outcome {
  const req = { body } as Request;
  let outcome: Outcome | undefined;
  let status = 0;
  const res = {
    status(code: number) { status = code; return res; },
    json(payload: { error: { details?: Detail[] } }) {
      outcome = { ok: false, status, details: payload.error.details ?? [] };
      return res;
    },
  } as unknown as Response;
  const next: NextFunction = () => { outcome = { ok: true, data: req.body }; };
  validateBody(schema as Parameters<typeof validateBody>[0])(req, res, next);
  if (!outcome) throw new Error('middleware neither responded nor called next');
  return outcome;
}

const details = (schema: unknown, body: unknown): Detail[] => {
  const out = run(schema, body);
  if (out.ok) throw new Error(`expected a 400, got data ${JSON.stringify(out.data)}`);
  expect(out.status).toBe(400);
  return out.details;
};

const UUID = '3f2b8c1e-9d4a-4b6e-8f1a-2c3d4e5f6a7b';

describe('UUIDs keep zod 3 acceptance (any 8-4-4-4-12 hex, as Postgres uuid)', () => {
  it.each([
    UUID,
    UUID.toUpperCase(),
    '11111111-1111-1111-1111-111111111111', // version 1 digit, variant 1: not RFC 9562
    '00000000-0000-0000-0000-000000000000',
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ])('accepts %s', (id) => {
    expect(run(idParamSchema, { id })).toEqual({ ok: true, data: { id } });
  });

  it('rejects a malformed id with the schema message and zod 3 code', () => {
    expect(details(idParamSchema, { id: 'not-a-uuid' })).toEqual([
      { field: 'id', code: 'invalid_string', message: 'must be a valid UUID' },
    ]);
  });

  it('keeps the type error separate from the format message', () => {
    expect(details(idParamSchema, { id: 5 })).toEqual([
      { field: 'id', code: 'invalid_type', message: 'Expected string, received number' },
    ]);
    expect(details(idParamSchema, {})).toEqual([
      { field: 'id', code: 'invalid_type', message: 'Required' },
    ]);
  });

  it('reports unknown keys at the root', () => {
    expect(details(idParamSchema, { id: UUID, extra: 1, more: 2 })).toEqual([
      { field: '(root)', code: 'unrecognized_keys', message: "Unrecognized key(s) in object: 'extra', 'more'" },
    ]);
  });
});

describe('enum, literal and string defaults', () => {
  it('enum: wrong value, wrong type, missing', () => {
    expect(details(candidateStatusUpdateSchema, { status: 'bogus' })).toEqual([{
      field: 'status',
      code: 'invalid_enum_value',
      message: "Invalid enum value. Expected 'queued' | 'screening' | 'screened' | 'advanced' | 'rejected', received 'bogus'",
    }]);
    expect(details(candidateStatusUpdateSchema, { status: 1 })).toEqual([{
      field: 'status',
      code: 'invalid_type',
      message: "Expected 'queued' | 'screening' | 'screened' | 'advanced' | 'rejected', received number",
    }]);
    expect(details(candidateStatusUpdateSchema, {})).toEqual([
      { field: 'status', code: 'invalid_type', message: 'Required' },
    ]);
  });

  it('enum with a schema message keeps it for every failure', () => {
    const missing = details(createDSARBodySchema, { candidate_id: UUID });
    expect(missing).toEqual([{
      field: 'request_type',
      code: 'invalid_type',
      message: 'request_type must be one of: export, delete, correct, restrict',
    }]);
    const wrong = details(createDSARBodySchema, { candidate_id: UUID, request_type: 'nuke' });
    expect(wrong).toEqual([{
      field: 'request_type',
      code: 'invalid_enum_value',
      message: 'request_type must be one of: export, delete, correct, restrict',
    }]);
  });

  it('literal', () => {
    expect(details(manualPhoneCallBodySchema, { confirm: false })).toEqual([
      { field: 'confirm', code: 'invalid_literal', message: 'Invalid literal value, expected true' },
    ]);
    expect(run(manualPhoneCallBodySchema, { confirm: true })).toEqual({ ok: true, data: { confirm: true } });
  });

  it('string length: custom and default messages, trim before checks', () => {
    expect(details(noteCreateSchema, { candidate_id: UUID, note: '   ' })).toEqual([
      { field: 'note', code: 'too_small', message: 'note is required' },
    ]);
    expect(details(roleDraftSchema, { job_role: 'x'.repeat(201) })).toEqual([
      { field: 'job_role', code: 'too_big', message: 'String must contain at most 200 character(s)' },
    ]);
    expect(run(noteCreateSchema, { candidate_id: UUID, note: '  hi  ' })).toEqual({
      ok: true,
      data: { candidate_id: UUID, note: 'hi' },
    });
  });
});

describe('numbers', () => {
  it('coerced query numbers keep zod 3 integer semantics and both issues', () => {
    expect(details(adminAuditListQuerySchema, { limit: '0.5' })).toEqual([
      { field: 'limit', code: 'invalid_type', message: 'Expected integer, received float' },
      { field: 'limit', code: 'too_small', message: 'Number must be greater than or equal to 1' },
    ]);
    expect(details(adminAuditListQuerySchema, { limit: 'abc' })).toEqual([
      { field: 'limit', code: 'invalid_type', message: 'Expected number, received nan' },
    ]);
  });

  it('defaults apply when keys are absent', () => {
    expect(run(adminAuditListQuerySchema, {})).toEqual({ ok: true, data: { limit: 100, offset: 0 } });
    expect(run(adminQuotaUpsertSchema, { scope: 'global' })).toEqual({
      ok: true,
      data: { scope: 'global', mode: 'simulation', period_days: 1, enabled: false },
    });
  });

  it('positive / bounded integer messages', () => {
    expect(details(adminQuotaUpsertSchema, { scope: 'global', max_sessions: 0 })).toEqual([
      { field: 'max_sessions', code: 'too_small', message: 'Number must be greater than 0' },
    ]);
  });

  it('integers beyond 2^53 are still integers (zod 3 Number.isInteger)', () => {
    expect(details(adminAuditListQuerySchema, { limit: 2 ** 60 })).toEqual([
      { field: 'limit', code: 'too_big', message: 'Number must be less than or equal to 100' },
    ]);
  });

  it('appeal expiry: invalid_type_error only for a present non-number', () => {
    const base = { candidate_id: UUID, session_id: UUID };
    expect(details(appealGrantCreateSchema, { ...base, expires_in_hours: 'soon' })).toEqual([
      { field: 'expires_in_hours', code: 'invalid_type', message: 'expires_in_hours is required' },
    ]);
    expect(details(appealGrantCreateSchema, base)).toEqual([
      { field: 'expires_in_hours', code: 'invalid_type', message: 'Required' },
    ]);
    expect(details(appealGrantCreateSchema, { ...base, expires_in_hours: 1.5 })).toEqual([
      { field: 'expires_in_hours', code: 'invalid_type', message: 'expires_in_hours must be an integer' },
    ]);
    expect(details(appealGrantCreateSchema, { ...base, expires_in_hours: 0.5 })).toEqual([
      { field: 'expires_in_hours', code: 'invalid_type', message: 'expires_in_hours must be an integer' },
      { field: 'expires_in_hours', code: 'too_small', message: 'expires_in_hours must be 1..72' },
    ]);
  });
});

describe('formats pinned to zod 3', () => {
  const consent = (proof: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    candidate_id: UUID,
    consents: ['ai_interview'],
    proof,
    ...extra,
  });

  it('datetime: Z only, seconds optional, any precision', () => {
    for (const ok of ['2026-08-22T14:30:00Z', '2026-08-22T14:30Z', '2026-08-22T14:30:00.1234567Z']) {
      expect(run(consentSubmitSchema, consent({ captured_at: ok })).ok).toBe(true);
    }
    expect(details(consentSubmitSchema, consent({ captured_at: '2026-08-22T14:30:00+05:30' }))).toEqual([
      { field: 'proof.captured_at', code: 'invalid_string', message: 'Invalid datetime' },
    ]);
    expect(details(createLegalHoldBodySchema, {
      entity_type: 'candidate',
      entity_id: UUID,
      hold_reason: 'r',
      hold_source: 'other',
      expires_at: '2026-02-30T00:00:00Z',
    })).toEqual([{ field: 'expires_at', code: 'invalid_string', message: 'Invalid datetime' }]);
  });

  it('ip: IPv4, IPv6, IPv4-mapped and zone ids as zod 3 accepted them', () => {
    for (const ip of ['127.0.0.1', '::1', '2001:db8::1', '::ffff:192.168.0.1', 'fe80::1%eth0']) {
      expect(run(consentSubmitSchema, consent({ ip_address: ip })).ok).toBe(true);
    }
    expect(details(consentSubmitSchema, consent({ ip_address: '256.1.1.1' }))).toEqual([
      { field: 'proof.ip_address', code: 'invalid_string', message: 'Invalid ip' },
    ]);
  });

  it('consent defaults: version, status and proof', () => {
    expect(run(consentSubmitSchema, { candidate_id: UUID, consents: ['recording'] })).toEqual({
      ok: true,
      data: { candidate_id: UUID, version: '1.0', consents: ['recording'], status: 'granted', proof: {} },
    });
  });

  it('refinement messages and paths', () => {
    expect(details(phoneCalendarQuerySchema, { from: '2026-08-22T14:30:00Z', to: '2026-08-22T14:00:00Z' })).toEqual([
      { field: 'to', code: 'custom', message: 'to_must_be_after_from' },
    ]);
    expect(details(phoneCalendarQuerySchema, { from: 'later', to: '2026-08-22T14:00:00Z' })).toEqual([
      { field: 'from', code: 'invalid_string', message: 'must_be_utc_iso_8601' },
      { field: 'from', code: 'custom', message: 'must_be_a_real_instant' },
      // zod 3 ran object refinements over a field that only failed a check
      // (not a type), so the range refinements still report.
      { field: 'to', code: 'custom', message: 'to_must_be_after_from' },
      { field: 'to', code: 'custom', message: 'range_exceeds_max_days' },
    ]);
  });
});

describe('records, unknown values and arrays', () => {
  it('a failing record key is reported as the key issue at the key path', () => {
    expect(details(appealReviewSchema, { to_status: 'granted', evidence: { '': 1 } })).toEqual([
      { field: 'evidence.', code: 'too_small', message: 'String must contain at least 1 character(s)' },
    ]);
    expect(details(appealReviewSchema, { to_status: 'granted', evidence: { k: { nested: true } } })).toEqual([
      { field: 'evidence.k', code: 'invalid_union', message: 'Invalid input' },
    ]);
    expect(details(appealReviewSchema, { to_status: 'granted', evidence: { k: 'v'.repeat(501) } })).toEqual([
      { field: 'evidence.k', code: 'too_big', message: 'String must contain at most 500 character(s)' },
    ]);
  });

  it('an unknown-typed key stays optional', () => {
    expect(run(correctDSARBodySchema, { corrections: [{ field: 'email' }] })).toEqual({
      ok: true,
      data: { corrections: [{ field: 'email' }] },
    });
  });

  it('record of unknown with a size refinement', () => {
    expect(details(createDSARBodySchema, {
      candidate_id: UUID,
      request_type: 'export',
      metadata: { blob: 'x'.repeat(5000) },
    })).toEqual([{ field: 'metadata', code: 'custom', message: 'metadata must not exceed 4KB when serialized' }]);
  });

  it('an array length issue comes before its element issues', () => {
    const schema = z.object({ turns: z.array(z.object({ text: z.string() }).strict()).min(2) }).strict();
    expect(details(schema, { turns: [{ text: 1, x: 1 }] })).toEqual([
      { field: 'turns', code: 'too_small', message: 'Array must contain at least 2 element(s)' },
      { field: 'turns.0.text', code: 'invalid_type', message: 'Expected string, received number' },
      { field: 'turns.0', code: 'unrecognized_keys', message: "Unrecognized key(s) in object: 'x'" },
    ]);
  });

  it('a non-array gets only the type error', () => {
    const schema = z.object({ turns: z.array(z.string()).min(2) });
    expect(details(schema, { turns: 'x' })).toEqual([
      { field: 'turns', code: 'invalid_type', message: 'Expected array, received string' },
    ]);
  });

  it('a failed transformed field still skips the template superRefine', () => {
    const out = details(createRoleSchema, {
      title: 'SWE',
      agent_name: 'a'.repeat(81),
      screening_template: [{ id: 'q1', question: 'a' }],
    });
    expect(out).toEqual([
      { field: 'agent_name', code: 'too_big', message: 'String must contain at most 80 character(s)' },
    ]);
  });
});
