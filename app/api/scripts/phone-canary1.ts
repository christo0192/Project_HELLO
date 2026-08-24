#!/usr/bin/env tsx
/**
 * scripts/phone-canary1.ts — the Canary-1 operator entry point.
 *
 * ── THIS FILE IS INSIDE THE STRUCTURAL CLOSURE ────────────────────────
 * `config/environment.schema.json` declares the api component's `sourceRoots`
 * as `["app/api/src"]`, so `app/api/scripts/` is scanned by neither the
 * environment contract nor any directory-walking structural test. It is a
 * genuinely unwatched directory. An earlier revision of this design put the
 * closure assertion on `lib/phone-canary1/**` and left the entry script
 * outside it — which is where a `console.error(err)` would have lived.
 *
 * So `phone-canary1-structural.test.ts` names this file EXPLICITLY, with its
 * own seeded positive control, and holds it to the same rules as the package:
 * no Supabase client, no `node:child_process`, no logger, no `node:fs` at all
 * (the one permitted read lives in `entry.ts` and nowhere else), no file
 * write, no bare `throw`, and no `console.error(err)`.
 *
 * ── WHY THE ORCHESTRATOR IS REACHED BY A DYNAMIC IMPORT ───────────────
 * The two process-level handlers must be installed before the destination is
 * READ. In ESM every static import is evaluated before any statement in this
 * module's body, so a static `import { runCanary1 } from '…/index.js'` would
 * load the prompt module first regardless of where the install call is
 * written. Loading a module reads no TTY, so that would not itself be a leak —
 * but it would make the ordering unassertable, and an ordering nobody can
 * assert is an ordering a later edit silently loses. The dynamic import makes
 * the property real and checkable.
 *
 * ── AND WHY IT WRITES TO STDOUT AND NOTHING ELSE ──────────────────────
 * There is no `--out` and no file of any kind. The evidence is the terminal
 * transcript, and `PROTOCOL.md`'s grammar — no free-text field anywhere — is
 * what makes that transcript safe for an operator to keep, paste into a
 * handover, or read aloud.
 */

import {
  installCanary1Containment,
  scrubVerbosity,
} from '../src/lib/phone-canary1/containment.js';

// ── (0) SCRUB, THEN CONTAIN — both ahead of any TTY read. ─────────────
// Order within this pair does not matter — neither reads a TTY — but both must
// precede the destination being read, which is what the structural suite
// asserts. The handlers take no parameter, so there is no identifier holding
// the error that a later edit could reach for. A provider message may quote the
// dialled number; Node's default top-level printer would put it on stderr
// inside a stack trace.
// A verbose SDK is a provider message on stderr, which is the leak the
// containment layer exists to prevent, arriving by a route it cannot catch.
// Scrubbed IN PLACE, in the map the SDK will read, because a scrubbed copy
// handed to a constructor that never looks at it is not a control.
scrubVerbosity(process.env);

let abortTeardown: (() => Promise<void>) | null = null;

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

installCanary1Containment({
  emit: (code) => {
    write(`CANARY|canary1|process_containment|FAIL|${code}`);
  },
  teardown: async () => {
    if (abortTeardown !== null) await abortTeardown();
  },
  exit: (code) => {
    // ACTUALLY EXIT, not merely set a code. Installing an `uncaughtException`
    // handler suppresses Node's own exit, so without this the process would
    // survive its own fatal error — with a live carrier leg attached to it.
    // The emit and the teardown both ran before this point, so the transcript
    // is already written.
    process.exitCode = code;
    process.exit(code);
  },
});

// ── (1) Only now is the rest of the mechanism loaded. ─────────────────
const { runCanary1, openCanary1Prompt, createCanary1LiveClients } = await import(
  '../src/lib/phone-canary1/index.js'
);

const credentials = {
  url: process.env.LIVEKIT_URL ?? '',
  apiKey: process.env.LIVEKIT_API_KEY ?? '',
  apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
};
const clients = createCanary1LiveClients(credentials, process.env);

// SIGINT is the operator's abort and MUST hang up rather than orphan a live
// call. The database halt cannot reach this process — it stops admission and
// the due pass, and this mechanism never admits — so this is the mechanism's
// own kill switch.
let aborting = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // A second Ctrl-C must not start a second teardown while the first is
    // still deleting the room — two concurrent deletes would race, and the
    // loser's failure would print `cleanup_failed` for a room that IS gone.
    if (aborting) return;
    aborting = true;
    void (async (): Promise<void> => {
      try {
        if (abortTeardown !== null) await abortTeardown();
      } catch {
        write('CANARY|canary1|teardown_room_absent|FAIL|cleanup_failed');
      } finally {
        // The abort ENDS the process. Leaving it alive to finish an originate
        // the operator just cancelled is the opposite of an abort.
        process.exitCode = 1;
        process.exit(1);
      }
    })();
  });
}

const result = await runCanary1({
  argv: process.argv.slice(2),
  env: process.env,
  write,
  prompt: {
    openPrompt: () => openCanary1Prompt(process.stdin, process.stdout),
    isTty: process.stdin.isTTY === true,
  },
  rooms: clients.rooms,
  dispatch: clients.dispatch,
  credentials,
  trunkId: process.env.PHONE_SIP_TRUNK_ID ?? '',
  sleep: (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
  now: () => Date.now(),
  onAbort: (teardown) => { abortTeardown = teardown; },
});

process.exitCode = result.exitCode;
