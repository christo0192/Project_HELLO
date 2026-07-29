/**
 * OBS-01 / OBS-02 observability tests — COMPREHENSIVE SUITE.
 *
 * Covers:
 *  - Logger schema: one JSON object per line, fixed envelope fields.
 *  - Envelope field validation (timestamp, correlationId) at runtime.
 *  - Key→type enforcement: booleans rejected, string/number partitioned.
 *  - Adversarial redaction: bearer/token/private-key/email/phone/path/URL/
 *    query/control/newline seeds in non-allowlisted metadata.
 *  - Value-safe redaction: MATRIX test — EVERY seed in EVERY string field.
 *  - Non-finite numeric rejection (NaN, Infinity, out-of-range, bool-in-numeric).
 *  - Runtime schema enforcement: level, event, component (max 64 chars parity).
 *  - Control-character sanitisation in allowlisted string fields.
 *  - err.name mapping in finalErrorHandler (attacker-controlled name → UnknownError).
 *  - Correlation middleware: valid UUID accepted, missing/malformed/oversized/
 *    control-char/comma-joined (duplicate) → generated UUID.
 *  - TRUE duplicate HTTP header test via raw Node HTTP on loopback.
 *  - Concurrent request isolation: no context bleed across concurrent requests.
 *  - X-Correlation-ID presence on 200 / 400 / 413 / CORS-blocked / OPTIONS paths.
 *  - finalErrorHandler: logs error_category only, not exception message.
 *  - Suite-level network trap: socket creation blocked for all tests.
 *  - unknown_event present in event catalogue.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { Request, Response, NextFunction } from 'express';
import { createLogger, EVENT_NAMES_SET } from '../lib/logger.js';
import { validateIncomingId, correlationMiddleware } from '../lib/correlation.js';
import { finalErrorHandler } from '../lib/validation.js';
import { createApp } from '../app.js';

// ===================================================================
//  SUITE-LEVEL NETWORK TRAP
// ===================================================================

beforeAll(() => {
  // Trap external networking: allow only loopback (127.0.0.1, ::1, localhost)
  // connections so supertest (which uses localhost) and the explicit
  // duplicate-header loopback test still work.  Any connection attempt to
  // a non-loopback address is blocked.
  const net = require('node:net');
  const dgram = require('node:dgram');

  const netConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args: any[]) {
    // Inspect arguments to determine target address.
    // Node's net.connect() accepts: (port, host?), (path), or (options).
    // When host is missing or undefined, Node defaults to localhost.
    let target: string | undefined;
    let isTcp = false;
    if (typeof args[0] === 'object' && args[0] !== null) {
      target = (args[0] as any).host ?? (args[0] as any).address;
      if ((args[0] as any).port !== undefined) isTcp = true;
    } else if (typeof args[0] === 'string') {
      target = args[0];
    } else if (typeof args[0] === 'number') {
      target = typeof args[1] === 'string' ? args[1] : 'localhost';
      isTcp = true;
    }
    // Allow loopback destinations and implicit-localhost (port-only) connections
    if (!target || target === 'localhost' ||
      target === '127.0.0.1' || target === '::1' ||
      target === '0.0.0.0' || target.startsWith('127.')
    ) {
      return netConnect.apply(this, args as any);
    }
    throw new Error(
      'NETWORK TRAP: net.Socket.connect() to non-loopback address "' +
      target + '" — a real network call escaped the test harness.',
    );
  };

  // Trap createConnection to also catch explicit connections (e.g., duplicate-header test)
  const origCreateConnection = net.createConnection;
  net.createConnection = function (...args: any[]) {
    let target: string | undefined;
    if (typeof args[0] === 'object' && args[0] !== null) {
      target = (args[0] as any).host ?? (args[0] as any).address;
    } else if (typeof args[0] === 'string') {
      target = args[0];
    } else if (typeof args[0] === 'number') {
      target = typeof args[1] === 'string' ? args[1] : 'localhost';
    }
    if (!target || target === 'localhost' || target === '127.0.0.1' ||
      target === '::1' || target.startsWith('127.')) {
      return origCreateConnection.apply(this, args as any);
    }
    throw new Error('NETWORK TRAP: createConnection to non-loopback address "' + target + '"');
  };

  // Trap dgram send
  const dgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function (...args: any[]) {
    throw new Error('NETWORK TRAP: dgram.Socket.send() called during test');
  };

  // Store originals for explicit afterAll restore (vitest module isolation does
  // NOT restore mutated built-in prototypes; we must do it ourselves).
  (globalThis as any).__obs_orig_net_connect = netConnect;
  (globalThis as any).__obs_orig_create_connection = origCreateConnection;
  (globalThis as any).__obs_orig_dgram_send = dgramSend;
});

afterAll(() => {
  // Explicitly restore saved native method originals.
  const net = require('node:net');
  const dgram = require('node:dgram');
  if ((globalThis as any).__obs_orig_net_connect) {
    net.Socket.prototype.connect = (globalThis as any).__obs_orig_net_connect;
  }
  if ((globalThis as any).__obs_orig_create_connection) {
    net.createConnection = (globalThis as any).__obs_orig_create_connection;
  }
  if ((globalThis as any).__obs_orig_dgram_send) {
    dgram.Socket.prototype.send = (globalThis as any).__obs_orig_dgram_send;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TIMESTAMP_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

afterEach(() => {
  vi.restoreAllMocks();
});

// ===================================================================
//  LOGGER — SCHEMA AND ENVELOPE VALIDATION
// ===================================================================

describe('OBS-01 Logger schema & envelope validation', () => {
  it('emits one valid JSON object per call', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
      clock: () => '2026-01-01T00:00:00.000Z',
    });

    log.info('startup_listen', { port: 8787 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.level).toBe('info');
    expect(parsed.component).toBe('test');
    expect(parsed.event).toBe('startup_listen');
    expect(parsed.correlationId).toBe('aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa');
    expect(parsed.port).toBe(8787);
  });

  it('timestamp is always UTC ISO-8601 with Z suffix', () => {
    const lines: string[] = [];
    const log = createLogger('test', { writer: (l) => lines.push(l) });
    log.info('startup_listen');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.timestamp).toMatch(TIMESTAMP_Z_RE);
  });

  it('emits correlationId null when no request context', () => {
    const lines: string[] = [];
    const log = createLogger('test', { writer: (l) => lines.push(l) });
    log.info('startup_listen');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.correlationId).toBeNull();
  });

  it('validates envelope timestamp: corrupt clock falls back', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      clock: () => 'not-a-timestamp',
    });
    log.info('startup_listen');
    const parsed = JSON.parse(lines[0]);
    // Must be a valid UTC Z timestamp now, not the corrupt input
    expect(parsed.timestamp).toMatch(TIMESTAMP_Z_RE);
    expect(parsed.timestamp).not.toBe('not-a-timestamp');
  });

  it('validates envelope correlationId: non-UUID falls back to null', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => 'not-a-uuid',
    });
    log.info('startup_listen');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.correlationId).toBeNull();
  });

  it('validates envelope correlationId: oversize value falls back to null', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => 'x'.repeat(200),
    });
    log.info('startup_listen');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.correlationId).toBeNull();
  });

  it('routes warn level to console.warn (CSP spy contract)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = createLogger('test');
    log.warn('csp_violation', { shape: 'legacy' });
    expect(warnSpy).toHaveBeenCalledOnce();
    const line = warnSpy.mock.calls[0][0] as string;
    expect(JSON.parse(line).level).toBe('warn');
  });

  it('routes error level to console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = createLogger('test');
    log.error('error_unhandled', { error_category: 'TypeError' });
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('replaces invalid component with "unknown"', () => {
    const lines: string[] = [];
    const log = createLogger('has spaces / slashes! too long 12345', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });
    log.info('startup_listen');
    expect(JSON.parse(lines[0]).component).toBe('unknown');
  });

  it('replaces unknown event name with "unknown_event"', () => {
    const lines: string[] = [];
    const log = createLogger('test', { writer: (l) => lines.push(l), correlationIdGetter: () => null });
    (log.info as unknown as (e: string) => void)('nonexistent_event_xyz');
    expect(JSON.parse(lines[0]).event).toBe('unknown_event');
  });

  it('unknown_event is present in EVENT_NAMES_SET', () => {
    expect(EVENT_NAMES_SET.has('unknown_event')).toBe(true);
  });

  it('component max 64 chars (parity with Python)', () => {
    const lines: string[] = [];
    const longName = 'a'.repeat(65);
    const log = createLogger(longName, { writer: (l) => lines.push(l) });
    log.info('startup_listen');
    expect(JSON.parse(lines[0]).component).toBe('unknown');
    // Safe component under 64 chars should work. Long repeated alnum strings
    // are intentionally rejected as high-entropy token-like values.
    const lines2: string[] = [];
    const okName = 'api.component-long-name.with-safe-separators.v1';
    const log2 = createLogger(okName, { writer: (l) => lines2.push(l) });
    log2.info('startup_listen');
    expect(JSON.parse(lines2[0]).component).toBe(okName);
  });
});

// ── Key→type enforcement ─────────────────────────────────────────

describe('OBS-01 Key→type enforcement — no bool, strict string/number', () => {
  function makeLog() {
    const lines: string[] = [];
    const log = createLogger('test', { writer: (l) => lines.push(l), correlationIdGetter: () => null });
    return { lines, log };
  }

  it('rejects boolean in a string-type key (model:true)', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { model: true as unknown as string });
    expect(JSON.parse(lines[0])).not.toHaveProperty('model');
  });

  it('rejects boolean in a string-type key (error_category:false)', () => {
    const { lines, log } = makeLog();
    log.error('error_unhandled', { error_category: false as unknown as string });
    expect(JSON.parse(lines[0])).not.toHaveProperty('error_category');
  });

  it('rejects boolean in a number-type key (port:true)', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { port: true as unknown as number });
    expect(JSON.parse(lines[0])).not.toHaveProperty('port');
  });

  it('rejects boolean in a number-type key (turn_index:false)', () => {
    const { lines, log } = makeLog();
    log.info('db_turn_saved', { speaker: 'bot', turn_index: false as unknown as number });
    expect(JSON.parse(lines[0])).not.toHaveProperty('turn_index');
  });

  it('rejects string value in a number-type key (port:"abc")', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { port: 'abc' as unknown as number });
    expect(JSON.parse(lines[0])).not.toHaveProperty('port');
  });

  it('rejects number value in a string-type key (model:123)', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { model: 123 as unknown as string });
    expect(JSON.parse(lines[0])).not.toHaveProperty('model');
  });
});

// ── Adversarial seed catalogue — non-allowlisted keys ─────────────────

describe('OBS-01 Adversarial redaction — non-allowlisted keys', () => {
  const SEEDS = {
    bearer_token:   'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    authorization:  'token private-key-abc123xyz-secret',
    email:          'victim@example.com',
    phone:          '+16505550123',
    file_path:      '/home/runner/.ssh/id_rsa',
    url_with_query: 'https://api.example.com/v1/users?token=secret&key=abc',
    nested_object:  { deep: 'secret_nested_value' },
    array_value:    ['item1', 'item2'],
  };

  it('drops all non-allowlisted keys and their values', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });

    log.info('error_unhandled', SEEDS as never);

    expect(lines).toHaveLength(1);
    const line = lines[0];

    expect(() => JSON.parse(line)).not.toThrow();

    expect(line).not.toContain('eyJhbGci');
    expect(line).not.toContain('private-key-abc');
    expect(line).not.toContain('victim@example.com');
    expect(line).not.toContain('+16505550123');
    expect(line).not.toContain('.ssh/id_rsa');
    expect(line).not.toContain('token=secret');
    expect(line).not.toContain('secret_nested_value');
    expect(line).not.toContain('item1');
    expect(line).not.toContain('bearer_token');
    expect(line).not.toContain('authorization');
    expect(line).not.toContain('nested_object');
  });

  it('produces structurally complete output with no seed keys present', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });
    log.error('error_unhandled', SEEDS as never);

    const parsed = JSON.parse(lines[0]);
    expect(parsed).toHaveProperty('timestamp');
    expect(parsed).toHaveProperty('level');
    expect(parsed).toHaveProperty('component');
    expect(parsed).toHaveProperty('event');
    expect(parsed).toHaveProperty('correlationId');
    for (const k of Object.keys(SEEDS)) {
      expect(parsed).not.toHaveProperty(k);
    }
  });
});

// ── MATRIX VALUE-SAFE REDACTION — every seed in every string field ──

describe('OBS-01 MATRIX: every adversarial seed in every allowlisted string field', () => {
  // Every allowlisted string-typed field
  const STRING_FIELDS = [
    'shape', 'document_origin', 'violated_directive', 'effective_directive',
    'blocked_origin', 'error_category', 'error_type', 'method', 'model',
    'schema', 'speaker',
  ] as const;

  // Seeds that should be rejected in any string field
  const SEEDS = [
    { label: 'bearer+JWT',       value: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload' },
    { label: 'email',            value: 'attacker@evil.com' },
    { label: '10plusDigits',     value: '14155551234' },
    { label: 'OpenAI_key',       value: 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456' },
    { label: 'GitHub_token',     value: 'ghp_' + 'abcdefghijklmnopqrstuv' },
    { label: 'Slack_token',      value: 'xox' + 'b-' + '123456789012-abcdefghijklmn' },
    { label: 'AWS_key',          value: 'AKIA' + '1234567890ABCDEF' },
    { label: 'PEM_header',       value: '-----BEGIN RSA PRIVATE KEY-----' },
    { label: 'high_entropy_30',  value: 'aB3dE5gH7jK9lMnOpQrStUvWxYz0123456' },
    { label: 'path_leak',        value: '/etc/passwd' },
    { label: 'file_path',        value: '/home/user/.ssh/id_rsa' },
    { label: 'control_char',     value: 'safe\x00injected_payload' },
    { label: 'newline_inject',   value: 'valid\n{"fake_log":true}' },
  ];

  for (const field of STRING_FIELDS) {
    for (const seed of SEEDS) {
      it(`[${field}] rejects "${seed.label}"`, () => {
        const lines: string[] = [];
        const log = createLogger('test', {
          writer: (l) => lines.push(l),
          correlationIdGetter: () => null,
          // Fixed clock so timestamp validation doesn't interfere
          clock: () => '2026-01-01T00:00:00.000Z',
        });

        // Use appropriate event/context for the field
        // (turn_index and duration_sec are numeric, not in STRING_FIELDS)
        const event = (field === 'document_origin' || field === 'blocked_origin'
          || field === 'violated_directive' || field === 'effective_directive'
          || field === 'shape')
          ? 'csp_violation' as const
          : field === 'speaker'
            ? 'db_turn_saved' as const
            : 'error_unhandled' as const;

        log.info(event, { [field]: seed.value } as never);

        const line = lines[0];
        const parsed = JSON.parse(line);
        // The field should be dropped entirely
        expect(parsed).not.toHaveProperty(field);
        // The seed value must not appear anywhere in the line
        const safeFrag = seed.value.length > 10
          ? seed.value.slice(0, 10)
          : seed.value;
        expect(line).not.toContain(safeFrag);
      });
    }
  }

  // But valid values must pass through
  const VALID_CASES = [
    { field: 'shape',    value: 'legacy' },
    { field: 'shape',    value: 'reporting-api' },
    { field: 'speaker',  value: 'bot' },
    { field: 'speaker',  value: 'candidate' },
    { field: 'method',   value: 'GET' },
    { field: 'method',   value: 'post' },       // normalises to POST
    { field: 'error_category', value: 'TypeError' },
    { field: 'error_type',     value: 'validation_error' },
    { field: 'model',    value: 'claude-haiku-4-5-20251001' },
    { field: 'schema',   value: 'screening_v2' },
    { field: 'violated_directive', value: 'script-src-elem' },
    { field: 'effective_directive', value: 'style-src-attr' },
    { field: 'document_origin',  value: 'https://example.com' },
    { field: 'blocked_origin',   value: 'https://cdn.example.com' },
  ];

  for (const { field, value } of VALID_CASES) {
    it(`allows valid [${field}]: "${value}"`, () => {
      const lines: string[] = [];
      const log = createLogger('test', {
        writer: (l) => lines.push(l),
        correlationIdGetter: () => null,
        clock: () => '2026-01-01T00:00:00.000Z',
      });
      log.info('error_unhandled', { [field]: value } as never);
      const parsed = JSON.parse(lines[0]);
      expect(parsed).toHaveProperty(field);
    });
  }
});

// ── Non-finite numeric rejection ───────────────────────────────────────

describe('OBS-01 Non-finite and out-of-range numeric fields', () => {
  function makeLog() {
    const lines: string[] = [];
    const log = createLogger('test', { writer: (l) => lines.push(l), correlationIdGetter: () => null });
    return { lines, log };
  }

  it('drops port: NaN', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { port: NaN });
    expect(JSON.parse(lines[0])).not.toHaveProperty('port');
  });

  it('drops http_status: Infinity', () => {
    const { lines, log } = makeLog();
    log.info('scoring_trigger', { http_status: Infinity });
    expect(JSON.parse(lines[0])).not.toHaveProperty('http_status');
  });

  it('drops port: 0 (out of range)', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { port: 0 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('port');
  });

  it('drops port: 65536 (out of range)', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { port: 65536 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('port');
  });

  it('drops turn_index: -1 (negative)', () => {
    const { lines, log } = makeLog();
    log.info('db_turn_saved', { speaker: 'bot', turn_index: -1 });
    const parsed = JSON.parse(lines[0]);
    expect(parsed).not.toHaveProperty('turn_index');
  });

  it('drops http_status: 99 (below range)', () => {
    const { lines, log } = makeLog();
    log.info('scoring_trigger', { http_status: 99 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('http_status');
  });

  it('drops http_status: 600 (above range)', () => {
    const { lines, log } = makeLog();
    log.info('scoring_trigger', { http_status: 600 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('http_status');
  });

  it('drops duration_sec: -1 (negative)', () => {
    const { lines, log } = makeLog();
    log.info('session_complete', { duration_sec: -1 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('duration_sec');
  });

  it('drops duration_sec: 1e6+1 (exceeds cap)', () => {
    const { lines, log } = makeLog();
    log.info('session_complete', { duration_sec: 1_000_001 });
    expect(JSON.parse(lines[0])).not.toHaveProperty('duration_sec');
  });

  it('allows valid port 8787', () => {
    const { lines, log } = makeLog();
    log.info('startup_listen', { port: 8787 });
    expect(JSON.parse(lines[0]).port).toBe(8787);
  });

  it('allows valid http_status 202', () => {
    const { lines, log } = makeLog();
    log.info('scoring_trigger', { http_status: 202 });
    expect(JSON.parse(lines[0]).http_status).toBe(202);
  });

  it('allows turn_index: 0', () => {
    const { lines, log } = makeLog();
    log.info('db_turn_saved', { speaker: 'bot', turn_index: 0 });
    expect(JSON.parse(lines[0]).turn_index).toBe(0);
  });

  it('allows duration_sec: 0', () => {
    const { lines, log } = makeLog();
    log.info('session_complete', { duration_sec: 0 });
    expect(JSON.parse(lines[0]).duration_sec).toBe(0);
  });

  it('allows duration_sec: 86400 (1 day)', () => {
    const { lines, log } = makeLog();
    log.info('session_complete', { duration_sec: 86400 });
    expect(JSON.parse(lines[0]).duration_sec).toBe(86400);
  });
});

// ── Control-character sanitisation ─────────────────────────────────────

describe('OBS-01 Control chars and newlines in allowlisted fields', () => {
  it('drops field with control chars entirely', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });
    log.warn('csp_violation', {
      shape: 'legacy',
      violated_directive: 'script-src\x00\x1finjected_payload',
    });

    const line = lines[0];
    expect(line).not.toContain('\x00');
    expect(line).not.toContain('\x1f');
    expect(line).not.toContain('injected_payload');
    // Control chars cause the entire field to be dropped
    expect(JSON.parse(line)).not.toHaveProperty('violated_directive');
  });

  it('drops field with newline entirely', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });
    log.warn('csp_violation', {
      shape: 'legacy',
      violated_directive: 'script-src\n{"fake_log":true}',
    });

    const line = lines[0];
    expect(line).not.toContain('fake_log');
    expect(JSON.parse(line)).not.toHaveProperty('violated_directive');
  });

  it('drops field with carriage-return entirely', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });
    log.warn('csp_violation', {
      shape: 'legacy',
      violated_directive: 'script-src\r\ninjected',
    });
    const line = lines[0];
    expect(line).not.toContain('\r');
    expect(line).not.toContain('injected');
    expect(JSON.parse(line)).not.toHaveProperty('violated_directive');
  });

  it('silently drops non-scalar value placed in an allowlisted key', () => {
    const lines: string[] = [];
    const log = createLogger('test', {
      writer: (l) => lines.push(l),
      correlationIdGetter: () => null,
    });
    log.info('error_unhandled', {
      error_category: { nested: 'secret' } as unknown as string,
    });
    const parsed = JSON.parse(lines[0]);
    expect(typeof parsed.error_category === 'object').toBe(false);
    expect(parsed).not.toHaveProperty('error_category');
  });
});

// ── ORIGIN validation ──────────────────────────────────────────

describe('OBS-01 Origin field validation (document_origin, blocked_origin)', () => {
  function makeLog() {
    const lines: string[] = [];
    const log = createLogger('test', { writer: (l) => lines.push(l), correlationIdGetter: () => null });
    return { lines, log };
  }

  const INVALID_ORIGINS = [
    { label: 'with userinfo',        value: 'https://user:pass@example.com' },
    { label: 'with path',            value: 'https://example.com/path' },
    { label: 'with query',           value: 'https://example.com?key=val' },
    { label: 'with fragment',        value: 'https://example.com#section' },
    { label: 'ftp scheme',           value: 'ftp://example.com' },
    { label: 'no scheme',            value: 'example.com' },
    { label: 'with credentials+path', value: 'https://user@example.com/path' },
  ];

  for (const { label, value } of INVALID_ORIGINS) {
    it(`rejects origin "${label}"`, () => {
      const { lines, log } = makeLog();
      log.warn('csp_violation', { shape: 'legacy', document_origin: value as never });
      expect(JSON.parse(lines[0])).not.toHaveProperty('document_origin');
    });
  }

  const VALID_ORIGINS = [
    { label: 'simple HTTPS',  value: 'https://example.com' },
    { label: 'with port',     value: 'https://example.com:8443' },
    { label: 'HTTP',          value: 'http://localhost:5173' },
    { label: 'subdomain',     value: 'https://api.example.com' },
    { label: 'localhost',     value: 'http://localhost' },
  ];

  for (const { label, value } of VALID_ORIGINS) {
    it(`allows origin "${label}"`, () => {
      const { lines, log } = makeLog();
      log.warn('csp_violation', { shape: 'legacy', document_origin: value });
      expect(JSON.parse(lines[0]).document_origin).toBe(value);
    });
  }
});

// ===================================================================
//  finalErrorHandler — err.name MAPPING
// ===================================================================

describe('OBS-01 finalErrorHandler — err.name mapping', () => {
  function callHandler(err: unknown) {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
      if (typeof line === 'string') lines.push(line);
    });
    const req = {} as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    finalErrorHandler(err, req, res, vi.fn() as unknown as NextFunction);
    spy.mockRestore();
    return lines;
  }

  it('logs TypeError correctly', () => {
    const lines = callHandler(new TypeError('secret message'));
    expect(JSON.parse(lines[0]).error_category).toBe('TypeError');
    expect(lines[0]).not.toContain('secret message');
  });

  it('maps attacker-controlled err.name to UnknownError', () => {
    class AttackerError extends Error {
      name = 'Bearer eyJhbGciOiJIUzI1NiJ9.payload';
    }
    const lines = callHandler(new AttackerError('trap'));
    expect(JSON.parse(lines[0]).error_category).toBe('UnknownError');
    expect(lines[0]).not.toContain('eyJ');
    expect(lines[0]).not.toContain('payload');
  });

  it('maps unknown subclass name to UnknownError', () => {
    class DatabaseError extends Error { name = 'DatabaseError'; }
    const lines = callHandler(new DatabaseError());
    expect(JSON.parse(lines[0]).error_category).toBe('UnknownError');
  });

  it('handles non-Error thrown values with UnknownError category', () => {
    const lines = callHandler('string_thrown');
    expect(JSON.parse(lines[0]).error_category).toBe('UnknownError');
  });

  it('emits structured JSON with error_category but not the exception message', () => {
    const lines = callHandler(new TypeError('cannot read properties of null (reading "secret")'));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe('error_unhandled');
    expect(parsed.error_category).toBe('TypeError');
    expect(lines[0]).not.toContain('cannot read properties');
    expect(lines[0]).not.toContain('secret');
    expect(lines[0]).not.toContain(' at ');
    expect(lines[0].split('\n')).toHaveLength(1);
  });
});

// ===================================================================
//  CORRELATION MIDDLEWARE — ID VALIDATION
// ===================================================================

describe('OBS-02 Correlation ID validation', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => { app = createApp(); });

  it('accepts a valid UUID v4 and echoes it in the response header', async () => {
    const supplied = '550e8400-e29b-41d4-a716-446655440000';
    const res = await request(app)
      .get('/api/health')
      .set('X-Correlation-ID', supplied);
    expect(res.headers['x-correlation-id']).toBe(supplied.toLowerCase());
  });

  it('normalises supplied UUID to lowercase', async () => {
    const supplied = '550E8400-E29B-41D4-A716-446655440000';
    const res = await request(app)
      .get('/api/health')
      .set('X-Correlation-ID', supplied);
    expect(res.headers['x-correlation-id']).toBe(supplied.toLowerCase());
  });

  it('generates a fresh UUID v4 when header is absent', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('rejects and replaces a non-UUID string', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Correlation-ID', 'not-a-uuid');
    const returned = res.headers['x-correlation-id'];
    expect(returned).toMatch(UUID_V4_RE);
    expect(returned).not.toContain('not-a-uuid');
  });

  it('rejects and replaces an oversized value (>128 chars)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Correlation-ID', 'a'.repeat(200));
    const returned = res.headers['x-correlation-id'] as string;
    expect(returned).toMatch(UUID_V4_RE);
    expect(returned.length).toBeLessThan(50);
  });

  it('rejects a value containing a NUL byte (unit-level)', () => {
    expect(validateIncomingId('abc\x00def')).toBeNull();
    expect(validateIncomingId('550e8400-e29b-41d4-a716-\x1f00000000')).toBeNull();
  });

  it('rejects and replaces a comma-joined (duplicate-header simulated) value', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('X-Correlation-ID',
        '550e8400-e29b-41d4-a716-446655440000, bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const returned = res.headers['x-correlation-id'] as string;
    expect(returned).toMatch(UUID_V4_RE);
    expect(returned).not.toContain('550e8400');
    expect(returned).not.toContain('bbbbbbbb');
  });

  it('rejects a UUID v1 (wrong version digit)', async () => {
    const v1id = '550e8400-e29b-11d4-a716-446655440000';
    const res = await request(app)
      .get('/api/health')
      .set('X-Correlation-ID', v1id);
    const returned = res.headers['x-correlation-id'];
    expect(returned).toMatch(UUID_V4_RE);
    expect(returned).not.toBe(v1id.toLowerCase());
  });

  it('rejects Node.js-joined duplicate header via middleware mock', () => {
    const nodeJoined =
      '550e8400-e29b-41d4-a716-446655440000, bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    let responseHeader: string | undefined;
    const mockReq = {
      headers: { 'x-correlation-id': nodeJoined },
    } as unknown as Request;
    const mockRes = {
      setHeader: vi.fn((_name: string, value: string) => { responseHeader = value; }),
    } as unknown as Response;
    const mockNext = vi.fn();

    correlationMiddleware(mockReq, mockRes, mockNext as unknown as NextFunction);

    expect(mockNext).toHaveBeenCalledOnce();
    expect(responseHeader).toMatch(UUID_V4_RE);
    expect(responseHeader).not.toContain('550e8400');
    expect(responseHeader).not.toContain('bbbbbbbb');
  });
});

// ===================================================================
//  TRUE DUPLICATE HTTP HEADER TEST (Finding 7)
// ===================================================================

describe('OBS-02 TRUE duplicate HTTP header via raw Node HTTP loopback', () => {
  it('two identical X-Correlation-ID headers generate fresh UUID', async () => {
    // Start a minimal HTTP server on loopback that uses our middleware.
    const express = (await import('express')).default;
    const { correlationMiddleware, getCorrelationId } = await import('../lib/correlation.js');

    const app = express();
    app.use(correlationMiddleware);
    app.get('/test', (_req, res) => {
      res.json({ cid: getCorrelationId(), header: _req.headers['x-correlation-id'] });
    });

    // Use raw Node HTTP to send TWO copies of X-Correlation-ID header.
    // Node's http module (and most clients) normalizes to one value with
    // joined commas.  But we send via rawHeaders to simulate a true
    // duplicate-header scenario.
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as import('net').AddressInfo;

    try {
      const body = await new Promise<string>((resolve, reject) => {
        // Craft raw HTTP request with duplicate X-Correlation-ID headers
        const rawReq = [
          'GET /test HTTP/1.1',
          'Host: 127.0.0.1:' + addr.port,
          'X-Correlation-ID: 550e8400-e29b-41d4-a716-446655440000',
          'X-Correlation-ID: bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          'Connection: close',
          '',
          '',
        ].join('\r\n');

        const socket = require('node:net').createConnection(
          { host: '127.0.0.1', port: addr.port },
          () => {
            socket.write(rawReq);
          },
        );

        let data = '';
        socket.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });

      // Parse the response to get the body
      const bodyMatch = body.match(/\r\n\r\n(.*)/s);
      const responseBody = bodyMatch ? bodyMatch[1] : '';
      // The response might have chunked encoding or content-length
      const responseHeaders = body.split('\r\n\r\n')[0];

      // The response should have a fresh X-Correlation-ID (not the supplied ones)
      // because the duplicate headers got joined by Node with ', '
      const responseCidMatch = responseHeaders.match(/x-correlation-id:\s*([^\r\n]+)/i);
      expect(responseCidMatch).not.toBeNull();
      const responseCid = responseCidMatch![1].trim();
      expect(responseCid).toMatch(UUID_V4_RE);
      expect(responseCid).not.toContain('550e8400');
      expect(responseCid).not.toContain('bbbbbbbb');
    } finally {
      // Await raw socket/server close on duplicate-test failure paths
      // with a deterministic 2-second timeout.
      const serverClosed = new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      await Promise.race([
        serverClosed,
        new Promise((_, reject) => setTimeout(() => reject(new Error('server.close timed out')), 2000)),
      ]);
    }
  });
});

// ===================================================================
//  CORRELATION MIDDLEWARE — RESPONSE HEADER COVERAGE
// ===================================================================

describe('OBS-02 X-Correlation-ID on all response paths', () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => { app = createApp(); });

  it('200 health response carries X-Correlation-ID', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('CORS-blocked response carries X-Correlation-ID', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('OPTIONS preflight from allowed origin carries X-Correlation-ID', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.status).toBe(204);
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('OPTIONS preflight from disallowed origin carries X-Correlation-ID', async () => {
    const res = await request(app)
      .options('/api/health')
      .set('Origin', 'https://evil.example.com')
      .set('Access-Control-Request-Method', 'GET');
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('400 malformed JSON carries X-Correlation-ID', async () => {
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send('not-valid-json');
    expect(res.status).toBe(400);
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('413 oversized CSP report carries X-Correlation-ID', async () => {
    const big = { 'csp-report': { 'document-uri': 'x'.repeat(70_000) } };
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .send(big);
    expect(res.status).toBe(413);
    expect(res.headers['x-correlation-id']).toMatch(UUID_V4_RE);
  });

  it('propagates supplied UUID end-to-end through a 400 error response', async () => {
    const supplied = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const res = await request(app)
      .post('/api/csp-report')
      .set('Content-Type', 'application/json')
      .set('X-Correlation-ID', supplied)
      .send('bad json');
    expect(res.status).toBe(400);
    expect(res.headers['x-correlation-id']).toBe(supplied);
  });
});

// ===================================================================
//  CORRELATION PROPAGATION — CORRELATION ID PRESENT IN ROUTE
// ===================================================================

describe('OBS-02 getCorrelationId() in route context', () => {
  it('returns a valid UUID v4 within a correlationMiddleware-wrapped route', async () => {
    const express = (await import('express')).default;
    const { correlationMiddleware, getCorrelationId } = await import('../lib/correlation.js');
    const miniApp = express();
    miniApp.use(correlationMiddleware);
    miniApp.get('/test-route', (_req, res) => {
      res.json({ cid: getCorrelationId() });
    });
    const res = await request(miniApp).get('/test-route');
    expect(res.status).toBe(200);
    expect(res.body.cid).toMatch(UUID_V4_RE);
    expect(res.headers['x-correlation-id']).toBe(res.body.cid);
  });

  it('supplied correlation ID from header is available via getCorrelationId in route', async () => {
    const express = (await import('express')).default;
    const { correlationMiddleware, getCorrelationId } = await import('../lib/correlation.js');
    const miniApp = express();
    miniApp.use(correlationMiddleware);
    miniApp.get('/test-route', (_req, res) => {
      res.json({ cid: getCorrelationId() });
    });
    const supplied = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
    const res = await request(miniApp)
      .get('/test-route')
      .set('X-Correlation-ID', supplied);
    expect(res.body.cid).toBe(supplied);
    expect(res.headers['x-correlation-id']).toBe(supplied);
  });
});

// ===================================================================
//  CONCURRENT REQUEST ISOLATION
// ===================================================================

describe('OBS-02 Concurrent request context isolation', () => {
  it('assigns unique IDs to concurrent requests with no header supplied', async () => {
    const app = createApp();
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/api/health'),
      request(app).get('/api/health'),
      request(app).get('/api/health'),
    ]);
    const ids = [r1, r2, r3].map((r) => r.headers['x-correlation-id'] as string);
    for (const id of ids) {
      expect(id).toMatch(UUID_V4_RE);
    }
    expect(new Set(ids).size).toBe(3);
  });

  it('returns each caller its own supplied UUID under concurrency', async () => {
    const app = createApp();
    const idA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const idB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const idC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const [r1, r2, r3] = await Promise.all([
      request(app).get('/api/health').set('X-Correlation-ID', idA),
      request(app).get('/api/health').set('X-Correlation-ID', idB),
      request(app).get('/api/health').set('X-Correlation-ID', idC),
    ]);
    expect(r1.headers['x-correlation-id']).toBe(idA);
    expect(r2.headers['x-correlation-id']).toBe(idB);
    expect(r3.headers['x-correlation-id']).toBe(idC);
  });
});
