/**
 * zod 4 compatibility layer for the API's validation contract.
 *
 * The API moved from zod 3 to zod 4 for GHSA-mrhx-c7xc-m3w5 (unbounded issue
 * accumulation on oversized arrays, fixed in 4.6.6). zod 4 renamed several
 * issue codes and rewrote every default message, and both reach API clients
 * through `error.details[]` ({ field, code, message }) in lib/validation.ts.
 * This module keeps that contract byte-for-byte where zod 3 defined it:
 *
 *  1. `installZod3Messages()` registers a global `customError` that rebuilds
 *     zod 3's English default messages ("Required", "Invalid uuid",
 *     "String must contain at least 1 character(s)", ...). It ranks BELOW any
 *     message a schema sets itself, so every custom message in src/schemas is
 *     untouched; it only replaces zod 4's defaults.
 *  2. `toZod3Issues()` maps zod 4 issues back to zod 3 codes
 *     (invalid_format -> invalid_string, invalid_value -> invalid_enum_value /
 *     invalid_literal / invalid_type) and flattens zod 4's `invalid_key`
 *     record-key wrapper into the inner issue zod 3 reported.
 *  3. The format helpers below pin zod 3's exact UUID, ISO-datetime and IP
 *     acceptance. zod 4's equivalents are stricter (`z.uuid()` is RFC 9562
 *     version/variant-strict, `z.iso.datetime()` requires seconds, and the
 *     IPv6 pattern drops IPv4-mapped and zone-id forms), so swapping them in
 *     silently would reject ids and timestamps clients send today.
 *  4. `zod3Int()` replaces `.int()`, whose zod 4 form rejects integers above
 *     2^53 and stops later checks after a non-integer.
 *
 * Two zod 4 behaviours are kept on purpose (see zod-compat.test.ts): an array
 * longer than its `.max()` reports only the length issue (the advisory fix),
 * and ±Infinity is refused by `z.number()` itself ("Number must be finite").
 *
 * The regex sources are copied verbatim from zod@3.25.76 (src/types.ts).
 */
import { z } from 'zod';

// ── zod 3 format patterns ─────────────────────────────────────────────

/** zod 3 `z.string().uuid()`: any 8-4-4-4-12 hex string, no version/variant check. */
export const ZOD3_UUID_RE =
  /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;

const ZOD3_DATE_SOURCE =
  '((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))';

/**
 * zod 3 `z.string().datetime()` with no options: a real calendar date, `T`,
 * HH:MM with OPTIONAL seconds and any fractional precision, and a literal `Z`
 * (no offset, no local time).
 */
export const ZOD3_DATETIME_RE = new RegExp(
  `^${ZOD3_DATE_SOURCE}T([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d+)?)?(Z)$`,
);

const ZOD3_IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ZOD3_IPV6_RE =
  /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;

/** zod 3 `z.string().ip()` with no version: IPv4 or IPv6. */
export const ZOD3_IP_RE = new RegExp(`(?:${ZOD3_IPV4_RE.source})|(?:${ZOD3_IPV6_RE.source})`);

// The default messages zod 3 produced for these formats. They are passed as
// the check's own message, so `toZod3Issues` reports them as `invalid_string`.
const ZOD3_UUID_MESSAGE = 'Invalid uuid';
const ZOD3_DATETIME_MESSAGE = 'Invalid datetime';
const ZOD3_IP_MESSAGE = 'Invalid ip';

/**
 * Drop-in for zod 3 `z.string().uuid(message?)`: same acceptance as zod 3 and
 * as Postgres `uuid`. The message belongs to the format check only, so a
 * non-string still reports zod 3's "Expected string, received ..." (zod 4's
 * `z.guid(message)` would put the message on the type error too).
 */
export function zod3Uuid(message?: string) {
  return z.string().regex(ZOD3_UUID_RE, { error: message ?? ZOD3_UUID_MESSAGE });
}

/** Drop-in for zod 3 `z.string().datetime(message?)`. */
export function zod3Datetime(message?: string) {
  return z.string().regex(ZOD3_DATETIME_RE, { error: message ?? ZOD3_DATETIME_MESSAGE });
}

/** Drop-in for zod 3 `z.string().ip(message?)`. */
export function zod3Ip(message?: string) {
  return z.string().regex(ZOD3_IP_RE, { error: message ?? ZOD3_IP_MESSAGE });
}

/**
 * Drop-in for zod 3 `.int(message?)`, applied as `.check(zod3Int())`.
 *
 * zod 4's `.int()` admits only SAFE integers (|n| <= 2^53 - 1) and stops the
 * remaining checks once a value is not an integer. zod 3 used
 * `Number.isInteger` and kept checking, so `0.5` against `.int().min(1)`
 * reported both issues. This check reproduces that exactly: the same values
 * pass, and the issue is continuable so later `.min()`/`.max()` still run.
 */
