#!/usr/bin/env node

/**
 * netguard.mjs — the zero-PSTN negative control.
 *
 * "This canary places no calls" is a claim. This file is the evidence, and it
 * has three independent legs because any one of them alone is weak:
 *
 *   1. STRUCTURAL — the telephony SDK is not resolvable from this directory
 *      at all. `scripts/` has no `node_modules`; `livekit-server-sdk` lives
 *      under `app/api/node_modules`. A canary that wanted to dial would have
 *      to add a dependency, which is a diff a reviewer sees.
 *   2. STATIC — no file in `scripts/phone-canary/` imports a network module.
 *      `db.mjs` is the single exception and may import `node:child_process`
 *      only, and is separately pinned to a LOCAL Postgres target.
 *   3. RUNTIME — every egress primitive Node offers is replaced by a trap
 *      that counts and throws. The measured window ends with zero.
 *
 * ── WHY THERE IS A POSITIVE CONTROL ───────────────────────────────────
 * A counter that reads zero and a counter that is broken are the same
 * observation. Leg 3's zero is therefore worthless on its own, and this lane
 * has already shipped one vacuous control (a touch-target test that exempted
 * exactly the controls it protected) and one green mutation that turned out
 * to be a mis-applied mutation.
 *
 * So `runPositiveControl()` DELIBERATELY trips every trap after the measured
 * window closes, and the manifest refuses to validate unless it fired. A
 * disarmed trap now fails the run instead of certifying it.
 */

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';

export class NetworkAttempted extends Error {
  constructor(primitive) {
    super(`phone-canary refuses network egress: ${primitive}`);
    this.name = 'NetworkAttempted';
    this.primitive = primitive;
  }
}

/** Everything Node can reach the outside world with, from a plain script. */
export const GUARDED_PRIMITIVES = Object.freeze([
  'fetch', 'http.request', 'http.get', 'https.request', 'https.get',
  'net.connect', 'net.createConnection', 'tls.connect',
  'dns.lookup', 'dns.resolve', 'dgram.createSocket',
]);

export function createNetGuard() {
  /** Counts during the MEASURED window. Must end at zero. */
  let measured = 0;
  /** Counts during the CONTROL window. Must end at GUARDED_PRIMITIVES.length. */
  let control = 0;
  let window = 'measured';
  const hit = [];
  const restore = [];

  const trap = (primitive) => (...args) => {
    void args;
    if (window === 'measured') measured += 1; else control += 1;
    hit.push(primitive);
    throw new NetworkAttempted(primitive);
  };

  const swap = (holder, key, primitive) => {
    const original = holder[key];
    // A primitive that does not exist on this Node cannot be trapped, and
    // pretending otherwise would inflate the positive control's expected
    // count and make a genuinely missing trap look satisfied.
    if (typeof original !== 'function') return false;
    holder[key] = trap(primitive);
    restore.push(() => { holder[key] = original; });
    return true;
  };

  const armed = [];
  const arm = (holder, key, primitive) => { if (swap(holder, key, primitive)) armed.push(primitive); };

  arm(globalThis, 'fetch', 'fetch');
  arm(http, 'request', 'http.request');
  arm(http, 'get', 'http.get');
  arm(https, 'request', 'https.request');
  arm(https, 'get', 'https.get');
  arm(net, 'connect', 'net.connect');
  arm(net, 'createConnection', 'net.createConnection');
  arm(tls, 'connect', 'tls.connect');
  arm(dns, 'lookup', 'dns.lookup');
  arm(dns, 'resolve', 'dns.resolve');
  arm(dgram, 'createSocket', 'dgram.createSocket');

  return {
    armed: Object.freeze([...armed]),
    /** Invocations during the measured window. The number that must be 0. */
    measuredCalls: () => measured,
    /** Invocations during the control window. */
    controlCalls: () => control,
    hits: () => Object.freeze([...hit]),

    /**
     * Close the measured window and prove every armed trap fires. Returns
     * `'fired'` only when ALL of them did — a partial control is not a
     * control, because the one that stayed silent is the one that would have
     * let a call through.
     */
    runPositiveControl() {
      window = 'control';
      const before = control;
      const fired = new Set();
      const probe = (primitive, fn) => {
        try { fn(); } catch (error) {
          if (error instanceof NetworkAttempted && error.primitive === primitive) {
            fired.add(primitive);
          }
        }
      };
      probe('fetch', () => globalThis.fetch('http://127.0.0.1:1/'));
      probe('http.request', () => http.request('http://127.0.0.1:1/'));
      probe('http.get', () => http.get('http://127.0.0.1:1/'));
      probe('https.request', () => https.request('https://127.0.0.1:1/'));
      probe('https.get', () => https.get('https://127.0.0.1:1/'));
      probe('net.connect', () => net.connect(1, '127.0.0.1'));
      probe('net.createConnection', () => net.createConnection(1, '127.0.0.1'));
      probe('tls.connect', () => tls.connect(1, '127.0.0.1'));
      probe('dns.lookup', () => dns.lookup('localhost', () => {}));
      probe('dns.resolve', () => dns.resolve('localhost', () => {}));
      probe('dgram.createSocket', () => dgram.createSocket('udp4'));

      const missing = armed.filter((p) => !fired.has(p));
      const counted = control - before;
      // Both must agree: every armed primitive threw its OWN error, and the
      // counter moved once per probe. A trap that threw the wrong error, or
      // one that threw without counting, is a broken trap.
      return missing.length === 0 && counted === armed.length ? 'fired' : 'not_fired';
    },

    dispose() { for (const undo of restore.reverse()) undo(); },
  };
}

/**
 * Structural leg 1: is the telephony SDK reachable from here at all?
 *
 * Returns `true` if it resolves — which must fail the run. Resolution is
 * attempted, never import; importing a telephony SDK to prove we do not use
 * one would be its own answer to the question.
 */
export async function sdkImportable(specifier = 'livekit-server-sdk') {
  try {
    await import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
