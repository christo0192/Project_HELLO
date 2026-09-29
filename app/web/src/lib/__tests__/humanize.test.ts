import { describe, expect, it } from 'vitest';
import { formatPhone, humanizeEnum, shortId } from '../humanize';

describe('humanizeEnum', () => {
  it('turns a snake_case enum into sentence case', () => {
    expect(humanizeEnum('under_review')).toBe('Under review');
    expect(humanizeEnum('dropped_at_gate')).toBe('Dropped at gate');
    expect(humanizeEnum('NO_ANSWER')).toBe('No answer');
  });

  it('keeps initialisms capitalised and handles kebab-case', () => {
    expect(humanizeEnum('provider_5xx')).toBe('Provider 5xx');
    expect(humanizeEnum('sip-error')).toBe('SIP error');
    expect(humanizeEnum('ai_screening')).toBe('AI screening');
  });

  it('prefers an explicit label', () => {
    expect(humanizeEnum('provider_5xx', { provider_5xx: 'Phone provider error' })).toBe('Phone provider error');
  });

  it('is empty for nothing', () => {
    expect(humanizeEnum(null)).toBe('');
    expect(humanizeEnum('')).toBe('');
    expect(humanizeEnum('__')).toBe('');
  });
});

describe('formatPhone', () => {
  it('groups Indian, North American and UK numbers', () => {
    expect(formatPhone('+919876543210')).toBe('+91 98765 43210');
    expect(formatPhone('+12025550100')).toBe('+1 202 555 0100');
    expect(formatPhone('+447700900123')).toBe('+44 7700 900123');
  });

  it('returns anything it does not recognise unchanged', () => {
    expect(formatPhone('+61412345678')).toBe('+61412345678');
    expect(formatPhone('98765')).toBe('98765');
    expect(formatPhone(null)).toBe('');
  });
});

describe('shortId', () => {
  it('is the first eight characters', () => {
    expect(shortId('3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e')).toBe('3f2a9c1e');
    expect(shortId(undefined)).toBe('');
  });
});
