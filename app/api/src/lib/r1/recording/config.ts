/**
 * R1 recording configuration (IMPLEMENTER-RULES C1).
 *
 * Like `../config.ts`, this is deliberately NOT part of env.ts: env.ts throws at import on a malformed
 * value, which would crash-loop the API that also runs phone dialing. This module is lazy and NEVER
 * throws; a bad value turns recording OFF (status `invalid`) and logs one line that names the
 * variable but never its value (two of the five are credentials).
 *
 *   all five R1_RECORDING_S3_* unset (and every knob unset or valid) -> `disabled`
 *   some of the five set, or ANY value (including a knob) invalid     -> `invalid`   (recording off)
 *   all five valid and every knob valid or unset                       -> `enabled`
 *
 * Recording is active only when `getR1Config().enabled` AND this module says `enabled`.
 *
 * The credentials exist ONLY on the API (`project-hello-api`); the worker receives short presigned
 * URLs and never an R2 secret. Each variable is read as a literal property of process.env (never a
 * computed key) so `scripts/check-env-contract.mjs` sees it.
 */

/** Fixed sizes and lifetimes: not operator knobs, so a malformed env cannot change them. */
export const PART_SIZE = 5_242_880; // 5 MiB, the R2 multipart minimum; every part but the last is this size
export const MAX_PARTS = 60; // 60 x 5 MiB = 300 MiB of streamed MP4
export const MAX_URLS = 400; // presigned URLs issued per recording (every presign counts)
export const WORKER_URL_TTL_SEC = 600; // worker-facing presigned URLs
export const CHECKPOINT_INTERVAL_SEC = 120; // the worker re-PUTs the growing OGG this often

export const MAX_BYTES_DEFAULT = 419_430_400; // 400 MiB
export const MAX_BYTES_MIN = 16_777_216; // 16 MiB
export const MAX_BYTES_MAX = 1_073_741_824; // 1 GiB
export const DOWNLOAD_TTL_DEFAULT_SEC = 300;
export const DOWNLOAD_TTL_MIN_SEC = 60;
export const DOWNLOAD_TTL_MAX_SEC = 900;
export const RETENTION_DAYS_DEFAULT = 90;
export const RETENTION_DAYS_MIN = 1;
export const RETENTION_DAYS_MAX = 90; // the candidate notice promises "90 days, then it is deleted"

export const R1_RECORDING_S3_VARIABLES = [
  'R1_RECORDING_S3_ENDPOINT',
  'R1_RECORDING_S3_REGION',
  'R1_RECORDING_S3_BUCKET',
  'R1_RECORDING_S3_ACCESS_KEY_ID',
  'R1_RECORDING_S3_SECRET_ACCESS_KEY',
] as const;
export const R1_RECORDING_KNOB_VARIABLES = [
  'R1_RECORDING_MAX_BYTES',
  'R1_RECORDING_DOWNLOAD_TTL_SEC',
  'R1_RECORDING_RETENTION_DAYS',
] as const;
export type R1RecordingEnvName =
  | (typeof R1_RECORDING_S3_VARIABLES)[number]
  | (typeof R1_RECORDING_KNOB_VARIABLES)[number];
export type R1RecordingEnvSource = Partial<Record<R1RecordingEnvName, string | undefined>>;

export type R1RecordingConfigStatus = 'enabled' | 'disabled' | 'invalid';

/** What the S3 adapter needs. The credentials are NON-ENUMERABLE so spreading, `JSON.stringify` or a
 * stray `console.log(config)` cannot leak them; read them by property name. */
