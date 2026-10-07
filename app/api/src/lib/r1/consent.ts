/**
 * R1 consent reads (plan section 7.8).
 *
 * R1 consent lives ONLY in `interview_round_consent_templates` and
 * `interview_round_consents`. This module and its callers never reference the
 * legacy `consent_templates` / `consent_records` tables: those feed the phone
 * RPCs and the legacy exchange, and an R1 write there would change phone
 * behaviour (fence 7, enforced by r1-consent-fence.test.ts).
 *
 * "Valid" mirrors `screening_v2.r1_admit_attempt` (0117), which is the
 * authority at admission: the round's LIVE (not withdrawn) consent row names a
 * template that is active AND carries the greatest active version, and its
 * consents contain every consent that template requires. Preflight and
 * exchange re-check it here so a withdrawal or a newer template stops a join
 * that admission already allowed. This read is STRICTER than admission in one
 * respect: the template must also be the round's audience (`consent_locale`),
 * which admission does not know about (see `readRoundConsent`).
 *
 * A decline or a withdrawal is recorded as an immediately-withdrawn row whose
 * `proof.decision` says which it was, so the live-consent unique index keeps
 * meaning "the one consent in force".
 */

import type { supabase } from '../supabase.js';

type Db = typeof supabase;

export interface ConsentTemplate {
  id: string;
  version: string;
  locale: string;
  title: string;
  body_md: string;
  required_consents: string[];
}

export type RoundConsent =
  | { state: 'granted'; templateVersion: string }
  | { state: 'required'; templateVersion: string | null }
  | { state: 'declined'; templateVersion: string | null }
  | { state: 'withdrawn'; templateVersion: string | null };

export type Read<T> = { ok: true; value: T } | { ok: false };

const CONSENT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

/** Required/granted consent lists are arrays of short snake_case identifiers. */
export function asConsentList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !CONSENT_TYPE.test(item)) return null;
    out.push(item);
  }
  return out;
}

/** True when every required consent is present (`required <@ granted`). */
export function consentCovers(required: readonly string[], granted: readonly string[]): boolean {
  return required.every((type) => granted.includes(type));
}

function toTemplate(row: Record<string, unknown> | null | undefined): ConsentTemplate | null {
  if (!row) return null;
  const required = asConsentList(row.required_consents);
  if (
    typeof row.id !== 'string'
    || typeof row.version !== 'string'
    || typeof row.locale !== 'string'
    || typeof row.title !== 'string'
    || typeof row.body_md !== 'string'
    || required === null
  ) {
    return null;
  }
  return {
    id: row.id,
    version: row.version,
    locale: row.locale,
    title: row.title,
    body_md: row.body_md,
    required_consents: required,
  };
}

const TEMPLATE_COLUMNS = 'id, version, locale, title, body_md, required_consents';

/**
 * The newest ACTIVE template. Ordering is the database's, so it agrees with
 * the `max(version)` that `r1_admit_attempt` applies. With `locale` the answer
 * is that locale's newest; without it, the newest across locales.
 */
export async function loadNewestTemplate(
  db: Db,
  locale?: string,
): Promise<Read<ConsentTemplate | null>> {
  let query = db
    .from('interview_round_consent_templates')
    .select(TEMPLATE_COLUMNS)
    .eq('is_active', true);
  if (locale !== undefined) query = query.eq('locale', locale);
  const { data, error } = await query
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, value: toTemplate(data as Record<string, unknown> | null) };
}

/** A specific template, regardless of whether it is still active. */
async function loadTemplateById(
  db: Db,
  id: string,
): Promise<Read<(ConsentTemplate & { is_active: boolean }) | null>> {
  const { data, error } = await db
    .from('interview_round_consent_templates')
    .select(`${TEMPLATE_COLUMNS}, is_active`)
    .eq('id', id)
    .maybeSingle();
  if (error) return { ok: false };
  const row = data as Record<string, unknown> | null;
  const template = toTemplate(row);
  if (!template || !row) return { ok: true, value: null };
  return { ok: true, value: { ...template, is_active: row.is_active === true } };
}

export interface LiveConsentRow {
  id: string;
  template_id: string;
  proof: Record<string, unknown> | null;
}

/** The round's single not-withdrawn consent row, if any (unique index). */
export async function loadLiveConsent(
  db: Db,
  roundId: string,
): Promise<Read<LiveConsentRow | null>> {
  const { data, error } = await db
    .from('interview_round_consents')
    .select('id, template_id, proof')
    .eq('round_id', roundId)
    .is('withdrawn_at', null)
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false };
  if (!data) return { ok: true, value: null };
  const proof = data.proof && typeof data.proof === 'object' && !Array.isArray(data.proof)
    ? (data.proof as Record<string, unknown>)
    : null;
  return {
    ok: true,
    value: { id: String(data.id), template_id: String(data.template_id), proof },
  };
}

/**
 * The consent in force for a round, derived the way admission derives it.
 *
 * `audience` is the round's `consent_locale`: the notice this round is owed
 * (candidate or staff dry run). A live consent only counts when the template it
 * names has THAT locale. Admission cannot tell the two notices apart (both ship at
 * one version), so without this check a consent captured under one audience would
 * keep reading `granted` after the round was re-marked for the other, and the
 * person who agreed to the staff notice ("no decision is made about you") would
 * be interviewed and evaluated as a candidate. Capture enforces the audience
 * (the template route and POST /consent pick the template from the round); this
 * makes every later read enforce it too.
 */
export async function readRoundConsent(
  db: Db,
  roundId: string,
  audience: string,
): Promise<Read<RoundConsent>> {
  const newest = await loadNewestTemplate(db);
  if (!newest.ok) return { ok: false };
  const newestVersion = newest.value?.version ?? null;

  const live = await db
    .from('interview_round_consents')
    .select('id, template_id, consents, granted_at')
    .eq('round_id', roundId)
    .is('withdrawn_at', null)
    .order('granted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (live.error) return { ok: false };

  if (live.data) {
    const granted = asConsentList(live.data.consents);
    const template = await loadTemplateById(db, String(live.data.template_id));
    if (!template.ok) return { ok: false };
    const current = template.value;
    const valid = current !== null
      && granted !== null
      && current.is_active
      && current.locale === audience
      && newest.value !== null
      && current.version === newestVersion
      && consentCovers(current.required_consents, granted);
    return {
      ok: true,
      value: valid
        ? { state: 'granted', templateVersion: current.version }
        : { state: 'required', templateVersion: newestVersion },
    };
  }

  const latest = await db
    .from('interview_round_consents')
    .select('proof, granted_at')
    .eq('round_id', roundId)
    .order('granted_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) return { ok: false };
  const proof = latest.data?.proof as { decision?: unknown } | null | undefined;
  if (proof?.decision === 'declined') {
    return { ok: true, value: { state: 'declined', templateVersion: newestVersion } };
  }
  if (proof?.decision === 'withdrawn') {
    return { ok: true, value: { state: 'withdrawn', templateVersion: newestVersion } };
  }
  return { ok: true, value: { state: 'required', templateVersion: newestVersion } };
}
