/**
 * Test setup for accessibility-focused vitest + jsdom + RTL + axe-core.
 *
 * - Registers a custom `toHaveNoViolations` matcher that fails on EVERY axe
 *   violation (minor, moderate, serious, critical) for the enabled rule set.
 *   Only rules that are impossible in jsdom (colour computation, layout/paint)
 *   are disabled. Incomplete checks are reported in test output.
 * - Traps all network boundaries (fetch, XMLHttpRequest, WebSocket,
 *   EventSource) with fail-closed counters. Every test that makes an
 *   un-mocked call fails before it can assert.
 * - Registers a console.error/warn spy that fails tests on unexpected output.
 * - Registers an unhandled rejection handler that fails the suite.
 * - Extends vitest with jest-dom DOM matchers.
 *
 * Seeded violation self-test: see ./SeededViolation.tsx — if axe is disabled
 * or unresolved, that test will fail the suite.
 */

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import axe from 'axe-core';
import { expect, afterEach, beforeEach, vi } from 'vitest';

// ── Global cleanup after each test ─────────────────────────────────────
afterEach(() => {
  cleanup();
});

// ═══════════════════════════════════════════════════════════════════════
// FAIL-CLOSED NETWORK TRAP
// ═══════════════════════════════════════════════════════════════════════
//
// Every network origin (fetch, XMLHttpRequest, WebSocket, EventSource) is
// replaced with a spy/trap that increments a counter. afterEach asserts
// the counter is zero — any test that reaches the network fails.
//
// The trap must be fail-closed (every call counts, no silent pass) and
// restore exact originals so isolation works.

const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
const originalWebSocket = globalThis.WebSocket;
const originalEventSource = globalThis.EventSource;

let _networkCallCount = 0;

function makeNetworkError(name: string): Error {
  return new Error(
    `NETWORK TRAP [${name}]: Tests must not make real ${name} calls. ` +
    'Mock external data boundaries instead.',
  );
}

beforeEach(() => {
  _networkCallCount = 0;

  // ── fetch trap ────────────────────────────────────────────────
  globalThis.fetch = vi.fn().mockImplementation(() => {
    _networkCallCount++;
    return Promise.reject(makeNetworkError('fetch'));
  }) as unknown as typeof globalThis.fetch;

  // ── XMLHttpRequest trap ───────────────────────────────────────
  // ── XHR trap via function constructor (avoids strict structural
  //    compatibility issues with the full XMLHttpRequest interface) ──
  function TrapXHR(this: any) {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '';
    this.response = null;
    this.responseType = '';
    this.responseURL = '';
    this.responseXML = null;
    this.statusText = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.upload = null!;
    this.onreadystatechange = null;
    this.onerror = null;
    this.onload = null;
    this.ontimeout = null;
  }
  TrapXHR.prototype.open = function () { /* no-op */ };
  TrapXHR.prototype.send = function () {
    _networkCallCount++;
    const err = makeNetworkError('XMLHttpRequest');
    setTimeout(function (this: any) {
      if (this.onerror) this.onerror.call(this, new Event('error'));
    }.bind(this), 0);
    throw err;
  };
  TrapXHR.prototype.setRequestHeader = function () { /* no-op */ };
  TrapXHR.prototype.abort = function () { /* no-op */ };
  TrapXHR.prototype.getAllResponseHeaders = function () { return ''; };
  TrapXHR.prototype.getResponseHeader = function () { return null; };
  TrapXHR.prototype.overrideMimeType = function () { /* no-op */ };
  TrapXHR.prototype.addEventListener = function () { /* no-op */ };
  TrapXHR.prototype.removeEventListener = function () { /* no-op */ };
  TrapXHR.prototype.dispatchEvent = function () { return false; };
  // Static XMLHttpRequest constants
  TrapXHR.UNSENT = 0;
  TrapXHR.OPENED = 1;
  TrapXHR.HEADERS_RECEIVED = 2;
  TrapXHR.LOADING = 3;
  TrapXHR.DONE = 4;
  // Assign as constructor
  globalThis.XMLHttpRequest = TrapXHR as unknown as typeof globalThis.XMLHttpRequest;

  // ── WebSocket trap ────────────────────────────────────────────
  // ── WebSocket trap via function constructor ──
  function TrapWebSocket(this: any, url: string) {
    this.url = url;
    this.readyState = 3;
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSING = 2;
    this.CLOSED = 3;
    this.binaryType = 'blob';
    this.bufferedAmount = 0;
    this.extensions = '';
    this.protocol = '';
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
    _networkCallCount++;
    setTimeout(function (this: any) {
      if (this.onerror) this.onerror.call(this, new Event('error'));
      if (this.onclose) this.onclose.call(this, new CloseEvent('close', { code: 1006, reason: 'Trap' }));
    }.bind(this), 0);
  }
  TrapWebSocket.prototype.close = function () { /* no-op */ };
  TrapWebSocket.prototype.send = function () { /* no-op */ };
  TrapWebSocket.prototype.addEventListener = function () { /* no-op */ };
  TrapWebSocket.prototype.removeEventListener = function () { /* no-op */ };
  TrapWebSocket.prototype.dispatchEvent = function () { return false; };
  globalThis.WebSocket = TrapWebSocket as unknown as typeof globalThis.WebSocket;

  // ── EventSource trap via function constructor ──
  function TrapEventSource(this: any, url: string) {
    this.url = url;
    this.readyState = 2;
    this.CONNECTING = 0;
    this.OPEN = 1;
    this.CLOSED = 2;
    this.withCredentials = false;
    this.onopen = null;
    this.onerror = null;
    this.onmessage = null;
    _networkCallCount++;
    setTimeout(function (this: any) {
      if (this.onerror) this.onerror.call(this, new Event('error'));
    }.bind(this), 0);
  }
  TrapEventSource.prototype.close = function () { /* no-op */ };
  TrapEventSource.prototype.addEventListener = function () { /* no-op */ };
  TrapEventSource.prototype.removeEventListener = function () { /* no-op */ };
  TrapEventSource.prototype.dispatchEvent = function () { return false; };
  globalThis.EventSource = TrapEventSource as unknown as typeof globalThis.EventSource;
});

