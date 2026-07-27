import { parsePhoneNumberFromString } from 'libphonenumber-js';

export interface NormalizedPhone {
  raw: string;
  e164: string | null;
  valid: boolean;
}

/**
 * Normalize a phone string to E.164, defaulting to India (+91) when no
 * country code is present (10-digit Indian mobiles).
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (!raw) return { raw: '', e164: null, valid: false };
  const cleaned = raw.trim();
  // Try as-is first (handles numbers that already carry +CC), then default IN.
  const parsed =
    parsePhoneNumberFromString(cleaned) ?? parsePhoneNumberFromString(cleaned, 'IN');
  if (parsed && parsed.isValid()) {
    return { raw: cleaned, e164: parsed.number, valid: true };
  }
  return { raw: cleaned, e164: null, valid: false };
}
