/**
 * lib/phone-canary1/index.ts — the named re-exports AND the composition root.
 *
 * ── WHY THE ORCHESTRATOR LIVES IN THE INDEX ───────────────────────────
 * The entry script `app/api/scripts/phone-canary1.ts` must do exactly two
 * things: install the process-level containment handlers as its first
 * statements, and then reach the rest of the mechanism. Reaching it through a
 * DYNAMIC import is what makes "handlers installed before the destination is
 * read" achievable at all — in ESM every static import is evaluated before any
 * statement in the importing module's body, so a statically-imported prompt
 * module would be loaded first no matter where the install call is written.
 *
 * That means the orchestration cannot live in the script (nothing could import
 * it for a test without executing it) and it must be reachable by one dynamic
 * import. So it lives here, and the package keeps the exact file split the
 * design specifies rather than growing an extra module for one function.
 *
 * ── WHAT `runCanary1` MAY AND MAY NOT DO ──────────────────────────────
 * It may: refuse, prompt, mint ids, create a room, dispatch the named worker,
 * originate ONCE, observe an occupancy count, tear down, and print lines that
 * parse under `PROTOCOL.md`.
 *
 * It may not: retry an originate, loop, write a file, read a database, post an
 * event, construct an API client, or emit anything the grammar cannot express.
 * Every one of those is asserted structurally rather than reviewed for.
 */

export { CANARY1_ARMED, CANARY1_NOT_ARMED } from './arming.js';
export {
  CANARY1_CONTAINMENT_CODES,
  CANARY1_VERBOSITY_ENV_KEYS,
  discardingErrors,
  installCanary1Containment,
  quietEnv,
  scrubVerbosity,
  type Canary1ContainmentCode,
  type Canary1ContainmentDeps,
  type Canary1ProcessLike,
} from './containment.js';
export {
  CANARY1_ARGV_SEPARATORS_RE,
  CANARY1_CONFIRM_PHRASE,
  CANARY1_DESTINATION_ENV_RE,
  CANARY1_ENTRY_REFUSALS,
  CANARY1_ENV_PATH,
  CANARY1_FORBIDDEN_FLAGS,
  CANARY1_LIVEKIT_ENV_KEY_RE,
  destinationInEnvironment,
  livekitCredentialsPersisted,
  looksLikeDestination,
  openCanary1Prompt,
  parseCanary1Argv,
  readCanary1Destination,
  type Canary1DestinationResult,
  type Canary1EntryRefusal,
  type Canary1Flags,
  type Canary1ParseResult,
  type Canary1PromptDeps,
  type Canary1PromptInterface,
} from './entry.js';
export {
  CANARY1_HANDLE_LENGTH,
  CANARY1_ID_MINT_ATTEMPTS,
  CANARY1_ID_MINT_FAILED,
  mintCanary1Ids,
  type Canary1Ids,
} from './ids.js';
export {
  CANARY1_DIGIT_RUN_RE,
  CANARY1_DISPATCH_METADATA_KEYS,
  CANARY1_METADATA_DIGIT_RUN,
  CANARY1_ROOM_CHANNEL,
  CANARY1_ROOM_METADATA_KEYS,
  buildCanary1DispatchMetadata,
  buildCanary1RoomMetadata,
  canary1RoomName,
  containsDigitRun,
} from './metadata.js';
export {
  CANARY1_BOUNDS,
  CANARY1_CLOSING_TEXT,
  CANARY1_DEFAULT_AGENT_NAME,
  CANARY1_DISCLOSURE_TEXT,
  CANARY1_DISPATCH_MODE,
  CANARY1_PARTICIPANT_WAIT_MARGIN_SEC,
  CANARY1_QUESTIONS,
  CANARY1_ROOM_EMPTY_TIMEOUT_SEC,
  CANARY1_ROOM_MAX_PARTICIPANTS,
  CANARY1_SCENARIO,
  CANARY1_SPOKEN_COPY,
  CANARY1_WALL_CLOCK_MARGIN_SEC,
  CANARY1_WORKER_ENV_VARS,
} from './plan.js';
export {
  CANARY1_PREFLIGHT_CHECKS,
  CANARY1_PREFLIGHT_REFUSALS,
  canary1MinimumWallClockSeconds,
  runCanary1Preflight,
  type Canary1PreflightInput,
  type Canary1PreflightRefusal,
  type Canary1PreflightResult,
  type Canary1TimeBounds,
} from './preflight.js';
export {
  CANARY1_EPOCH,
  buildCanary1DialConfig,
  buildCanary1ScreeningConfig,
  createCanary1LiveClients,
  createCanary1Room,
  dispatchCanary1Worker,
  originateCanary1Call,
  type Canary1Credentials,
  type Canary1DispatchClientLike,
  type Canary1OriginateDeps,
  type Canary1OriginateOutcome,
  type Canary1RoomClientLike,
} from './originate.js';
export {
  CANARY1_MANUAL_REMEDY_CODES,
  CANARY1_TEARDOWN_BACKOFF_MS,
  tearDownCanary1Room,
  type Canary1RoomTeardownClientLike,
  type Canary1RoomView,
  type Canary1TeardownDeps,
  type Canary1TeardownResult,
} from './teardown.js';
export {
  CANARY1_GRAMMAR,
  CANARY1_UNPRINTABLE_LINE,
  canary1CountLine,
  canary1DoneLine,
  canary1VerdictLine,
  createCanary1Emitter,
  type Canary1Emitter,
} from './verdict.js';

