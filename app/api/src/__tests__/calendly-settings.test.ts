/**
 * Calendly settings validators: resource URIs on the one fixed API origin (id segment out, nothing
 * else accepted), the invitee URI, the URI builder, and the token / signing-key shapes.
 */
import { describe, expect, it } from 'vitest';
import {
  CALENDLY_API_BASE_URL,
  CALENDLY_ID_SEGMENT_RE,
  type CalendlyCollection,
  calendlyUri,
  isCalendlySigningKeyShaped,
  isCalendlyTokenShaped,
  parseCalendlyInviteeUri,
  parseCalendlyUri,
} from '../integrations/calendly/settings.js';

const COLLECTIONS: CalendlyCollection[] = [
  'event_types',
  'scheduled_events',
  'users',
  'organizations',
  'webhook_subscriptions',
];
const ID = 'AAAABBBBCCCCDDDD';
const UUID_ID = '0f1e2d3c-4b5a-4968-8778-695a4b3c2d1e';

describe('Calendly constants', () => {
  it('uses the fixed API origin and a one-segment id shape', () => {
    expect(CALENDLY_API_BASE_URL).toBe('https://api.calendly.com');
    expect(CALENDLY_ID_SEGMENT_RE.test(ID)).toBe(true);
    expect(CALENDLY_ID_SEGMENT_RE.test('a/b')).toBe(false);
  });
});

describe('parseCalendlyUri', () => {
  it.each(COLLECTIONS)('returns the id of a %s URI', (collection) => {
    expect(parseCalendlyUri(`https://api.calendly.com/${collection}/${ID}`, collection)).toBe(ID);
    expect(parseCalendlyUri(`https://api.calendly.com/${collection}/${UUID_ID}`, collection)).toBe(UUID_ID);
  });

  it('accepts the 1- and 64-char id bounds', () => {
    expect(parseCalendlyUri('https://api.calendly.com/users/A', 'users')).toBe('A');
    const longest = 'a'.repeat(64);
    expect(parseCalendlyUri(`https://api.calendly.com/users/${longest}`, 'users')).toBe(longest);
  });

  it('rejects a URI of another collection', () => {
    expect(parseCalendlyUri(`https://api.calendly.com/event_types/${ID}`, 'users')).toBeNull();
    expect(parseCalendlyUri(`https://api.calendly.com/users/${ID}`, 'event_types')).toBeNull();
    expect(parseCalendlyUri(`https://api.calendly.com/scheduled_events/${ID}`, 'event_types')).toBeNull();
  });

  it.each([
    ['http', `http://api.calendly.com/event_types/${ID}`],
    ['the booking host', `https://calendly.com/event_types/${ID}`],
    ['a look-alike suffix host', `https://api.calendly.com.evil.test/event_types/${ID}`],
    ['userinfo', `https://user@api.calendly.com/event_types/${ID}`],
    ['a port', `https://api.calendly.com:443/event_types/${ID}`],
    ['upper-case host', `https://API.CALENDLY.COM/event_types/${ID}`],
    ['a trailing slash', `https://api.calendly.com/event_types/${ID}/`],
    ['a query', `https://api.calendly.com/event_types/${ID}?x=1`],
    ['a fragment', `https://api.calendly.com/event_types/${ID}#x`],
    ['an extra segment', `https://api.calendly.com/event_types/${ID}/extra`],
    ['an empty id', 'https://api.calendly.com/event_types/'],
    ['no id', 'https://api.calendly.com/event_types'],
    ['a dot id', 'https://api.calendly.com/event_types/..'],
    ['an underscore', 'https://api.calendly.com/event_types/abc_def'],
    ['a percent escape', 'https://api.calendly.com/event_types/abc%2Fdef'],
    ['a space', 'https://api.calendly.com/event_types/abc def'],
    ['a 65-char id', `https://api.calendly.com/event_types/${'a'.repeat(65)}`],
    ['leading whitespace', ` https://api.calendly.com/event_types/${ID}`],
    ['trailing newline', `https://api.calendly.com/event_types/${ID}\n`],
    ['a bare id', ID],
    ['empty', ''],
  ])('rejects %s', (_name, raw) => {
    expect(parseCalendlyUri(raw, 'event_types')).toBeNull();
  });

  it('rejects an unknown collection and non-strings without throwing', () => {
    expect(parseCalendlyUri(`https://api.calendly.com/invitees/${ID}`, 'invitees' as CalendlyCollection)).toBeNull();
    expect(parseCalendlyUri(`https://api.calendly.com/__proto__/${ID}`, '__proto__' as CalendlyCollection)).toBeNull();
    for (const raw of [null, undefined, 1, {}, [`https://api.calendly.com/users/${ID}`]]) {
      expect(parseCalendlyUri(raw, 'users')).toBeNull();
    }
  });
});

