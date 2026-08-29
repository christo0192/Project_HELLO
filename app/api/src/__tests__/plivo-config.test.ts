/**
 * Plivo bounce config — the enablement gate, fail-closed, secrets never in the
 * health projection.
 */

import { describe, it, expect } from 'vitest';
import {
  loadPlivoPhoneConfig,
  isPlivoWebhookActive,
  describePlivoPhoneConfig,
} from '../integrations/plivo-phone/config.js';

const FULL = {
  PHONE_BOUNCE_MODE: 'true',
  PHONE_BOUNCE_CALLER_ID: '+919800000001',
  PLIVO_AUTH_ID: 'MAxxxxxxxxxxxxxxxxxx',
  PLIVO_AUTH_TOKEN: 'a-plivo-auth-token-abc',
  PLIVO_ANSWER_URL: 'https://api.example.com/api/integrations/plivo/answer',
  PLIVO_DIAL_STATUS_URL: 'https://api.example.com/api/integrations/plivo/dial-status',
  PLIVO_HANGUP_URL: 'https://api.example.com/api/integrations/plivo/hangup',
} as NodeJS.ProcessEnv;

describe('plivo config — the active gate', () => {
  it('is active only with bounce on AND a >=16-char token', () => {
    expect(isPlivoWebhookActive(loadPlivoPhoneConfig(FULL))).toBe(true);
    expect(isPlivoWebhookActive(loadPlivoPhoneConfig({ ...FULL, PHONE_BOUNCE_MODE: 'false' }))).toBe(false);
    expect(isPlivoWebhookActive(loadPlivoPhoneConfig({ ...FULL, PLIVO_AUTH_TOKEN: 'short' }))).toBe(false);
    expect(isPlivoWebhookActive(loadPlivoPhoneConfig({} as NodeJS.ProcessEnv))).toBe(false);
  });

  it('rejects a token under 16 chars (degrades to empty)', () => {
    expect(loadPlivoPhoneConfig({ ...FULL, PLIVO_AUTH_TOKEN: '123456789012345' }).authToken).toBe('');
    expect(loadPlivoPhoneConfig({ ...FULL, PLIVO_AUTH_TOKEN: '1234567890123456' }).authToken).toBe('1234567890123456');
  });

  it('validates the caller id as strict E.164 (invalid degrades to empty)', () => {
    expect(loadPlivoPhoneConfig({ ...FULL, PHONE_BOUNCE_CALLER_ID: '9800000001' }).callerId).toBe('');
    expect(loadPlivoPhoneConfig({ ...FULL, PHONE_BOUNCE_CALLER_ID: '+919800000001' }).callerId).toBe('+919800000001');
  });

  it('validates the signed URLs (non-http degrades to empty)', () => {
    const bad = loadPlivoPhoneConfig({ ...FULL, PLIVO_ANSWER_URL: 'ftp://x/y' });
    expect(bad.answerUrl).toBe('');
    expect(loadPlivoPhoneConfig(FULL).answerUrl).toBe(FULL.PLIVO_ANSWER_URL);
  });
});

describe('plivo config — the health projection carries no secret', () => {
  it('exposes booleans only, never the token, caller id or url', () => {
    const d = describePlivoPhoneConfig(loadPlivoPhoneConfig(FULL));
    const blob = JSON.stringify(d);
    expect(blob).not.toContain(FULL.PLIVO_AUTH_TOKEN);
    expect(blob).not.toContain('+919800000001');
    expect(d.webhookActive).toBe(true);
    expect(d.authTokenConfigured).toBe(true);
    expect(d.callerIdConfigured).toBe(true);
  });
});
