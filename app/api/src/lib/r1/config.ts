/** R1 is deliberately isolated from env.ts: malformed optional R1 config must
 * never prevent the established phone API from booting. */
export type R1ConfigStatus = 'enabled' | 'disabled' | 'invalid';
export interface R1Config { enabled: boolean; status: R1ConfigStatus; reason?: string }

let reported: string | undefined;
function report(reason: string): void {
  if (reported === reason) return;
  reported = reason;
  // Do not include values: configuration can contain secrets in future.
  console.error(`[r1-config] disabled: ${reason}`);
}

/** Lazily inspect the process environment. This function never throws. */
export function getR1Config(source: NodeJS.ProcessEnv = process.env): R1Config {
  const raw = source.R1_ENABLED;
  if (raw === undefined || raw === '' || raw === 'false') return { enabled: false, status: 'disabled' };
  if (raw === 'true') return { enabled: true, status: 'enabled' };
  const reason = 'R1_ENABLED must be either "true" or "false"';
  report(reason);
  return { enabled: false, status: 'invalid', reason };
}
