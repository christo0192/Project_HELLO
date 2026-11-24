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

const R1_INDIA_PLAYBOOK_OFF = new Set(['0', 'off', 'false', 'no']);

/**
 * Owner decision 2026-11-20: the R1 post-session scorer follows the IK India sales playbook.
 * On when unset, blank or any value other than 0/off/false/no (trimmed, any case).
 * Never throws; read lazily, never by env.ts.
 */
export function r1IndiaPlaybookEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  const raw: unknown = source === process.env ? process.env.R1_INDIA_PLAYBOOK : source?.R1_INDIA_PLAYBOOK;
  return typeof raw !== 'string' || !R1_INDIA_PLAYBOOK_OFF.has(raw.trim().toLowerCase());
}

/**
 * Owner decision 2026-11-24 (IK offers): referrals to hiring or partner companies and a paid
 * interview-prep add-on are real IK offers for the R1 post-session scorer. On when unset, blank or
 * any value other than 0/off/false/no (trimmed, any case). Never throws; read lazily, never by env.ts.
 */
export function r1IkOffersEnabled(source: NodeJS.ProcessEnv = process.env): boolean {
  const raw: unknown = source === process.env ? process.env.R1_IK_OFFERS : source?.R1_IK_OFFERS;
  return typeof raw !== 'string' || !R1_INDIA_PLAYBOOK_OFF.has(raw.trim().toLowerCase());
}
