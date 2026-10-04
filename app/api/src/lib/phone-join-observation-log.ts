/**
 * M010 — the log line for the targeted dial's agent-join observation.
 *
 * `dialPhoneAttempt` hands its sink one closed-vocabulary code per targeted
 * dial (see `phoneAgentJoinObservationCode` in livekit-phone-dial/dial.ts),
 * the seconds that stage took, and the leased Fly machine id. This module
 * turns that into ONE structured line. It is separate from `runtime.ts` so the
 * line the runtime actually emits can be tested against the real logger.
 *
 * The machine id is the correlator to the worker's own logs. It is not
 * personal data, but a raw 14-hex id with ten or more consecutive decimal
 * digits trips the logger's `\d{10,}` defence and the field would be dropped
 * for that machine on every line. So it is split into two halves (`m.<7>.<7>`),
 * which can never hold more than seven digits in a row and is still exact.
 */

/** The structural subset of `createLogger(...)` this sink needs. */
export interface JoinObservationLogger {
  info(event: 'unknown_event', fields: Record<string, string | number>): void;
}

/** `m.<first 7>.<rest>` for a machine id, `none` when there is none. */
export function machineCorrelator(machineId: string): string {
  if (machineId === '') return 'none';
  return `m.${machineId.slice(0, 7)}.${machineId.slice(7)}`;
}

export function createAgentJoinObservationSink(
  logger: JoinObservationLogger,
): (code: string, elapsedSec: number, machineId: string) => void {
  return (code, elapsedSec, machineId) => {
    logger.info('unknown_event', {
      error_type: 'phone_agent_join_observed',
      error_category: code,
      duration_sec: elapsedSec,
      phase: machineCorrelator(machineId),
    });
  };
}
