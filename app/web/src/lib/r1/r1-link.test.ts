import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './r1-digest';
import {
  captureLinkToken,
  captureMeetTicket,
  clearNonce,
  isLinkToken,
  isMeetTicket,
  isNonce,
  linkDigest,
  R1_MEET_PATH,
  R1_NONCE_STORAGE_KEY,
  readNonce,
  saveNonce,
} from './r1-link';

const TOKEN = 'ab12'.repeat(16);
const OTHER_TOKEN = 'cd34'.repeat(16);
const NONCE = 'nonce_value-0123456789abcdef';
/** The server mints 32 random bytes as base64url: 43 characters. */
const TICKET = 'meet-ticket-not-a-secret_0123456789ABCDEFxy';

afterEach(() => {
  vi.restoreAllMocks();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('captureLinkToken', () => {
  it('returns a well-formed token and strips the fragment', () => {
    window.history.replaceState(null, '', `/candidate/r1#${TOKEN}`);
    expect(captureLinkToken()).toBe(TOKEN);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/candidate/r1');
  });

  it.each([
    ['a missing fragment', ''],
    ['a short token', '#abc123'],
    ['uppercase hex', `#${TOKEN.toUpperCase()}`],
    ['non-hex characters', `#${'z'.repeat(64)}`],
    ['malformed percent-encoding', '#%E0%A4%A'],
  ])('returns null for %s and still strips the fragment', (_name, hash) => {
    window.history.replaceState(null, '', `/candidate/r1${hash}`);
    expect(captureLinkToken()).toBeNull();
    expect(window.location.hash).toBe('');
  });

  it('never leaves the token in the URL, even as a query', () => {
    window.history.replaceState(null, '', `/candidate/r1?x=1#${TOKEN}`);
    captureLinkToken();
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.search).toBe('');
  });

  it('is single-use: a second capture finds nothing', () => {
    window.history.replaceState(null, '', `/candidate/r1#${TOKEN}`);
    expect(captureLinkToken()).toBe(TOKEN);
    expect(captureLinkToken()).toBeNull();
  });
});

describe('token shapes', () => {
  it('accepts 64 lowercase hex characters only', () => {
    expect(isLinkToken(TOKEN)).toBe(true);
    expect(isLinkToken(TOKEN.slice(1))).toBe(false);
    expect(isLinkToken(`${TOKEN}0`)).toBe(false);
  });

  it('accepts a conservative nonce alphabet', () => {
    expect(isNonce(NONCE)).toBe(true);
    expect(isNonce('short')).toBe(false);
    expect(isNonce(`${NONCE}!`)).toBe(false);
    expect(isNonce(`<script>${NONCE}`)).toBe(false);
  });
});

describe('nonce storage', () => {
  it('round-trips through sessionStorage under one key, for the same link', () => {
    saveNonce(TOKEN, NONCE);
    expect(window.sessionStorage.getItem(R1_NONCE_STORAGE_KEY)).not.toBeNull();
    expect(readNonce(TOKEN)).toBe(NONCE);
    clearNonce();
    expect(readNonce(TOKEN)).toBeNull();
  });

  it('stores the nonce beside a short digest of its link, never the token itself', () => {
    window.history.replaceState(null, '', `/candidate/r1#${TOKEN}`);
    captureLinkToken();
    saveNonce(TOKEN, NONCE);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
    const raw = window.sessionStorage.getItem(R1_NONCE_STORAGE_KEY) ?? '';
    expect(JSON.parse(raw)).toEqual({ l: linkDigest(TOKEN), n: NONCE });
    expect(linkDigest(TOKEN)).toBe(sha256Hex(TOKEN).slice(0, 16));
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(sha256Hex(TOKEN));
  });

  it('refuses to save a malformed nonce or link, and ignores a tampered stored entry', () => {
    saveNonce(TOKEN, 'bad nonce');
    saveNonce('not-a-token', NONCE);
    expect(window.sessionStorage.length).toBe(0);
    for (const tampered of [
      '<b>x</b>',
      NONCE,
      '[]',
      'null',
      JSON.stringify({ l: linkDigest(TOKEN), n: '<b>x</b>' }),
      JSON.stringify({ l: 'ZZZZ', n: NONCE }),
      JSON.stringify({ l: linkDigest(TOKEN) }),
    ]) {
      window.sessionStorage.setItem(R1_NONCE_STORAGE_KEY, tampered);
      expect(readNonce(TOKEN), tampered).toBeNull();
    }
  });

  it('works without storage: every access is guarded', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveNonce(TOKEN, NONCE)).not.toThrow();
    expect(readNonce(TOKEN)).toBeNull();
    expect(() => clearNonce()).not.toThrow();
    window.history.replaceState(null, '', `/candidate/r1#${TOKEN}`);
    expect(captureLinkToken()).toBe(TOKEN);
    getItem.mockRestore();
    setItem.mockRestore();
    removeItem.mockRestore();
  });
});

