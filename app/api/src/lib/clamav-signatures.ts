/**
 * clamav-signatures.ts — machine-readable ClamAV signature freshness.
 *
 * WHY THIS EXISTS
 * ---------------
 * `clamscan` exits 0 for a clean file even when its virus database is months
 * old; the only hint is a localized warning on stderr ("virus database is older
 * than 7 days"). Trusting that exit code means accepting uploads that were
 * never really screened, and matching on the warning text is brittle (it is
 * translated, reworded between releases, and absent below ClamAV's own 7-day
 * threshold — which is far more permissive than we want).
 *
 * Every ClamAV database file (`main`/`daily`/`bytecode`, in either `.cvd`
 * container or `.cld` incremental form) begins with a 512-byte ASCII header:
 *
 *   ClamAV-VDB:18 Aug 2026 06-27 +0000:28096:355605:90:<md5>:<dsig>:<builder>:1787034460
 *   ^0         ^1                       ^2    ^3     ^4 ^5     ^6      ^7       ^8
 *
 * Field 8 is the build time in **seconds since the Unix epoch** — an integer,
 * with no locale, no month names, and no timezone parsing. That is the signal
 * this module reads. Nothing here executes a subprocess or touches the network.
 *
 * FAIL-CLOSED CONTRACT
 * --------------------
 * Every failure mode — directory missing, file missing, unreadable, truncated,
 * wrong magic, non-numeric build time, implausible build time, or older than
 * the configured maximum without upstream evidence — resolves to `fresh: false`
 * with a stable snake_case reason code. There is no path through this module
 * that reports freshness it did not positively establish.
 *
 * A LATE RELEASE IS NOT A STALE DATABASE
 * --------------------------------------
 * The ceiling asks "is this machine keeping up?", and age alone cannot always
 * answer that. ClamAV builds `daily` about once a day, so a ceiling of 24 h has
 * no margin at all: when a release ran late on 2026-11-04, a machine holding the
 * newest database in existence crossed the ceiling and stopped all resume
 * ingestion. Refusing protected nothing, because nothing newer existed.
 *
 * So a database past the ceiling is still accepted, up to a hard limit, when the
 * local `daily` version is at or above the version the publisher advertises. The
 * evidence is that comparison, and deliberately not the updater's own report:
 * freshclam exits 0 on a CDN cool-down too, so "the updater succeeded" would pass
 * a rate-limited machine that is falling further behind. If the publisher has
 * moved on, or the evidence is absent or old, the ceiling holds.
 *
 * TRUST ASSUMPTION. The advertised version comes from plain DNS, which nothing
 * here authenticates. A forged record with a low version and a current time makes
 * the local database look current, up to the hard limit and no further. That is
 * the same record freshclam itself trusts when deciding whether to download, so a
 * forged answer already stops updates today. Databases stay signed either way;
 * what a forger gains is holding this machine on the signatures it has.
 *
 * WHICH DATABASE DECIDES AGE
 * --------------------------
 * `main` is republished roughly yearly (a legitimately current install can
 * carry a `main.cvd` eight months old) and `bytecode` almost as rarely, so
 * judging age on them would fail closed forever. `daily` is the database
 * that moves, about once a day, and it is what ClamAV's own staleness warning
 * is computed from — so `daily` sets the age. `main` is still
 * required to be PRESENT and parseable: a database directory without it cannot
 * screen anything.
 */

import { open } from 'node:fs/promises';
import { join } from 'node:path';

import {
  readAvUpstreamEvidence,
  resolveAvUpdaterStatusFile,
  upstreamEvidenceUsable,
  type AvUpstreamEvidence,
} from './av-updater.js';

export { UPSTREAM_EVIDENCE_MAX_AGE_SEC, UPSTREAM_RECORD_MAX_AGE_SEC } from './av-updater.js';

// Keep the env names visible to the env-contract checker, which scans for
// `process.env.<VAR>` literals. Functional reads go through the injectable
// `source` map below.
const _contractVisibleEnvReads = [
  process.env.RESUME_SCANNER_DB_DIR,
  process.env.RESUME_SCANNER_MAX_DB_AGE_HOURS,
];
void _contractVisibleEnvReads;

/** Default ClamAV database directory (matches the Debian/ClamAV default). */
export const DEFAULT_DB_DIR = '/var/lib/clamav';