// ── Zero-call enforcement ─────────────────────────────────────────────
afterEach(() => {
  // Restore originals so isolation works across suites
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
  globalThis.WebSocket = originalWebSocket;
  globalThis.EventSource = originalEventSource;

  // Fail if any test made a network call
  if (_networkCallCount > 0) {
    const orig = Error.stackTraceLimit;
    Error.stackTraceLimit = 20;
    const err = new Error(
      `NETWORK TRAP: ${_networkCallCount} unexpected network call(s) detected.\n` +
      'Every test must mock its data boundaries. See src/test/setup.ts.',
    );
    Error.stackTraceLimit = orig;
    throw err;
  }
});

// Expose counter for seeded-trap tests to read/reset
(globalThis as any).__networkCallCount = () => _networkCallCount;
(globalThis as any).__resetNetworkCount = () => { _networkCallCount = 0; };

// ═══════════════════════════════════════════════════════════════════════
// CONSOLE ERROR / WARN SPY
// ═══════════════════════════════════════════════════════════════════════
//
// Any test that logs an unexpected console.error or console.warn will fail.
// Tests may register exact expected messages via __allowConsole.

const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
let _allowedConsolePatterns: RegExp[] = [];

(globalThis as any).__allowConsole = (pattern: RegExp) => {
  _allowedConsolePatterns.push(pattern);
};

beforeEach(() => {
  _allowedConsolePatterns = [];

  console.error = vi.fn((...args: any[]) => {
    const msg = args.join(' ');
    // Allow React act() warnings — informational in jsdom
    if (/inside a test was not wrapped in act/.test(msg)) return;
    if (!_allowedConsolePatterns.some((p) => p.test(msg))) {
      throw new Error(
        `UNEXPECTED console.error: ${msg}\n` +
        'Use __allowConsole(/pattern/) to permit expected diagnostics.',
      );
    }
  }) as unknown as typeof console.error;

  console.warn = vi.fn((...args: any[]) => {
    const msg = args.join(' ');
    if (!_allowedConsolePatterns.some((p) => p.test(msg))) {
      throw new Error(
        `UNEXPECTED console.warn: ${msg}\n` +
        'Use __allowConsole(/pattern/) to permit expected diagnostics.',
      );
    }
  }) as unknown as typeof console.warn;
});

afterEach(() => {
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
});

// ═══════════════════════════════════════════════════════════════════════
// UNHANDLED REJECTION TRAP
// ═══════════════════════════════════════════════════════════════════════

