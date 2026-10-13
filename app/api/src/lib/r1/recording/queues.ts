/**
 * The queue names of the R1 recording lane (IMPLEMENTER-RULES C3).
 *
 * `r1.recording.finalize` is enqueued by the 0127 trigger when a recording reaches `finishing`;
 * `r1.recording.erase` by the 0127 consent trigger (and by the worker gate when it finds a
 * withdrawn consent); `r1.sweep` by a 15-minute loop. All three belong to the R1 runtime only: the
 * phone runtime keeps its handler set `{phone.dial, phone.assessment}` and never claims them.
 */
export const R1_RECORDING_FINALIZE_QUEUE = 'r1.recording.finalize';
export const R1_RECORDING_ERASE_QUEUE = 'r1.recording.erase';
export const R1_SWEEP_QUEUE = 'r1.sweep';