/**
 * Conservative default maximum age for a `daily` database that has no upstream
 * proof behind it.
 *
 * ClamAV itself only warns at 7 days. This deployment checks hourly, but ClamAV
 * publishes `daily` only about once a day, so a healthy machine can legitimately
 * reach this ceiling whenever a release runs late. That case is covered by the
 * upstream proof below. It is deliberately far stricter than the upstream
 * warning threshold.
 */
export const DEFAULT_MAX_DB_AGE_HOURS = 24;

/**
 * The hard limit for a database the publisher still advertises as its newest. Past
 * ClamAV's own 7-day warning, a silent publisher is an incident for a person to
 * look at, and no evidence extends it.
 */
export const UPSTREAM_CONFIRMED_MAX_DB_AGE_HOURS = 168;

/** Bounds applied to `RESUME_SCANNER_MAX_DB_AGE_HOURS`. */
export const MAX_DB_AGE_HOURS_BOUNDS = { def: DEFAULT_MAX_DB_AGE_HOURS, min: 1, max: 168 } as const;

/** Bytes of a database file that must be read to see the whole header. */
export const CVD_HEADER_BYTES = 512;

/** The header magic every CVD/CLD file starts with. */
const CVD_MAGIC = 'ClamAV-VDB:';

/** Index of the build-time-in-epoch-seconds field within the header. */
const FIELD_BUILD_EPOCH = 8;

/** Earliest build time we will believe (2010-01-01). Anything older is corrupt. */
const MIN_PLAUSIBLE_EPOCH_MS = Date.UTC(2010, 0, 1);

/**
 * How far into the future a build time may sit before we call it corrupt. A
 * small allowance absorbs publisher/host clock skew; anything beyond it means
 * either a damaged header or a badly wrong local clock, and both must fail
 * closed rather than yield an "age" that looks reassuringly small.
 */
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/** Databases that must be present and parseable for a scan to be trustworthy. */
export const REQUIRED_DATABASES = ['main', 'daily'] as const;

/** The database whose build time defines signature age. */
export const AGE_DATABASE = 'daily';

/** File extensions a database may use, in no particular preference order. */
const DB_EXTENSIONS = ['cvd', 'cld'] as const;

/** Stable, sanitized reason codes. Never free text, never a path. */
export type SignatureReason =
  | 'signatures_missing'
  | 'signatures_unreadable'
  | 'signatures_corrupt'
  | 'signatures_stale';

export interface SignatureState {
  /** True only when every required database parsed AND `daily` is within the ceiling. */
  fresh: boolean;
  /** Age of the `daily` database in seconds, or null when it could not be read. */
  ageSec: number | null;
  /** The ceiling this verdict was measured against, in seconds. */
  maxAgeSec: number;
  /** Stable reason code when not fresh; null when fresh. */
  reason: SignatureReason | null;
  /**
   * Present only when `fresh` rests on upstream evidence and not on age: the
   * database is past the normal ceiling, and at or above the advertised version.
   */
  upstreamConfirmed?: true;
}

/** Parsed CVD/CLD header. `version` is compared with the publisher's advertised
 *  version, and is never exposed on any health or API surface. */
export interface CvdHeader {
  buildTimeMs: number;
  version: number;
}

/**
 * Parse a CVD/CLD header from the leading bytes of a database file.
 * Returns null for anything that is not a positively valid header.
 */
export function parseCvdHeader(head: Buffer, nowMs: number = Date.now()): CvdHeader | null {
  if (!Buffer.isBuffer(head) || head.length < CVD_MAGIC.length) return null;

  // Headers are normally space-padded to 512 bytes. Tolerate NUL/newline
  // terminators used by some database variants while rejecting binary bytes.
  let end = head.length;
  for (let i = 0; i < head.length; i += 1) {
    const b = head[i]!;
    if (b === 0x00 || b === 0x0a || b === 0x0d) { end = i; break; }
    // Any byte outside printable ASCII means this is not a text header.
    if (b < 0x20 || b > 0x7e) return null;
  }
  const text = head.subarray(0, end).toString('ascii');
  if (!text.startsWith(CVD_MAGIC)) return null;

  const fields = text.split(':');
  if (fields.length <= FIELD_BUILD_EPOCH) return null;

  const rawEpoch = fields[FIELD_BUILD_EPOCH]!.trim();
  if (!/^\d{1,12}$/.test(rawEpoch)) return null;
  const buildTimeMs = Number(rawEpoch) * 1000;
  if (!Number.isSafeInteger(buildTimeMs)) return null;
  if (buildTimeMs < MIN_PLAUSIBLE_EPOCH_MS) return null;
  if (buildTimeMs > nowMs + MAX_FUTURE_SKEW_MS) return null;

  const rawVersion = fields[2]!.trim();
  if (!/^\d{1,12}$/.test(rawVersion)) return null;

  return { buildTimeMs, version: Number(rawVersion) };
}