export function zod3Int(message?: string) {
  return z.check<number>((ctx) => {
    if (Number.isInteger(ctx.value)) return;
    ctx.issues.push({
      code: 'invalid_type',
      expected: 'integer',
      input: ctx.value,
      continue: true,
      ...(message === undefined ? {} : { message }),
    });
  });
}

// ── zod 3 default messages ────────────────────────────────────────────

/** zod 3's `getParsedType` names, used in "Expected X, received Y". */
export function zod3ParsedType(value: unknown): string {
  switch (typeof value) {
    case 'undefined':
      return 'undefined';
    case 'string':
      return 'string';
    case 'number':
      return Number.isNaN(value) ? 'nan' : 'number';
    case 'boolean':
      return 'boolean';
    case 'function':
      return 'function';
    case 'bigint':
      return 'bigint';
    case 'symbol':
      return 'symbol';
    case 'object':
      if (Array.isArray(value)) return 'array';
      if (value === null) return 'null';
      if (typeof (value as { then?: unknown }).then === 'function'
        && typeof (value as { catch?: unknown }).catch === 'function') return 'promise';
      if (value instanceof Map) return 'map';
      if (value instanceof Set) return 'set';
      if (value instanceof Date) return 'date';
      return 'object';
    default:
      return 'unknown';
  }
}

/** zod 3 `util.joinValues`: strings single-quoted, joined by " | ". */
function joinValues(values: readonly unknown[], separator = ' | '): string {
  return values.map((v) => (typeof v === 'string' ? `'${v}'` : String(v))).join(separator);
}

/** zod 4 reports `expected` with its own type names; these differ from zod 3's. */
function zod3Expected(expected: string): string {
  if (expected === 'int') return 'integer';
  if (expected === 'record') return 'object';
  return expected;
}

type RawIssue = Record<string, unknown> & {
  code?: string;
  input?: unknown;
  inst?: { _zod?: { def?: { type?: string } } };
};

function isLiteralIssue(issue: RawIssue): boolean {
  return issue.inst?._zod?.def?.type === 'literal';
}

function sizeMessage(kind: 'too_small' | 'too_big', issue: RawIssue): string {
  const origin = issue.origin;
  const exact = issue.exact === true;
  const inclusive = issue.inclusive === true;
  if (kind === 'too_small') {
    const min = String(issue.minimum);
    if (origin === 'array' || origin === 'set') {
      return `Array must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'more than'} ${min} element(s)`;
    }
    if (origin === 'string') {
      return `String must contain ${exact ? 'exactly' : inclusive ? 'at least' : 'over'} ${min} character(s)`;
    }
    if (origin === 'number' || origin === 'bigint') {
      return `Number must be ${exact ? 'exactly equal to ' : inclusive ? 'greater than or equal to ' : 'greater than '}${min}`;
    }
    return 'Invalid input';
  }
  const max = String(issue.maximum);
  if (origin === 'array' || origin === 'set') {
    return `Array must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'less than'} ${max} element(s)`;
  }
  if (origin === 'string') {
    return `String must contain ${exact ? 'exactly' : inclusive ? 'at most' : 'under'} ${max} character(s)`;
  }
  if (origin === 'number') {
    return `Number must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${max}`;
  }
  if (origin === 'bigint') {
    return `BigInt must be ${exact ? 'exactly' : inclusive ? 'less than or equal to' : 'less than'} ${max}`;
  }
  return 'Invalid input';
}

/**
 * zod 3's English default message for a zod 4 raw issue. Only reached when the
 * schema (or check) did not set a message of its own.
 */
export function zod3DefaultMessage(issue: RawIssue): string {
  switch (issue.code) {
    case 'invalid_type': {
      const input = issue.input;
      if (input === undefined) return 'Required';
      if (issue.expected === 'number' && typeof input === 'number' && !Number.isNaN(input)) {
        // zod 4 rejects ±Infinity in z.number() itself; zod 3 only did so in
        // .finite(), whose message this is.
        return 'Number must be finite';
      }
      const expected = zod3Expected(String(issue.expected));
      // zod 3's .int() failure read "Expected integer, received float".
      const received = expected === 'integer' && typeof input === 'number' ? 'float' : zod3ParsedType(input);
      return `Expected ${expected}, received ${received}`;
    }
    case 'invalid_value': {
      const values = (issue.values as unknown[] | undefined) ?? [];
      if (isLiteralIssue(issue)) {
        return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
      }
      // zod 3 z.enum: a non-string input failed its type check first.
      if (issue.input === undefined) return 'Required';
      if (typeof issue.input !== 'string') {
        return `Expected ${joinValues(values)}, received ${zod3ParsedType(issue.input)}`;
      }
      return `Invalid enum value. Expected ${joinValues(values)}, received '${issue.input}'`;
    }
    case 'invalid_format': {
      const format = String(issue.format);
      if (format === 'regex') return 'Invalid';
      if (format === 'guid' || format === 'uuid') return ZOD3_UUID_MESSAGE;
      return `Invalid ${format}`;
    }
    case 'too_small':
    case 'too_big':
      return sizeMessage(issue.code, issue);
    case 'unrecognized_keys':
      return `Unrecognized key(s) in object: ${joinValues((issue.keys as unknown[] | undefined) ?? [], ', ')}`;
    case 'not_multiple_of':
      return `Number must be a multiple of ${String(issue.divisor)}`;
    case 'invalid_union':
    case 'custom':
    default:
      return 'Invalid input';
  }
}