import { CANARY1_ARMED, CANARY1_NOT_ARMED } from './arming.js';
import { discardingErrors } from './containment.js';
import {
  destinationInEnvironment,
  livekitCredentialsPersisted,
  parseCanary1Argv,
  readCanary1Destination,
  type Canary1PromptDeps,
} from './entry.js';
import { mintCanary1Ids } from './ids.js';
import { canary1RoomName } from './metadata.js';
import {
  CANARY1_BOUNDS,
  CANARY1_DEFAULT_AGENT_NAME,
  CANARY1_DISPATCH_MODE,
  CANARY1_PARTICIPANT_WAIT_MARGIN_SEC,
  CANARY1_QUESTIONS,
} from './plan.js';
import { CANARY1_PREFLIGHT_CHECKS, runCanary1Preflight } from './preflight.js';
import {
  buildCanary1DialConfig,
  buildCanary1ScreeningConfig,
  createCanary1Room,
  dispatchCanary1Worker,
  originateCanary1Call,
  type Canary1Credentials,
  type Canary1DispatchClientLike,
  type Canary1OriginateDeps,
  type Canary1RoomClientLike,
} from './originate.js';
import { tearDownCanary1Room } from './teardown.js';
import { createCanary1Emitter, type Canary1Emitter } from './verdict.js';

export interface Canary1RunDeps {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  /** The ONE write. Everything printed goes through the emitter into this. */
  readonly write: (line: string) => void;
  readonly prompt: Canary1PromptDeps;
  readonly rooms: Canary1RoomClientLike;
  readonly dispatch: Canary1DispatchClientLike;
  readonly credentials: Canary1Credentials;
  readonly trunkId: string;
  readonly sleep: (ms: number) => Promise<void>;
  /** Monotonic-ish clock in milliseconds. Injected so a test can drive it. */
  readonly now: () => number;
  readonly originate?: Canary1OriginateDeps;
  /** Injected so a test can prove the re-mint loop is real. */
  readonly uuid?: () => string;
  /** Overridden only by the arming pin test's negative control. */
  readonly armed?: boolean;
  /**
   * Reader for the ONE permitted file read, injected ONLY so a test is
   * hermetic: a developer with a real `app/api/.env` on disk would otherwise
   * see every orchestration test refuse `credentials_persisted`, and the fix
   * for that would be to delete the assertion.
   *
   * The entry script does NOT pass it, so production always uses the
   * path-pinned read — and `phone-canary1-structural.test.ts` asserts that,
   * so the seam cannot become a way to bypass the control.
   */
  readonly readEnvFile?: () => string | null;
  /** Registers the abort so Ctrl-C runs the SAME teardown. */
  readonly onAbort?: (teardown: () => Promise<void>) => void;
}

