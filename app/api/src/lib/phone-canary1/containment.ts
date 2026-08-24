/**
 * lib/phone-canary1/containment.ts — the layer that makes it impossible for a
 * provider error to print the number.
 *
 * ── THE FACT THIS FILE EXISTS FOR ─────────────────────────────────────
 * `dial.ts` catches the originate failure and DISCARDS the error object, with
 * the reason written next to it: *a provider message may quote the dialled
 * number.* That is the production dialer's control, and Canary-1 does not
 * inherit it, because the CLI bypasses `dialPhoneAttempt` and calls the seam
 * directly. So the rule is restated here as a module house rule with a
 * mechanism behind it.
 *
 * Two independent layers, because either alone is a single point of failure:
 *
 *   1. `discardingErrors` — every seam call goes through it. It catches, drops
 *      the error object entirely, and returns a stable code. Nothing is
 *      logged, nothing is rethrown, and the error never becomes a value a
 *      caller could accidentally interpolate.
 *   2. `installCanary1Containment` — process-level `uncaughtException` and
 *      `unhandledRejection` handlers that print a BARE code, run teardown, and
 *      exit non-zero. Without these, an error escaping any path Node considers
 *      top-level reaches stderr as a formatted stack trace with the provider's
 *      message in it — the exact leak layer 1 exists to prevent, arriving by
 *      the one route layer 1 cannot cover.
 *
 * ── ORDERING IS LOAD-BEARING ──────────────────────────────────────────
 * The handlers are installed by the entry script as its FIRST statements,
 * ahead of the destination being read. The prompt module is reached through a
 * dynamic `await import(...)` after installation, because in ESM every static
 * import is evaluated before any statement in the importing module's body — so
 * "installed before the prompt module is imported" is not achievable with a
 * static import, and asserting it would assert something no program can do.
 * What must hold, and what is asserted, is that the handlers precede the TTY
 * being read.
 *
 * ── AND TEARDOWN IS INSIDE THE CONTAINMENT ────────────────────────────
 * The teardown callback runs inside the handler's own try/catch. A failing
 * room delete during an uncaught-exception unwind must not become a second,
 * uncontained stack trace.
 *
 * No I/O of its own, no logger, no SDK.
 */

/**
 * Environment keys that make an SDK, or Node itself, more talkative. The SIP
 * client is constructed against an environment with these removed, because a
 * verbose provider client is a provider message on stderr, and the whole point
 * of layer 1 is that no provider message reaches a terminal.
 */
export const CANARY1_VERBOSITY_ENV_KEYS = [
  'DEBUG',
  'LIVEKIT_LOG_LEVEL',
  'LOG_LEVEL',
  'NODE_DEBUG',
] as const;

/** The stable codes the containment layer may emit. Never a message. */
export const CANARY1_CONTAINMENT_CODES = [
  'uncaught_exception',
  'unhandled_rejection',
  'seam_failed',
  'teardown_failed_in_containment',
] as const;

export type Canary1ContainmentCode = (typeof CANARY1_CONTAINMENT_CODES)[number];

/**
 * A copy of `source` with every verbosity key removed. Pure; mutates nothing.
 *
 * Useful for asserting the key set, and for any caller that wants a scrubbed
 * VALUE. It is deliberately NOT the control — see `scrubVerbosity`.
 */
export function quietEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...source };
  for (const key of CANARY1_VERBOSITY_ENV_KEYS) delete copy[key];
  return copy;
}

/**
 * THE CONTROL: delete every verbosity key from the map the SDK will actually
 * read, IN PLACE. Returns the keys that were removed, so the caller can say so.
 *
 * ── WHY IN PLACE, WHEN A COPY WOULD BE TIDIER ─────────────────────────
 * Because a copy does nothing. `livekit-server-sdk` and Node's own `NODE_DEBUG`
 * machinery read `process.env` directly; handing a scrubbed clone to a
 * constructor that never looks at it is a control that reads like a guarantee
 * and is not one — the class this lane keeps deleting. The mechanism must
 * mutate the map the reader reads, or not claim the property.
 *
 * The usual objection — "this process does not own the ambient environment" —
 * does not apply here. This is a single-purpose, single-shot, short-lived CLI
 * that the operator invoked for exactly one call; it does not spawn anything
 * (there is no `node:child_process` anywhere in the closure, asserted), so the
 * only reader of this map is this process. Nothing else in the operator's
 * shell is affected, because the shell's own environment is a separate copy.
 */
export function scrubVerbosity(env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = [];
  for (const key of CANARY1_VERBOSITY_ENV_KEYS) {
    if (env[key] !== undefined) {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

/**
 * Run `fn`, and on ANY failure return `undefined` having discarded the error.
 *
 * The error object is never bound to anything that outlives the catch, never
 * passed to a callback, and never inspected — not even for its `name`. A
 * caller that wants to know whether the seam failed reads `undefined`; a
 * caller that wants to say so emits a stable code of its own.
 */
export async function discardingErrors<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** The narrow slice of `process` the containment layer touches. */
export interface Canary1ProcessLike {
  on(event: 'uncaughtException' | 'unhandledRejection', handler: () => void): unknown;
  exitCode?: number | undefined;
}

export interface Canary1ContainmentDeps {
  /** Emits a grammar-legal verdict line. Never receives an error object. */
  readonly emit: (code: Canary1ContainmentCode) => void;
  /** Best-effort teardown. Its own failures are contained here. */
  readonly teardown: () => Promise<void>;
  /** Ends the process. Injected so a test can observe it without dying. */
  readonly exit: (code: number) => void;
  /** Injected so a test can install handlers without touching the real process. */
  readonly proc?: Canary1ProcessLike;
}

/**
 * Install the two process-level handlers.
 *
 * NOTE the handler signatures: they take NO parameter. The error Node would
 * hand them is not merely ignored — it is not bound at all, so there is no
 * identifier a later edit can reach for. A handler that accepted `err` and
 * declined to print it would be one careless line away from printing it.
 */
export function installCanary1Containment(deps: Canary1ContainmentDeps): void {
  const proc = deps.proc ?? (process as unknown as Canary1ProcessLike);

  const contain = (code: Canary1ContainmentCode): void => {
    try {
      deps.emit(code);
    } catch {
      // An emitter that throws must not become the stack trace this handler
      // exists to prevent.
    }
    void (async (): Promise<void> => {
      try {
        await deps.teardown();
      } catch {
        try {
          deps.emit('teardown_failed_in_containment');
        } catch {
          // Nothing further is safe to attempt.
        }
      } finally {
        deps.exit(1);
      }
    })();
  };

  proc.on('uncaughtException', () => contain('uncaught_exception'));
  proc.on('unhandledRejection', () => contain('unhandled_rejection'));
}