beforeEach(() => {
  const handler = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    throw new Error(
      `UNHANDLED REJECTION: ${event.reason?.message ?? event.reason}`,
    );
  };
  globalThis.addEventListener('unhandledrejection', handler);
  // Store handler reference for cleanup
  (globalThis as any).__unhandledRejectionHandler = handler;
});

afterEach(() => {
  const handler = (globalThis as any).__unhandledRejectionHandler;
  if (handler) {
    globalThis.removeEventListener('unhandledrejection', handler);
    delete (globalThis as any).__unhandledRejectionHandler;
  }
});

// ═══════════════════════════════════════════════════════════════════════
// AXE-CORE CUSTOM MATCHER (STRICT — FAIL ON ALL VIOLATIONS)
// ═══════════════════════════════════════════════════════════════════════

export interface AxeViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{
    html: string;
    target: string[];
    failureSummary: string;
  }>;
}

export interface AxeResult {
  violations: AxeViolation[];
  passes: Array<{ id: string }>;
  incomplete: Array<{ id: string }>;
  inapplicable: Array<{ id: string }>;
}

/**
 * Run axe-core against a container HTMLElement.
 *
 * Enabled rule set: WCAG 2.0/2.1 Level A & AA, plus best-practice rules.
 *
 * Rules DISABLED (only those impossible in jsdom, with justification):
 *   - color-contrast: jsdom cannot compute pixel colours or painted styles.
 *     Must be verified in a real browser (manual or Playwright).
 *   - link-in-text-block: requires computed styles that jsdom cannot resolve.
 *   - scrollable-region-focusable: requires layout/paint that jsdom cannot do.
 *
 * NOTE: This means toHaveNoViolations() does NOT check colour contrast.
 * All other WCAG 2.1 A/AA rules ARE enforced.
 */
export async function runAxe(container: HTMLElement): Promise<AxeResult> {
  const results = await axe.run(container as any, {
    runOnly: {
      type: 'tag',
      values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
    },
    rules: {
      'color-contrast': { enabled: false },
      'link-in-text-block': { enabled: false },
      'scrollable-region-focusable': { enabled: false },
    },
  });

  return {
    violations: (results.violations ?? []) as AxeViolation[],
    passes: results.passes ?? [],
    incomplete: results.incomplete ?? [],
    inapplicable: results.inapplicable ?? [],
  };
}

/**
 * Custom vitest matcher: toHaveNoViolations()
 *
 * FAILS ON EVERY VIOLATION (minor, moderate, serious, critical).
 *
 * Only rules disabled are those impossible in jsdom (see runAxe above).
 * Incomplete checks (axe could not determine pass/fail) are reported
 * in the output but do NOT fail the test — they indicate rules that
 * require manual verification.
 *
 * Usage:
 *   await expect(container).toHaveNoViolations();
 */
expect.extend({
  async toHaveNoViolations(received: HTMLElement) {
    const results = await runAxe(received);

    if (results.violations.length === 0) {
      // Report incomplete checks as informational
      const incompleteDetail = results.incomplete.length > 0
        ? `\n  ⚠ ${results.incomplete.length} incomplete check(s) — ` +
          `requires manual verification:\n    ` +
          results.incomplete.map((i) => i.id).join(', ')
        : '';

      return {
        message: () =>
          `Expected no axe violations. Found 0 violations.` +
          incompleteDetail,
        pass: true,
      };
    }

    const detail = results.violations
      .map(
        (v) =>
          `  [${v.impact}] ${v.id}: ${v.help}\n` +
          `    ${v.helpUrl}\n` +
          v.nodes
            .slice(0, 3) // limit node output
            .map(
              (n) =>
                `    → ${n.html}\n` +
                `      target: ${n.target.join(', ')}\n` +
                (n.failureSummary ? `      ${n.failureSummary}` : ''),
            )
            .join('\n'),
      )
      .join('\n');

    const summary =
      results.violations.length === 1
        ? '1 axe violation:'
        : `${results.violations.length} axe violations:`;

    const incompleteNote = results.incomplete.length > 0
      ? `\n  ⚠ ${results.incomplete.length} incomplete check(s) also present ` +
        `(requires manual verification)`
      : '';

    return {
      message: () =>
        `Found ${summary}\n${detail}${incompleteNote}`,
      pass: false,
    };
  },
});

// ── Type augmentation ───────────────────────────────────────────────────
declare module 'vitest' {
  interface Assertion<T = any> {
    toHaveNoViolations(): Promise<void>;
  }
  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): Promise<void>;
  }
}
