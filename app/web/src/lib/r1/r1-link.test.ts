import { afterEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './r1-digest';
import {
  captureLinkToken,
  clearNonce,
  isLinkToken,
  isNonce,
  linkDigest,
  R1_NONCE_STORAGE_KEY,
  readNonce,
  saveNonce,
} from './r1-link';

const TOKEN = 'ab12'.repeat(16);
const OTHER_TOKEN = 'cd34'.repeat(16);
const NONCE = 'nonce_value-0123456789abcdef';

afterEach(() => {
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