export interface R1RecordingS3Settings {
  readonly endpoint: string;
  readonly region: 'auto';
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface R1RecordingKnobs {
  readonly maxBytes: number;
  readonly downloadTtlSec: number;
  readonly retentionDays: number;
}

export type R1RecordingConfig =
  | { readonly enabled: false; readonly status: 'disabled' }
  | { readonly enabled: false; readonly status: 'invalid'; readonly reason: string }
  | ({ readonly enabled: true; readonly status: 'enabled'; readonly s3: R1RecordingS3Settings } & R1RecordingKnobs);

// Every reason is one of a dozen fixed strings, so remembering them all is bounded and means each
// problem is logged once per process however often the config is re-read (the gate reads it per request).
const reported = new Set<string>();
function report(reason: string): void {
  if (reported.has(reason)) return;
  reported.add(reason);
  // The reason names a variable, never a value: two of them are credentials.
  console.error(`[r1-recording-config] recording off: ${reason}`);
}
/** Test seam: forget what was reported so a test can observe the lines again. */
export function resetR1RecordingConfigReport(): void {
  reported.clear();
}

// 32 lower-case hex account id, optional jurisdiction label, then the R2 S3 domain.
const ENDPOINT_HOST = /^[0-9a-f]{32}\.(?:(?:eu|fedramp)\.)?r2\.cloudflarestorage\.com$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const DIGITS = /^[0-9]{1,12}$/;
// A credential with a stray newline or space (a classic pasted-secret mistake) would only fail later
// as an opaque SignatureDoesNotMatch from R2: refuse it here.
const CREDENTIAL = /^[\x21-\x7e]{1,512}$/;

/** Set means "not undefined and not blank". A non-string value counts as set (and is then invalid). */
function present(value: unknown): boolean {
  return value !== undefined && value !== '';
}

// `.env.example` carries this placeholder in the two credential slots (the env-contract check demands
// it). A developer who copies the file must not get a "half configured" report for a placeholder, so
// the exact placeholder counts as unset for those two variables only.
const CREDENTIAL_PLACEHOLDER = 'replace_me';
function isSet(name: (typeof R1_RECORDING_S3_VARIABLES)[number], value: unknown): boolean {
  if ((name === 'R1_RECORDING_S3_ACCESS_KEY_ID' || name === 'R1_RECORDING_S3_SECRET_ACCESS_KEY') && value === CREDENTIAL_PLACEHOLDER) return false;
  return present(value);
}

/** `https://<acct>[.eu|.fedramp].r2.cloudflarestorage.com`: https, no path, query, port or userinfo. */
export function isValidR2Endpoint(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  // One trailing slash is harmless and common when pasting; anything else must equal the origin.
  const candidate = raw.endsWith('/') ? raw.slice(0, -1) : raw;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    ENDPOINT_HOST.test(url.hostname) &&
    url.port === '' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    candidate === url.origin
  );
}

