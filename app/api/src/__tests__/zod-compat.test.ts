/**
 * lib/zod-compat.ts: the zod 4 -> zod 3 contract layer, plus the two
 * deliberate differences from zod 3 that the upgrade keeps.
 */
import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validateBody, zodErrorHandler } from '../lib/validation.js';
import {
  installZod3Messages,
  toZod3Issues,
  ZOD3_DATETIME_RE,
  ZOD3_IP_RE,
  ZOD3_UUID_RE,
  zod3Int,
  zod3Uuid,
} from '../lib/zod-compat.js';
import { uuidSchema } from '../schemas/common.js';
import { adminAuditListQuerySchema } from '../schemas/admin.js';
import { correctDSARBodySchema } from '../schemas/dsar.js';

installZod3Messages();

function respond(handler: (res: Response) => void) {
  let status = 0;
  let body: unknown;
  const res = {
    status(code: number) { status = code; return res; },
    json(payload: unknown) { body = payload; return res; },
  } as unknown as Response;
  handler(res);
  return { status, body: body as { error: { type: string; details?: unknown[] } } };
}

const bodyDetails = (schema: z.ZodType, input: unknown) =>
  respond((res) => validateBody(schema)({ body: input } as Request, res, (() => {}) as NextFunction)).body.error.details;

describe('format helpers', () => {
  it('zod3Uuid is the zod 3 loose pattern, not RFC 9562', () => {
    expect(zod3Uuid().safeParse('11111111-1111-1111-1111-111111111111').success).toBe(true);
    expect(z.uuid().safeParse('11111111-1111-1111-1111-111111111111').success).toBe(false);
    expect(ZOD3_UUID_RE.test('3F2B8C1E-9D4A-4B6E-8F1A-2C3D4E5F6A7B')).toBe(true);
    expect(ZOD3_UUID_RE.test('3f2b8c1e9d4a4b6e8f1a2c3d4e5f6a7b')).toBe(false);
  });

  it('datetime keeps the leap-year aware date and optional seconds', () => {
    expect(ZOD3_DATETIME_RE.test('2024-02-29T00:00Z')).toBe(true);
    expect(ZOD3_DATETIME_RE.test('2026-02-29T00:00:00Z')).toBe(false);
    expect(ZOD3_DATETIME_RE.test('2026-08-22T14:30:00.5Z')).toBe(true);
    expect(ZOD3_DATETIME_RE.test('2026-08-22T14:30:00')).toBe(false);
  });

  it('ip accepts either family and nothing else', () => {
    expect(ZOD3_IP_RE.test('10.0.0.1')).toBe(true);
    expect(ZOD3_IP_RE.test('::ffff:10.0.0.1')).toBe(true);
    expect(ZOD3_IP_RE.test('10.0.0')).toBe(false);
    expect(ZOD3_IP_RE.test('host.example.com')).toBe(false);
  });

  it('zod3Int uses Number.isInteger and keeps later checks running', () => {
    const schema = z.number().check(zod3Int()).min(1).max(10);
    expect(schema.safeParse(5).success).toBe(true);
    expect(z.number().check(zod3Int()).safeParse(2 ** 60).success).toBe(true);
    const result = schema.safeParse(0.5);
    expect(result.success).toBe(false);
    expect(toZod3Issues(result.error!).map((i) => i.code)).toEqual(['invalid_type', 'too_small']);
  });
});

describe('toZod3Issues', () => {
  it('works without reportInput (a thrown .parse() error)', () => {
    const result = uuidSchema.safeParse('nope');
    expect(result.success).toBe(false);
    expect(toZod3Issues(result.error!)).toEqual([
      { path: [], code: 'invalid_string', message: 'must be a valid UUID' },
    ]);
  });

  it('zodErrorHandler answers a thrown ZodError with the zod 3 contract', () => {
    let thrown: unknown;
    try { uuidSchema.parse('nope'); } catch (error) { thrown = error; }
    const out = respond((res) => zodErrorHandler(thrown, {} as Request, res, (() => {}) as NextFunction));
    expect(out.status).toBe(400);
    expect(out.body).toEqual({
      error: {
        type: 'validation_error',
        message: 'Request validation failed',
        details: [{ field: '(root)', code: 'invalid_string', message: 'must be a valid UUID' }],
      },
    });
  });

  it('installZod3Messages is idempotent', () => {
    installZod3Messages();
    installZod3Messages();
    expect(z.string().safeParse(undefined).error!.issues[0]!.message).toBe('Required');
  });
});

describe('intentional differences from zod 3', () => {
  it('an oversized array reports only its length (GHSA-mrhx-c7xc-m3w5)', () => {
    // zod 3 also parsed every element and returned one issue per bad item,
    // which is the unbounded accumulation the advisory describes.
    const corrections = Array.from({ length: 51 }, () => 12345);
    expect(bodyDetails(correctDSARBodySchema, { corrections })).toEqual([
      { field: 'corrections', code: 'too_big', message: 'Cannot apply more than 50 corrections at once' },
    ]);
  });

  it('a non-finite number is refused as not finite', () => {
    // Reachable only as a JSON literal that overflows (1e400) or `?limit=Infinity`.
    // zod 3 refused it too here (not an integer) but with two issues.
    expect(bodyDetails(adminAuditListQuerySchema, { limit: 'Infinity' })).toEqual([
      { field: 'limit', code: 'not_finite', message: 'Number must be finite' },
    ]);
    expect(z.number().safeParse(JSON.parse('1e400')).success).toBe(false);
  });
});
