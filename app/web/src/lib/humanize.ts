/**
 * The words HR sees for values the API speaks in machine form.
 *
 * Backend enums (`under_review`, `no_answer`), E.164 numbers and UUIDs are
 * exact and stable, which is why the API uses them, and they read as a
 * database leaking onto the page. These helpers turn them into sentence-case
 * words and grouped digits at the last moment, in the view. Callers keep the
 * raw value one hover away (`title`) where an operator may need to quote it.
 *
 * Prefer an explicit label map for any enum whose words matter (a status a
 * recruiter acts on). `humanizeEnum` is the floor for everything else: it is
 * never wrong, only plain.
 */

/**
 * `snake_case` / `kebab-case` enum → sentence case: "under_review" →
 * "Under review". A known value in `labels` wins. Empty input → "".
 */
export function humanizeEnum(
  value: string | null | undefined,
  labels?: Readonly<Record<string, string>>,
): string {
  if (!value) return '';
  const known = labels?.[value];
  if (known) return known;
  const spaced = value.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!spaced) return '';
  // Common initialisms stay capitalised mid-sentence.
  const words = spaced.split(' ').map((w) => (INITIALISMS.has(w) ? w.toUpperCase() : w));
  const first = words[0];
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

const INITIALISMS = new Set(['ai', 'api', 'id', 'ivr', 'sip', 'sms', 'ta', 'url', 'hr']);

/**
 * An E.164 number grouped the way people write it: "+919876543210" →
 * "+91 98765 43210", "+12025550100" → "+1 202 555 0100". A number this does
 * not recognise comes back unchanged (still readable, never mangled).
 */
export function formatPhone(value: string | null | undefined): string {
  if (!value) return '';
  const raw = value.trim();
  const digits = raw.replace(/[^\d]/g, '');
  if (!raw.startsWith('+') || digits.length < 8) return raw;
  if (digits.startsWith('91') && digits.length === 12) {
    const n = digits.slice(2);
    return `+91 ${n.slice(0, 5)} ${n.slice(5)}`;
  }
  if (digits.startsWith('1') && digits.length === 11) {
    const n = digits.slice(1);
    return `+1 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  if (digits.startsWith('44') && digits.length === 12) {
    const n = digits.slice(2);
    return `+44 ${n.slice(0, 4)} ${n.slice(4)}`;
  }
  return raw;
}

/**
 * A short, human-scannable handle for an id that must be shown at all
 * (support, logs): the first 8 characters. Never use it as a heading or as
 * the only name of a thing; name things by what they are.
 */
export function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.replace(/-/g, '').slice(0, 8);
}