describe('a nonce belongs to one link', () => {
  it('is never returned for a different link', () => {
    saveNonce(TOKEN, NONCE);
    expect(readNonce(OTHER_TOKEN)).toBeNull();
    expect(readNonce(TOKEN)).toBe(NONCE);
  });

  it('is discarded when a different link is captured in the same tab', () => {
    saveNonce(TOKEN, NONCE);
    window.history.replaceState(null, '', `/candidate/r1#${OTHER_TOKEN}`);
    expect(captureLinkToken()).toBe(OTHER_TOKEN);
    expect(window.sessionStorage.getItem(R1_NONCE_STORAGE_KEY)).toBeNull();
    expect(readNonce(TOKEN)).toBeNull();
    expect(readNonce(OTHER_TOKEN)).toBeNull();
  });

  it('survives capturing the same link again', () => {
    saveNonce(TOKEN, NONCE);
    window.history.replaceState(null, '', `/candidate/r1#${TOKEN}`);
    expect(captureLinkToken()).toBe(TOKEN);
    expect(readNonce(TOKEN)).toBe(NONCE);
  });

  it('is left alone when the page is opened with no usable fragment', () => {
    saveNonce(TOKEN, NONCE);
    window.history.replaceState(null, '', '/candidate/r1');
    expect(captureLinkToken()).toBeNull();
    expect(readNonce(TOKEN)).toBe(NONCE);
  });

  it('discards an entry left in the old bare-nonce format', () => {
    window.sessionStorage.setItem(R1_NONCE_STORAGE_KEY, NONCE);
    window.history.replaceState(null, '', `/candidate/r1#${TOKEN}`);
    captureLinkToken();
    expect(window.sessionStorage.getItem(R1_NONCE_STORAGE_KEY)).toBeNull();
  });
});

describe('captureMeetTicket (the Meet bridge, M034 S07)', () => {
  const expectStripped = () => {
    expect(window.location.pathname).toBe(R1_MEET_PATH);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(TICKET);
  };

  it('is served at /candidate/r1/meet', () => {
    expect(R1_MEET_PATH).toBe('/candidate/r1/meet');
  });

  it('returns a well-formed ticket from #t= and strips the URL to the bare Meet path', () => {
    window.history.replaceState(null, '', `/candidate/r1/meet#t=${TICKET}`);
    expect(captureMeetTicket()).toBe(TICKET);
    expectStripped();
  });

  it.each([
    ['a missing fragment', ''],
    ['an empty fragment', '#'],
    ['an empty ticket', '#t='],
    ['a short ticket', `#t=${TICKET.slice(0, 31)}`],
    ['a ticket that is too long', `#t=${'a'.repeat(129)}`],
    ['a character outside base64url', `#t=${TICKET.slice(0, 40)}+/=`],
    ['a percent-encoded character', `#t=${TICKET.slice(0, 40)}%2F`],
    ['undecodable percent-encoding', '#t=%E0%A4%A'],
    ['undecodable percent-encoding around a ticket', `#t=${TICKET}%E0%A4%A`],
    ['the wrong key', `#x=${TICKET}`],
    ['a bare ticket without t=', `#${TICKET}`],
    ['a link token', `#${TOKEN}`],
  ])('returns null for %s and still strips the URL', (_name, hash) => {
    window.history.replaceState(null, '', `/candidate/r1/meet${hash}`);
    expect(captureMeetTicket()).toBeNull();
    expectStripped();
  });

  it('strips a query string with the fragment', () => {
    window.history.replaceState(null, '', `/candidate/r1/meet?x=1#t=${TICKET}`);
    expect(captureMeetTicket()).toBe(TICKET);
    expectStripped();
  });

  it('accepts the ticket beside other fragment keys, and only from t', () => {
    window.history.replaceState(null, '', `/candidate/r1/meet#v=1&t=${TICKET}`);
    expect(captureMeetTicket()).toBe(TICKET);
    expectStripped();
  });

  it.each([`#t=${TICKET}`, '#t=short', ''])(
    'resets the address bar exactly once, to the bare Meet path, for %j',
    (hash) => {
      window.history.replaceState(null, '', `/candidate/r1/meet${hash}`);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      captureMeetTicket();
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(null, '', '/candidate/r1/meet');
    },
  );

  it('is single-use: a second capture finds nothing', () => {
    window.history.replaceState(null, '', `/candidate/r1/meet#t=${TICKET}`);
    expect(captureMeetTicket()).toBe(TICKET);
    expect(captureMeetTicket()).toBeNull();
  });

  it('touches no storage at all, and leaves a stored link nonce alone', () => {
    saveNonce(TOKEN, NONCE);
    const touched = [
      vi.spyOn(Storage.prototype, 'getItem'),
      vi.spyOn(Storage.prototype, 'setItem'),
      vi.spyOn(Storage.prototype, 'removeItem'),
      vi.spyOn(Storage.prototype, 'clear'),
      vi.spyOn(Storage.prototype, 'key'),
    ];
    for (const hash of [`#t=${TICKET}`, '#t=short', '', `#${TOKEN}`]) {
      window.history.replaceState(null, '', `/candidate/r1/meet${hash}`);
      captureMeetTicket();
    }
    for (const spy of touched) expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    expect(readNonce(TOKEN)).toBe(NONCE);
    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(TICKET);
  });

  it('reads the window it is given', () => {
    const replaceState = vi.fn();
    const fake = {
      location: { hash: `#t=${TICKET}` },
      history: { replaceState },
    } as unknown as Window;
    expect(captureMeetTicket(fake)).toBe(TICKET);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/candidate/r1/meet');
  });
});

describe('Meet ticket shape', () => {
  it('accepts 32 to 128 base64url characters only', () => {
    expect(isMeetTicket(TICKET)).toBe(true);
    expect(TICKET).toHaveLength(43);
    expect(isMeetTicket('a'.repeat(32))).toBe(true);
    expect(isMeetTicket('a'.repeat(128))).toBe(true);
    expect(isMeetTicket('a'.repeat(31))).toBe(false);
    expect(isMeetTicket('a'.repeat(129))).toBe(false);
    for (const bad of [`${TICKET}=`, `${TICKET}+`, `${TICKET}/`, `${TICKET} `, `<b>${TICKET}`, '']) {
      expect(isMeetTicket(bad), bad).toBe(false);
    }
  });
});
