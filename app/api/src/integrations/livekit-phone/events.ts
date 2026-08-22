/**
 * livekit-phone/events.ts — the closed translation from a LiveKit webhook to
 * a 0042 phone event. Pure: no I/O, no clock, no client.
 *
 * ── THE ONLY SUBJECT RESOLVER IS THE PARTICIPANT IDENTITY ─────────────
 * `admit_phone_attempt` writes `participant_identity = 'phone-' || <attempt
 * uuid>` and 0042 constrains the column to `^phone-[0-9a-f-]{36}$`. That makes
 * the identity a DETERMINISTIC, self-describing handle on the attempt: the
 * subject is recovered by parsing, never by a lookup keyed on anything a
 * carrier chose. No phone number, no SIP call id and no room name participates
 * in resolution.
 *
 * ── WHY THE ATTRIBUTE READER IS AN ALLOWLIST AND NOT A COPY ───────────
 * LiveKit populates SIP participants with `sip.phoneNumber`,
 * `sip.trunkPhoneNumber` and `sip.callID` ATTRIBUTES AUTOMATICALLY. A
 * pass-through of `participant.attributes` would therefore carry the
 * subscriber's number into whatever it touched — a log line, an error, the
 * event ledger's metadata. So attributes are read through a CLOSED allowlist
 * of exactly one key, by exact name, and a structural test asserts no `sip.`
 * attribute is ever named in this module. The allowlist is the control; "we
 * only use the epoch" is not.
 *
 * ── ACCEPTED LIVEKIT EVENTS vs PHONE-RELEVANT EVENTS ──────────────────
 * Two different questions, deliberately separated:
 *   1. Is this a LiveKit event name AT ALL? An unknown name is a signed body
 *      we cannot interpret — non-retryable 4xx, so a misconfiguration is loud.
 *   2. Does it concern a phone attempt? This API receives the SAME webhook
 *      stream as the browser interview rooms. A `track_published` in a
 *      candidate's browser session is a perfectly valid LiveKit event that
 *      this route must ACCEPT and IGNORE with zero database work — never
 *      record, or the phone ledger fills with another feature's traffic.
 */

/**
 * Every event name LiveKit's `WebhookEvent` can carry (server SDK 2.16
 * `WebhookEventNames`). Mirrored rather than imported so an SDK upgrade that
 * ADDS a name surfaces as a drift-test failure instead of silently widening
 * what this route accepts.
 */
export const LIVEKIT_WEBHOOK_EVENTS = [
  'room_started',
  'room_finished',
  'participant_joined',
  'participant_left',
  'participant_connection_aborted',
  'track_published',
  'track_unpublished',
  'egress_started',
  'egress_updated',
  'egress_ended',
  'ingress_started',
  'ingress_ended',
] as const;

export type LiveKitWebhookEvent = (typeof LIVEKIT_WEBHOOK_EVENTS)[number];

const LIVEKIT_EVENT_SET: ReadonlySet<string> = new Set(LIVEKIT_WEBHOOK_EVENTS);

/** True iff `name` is an event name this SDK version can produce. */
export function isLiveKitWebhookEvent(name: unknown): name is LiveKitWebhookEvent {
  return typeof name === 'string' && LIVEKIT_EVENT_SET.has(name);
}

/**
 * The THREE LiveKit events that carry a phone-attempt transition, and the
 * 0042 `event_type` each becomes.
 *
 * `participant_joined -> sip.participant_joined` is the one 0042 documents as
 * "#14 JOIN IS NOT ANSWER": it moves the ATTEMPT to `answered_unclassified`
 * and moves the engagement nowhere. Classification (`classify.human` /
 * `classify.machine`), disclosure and assessment events are produced by the
 * in-room agent, not by a webhook, so they are deliberately absent here.
 */
export const PHONE_EVENT_BY_LIVEKIT_EVENT: Readonly<Record<string, string>> = Object.freeze({
  participant_joined: 'sip.participant_joined',
  participant_left: 'sip.participant_left',
  participant_connection_aborted: 'sip.connection_aborted',
});

/** The participant identity 0042 writes: `phone-` + the attempt uuid. */
const PARTICIPANT_IDENTITY_RE =
  /^phone-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * The ONLY participant attribute this module may read. `sip.phoneNumber`,
 * `sip.trunkPhoneNumber` and `sip.callID` are excluded BY CONSTRUCTION: the
 * reader indexes this allowlist, it never enumerates the attribute map.
 */
export const APPROVED_PARTICIPANT_ATTRIBUTES = ['phone_epoch'] as const;

/** A non-negative 32-bit epoch, matching 0042's `integer` fencing token. */
const EPOCH_RE = /^(0|[1-9][0-9]{0,9})$/;
const MAX_EPOCH = 2147483647;