describe('parseCalendlyInviteeUri', () => {
  it('returns both ids', () => {
    expect(parseCalendlyInviteeUri(`https://api.calendly.com/scheduled_events/${ID}/invitees/${UUID_ID}`)).toEqual({
      eventId: ID,
      inviteeId: UUID_ID,
    });
  });

  it.each([
    ['http', `http://api.calendly.com/scheduled_events/${ID}/invitees/${ID}`],
    ['another host', `https://calendly.com/scheduled_events/${ID}/invitees/${ID}`],
    ['a look-alike suffix host', `https://api.calendly.com.evil.test/scheduled_events/${ID}/invitees/${ID}`],
    ['another collection', `https://api.calendly.com/event_types/${ID}/invitees/${ID}`],
    ['a misspelled sub-collection', `https://api.calendly.com/scheduled_events/${ID}/invitee/${ID}`],
    ['the event URI alone', `https://api.calendly.com/scheduled_events/${ID}`],
    ['a trailing slash', `https://api.calendly.com/scheduled_events/${ID}/invitees/${ID}/`],
    ['a query', `https://api.calendly.com/scheduled_events/${ID}/invitees/${ID}?x=1`],
    ['an extra segment', `https://api.calendly.com/scheduled_events/${ID}/invitees/${ID}/extra`],
    ['an empty invitee id', `https://api.calendly.com/scheduled_events/${ID}/invitees/`],
    ['a bad event id', `https://api.calendly.com/scheduled_events/a.b/invitees/${ID}`],
    ['a bad invitee id', `https://api.calendly.com/scheduled_events/${ID}/invitees/a_b`],
    ['a 65-char id', `https://api.calendly.com/scheduled_events/${'a'.repeat(65)}/invitees/${ID}`],
    ['trailing newline', `https://api.calendly.com/scheduled_events/${ID}/invitees/${ID}\n`],
    ['empty', ''],
  ])('rejects %s', (_name, raw) => {
    expect(parseCalendlyInviteeUri(raw)).toBeNull();
  });

  it('rejects non-strings without throwing', () => {
    for (const raw of [null, undefined, 1, {}]) expect(parseCalendlyInviteeUri(raw)).toBeNull();
  });
});

describe('calendlyUri', () => {
  it.each(COLLECTIONS)('round-trips a %s URI', (collection) => {
    const uri = calendlyUri(collection, ID);
    expect(uri).toBe(`${CALENDLY_API_BASE_URL}/${collection}/${ID}`);
    expect(parseCalendlyUri(uri, collection)).toBe(ID);
  });

  it('throws a TypeError on a bad id, without echoing it', () => {
    for (const id of ['', 'a/b', 'a?b', 'a.b', 'a'.repeat(65), 'secret-looking id']) {
      expect(() => calendlyUri('users', id)).toThrow(TypeError);
      try {
        calendlyUri('users', id);
      } catch (error) {
        if (id) expect(String((error as Error).message)).not.toContain(id);
      }
    }
    expect(() => calendlyUri('users', null as unknown as string)).toThrow(TypeError);
  });

  it('throws a TypeError on an unknown collection', () => {
    expect(() => calendlyUri('invitees' as CalendlyCollection, ID)).toThrow(TypeError);
  });
});

describe('token and signing-key shapes', () => {
  it('accepts a token of 20..4096 printable ASCII characters', () => {
    expect(isCalendlyTokenShaped('calendly-fake-' + 't'.repeat(40))).toBe(true);
    expect(isCalendlyTokenShaped('t'.repeat(20))).toBe(true);
    expect(isCalendlyTokenShaped('t'.repeat(4096))).toBe(true);
  });

  it.each([
    ['too short', 't'.repeat(19)],
    ['too long', 't'.repeat(4097)],
    ['a space', 'calendly-fake token-tttttttt'],
    ['a trailing newline', 't'.repeat(30) + '\n'],
    ['non-ASCII', 'é'.repeat(30)],
    ['the env placeholder', 'replace_me'],
    ['empty', ''],
  ])('rejects a token with %s', (_name, raw) => {
    expect(isCalendlyTokenShaped(raw)).toBe(false);
  });

  it('accepts a signing key of 16..256 printable ASCII characters', () => {
    expect(isCalendlySigningKeyShaped('calendly-fake-' + 's'.repeat(20))).toBe(true);
    expect(isCalendlySigningKeyShaped('s'.repeat(16))).toBe(true);
    expect(isCalendlySigningKeyShaped('s'.repeat(256))).toBe(true);
  });

  it.each([
    ['too short', 's'.repeat(15)],
    ['too long', 's'.repeat(257)],
    ['a space', 'calendly fake-ssssssss'],
    ['a tab', 's'.repeat(10) + '\t' + 's'.repeat(10)],
    ['the env placeholder', 'replace_me'],
    ['empty', ''],
  ])('rejects a signing key with %s', (_name, raw) => {
    expect(isCalendlySigningKeyShaped(raw)).toBe(false);
  });

  it('rejects non-strings', () => {
    for (const raw of [null, undefined, 1, {}, ['t'.repeat(30)]]) {
      expect(isCalendlyTokenShaped(raw)).toBe(false);
      expect(isCalendlySigningKeyShaped(raw)).toBe(false);
    }
  });
});