function parseKnob(raw: unknown, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !DIGITS.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function withHiddenCredentials(s3: Pick<R1RecordingS3Settings, 'endpoint' | 'region' | 'bucket'>, accessKeyId: string, secretAccessKey: string): R1RecordingS3Settings {
  const settings = { ...s3 } as { endpoint: string; region: 'auto'; bucket: string };
  Object.defineProperty(settings, 'accessKeyId', { value: accessKeyId, enumerable: false });
  Object.defineProperty(settings, 'secretAccessKey', { value: secretAccessKey, enumerable: false });
  return Object.freeze(settings) as unknown as R1RecordingS3Settings;
}

function invalid(reason: string): R1RecordingConfig {
  report(reason);
  return { enabled: false, status: 'invalid', reason };
}

/**
 * Inspect the environment. NEVER throws. `source` is a test seam; production passes nothing and the
 * variables are read as literal property accesses on process.env.
 */
export function getR1RecordingConfig(source?: R1RecordingEnvSource): R1RecordingConfig {
  const env: R1RecordingEnvSource = source ?? {
    R1_RECORDING_S3_ENDPOINT: process.env.R1_RECORDING_S3_ENDPOINT,
    R1_RECORDING_S3_REGION: process.env.R1_RECORDING_S3_REGION,
    R1_RECORDING_S3_BUCKET: process.env.R1_RECORDING_S3_BUCKET,
    R1_RECORDING_S3_ACCESS_KEY_ID: process.env.R1_RECORDING_S3_ACCESS_KEY_ID,
    R1_RECORDING_S3_SECRET_ACCESS_KEY: process.env.R1_RECORDING_S3_SECRET_ACCESS_KEY,
    R1_RECORDING_MAX_BYTES: process.env.R1_RECORDING_MAX_BYTES,
    R1_RECORDING_DOWNLOAD_TTL_SEC: process.env.R1_RECORDING_DOWNLOAD_TTL_SEC,
    R1_RECORDING_RETENTION_DAYS: process.env.R1_RECORDING_RETENTION_DAYS,
  };
  try {
    // The knobs are validated first and always: a malformed knob is `invalid` even with no S3 values
    // (an operator typo must not sit unnoticed until the secrets arrive).
    const maxBytes = parseKnob(env.R1_RECORDING_MAX_BYTES, MAX_BYTES_DEFAULT, MAX_BYTES_MIN, MAX_BYTES_MAX);
    if (maxBytes === null) return invalid('R1_RECORDING_MAX_BYTES must be an integer from 16777216 to 1073741824');
    const downloadTtlSec = parseKnob(
      env.R1_RECORDING_DOWNLOAD_TTL_SEC,
      DOWNLOAD_TTL_DEFAULT_SEC,
      DOWNLOAD_TTL_MIN_SEC,
      DOWNLOAD_TTL_MAX_SEC,
    );
    if (downloadTtlSec === null) return invalid('R1_RECORDING_DOWNLOAD_TTL_SEC must be an integer from 60 to 900');
    const retentionDays = parseKnob(
      env.R1_RECORDING_RETENTION_DAYS,
      RETENTION_DAYS_DEFAULT,
      RETENTION_DAYS_MIN,
      RETENTION_DAYS_MAX,
    );
    if (retentionDays === null) return invalid('R1_RECORDING_RETENTION_DAYS must be an integer from 1 to 90');

    const setCount = R1_RECORDING_S3_VARIABLES.filter((name) => isSet(name, env[name])).length;
    if (setCount === 0) return { enabled: false, status: 'disabled' };
    if (setCount < R1_RECORDING_S3_VARIABLES.length) {
      return invalid('some but not all of the five R1_RECORDING_S3_* variables are set');
    }

    const endpoint = env.R1_RECORDING_S3_ENDPOINT;
    if (!isValidR2Endpoint(endpoint)) {
      return invalid('R1_RECORDING_S3_ENDPOINT must be https://<32 hex>.r2.cloudflarestorage.com (optionally .eu or .fedramp before r2)');
    }
    if (env.R1_RECORDING_S3_REGION !== 'auto') return invalid('R1_RECORDING_S3_REGION must be "auto"');
    const bucket = env.R1_RECORDING_S3_BUCKET;
    if (typeof bucket !== 'string' || !BUCKET.test(bucket)) return invalid('R1_RECORDING_S3_BUCKET is not a valid bucket name');
    const accessKeyId = env.R1_RECORDING_S3_ACCESS_KEY_ID;
    if (typeof accessKeyId !== 'string' || !CREDENTIAL.test(accessKeyId)) return invalid('R1_RECORDING_S3_ACCESS_KEY_ID is malformed');
    const secretAccessKey = env.R1_RECORDING_S3_SECRET_ACCESS_KEY;
    if (typeof secretAccessKey !== 'string' || !CREDENTIAL.test(secretAccessKey)) return invalid('R1_RECORDING_S3_SECRET_ACCESS_KEY is malformed');

    return {
      enabled: true,
      status: 'enabled',
      s3: withHiddenCredentials({ endpoint: endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint, region: 'auto', bucket }, accessKeyId, secretAccessKey),
      maxBytes,
      downloadTtlSec,
      retentionDays,
    };
  } catch {
    // Defensive: nothing above throws, but this module's contract is that it never does.
    return invalid('unexpected error while reading the recording configuration');
  }
}
