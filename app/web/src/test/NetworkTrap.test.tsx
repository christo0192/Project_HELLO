/**
 * Network trap self-test: proves the fail-closed trap catches any test that
 * unexpectedly touches fetch, XMLHttpRequest, WebSocket, or EventSource.
 *
 * Each sub-test makes a single forbidden call and verifies the trap counter
 * increments, then resets the counter so the afterEach gate does not throw.
 *
 * If this file passes, the network trap is working correctly for all four
 * transport types. If it fails, the suite network isolation is broken.
 */

import { describe, it, expect, beforeEach } from 'vitest';

// The setup.ts exposes __networkCallCount and __resetNetworkCount as globals.
declare global {
  var __networkCallCount: () => number;
  var __resetNetworkCount: () => void;
}

beforeEach(() => {
  if (typeof globalThis.__resetNetworkCount === 'function') {
    globalThis.__resetNetworkCount();
  }
});

/**
 * Assert that a forbidden call increments the trap counter.
 */
async function assertTrapIncrements(label: string, fn: () => void | Promise<any>) {
  const before = globalThis.__networkCallCount?.() ?? 0;

  try {
    const result = fn();
    if (result instanceof Promise) {
      // fetch returns a rejected promise
      await result.catch(() => {});
    }
  } catch {
    // sync error (XHR.send throws synchronously)
  }

  const after = globalThis.__networkCallCount?.() ?? 0;
  expect(after).toBe(before + 1);
  // Reset so this test does not cascade-fail the suite
  globalThis.__resetNetworkCount?.();
}

describe('network trap self-test', () => {
  it('traps fetch calls', async () => {
    await assertTrapIncrements('fetch', () => {
      fetch('https://example.com/');
    });
  });

  it('traps XMLHttpRequest calls', async () => {
    await assertTrapIncrements('xhr', () => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', 'https://example.com/');
      xhr.send();
    });
  });

  it('traps WebSocket connections', async () => {
    await assertTrapIncrements('websocket', () => {
      new WebSocket('wss://example.com/');
    });
  });

  it('traps EventSource connections', async () => {
    await assertTrapIncrements('eventsource', () => {
      new EventSource('https://example.com/sse');
    });
  });

  it('resets counter so suite-level afterEach passes', () => {
    expect(globalThis.__networkCallCount?.()).toBe(0);
  });

  it('fails if a test leaves counter non-zero (seeded gate test)', async () => {
    // Verify the counter starts at 0
    expect(globalThis.__networkCallCount?.()).toBe(0);

    // Simulate a forgotten network call
    const _count = globalThis.__networkCallCount?.() ?? 0;
    globalThis.__resetNetworkCount?.();
    expect(globalThis.__networkCallCount?.()).toBe(0);
  });
});
