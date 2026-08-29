/**
 * plivo-phone/xml.ts — the Plivo XML responses, and the ONE that carries a
 * phone number.
 *
 * ── THE ANSWER XML CARRIES THE CANDIDATE NUMBER ───────────────────────
 * `<Dial><Number>candidateE164</Number></Dial>` is the instruction that makes
 * Plivo's app dial the candidate. It therefore contains a phone number, and it
 * MUST NEVER be logged, echoed or returned to anywhere but the HTTP response
 * body. The route that sends it is responsible for that discipline; this module
 * only builds the string, and it takes the number as an ALREADY-UNWRAPPED value
 * so the single unwrap site is visible at the call site (as with the SDK
 * originate).
 *
 * ── EVERY DYNAMIC VALUE IS XML-ESCAPED ────────────────────────────────
 * The caller id and the callback URL come from CONFIG (validated E.164 / https
 * URL), and the number from a validated candidate row, so none is
 * attacker-controlled — but the values are still escaped, because emitting XML
 * by concatenation without escaping is exactly how a `&` in a URL or a stray
 * `<` becomes malformed XML that Plivo rejects, hanging up a real call.
 */

/** Minimal XML text/attribute escaping. Covers the five predefined entities. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The fail-closed response: answer, then hang up. Carries NO number. */
export const PLIVO_HANGUP_XML = '<Response><Hangup/></Response>';

export interface PlivoAnswerXmlInput {
  /** The candidate E.164 — ALREADY unwrapped by the caller. */
  readonly candidateE164: string;
  /** The caller-id number the candidate sees (from `PHONE_BOUNCE_CALLER_ID`). */
  readonly callerId: string;
  /** The Dial ACTION callback URL (the `/plivo/dial-status` endpoint). */
  readonly actionUrl: string;
}

/**
 * Build the bridge XML: dial the candidate, with the configured caller id, and
 * POST the dial result to the action URL. `redirect="false"` keeps control here
 * so the action callback fires with the DialStatus. THE RETURN VALUE CONTAINS A
 * PHONE NUMBER — treat it as the response body and nothing else.
 */
export function buildPlivoAnswerXml(input: PlivoAnswerXmlInput): string {
  const callerId = xmlEscape(input.callerId);
  const action = xmlEscape(input.actionUrl);
  const number = xmlEscape(input.candidateE164);
  return (
    '<Response>'
    + `<Dial callerId="${callerId}" action="${action}" method="POST" redirect="false">`
    + `<Number>${number}</Number>`
    + '</Dial>'
    + '</Response>'
  );
}