/** Clamp the configured ceiling into its bounds; malformed input yields the default. */
export function resolveMaxDbAgeHours(raw: string | undefined): number {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw.trim())) return MAX_DB_AGE_HOURS_BOUNDS.def;
  const n = Number(raw.trim());
  if (!Number.isSafeInteger(n)) return MAX_DB_AGE_HOURS_BOUNDS.def;
  if (n < MAX_DB_AGE_HOURS_BOUNDS.min) return MAX_DB_AGE_HOURS_BOUNDS.min;
  if (n > MAX_DB_AGE_HOURS_BOUNDS.max) return MAX_DB_AGE_HOURS_BOUNDS.max;
  return n;
}

export interface SignatureReaderOptions {
  /** Database directory. Defaults to `RESUME_SCANNER_DB_DIR` then `/var/lib/clamav`. */
  dbDir?: string;
  /** Age ceiling in seconds. Defaults to the bounded `RESUME_SCANNER_MAX_DB_AGE_HOURS`. */
  maxAgeSec?: number;
  /** Env map (injectable for tests). */
  source?: NodeJS.ProcessEnv;
  /** Upstream evidence. Defaults to the supervisor's status file. */
  upstream?: () => Promise<AvUpstreamEvidence | null>;
}

export function resolveDbDir(opts: SignatureReaderOptions = {}): string {
  if (typeof opts.dbDir === 'string' && opts.dbDir !== '') return opts.dbDir;
  const source = opts.source ?? process.env;
  const fromEnv = source.RESUME_SCANNER_DB_DIR;
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : DEFAULT_DB_DIR;
}

function resolveMaxAgeSec(opts: SignatureReaderOptions): number {
  if (typeof opts.maxAgeSec === 'number' && Number.isFinite(opts.maxAgeSec) && opts.maxAgeSec > 0) {
    return Math.floor(opts.maxAgeSec);
  }
  const source = opts.source ?? process.env;
  return resolveMaxDbAgeHours(source.RESUME_SCANNER_MAX_DB_AGE_HOURS) * 3600;
}

type DbLookup =
  | { ok: true; header: CvdHeader }
  | { ok: false; reason: 'signatures_missing' | 'signatures_unreadable' | 'signatures_corrupt' };

/**
 * Read one logical database (`name`), trying each supported extension. When
 * both `.cvd` and `.cld` exist — normal after a scripted update — the NEWER
 * build time wins, because that is the one libclamav will actually load.
 *
 * A file that exists but cannot be read is `signatures_unreadable`; one that
 * reads but does not parse is `signatures_corrupt`. Both fail closed; the
 * distinction only exists so an operator knows whether to look at permissions
 * or at a truncated download.
 */
