import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guards for the Meet staff surfaces (M034 S10, dark).
 *
 * The page lists what one read answers and nothing else. These checks pin the boundaries that keep it
 * that way: no Meet link, ticket, attester, bot, session or profile field is ever named on the web side;
 * the server alone decides whether Meet is on (no env, no flag, no storage); the only request is the one
 * client method, never on a timer; every time is India time; and the route is lazy, behind sign-in,
 * inside the shell, for every staff role. Comments are stripped before matching, and every pattern has a
 * negative control, so a guard that stops catching anything goes red here and not silently green.
 */

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(resolve(ROOT, relative), 'utf8');
}

/** The source with its comments gone, as r1-structure.test.ts reads it. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * App.tsx without its comments. Not `code`: App.tsx routes `path="/mfa/*"`, and a `/*` inside a string
 * would open a "comment" that eats the routes after it. Only JSX comments and comments that start a
 * line go, which is every comment App.tsx has; its header names `requireRole="admin"`, so they must.
 */
function appCode(source: string): string {
  return source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const PAGE = 'src/pages/R1MeetBookingsPage.tsx';
const LIB = 'src/lib/r1-meet-bookings.ts';
const TYPES = 'src/lib/r1-meet-bookings-types.ts';

const FILES = [
  LIB,
  TYPES,
  PAGE,
  'src/components/r1/MeetBookingsFilters.tsx',
  'src/components/r1/MeetBookingsTable.tsx',
  'src/components/r1/ViaMeetTag.tsx',
];

interface Guard {
  what: string;
  pattern: RegExp;
  /** Text each alternative of the pattern must catch: the negative controls. */
  caught: string[];
}

const GUARDS: Guard[] = [
  {
    what: 'a field the Meet read never sends (a link, a ticket, the attester, the bot, a session, a profile)',
    pattern: /meet_url|meet\.google|ticket|recall_bot|attested_by|scheduled_by_user|session_id|objective_profile|livekit/i,
    caught: [
      'booking.meet_url',
      "'https://meet.google.com/abc-defg-hij'",
      'row.ticket_digest',
      'bridgeTicket',
      'recall_bot_id',
      'attested_by',
      'scheduled_by_user_id',
      'session_id',
      'objective_profile',
      "from 'livekit-client'",
    ],
  },
  {
    what: 'an env read or a Meet flag of its own (the server decides)',
    pattern: /import\.meta\.env|process\.env|VITE_|R1_MEET_ENABLED/,
    caught: ['import.meta.env.MODE', 'process.env.NODE_ENV', "'VITE_API_URL'", 'R1_MEET_ENABLED'],
  },
  {
    what: 'web storage, a direct fetch, a timer or raw HTML',
    pattern: /localStorage|sessionStorage|\bfetch\(|setInterval|setTimeout|dangerouslySetInnerHTML|innerHTML/,
    caught: [
      "localStorage.getItem('k')",
      "sessionStorage.setItem('k', v)",
      'fetch(url)',
      'setInterval(read, 30_000)',
      'setTimeout(read, 500)',
      'dangerouslySetInnerHTML={{ __html: x }}',
      'node.innerHTML = x',
    ],
  },
  {
    what: "a time in the host's zone (India time only)",
    pattern: /toLocale|\bget(?:Hours|Minutes|Date|Day|Month|FullYear)\(/,
    caught: [
      'when.toLocaleString()',
      'when.toLocaleDateString()',
      'when.getHours()',
      'when.getMinutes()',
      'when.getDate()',
      'when.getDay()',
      'when.getMonth()',
      'when.getFullYear()',
    ],
  },
  {
    // Lexy is the R1 interviewer (owner 2026-11-27); the old names stay off every new R1 surface.
    what: 'the retired interviewer name',
    pattern: /christy/i,
    caught: ['Christy', 'christy_voice'],
  },
  {
    // The word only: identifiers such as `dex_absent` are stored reason codes, not copy.
    what: 'the interviewer name before Lexy',
    pattern: /\bDex\b/,
    caught: ['Dex', 'Dex scheduled', 'with Dex as an interviewer'],
  },
];

describe('the Meet staff surfaces are the files this guard reads', () => {
  it('finds every one of them', () => {
    for (const file of FILES) expect(existsSync(resolve(ROOT, file)), `${file} exists`).toBe(true);
  });

  it('reads code and not comments', () => {
    const commented = "// meet_url and fetch(\n/* livekit, toLocaleString(), Christy */\nconst ok = 1;\n";
    expect(code(commented)).toBe('\n\nconst ok = 1;\n');
    // A JSX comment is a block comment too.
    expect(code('<p>{/* setInterval */}</p>')).toBe('<p>{}</p>');
  });
});

describe('the Meet staff surfaces keep to their boundary', () => {
  for (const guard of GUARDS) {
    it(`has no ${guard.what}`, () => {
      for (const control of guard.caught) {
        expect(control, `negative control: ${guard.pattern} catches ${control}`).toMatch(guard.pattern);
      }
      for (const file of FILES) {
        expect(code(read(file)), `${file} has ${guard.what}`).not.toMatch(guard.pattern);
      }
    });
  }

  const API_MEMBER = /\bapi\.(\w+)/g;
  const API_IMPORT = /from '(?:\.\.\/)+api'|from '\.\/api'/;
  const API_PATH = /['"`]\/api\//;

  it('the page makes one kind of request, through the one client method', () => {
    const members = (source: string) => [...new Set([...source.matchAll(API_MEMBER)].map((match) => match[1]))];
    // Negative control: the extractor sees every member called.
    expect(members('api.getR1Review(id); api.listR1MeetBookings(q); apiErrorCopy(e)')).toEqual([
      'getR1Review',
      'listR1MeetBookings',
    ]);
    const page = code(read(PAGE));
    expect(page).toMatch(/import \{ api \} from '\.\.\/api';/);
    expect(members(page)).toEqual(['listR1MeetBookings']);
  });

  it('no other file of these calls the API, and only the client names its path', () => {
    expect("import { api } from '../../api';").toMatch(API_IMPORT);
    expect("import { api } from './api';").toMatch(API_IMPORT);
    expect("import { ApiError } from './api-client';").not.toMatch(API_IMPORT);
    expect("request('/api/interview-rounds/meet-bookings')").toMatch(API_PATH);
    for (const file of FILES.filter((name) => name !== PAGE)) {
      const source = code(read(file));
      expect(source, `${file} imports the api module`).not.toMatch(API_IMPORT);
      expect([...source.matchAll(API_MEMBER)], `${file} calls the api module`).toEqual([]);
    }
    for (const file of FILES.filter((name) => name !== LIB)) {
      expect(code(read(file)), `${file} hard-codes an API path`).not.toMatch(API_PATH);
    }
    expect(code(read(LIB))).toContain("R1_MEET_BOOKINGS_PATH = '/api/interview-rounds/meet-bookings'");
  });

  it('keeps the wire shapes free of runtime imports, so the e2e harness can read them', () => {
    expect('import { x } from "./y";').toMatch(/^\s*import\b/m);
    expect(code(read(TYPES))).not.toMatch(/^\s*import\b/m);
  });

  it('reads the answer through the strict reader, in api.ts', () => {
    expect(read('src/api.ts')).toMatch(
      /listR1MeetBookings: \(query: R1MeetBookingsQuery = \{\}\) =>\s*request<unknown>\(r1MeetBookingsPath\(query\)\)\.then\(readR1MeetBookings\)/,
    );
  });
});

describe('the Meet bookings route', () => {
  const ROUTE = 'path="/interviews/meet-bookings"';
  const LAZY = "lazyPage(() => import('./pages/R1MeetBookingsPage'), 'R1MeetBookingsPage')";

  /** Why the route is not where it must be, or null: lazy, once, behind sign-in, inside the shell, for every role. */
  function misplacement(app: string): string | null {
    const source = appCode(app);
    if (source.split(ROUTE).length - 1 !== 1) return 'the path is not routed exactly once';
    if (source.split(LAZY).length - 1 !== 1) return 'the page is not lazy';
    if (/import \{[^}]*\bR1MeetBookingsPage\b[^}]*\} from/.test(source)) return 'the page is imported eagerly';
    const route = source.indexOf(ROUTE);
    const signedIn = source.indexOf('<ProtectedRoute />');
    const shell = source.indexOf('<Layout />', signedIn);
    // The second sign-in block is the scoped Ashby review, outside the shell; then the admin block.
    const outsideShell = source.indexOf('<ProtectedRoute />', signedIn + 1);
    const adminOnly = source.indexOf('requireRole="admin"');
    if (signedIn < 0 || shell < 0 || adminOnly < 0) return 'the route blocks are not found';
    if (!(signedIn < shell && shell < route)) return 'the route is not behind sign-in, inside the shell';
    if (!(outsideShell < 0 || route < outsideShell) || !(route < adminOnly)) return 'the route is outside the staff block';
    const line = source.slice(source.lastIndexOf('\n', route), source.indexOf('\n', route));
    if (/requireRole/.test(line)) return 'the route is held to one role';
    return null;
  }

  it('is lazy, routed once, behind sign-in and inside the shell, for every staff role', () => {
    expect(misplacement(read('src/App.tsx'))).toBeNull();
  });

  it('strips App.tsx comments without touching a route that names a wildcard', () => {
    const sample = '/** header requireRole="admin" */\n<Route path="/a/*" />\n<Route path="/b" />\n{/* note */}\n// line\n';
    expect(appCode(sample)).toBe('\n<Route path="/a/*" />\n<Route path="/b" />\n\n\n');
    // Negative control: the naive strip eats from the wildcard to the next comment's end.
    expect(code(sample)).not.toContain('path="/b"');

    const stripped = appCode(read('src/App.tsx'));
    expect(stripped).not.toContain('{/*');
    expect(stripped).not.toMatch(/^[ \t]*\/\*/m);
    // Only the admin block itself is left, not a comment that describes it.
    expect(stripped.split('requireRole="admin"').length - 1).toBe(1);
  });

  it('notices each way it could be misplaced (negative controls)', () => {
    const app = read('src/App.tsx');
    const routeLine = app.split('\n').find((line) => line.includes(ROUTE))!;
    expect(routeLine).toBeDefined();
    const eagerImport = "import { NotFoundPage } from './pages/NotFoundPage';\nimport { R1MeetBookingsPage } from './pages/R1MeetBookingsPage';";

    const twice = app.replace(routeLine, `${routeLine}\n${routeLine}`);
    expect(misplacement(twice)).toBe('the path is not routed exactly once');

    const notLazy = app
      .replace(`const R1MeetBookingsPage = ${LAZY};`, '')
      .replace("import { NotFoundPage } from './pages/NotFoundPage';", eagerImport);
    expect(misplacement(notLazy)).toBe('the page is not lazy');

    const alsoEager = app.replace("import { NotFoundPage } from './pages/NotFoundPage';", eagerImport);
    expect(misplacement(alsoEager)).toBe('the page is imported eagerly');

    const adminOnly = app
      .replace(`${routeLine}\n`, '')
      .replace('<Route path="/admin/r1" element={<R1SettingsPage />} />', `<Route path="/admin/r1" element={<R1SettingsPage />} />\n${routeLine}`);
    expect(misplacement(adminOnly)).toBe('the route is outside the staff block');

    const oneRole = app.replace(ROUTE, `${ROUTE} requireRole="viewer"`);
    expect(misplacement(oneRole)).toBe('the route is held to one role');
  });
});
