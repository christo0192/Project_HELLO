/**
 * phone-screening/consent.ts — the ADVISORY consent preflight.
 *
 * ── WHAT THIS IS FOR, AND WHAT IT IS NOT ──────────────────────────────
 * `admit_phone_attempt` re-checks consent under the engagement row lock and is
 * the ONLY thing that can grant a dial. This preflight exists so a caller can
 * refuse early with a stable code instead of spending an admission round trip,
 * and so an operator surface can explain WHY an engagement is not dialable.
 *
 * It is deliberately asymmetric, and the asymmetry is the whole safety
 * property: **the preflight can only ever REFUSE. It can never grant.** A
 * "clear" preflight means nothing more than "no local reason to stop", and the
 * admission RPC still decides. So the two can never disagree in the dangerous
 * direction — an advisory `allowed` followed by an RPC `consent_expired`
 * surfaces the RPC's refusal and admits nothing.
 *
 * ── FAIL CLOSED ON EVERY NEGATIVE, INCLUDING A FAILED READ ────────────
 * Absent record, non-`granted` status, expiry, missing active template and a
 * required-consent subset miss are each a refusal — and so is a read that
 * throws. A consent gate that fails open on a database blip is not a gate.
 *
 * ── THE LATEST RECORD WINS, REGARDLESS OF ITS STATUS ──────────────────
 * The mirrored SQL is `order by created_at desc, id desc limit 1` over ALL of
 * the candidate's records, not `where status = 'granted' limit 1`. A later
 * `withdrawn` or `declined` row therefore OVERRIDES an older `granted` one. If
 * this read filtered by status, a withdrawal would be invisible and the gate
 * would keep saying yes forever.
 *
 * No number, no proof payload and no candidate field beyond the ids crosses
 * this boundary. Pure apart from the injected reader.
 */

import type { ConsentRecordStatus, ConsentType } from './vocabulary.js';

/**
 * The refusal codes this preflight can produce. Each is byte-identical to the
 * `admit_phone_attempt` status it mirrors, so a caller comparing the advisory
 * answer with the RPC's is comparing like with like. `consent_read_error` is
 * the one member with no SQL counterpart: it means the preflight itself could
 * not answer, which is a local fail-closed refusal, not a database verdict.
 */
export const CONSENT_PREFLIGHT_REFUSALS = [
  'consent_missing',
  'consent_not_granted',
  'consent_expired',
  'consent_template_inactive',
  'consent_subset_missing',
  'consent_read_error',
] as const;

export type ConsentPreflightRefusal = (typeof CONSENT_PREFLIGHT_REFUSALS)[number];

/** The latest consent record for a candidate, whatever its status. */
export interface ConsentRecordSnapshot {
  readonly status: ConsentRecordStatus | string;
  readonly consents: readonly (ConsentType | string)[];
  readonly expiresAt: Date | null;
}

/** The active consent template's required set. */
export interface ConsentTemplateSnapshot {
  readonly requiredConsents: readonly (ConsentType | string)[];
}

/**
 * The reads the preflight needs, as an injectable port. Returning `null` means
 * "no such row"; THROWING means the read failed, and both are refusals.
 */
export interface ConsentReader {
  /** The LATEST record by `(created_at desc, id desc)`, regardless of status. */
  latestConsentRecord(candidateId: string): Promise<ConsentRecordSnapshot | null>;
  /** The active template by `(updated_at desc, id desc)`, or null if none. */
  activeConsentTemplate(): Promise<ConsentTemplateSnapshot | null>;
}

export type ConsentPreflightResult =
  | {
      readonly decision: 'no_local_objection';
      /**
       * Never `allowed`. The name is the point: this outcome authorises
       * nothing, it only reports that no local reason to stop was found.
       */
    }
  | {
      readonly decision: 'refused';
      readonly code: ConsentPreflightRefusal;
      /** Present for `consent_not_granted`, mirroring the RPC's detail field. */
      readonly consentStatus?: string;
    };

/**
 * Run the advisory preflight for one candidate.
 *
 * The order is the SQL's order, because the FIRST refusal is the one an
 * operator sees and reordering would change the reported cause: record →
 * status → expiry → active template → required-subset.
 */
export async function consentPreflight(
  reader: ConsentReader,
  candidateId: string,
  now: Date,
): Promise<ConsentPreflightResult> {
  let record: ConsentRecordSnapshot | null;
  try {
    record = await reader.latestConsentRecord(candidateId);
  } catch {
    // A read that throws is a refusal. Sanitized: the underlying error is not
    // inspected, not logged here and not attached to the result.
    return { decision: 'refused', code: 'consent_read_error' };
  }
  if (!record) return { decision: 'refused', code: 'consent_missing' };
  if (record.status !== 'granted') {
    return { decision: 'refused', code: 'consent_not_granted', consentStatus: record.status };
  }
  if (record.expiresAt !== null && record.expiresAt.getTime() <= now.getTime()) {
    return { decision: 'refused', code: 'consent_expired' };
  }

  let template: ConsentTemplateSnapshot | null;
  try {
    template = await reader.activeConsentTemplate();
  } catch {
    return { decision: 'refused', code: 'consent_read_error' };
  }
  // `select required_consents ... where is_active` returning no row is
  // `consent_template_inactive` in SQL, and that is the ONLY refusal here. An
  // ACTIVE template with an empty required set passes, deliberately and in
  // agreement with the SQL: `'{}' <@ consents` is true, so the subset check
  // below has nothing to refuse. Refusing it here would make the preflight
  // stricter than the gate it mirrors.
  if (!template) return { decision: 'refused', code: 'consent_template_inactive' };

  const granted = new Set(record.consents);
  for (const required of template.requiredConsents) {
    if (!granted.has(required)) return { decision: 'refused', code: 'consent_subset_missing' };
  }

  return { decision: 'no_local_objection' };
}
