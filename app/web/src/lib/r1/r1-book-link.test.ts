import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureManageToken,
  isManageToken,
  R1_BOOK_MANAGE_PATH,
  R1_BOOK_PATH,
} from './r1-book-link';

/**
 * The manage token of `/book/manage#m=<token>` (M035 S07, decision D-S07-M14): read from the
 * fragment only, the address bar reset to `/book/manage` at once in every case (before the token
 * is validated), and nothing stored. The token is built at run time (gitleaks).
 */

/** 32 random bytes as base64url without padding: 43 characters. */
const TOKEN = `${'A'.repeat(20)}-_${'z9'.repeat(10)}q`;

const STORAGE_METHODS = ['setItem', 'getItem', 'removeItem', 'clear', 'key'] as const;

function spyStorage() {
  return STORAGE_METHODS.map((method) => vi.spyOn(Storage.prototype, method));
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the booking paths', () => {
  it('serves the public booking pages at /book and /book/manage', () => {
    expect(R1_BOOK_PATH).toBe('/book');
    expect(R1_BOOK_MANAGE_PATH).toBe('/book/manage');
  });
});

describe('isManageToken', () => {
  it('accepts exactly 43 base64url characters', () => {
    expect(TOKEN).toHaveLength(43);
    expect(isManageToken(TOKEN)).toBe(true);
    expect(isManageToken('m'.repeat(43))).toBe(true);
  });

  it.each([
    ['42 characters', 'm'.repeat(42)],
    ['44 characters', 'm'.repeat(44)],
    ['a plus', `${'m'.repeat(42)}+`],
    ['a slash', `${'m'.repeat(42)}/`],
    ['padding', `${'m'.repeat(42)}=`],
    ['a dot', `${'m'.repeat(42)}.`],
    ['a space', `${'m'.repeat(42)} `],
    ['an empty string', ''],
  ])('refuses %s', (_name, value) => {
    expect(isManageToken(value)).toBe(false);
  });

  it.each([[null], [undefined], [43], [{}], [['m'.repeat(43)]]])('refuses a non-string %j', (value) => {
    expect(isManageToken(value)).toBe(false);
  });
});

describe('captureManageToken', () => {
  const expectStripped = () => {
    expect(window.location.pathname).toBe('/book/manage');
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
  };

  it('returns a well-formed token from #m= and strips the URL to the bare manage path', () => {
    window.history.replaceState(null, '', `/book/manage#m=${TOKEN}`);
    expect(captureManageToken()).toBe(TOKEN);
    expectStripped();
  });

  it('accepts the token beside other fragment keys, and only from m', () => {
    window.history.replaceState(null, '', `/book/manage#v=1&m=${TOKEN}`);
    expect(captureManageToken()).toBe(TOKEN);
    expectStripped();
  });

  it('strips a query string with the fragment', () => {
    window.history.replaceState(null, '', `/book/manage?utm=1#m=${TOKEN}`);
    expect(captureManageToken()).toBe(TOKEN);
    expectStripped();
  });

  const BAD: Array<[string, string]> = [
    ['no fragment', ''],
    ['an empty fragment', '#'],
    ['an empty m', '#m='],
    ['42 characters', `#m=${TOKEN.slice(0, 42)}`],
    ['44 characters', `#m=${TOKEN}x`],
    ['a plus (read as a space)', `#m=${TOKEN.slice(0, 42)}+`],
    ['a slash', `#m=${TOKEN.slice(0, 42)}/`],
    ['padding', `#m=${TOKEN.slice(0, 42)}=`],
    ['a dot', `#m=${TOKEN.slice(0, 42)}.`],
    ['a percent-encoded slash', `#m=${TOKEN.slice(0, 40)}%2F`],
    ['undecodable percent-encoding', '#m=%E0%A4%A'],
    ['the token without m=', `#${TOKEN}`],
    ['the wrong key', `#t=${TOKEN}`],
    ['the token in the query only', `?m=${TOKEN}`],
  ];

  it.each(BAD)('returns null for %s and still strips the URL', (_name, suffix) => {
    window.history.replaceState(null, '', `/book/manage${suffix}`);
    expect(captureManageToken()).toBeNull();
    expectStripped();
  });

  it.each([[`#m=${TOKEN}`], ...BAD.map(([, suffix]) => [suffix])])(
    'resets the address bar exactly once, to /book/manage, for %j',
    (suffix) => {
      window.history.replaceState(null, '', `/book/manage${suffix}`);
      const replaceState = vi.spyOn(window.history, 'replaceState');
      captureManageToken();
      expect(replaceState).toHaveBeenCalledTimes(1);
      expect(replaceState).toHaveBeenCalledWith(null, '', '/book/manage');
    },
  );

  it.each([[`#m=${TOKEN}`], ['#m=short'], ['']])(
    'strips the address bar before it validates the token, for %j',
    (suffix) => {
      window.history.replaceState(null, '', `/book/manage${suffix}`);
      const order: string[] = [];
      const realTest = RegExp.prototype.test;
      const strip = vi.spyOn(window.history, 'replaceState').mockImplementation(() => {
        order.push('strip');
      });
      const validate = vi
        .spyOn(RegExp.prototype, 'test')
        .mockImplementation(function (this: RegExp, input: string) {
          if (this.source === '^[A-Za-z0-9_-]{43}$') order.push('validate');
          return realTest.call(this, input);
        });
      const result = captureManageToken();
      validate.mockRestore();
      strip.mockRestore();
      expect(result).toBe(suffix === `#m=${TOKEN}` ? TOKEN : null);
      expect(order).toEqual(['strip', 'validate']);
    },
  );

  it('works on the window it is given', () => {
    const replaceState = vi.fn();
    const fake = {
      location: { hash: `#m=${TOKEN}` },
      history: { replaceState },
    } as unknown as Window;
    expect(captureManageToken(fake)).toBe(TOKEN);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/book/manage');
  });

  it.each([[`#m=${TOKEN}`], ['#m=short'], ['']])('touches no web storage, for %j', (suffix) => {
    window.history.replaceState(null, '', `/book/manage${suffix}`);
    const spies = spyStorage();
    captureManageToken();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