let installed = false;

/**
 * Register zod 3's default messages process-wide. Idempotent. Messages are
 * resolved when an issue is raised, so this must run before the first parse;
 * lib/validation.ts calls it at import, and every route that surfaces zod
 * issues to a client imports lib/validation.ts.
 */
export function installZod3Messages(): void {
  if (installed) return;
  installed = true;
  z.config({ customError: (issue) => zod3DefaultMessage(issue as unknown as RawIssue) });
}

// ── zod 3 issue codes ─────────────────────────────────────────────────

export interface Zod3IssueLike {
  path: PropertyKey[];
  code: string;
  message: string;
}

function zod3Code(issue: z.core.$ZodIssue & { input?: unknown }): string {
  switch (issue.code) {
    case 'invalid_format':
      return 'invalid_string';
    case 'invalid_value': {
      // zod 4 folds z.literal and z.enum into one code. A literal carries its
      // one value; every z.enum in src/schemas has two or more members.
      if (issue.values.length === 1) return 'invalid_literal';
      return 'input' in issue && typeof issue.input !== 'string' ? 'invalid_type' : 'invalid_enum_value';
    }
    case 'invalid_type':
      if (issue.expected === 'number' && typeof issue.input === 'number' && !Number.isNaN(issue.input)) {
        return 'not_finite';
      }
      return 'invalid_type';
    default:
      return issue.code;
  }
}

const pathKey = (path: readonly PropertyKey[]) => JSON.stringify(path.map(String));
const isDescendant = (child: readonly PropertyKey[], parent: readonly PropertyKey[]) =>
  child.length > parent.length && parent.every((k, i) => k === child[i]);

/**
 * Map a zod 4 error to the zod 3 issue list the API has always returned.
 *
 * Besides renaming codes (see `zod3Code`) it undoes two ordering/shape
 * differences in zod 4's output:
 *  - zod 3 checked an array's length BEFORE parsing its elements, so the
 *    array's too_small/too_big came first; zod 4 reports it after them.
 *  - zod 3 stopped at a type error. zod 4 still runs a length check on any
 *    input with a `.length` (a string given to `z.array().min(2)` also gets
 *    "too_small"), which zod 3 never reported.
 *
 * Pass the error from a parse run with `{ reportInput: true }` so enum type
 * failures keep zod 3's `invalid_type` code; without input they read as
 * `invalid_enum_value`.
 */
export function toZod3Issues(error: z.ZodError): Zod3IssueLike[] {
  type Entry = Zod3IssueLike & { origin?: unknown };
  const flat: Entry[] = [];
  const visit = (issues: readonly z.core.$ZodIssue[], prefix: PropertyKey[]) => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path];
      if (issue.code === 'invalid_key') {
        // zod 3 reported a failing record key as the key schema's own issue,
        // at the key's path.
        visit(issue.issues, path);
        continue;
      }
      flat.push({
        path,
        code: zod3Code(issue),
        message: issue.message,
        origin: 'origin' in issue ? issue.origin : undefined,
      });
    }
  };
  visit(error.issues, []);

  // Linear in the number of issues: an unbounded array in a 1 MB body can
  // carry hundreds of thousands of them.
  const out: Entry[] = [];
  const typeErrorAt = new Set<string>();
  for (const entry of flat) {
    const isSize = entry.code === 'too_small' || entry.code === 'too_big';
    // Length checks only: a numeric bound after zod3Int's (continuable)
    // integer issue is one zod 3 reported too.
    const isLength = isSize && entry.origin !== 'number' && entry.origin !== 'bigint';
    if (isLength && typeErrorAt.has(pathKey(entry.path))) continue;
    if (entry.code === 'invalid_type') typeErrorAt.add(pathKey(entry.path));
    if (isSize && entry.origin === 'array') {
      // zod 4 appends an array's own checks right after that array's element
      // issues, so they are the contiguous run just before it.
      let at = out.length;
      while (at > 0 && isDescendant(out[at - 1]!.path, entry.path)) at--;
      if (at !== out.length) {
        out.splice(at, 0, entry);
        continue;
      }
    }
    out.push(entry);
  }
  return out.map(({ path, code, message }) => ({ path, code, message }));
}