/**
 * The narrow slice of a LiveKit webhook this module is willing to look at.
 * Everything else on the envelope — room metadata, track lists, participant
 * name, the SIP attributes — is out of reach by type, not by discipline.
 */
export interface LiveKitPhoneEnvelope {
  readonly event: string;
  /** LiveKit's unique event uuid. Becomes `provider_event_id` when usable. */
  readonly id?: string | null;
  readonly participantIdentity?: string | null;
  /** Attribute map. Read ONLY through `APPROVED_PARTICIPANT_ATTRIBUTES`. */
  readonly participantAttributes?: Readonly<Record<string, string>> | null;
}

export type PhoneEventResolution =
  | { readonly kind: 'not_livekit_event' }
  | { readonly kind: 'not_phone_event'; readonly event: LiveKitWebhookEvent }
  | {
      readonly kind: 'phone_event';
      readonly event: LiveKitWebhookEvent;
      readonly eventType: string;
      readonly attemptId: string;
      readonly epoch: number | undefined;
      readonly providerEventId: string;
    };

/** 0042's `chk_phone_call_events_provider_id` character class. */
const PROVIDER_EVENT_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;

/**
 * Read one approved attribute by EXACT name. Returns undefined for anything
 * absent, non-string or outside the allowlist — never throws, never enumerates.
 */
function approvedAttribute(
  attributes: Readonly<Record<string, string>> | null | undefined,
  key: (typeof APPROVED_PARTICIPANT_ATTRIBUTES)[number],
): string | undefined {
  if (!attributes || typeof attributes !== 'object') return undefined;
  const value = (attributes as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Parse the fencing epoch. A malformed value is DROPPED, never coerced. */
export function parsePhoneEpoch(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!EPOCH_RE.test(value)) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_EPOCH) return undefined;
  return parsed;
}

/**
 * Recover the attempt uuid from a participant identity, or undefined.
 * Structural and total — no lookup, no provider value, no phone number.
 */
export function attemptIdFromIdentity(identity: string | null | undefined): string | undefined {
  if (typeof identity !== 'string') return undefined;
  const match = PARTICIPANT_IDENTITY_RE.exec(identity);
  return match ? match[1] : undefined;
}

/**
 * Mint the `provider_event_id`, which 0042 declares NOT NULL because a unique
 * index over a nullable column does not dedup.
 *
 * LiveKit's own event uuid is preferred — a redelivery repeats it, which is
 * exactly the dedup key we want. When it is absent or carries a character
 * outside 0042's class, a DETERMINISTIC synthetic id is derived from values
 * that are themselves stable for the event: the attempt and the event type.
 * Nothing time-derived participates, so a redelivery of the same transition
 * mints the same id rather than a second ledger row.
 */
export function phoneProviderEventId(
  livekitEventId: string | null | undefined,
  attemptId: string,
  eventType: string,
  epoch: number | undefined,
): string {
  if (typeof livekitEventId === 'string') {
    const candidate = livekitEventId.trim();
    if (PROVIDER_EVENT_ID_RE.test(candidate)) return candidate;
  }
  // The epoch participates for the same reason it does in the reconciliation
  // id: two `participant_joined` events on the same attempt either side of an
  // epoch bump are DIFFERENT events, and an id without the epoch would collide
  // them so the second read back as a duplicate instead of applying. `na`
  // when the attribute is absent — still deterministic, because a redelivery
  // of the same event carries the same attributes.
  return `lk:${attemptId}:${eventType}:${epoch === undefined ? 'na' : epoch}`;
}

/**
 * Classify one verified LiveKit envelope. Pure and total: every input lands in
 * exactly one of the three resolutions, and only the third reaches a database.
 */
export function resolvePhoneEvent(envelope: LiveKitPhoneEnvelope): PhoneEventResolution {
  if (!isLiveKitWebhookEvent(envelope.event)) return { kind: 'not_livekit_event' };
  const event = envelope.event;

  const eventType = PHONE_EVENT_BY_LIVEKIT_EVENT[event];
  if (eventType === undefined) return { kind: 'not_phone_event', event };

  // A phone-shaped LiveKit event whose participant is NOT one of ours is
  // another feature's room. Accepted and ignored — never recorded.
  const attemptId = attemptIdFromIdentity(envelope.participantIdentity);
  if (attemptId === undefined) return { kind: 'not_phone_event', event };

  const epoch = parsePhoneEpoch(
    approvedAttribute(envelope.participantAttributes, 'phone_epoch'),
  );
  return {
    kind: 'phone_event',
    event,
    eventType,
    attemptId,
    epoch,
    providerEventId: phoneProviderEventId(envelope.id, attemptId, eventType, epoch),
  };
}