export interface Canary1RunResult {
  readonly exitCode: number;
  readonly lines: readonly string[];
  /** Whether any provider seam was reached. Asserted directly by the tests. */
  readonly providerContacted: boolean;
}

function refused(emitter: Canary1Emitter, check: string, code: string): Canary1RunResult {
  emitter.check(check, false, code);
  emitter.done();
  return { exitCode: 1, lines: emitter.lines(), providerContacted: false };
}

/**
 * The whole run. Single-shot: there is no loop anywhere in this function, and
 * a structural test asserts it — one invocation, one destination, at most one
 * originate.
 */
export async function runCanary1(deps: Canary1RunDeps): Promise<Canary1RunResult> {
  const emitter = createCanary1Emitter(deps.write);

  const parsed = parseCanary1Argv(deps.argv);
  if (!parsed.ok) return refused(emitter, 'argv_accepted', parsed.refusal);
  emitter.check('argv_accepted', true, 'ok');

  if (destinationInEnvironment(deps.env)) {
    return refused(emitter, 'environment_accepted', 'destination_in_environment');
  }
  emitter.check('environment_accepted', true, 'ok');

  // ── THE ARMING GATE — FIRST OF EVERYTHING THAT CAN REFUSE ───────────
  // Wider than the design required in two ways, both deliberate.
  //
  // It gates the DRY RUN as well as `--execute`, so `main` carries a mechanism
  // that contacts nothing rather than one that contacts nothing when asked not
  // to. And it is checked FIRST — ahead of the trunk, the credentials, the
  // bounds and the prompt — so the refusal an operator sees on `main` is the
  // one that is actually true of `main`. An earlier ordering ran the credential
  // and trunk preflight first, which meant a bare invocation on a fresh machine
  // reported a missing trunk and never printed the disarmed state at all: the
  // property this whole mechanism exists to demonstrate was the one thing the
  // terminal did not say.
  //
  // The two refusals ABOVE this line stay above it on purpose. A destination in
  // argv or in an environment variable is already durable — in
  // `/proc/<pid>/cmdline`, in a shell history file — by the time this process
  // starts, so an operator who did that must be told whether or not the
  // mechanism is armed. Everything below this line is a precondition for
  // running, and there is no point stating a precondition for a run that cannot
  // happen.
  if (!(deps.armed ?? CANARY1_ARMED)) return refused(emitter, 'armed', CANARY1_NOT_ARMED);
  emitter.check('armed', true, 'ok');

  if (livekitCredentialsPersisted(deps.readEnvFile)) {
    return refused(emitter, 'credentials_transient', 'credentials_persisted');
  }
  emitter.check('credentials_transient', true, 'ok');


  const flags = parsed.flags;
  const bounds = {
    ringSeconds: flags.ringSeconds ?? CANARY1_BOUNDS.ringSeconds.def,
    originateTimeoutSeconds: CANARY1_BOUNDS.originateTimeoutSeconds.def,
    participantWaitSeconds:
      flags.participantWaitSeconds ?? CANARY1_BOUNDS.participantWaitSeconds.def,
    maxCallSeconds: flags.maxCallSeconds ?? CANARY1_BOUNDS.maxCallSeconds.def,
    wallClockSeconds: flags.wallClockSeconds ?? CANARY1_BOUNDS.wallClockSeconds.def,
    questions: flags.questions ?? CANARY1_BOUNDS.questions.def,
  };

  const preflight = runCanary1Preflight({
    bounds,
    trunkId: deps.trunkId,
    credentials: deps.credentials,
    questionsAvailable: CANARY1_QUESTIONS.length,
  });
  if (!preflight.ok) {
    return refused(emitter, CANARY1_PREFLIGHT_CHECKS[preflight.refusal], preflight.refusal);
  }
  for (const check of Object.values(CANARY1_PREFLIGHT_CHECKS)) emitter.check(check, true, 'ok');


  const destination = await readCanary1Destination(deps.prompt, deps.write);
  if (!destination.ok) {
    return refused(emitter, 'preflight_destination_accepted', destination.refusal);
  }
  emitter.check('preflight_destination_accepted', true, 'ok');

  const ids = mintCanary1Ids(deps.uuid);
  const roomName = canary1RoomName(ids.sessionId);
  let providerContacted = false;
  let tornDown = false;
  // The exit code is decided INSIDE the try and the result is assembled AFTER
  // the finally, so the returned transcript includes the teardown lines. An
  // earlier shape returned from inside the try and handed the caller a
  // snapshot taken before teardown ran — the lines were printed but the
  // returned evidence did not contain them, which is precisely the "the run
  // said it tore down and the record does not show it" failure this
  // mechanism's whole evidence story depends on not having.
  let exitCode = 1;

  const teardown = async (): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    const result = await tearDownCanary1Room(roomName, { rooms: deps.rooms, sleep: deps.sleep });
    // ONLY ABSENCE DECIDES. `deleteCalled` is an observation, reported as a
    // count, because a delete can legitimately throw on a room the provider has
    // already reaped — `teardown.ts` treats that as a success and says why:
    // reporting a cleanup failure for a room that does not exist sends an
    // operator to the LiveKit console for nothing and trains them to ignore the
    // line that matters. Driving a FAIL off it here would do exactly that, and
    // would force a non-zero exit on a clean run.
    emitter.count('teardown_delete_returned', result.deleteCalled ? 1 : 0);
    emitter.check('teardown_room_absent', result.verifiedAbsent, result.verifiedAbsent ? 'ok' : 'cleanup_failed');
    emitter.count('teardown_attempts', result.attempts);
  };
  deps.onAbort?.(teardown);

  // An inner void routine so the phases can `return` early WITHOUT returning a
  // transcript snapshot taken before the `finally` has run.
  const conduct = async (): Promise<void> => {
    providerContacted = true;
    const room = await createCanary1Room(ids, roomName, deps.rooms);
    emitter.check('room_created', room === 'created', room === 'created' ? 'ok' : 'room_create_failed');
    if (room !== 'created') return;

    const agentName = flags.agentName ?? CANARY1_DEFAULT_AGENT_NAME;
    const dispatched = await dispatchCanary1Worker(
      ids, roomName, agentName, CANARY1_DISPATCH_MODE, deps.dispatch,
    );
    const ok = dispatched === 'dispatched';
    emitter.check('dispatch_created', ok, ok ? 'ok' : 'dispatch_failed');
    if (!ok) return;

    if (!flags.execute) {
      emitter.check('originate_skipped', true, 'dry_run');
      // ── THE DRY RUN HAS TO WAIT, OR IT PROVES ALMOST NOTHING ──────
      // An earlier shape emitted `originate_skipped` and fell straight into
      // teardown, deleting the room within milliseconds of the dispatch. The
      // worker starts no idle job processes (`num_idle_processes: 0`,
      // `initialize_process_timeout: 60.0`) and then waits 120 s for a
      // participant, so it could not possibly have been assigned the job yet —
      // and the runbook's claim that the dry run proves the worker "enters the
      // canary branch, parses the metadata and closes" would have been false
      // of a run that had already torn the room down.
      //
      // So the dry run WATCHES for the agent to appear, bounded, and says what
      // it saw. Seeing the agent join is the whole point: it is the only
      // offline-safe evidence that arming, the dispatch metadata and the
      // inbound closed-key/digit-run guard all agree end to end.
      const joined = await observeAgentJoin(deps, roomName, bounds);
      emitter.check('worker_joined', joined, joined ? 'ok' : 'worker_never_joined');
      exitCode = joined ? 0 : 1;
      return;
    }

    const startedAt = deps.now();
    const outcome = await originateCanary1Call({
      ids,
      roomName,
      number: destination.number,
      config: buildCanary1ScreeningConfig(destination.number.digest, bounds.ringSeconds),
      dialConfig: buildCanary1DialConfig(
        deps.trunkId, agentName, bounds.originateTimeoutSeconds, bounds.maxCallSeconds,
      ),
      credentials: deps.credentials,
      ringSeconds: bounds.ringSeconds,
      maxCallSeconds: bounds.maxCallSeconds,
    }, deps.originate);

    if (outcome.status !== 'answered') {
      emitter.check('originate_answered', false, outcome.status);
      return;
    }
    emitter.check('originate_answered', true, 'ok');

    // OBSERVATION, not inference. The CLI cannot hear the conversation and must
    // not claim to: what it can see is whether the room held both the SIP leg
    // and the agent, so that is what the line says and what the code names.
    const occupied = await observeOccupancy(deps, roomName, bounds, startedAt);
    emitter.check('conversation_observed', occupied, occupied ? 'room_occupied' : 'room_never_occupied');
    emitter.count('call_seconds', Math.max(0, Math.round((deps.now() - startedAt) / 1_000)));
    exitCode = occupied ? 0 : 1;
  };

  try {
    await conduct();
  } finally {
    // A `finally` that FAILS CLOSED: it deletes a room and drops a live leg.
    // The halt drill forbids one for the opposite reason — there it would lift
    // a kill switch. Direction is what matters.
    await teardown();
    emitter.done();
  }

  // A teardown that could not VERIFY the room gone is never a success, however
  // well the call itself went. Partial failure is always a non-zero exit;
  // there is no "mostly torn down" when the thing not torn down is a live leg.
  return {
    exitCode: emitter.failed() ? 1 : exitCode,
    lines: emitter.lines(),
    providerContacted,
  };
}