async function readDatabase(dbDir: string, name: string, nowMs: number): Promise<DbLookup> {
  let best: CvdHeader | null = null;
  let sawFile = false;
  let sawUnreadable = false;

  for (const ext of DB_EXTENSIONS) {
    const path = join(dbDir, `${name}.${ext}`);
    let head: Buffer;
    try {
      // Read ONLY the header. `main.cvd` is ~89 MB and this runs on the scan
      // path and behind the health endpoint, so slurping the whole file to
      // look at its first 512 bytes would be an easy self-inflicted stall.
      const handle = await open(path, 'r');
      try {
        const buf = Buffer.alloc(CVD_HEADER_BYTES);
        const { bytesRead } = await handle.read(buf, 0, CVD_HEADER_BYTES, 0);
        head = buf.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // ENOENT/ENOTDIR mean "this variant is absent", which is normal.
      if (code === 'ENOENT' || code === 'ENOTDIR') continue;
      sawUnreadable = true;
      continue;
    }
    sawFile = true;
    const header = parseCvdHeader(head, nowMs);
    if (header && (!best || header.buildTimeMs > best.buildTimeMs)) best = header;
  }

  if (best) return { ok: true, header: best };
  if (sawFile) return { ok: false, reason: 'signatures_corrupt' };
  if (sawUnreadable) return { ok: false, reason: 'signatures_unreadable' };
  return { ok: false, reason: 'signatures_missing' };
}

/** Whether this evidence shows the local `daily` is the newest published. */
function upstreamConfirmsLocal(
  localVersion: number,
  evidence: AvUpstreamEvidence,
  nowMs: number,
): boolean {
  return upstreamEvidenceUsable(evidence, nowMs) && localVersion >= evidence.daily_version;
}

async function readUpstreamEvidence(opts: SignatureReaderOptions): Promise<AvUpstreamEvidence | null> {
  const read = opts.upstream
    ?? (() => readAvUpstreamEvidence(resolveAvUpdaterStatusFile(opts.source ?? process.env)));
  try {
    return await read();
  } catch {
    // An absence of evidence: the ceiling applies, the database is not unreadable.
    return null;
  }
}

/**
 * Read the current signature state. Never throws: any unexpected failure
 * resolves to a not-fresh verdict.
 */
export async function readSignatureState(
  opts: SignatureReaderOptions = {},
  nowMs: number = Date.now(),
): Promise<SignatureState> {
  const maxAgeSec = resolveMaxAgeSec(opts);
  const dbDir = resolveDbDir(opts);

  try {
    let ageSec: number | null = null;
    let dailyVersion: number | null = null;

    for (const name of REQUIRED_DATABASES) {
      const found = await readDatabase(dbDir, name, nowMs);
      if (!found.ok) {
        return {
          fresh: false,
          // Age is unknown unless `daily` itself parsed; a missing `main`
          // must not let a `daily` age masquerade as a partial success.
          ageSec: name === AGE_DATABASE ? null : ageSec,
          maxAgeSec,
          reason: found.reason,
        };
      }
      if (name === AGE_DATABASE) {
        ageSec = Math.max(0, Math.floor((nowMs - found.header.buildTimeMs) / 1000));
        dailyVersion = found.header.version;
      }
    }

    if (ageSec === null) {
      // Unreachable while AGE_DATABASE ∈ REQUIRED_DATABASES; fail closed anyway.
      return { fresh: false, ageSec: null, maxAgeSec, reason: 'signatures_missing' };
    }
    if (ageSec > maxAgeSec) {
      const hardMaxSec = UPSTREAM_CONFIRMED_MAX_DB_AGE_HOURS * 3600;
      if (ageSec <= hardMaxSec && dailyVersion !== null) {
        const evidence = await readUpstreamEvidence(opts);
        if (evidence !== null && upstreamConfirmsLocal(dailyVersion, evidence, nowMs)) {
          return { fresh: true, ageSec, maxAgeSec: hardMaxSec, reason: null, upstreamConfirmed: true };
        }
      }
      return { fresh: false, ageSec, maxAgeSec, reason: 'signatures_stale' };
    }
    return { fresh: true, ageSec, maxAgeSec, reason: null };
  } catch {
    return { fresh: false, ageSec: null, maxAgeSec, reason: 'signatures_unreadable' };
  }
}

/** A freshness probe: cheap to call, safe to call often. */
export type SignatureFreshnessReader = () => Promise<SignatureState>;

/**
 * Wrap `readSignatureState` in a short TTL cache.
 *
 * The scan path and the health surface both need this on every request, and a
 * database directory does not change meaningfully inside a few seconds. The TTL
 * is short enough that a completed update becomes visible promptly. A cached
 * verdict can outlive the moment a database crossed a ceiling or its upstream
 * evidence expired, by at most this TTL. Both limits are hours wide, so that
 * is not a meaningful extension of either.
 */
export function createSignatureFreshnessReader(
  opts: SignatureReaderOptions & { ttlMs?: number; now?: () => number } = {},
): SignatureFreshnessReader {
  const ttlMs = typeof opts.ttlMs === 'number' && opts.ttlMs >= 0 ? opts.ttlMs : 15_000;
  const now = opts.now ?? (() => Date.now());
  let cachedAt = -Infinity;
  let cached: SignatureState | null = null;
  let inFlight: Promise<SignatureState> | null = null;

  return async (): Promise<SignatureState> => {
    const t = now();
    if (cached && t - cachedAt < ttlMs) return cached;
    if (inFlight) return inFlight;
    inFlight = readSignatureState(opts, t)
      .then((state) => {
        cached = state;
        cachedAt = t;
        return state;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };
}

/** Process-wide reader shared by the scanner and the health surface. */
let shared: SignatureFreshnessReader | null = null;

export function defaultSignatureFreshnessReader(): SignatureFreshnessReader {
  if (!shared) shared = createSignatureFreshnessReader();
  return shared;
}

/** Test isolation only. */
export function resetSignatureFreshnessReader(): void {
  shared = null;
}