/**
 * Poll for the NAMED WORKER to join the canary room, bounded.
 *
 * The bound covers a cold worker start plus the worker's own participant wait,
 * because that is how long the room legitimately sits with the agent in it and
 * nobody else. The room simply vanishing is NOT read as success: `emptyTimeout`
 * can reap a room the worker never reached, and "the worker ran" and "we could
 * not tell" must not look the same.
 */
async function observeAgentJoin(
  deps: Canary1RunDeps,
  roomName: string,
  bounds: { readonly participantWaitSeconds: number },
): Promise<boolean> {
  const deadline = deps.now()
    + (bounds.participantWaitSeconds + CANARY1_PARTICIPANT_WAIT_MARGIN_SEC) * 1_000;
  while (deps.now() < deadline) {
    const listed = await discardingErrors(async () => deps.rooms.listRooms([roomName]));
    if (listed !== undefined && (listed[0]?.numParticipants ?? 0) >= 1) return true;
    await discardingErrors(async () => deps.sleep(CANARY1_OBSERVE_POLL_MS));
  }
  return false;
}

/**
 * Poll the room's occupancy until both parties have been seen together or the
 * wall clock expires. Reads ONE field, a count.
 */
async function observeOccupancy(
  deps: Canary1RunDeps,
  roomName: string,
  bounds: { readonly wallClockSeconds: number },
  startedAt: number,
): Promise<boolean> {
  const deadline = startedAt + bounds.wallClockSeconds * 1_000;
  let sawBoth = false;
  while (deps.now() < deadline) {
    const listed = await discardingErrors(async () => deps.rooms.listRooms([roomName]));
    if (listed !== undefined) {
      const count = listed[0]?.numParticipants ?? 0;
      if (count >= 2) sawBoth = true;
      // The room being GONE after both were seen is a completed call, not a
      // failure: the worker deletes the room at the end of its own branch.
      if (listed.length === 0) return sawBoth;
    }
    await discardingErrors(async () => deps.sleep(CANARY1_OBSERVE_POLL_MS));
  }
  return sawBoth;
}

/** How often occupancy is sampled. A poll, not a subscription — no webhook here. */
export const CANARY1_OBSERVE_POLL_MS = 2_000;
