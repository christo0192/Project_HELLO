/**
 * container-av-contract.test.ts — the image contract behind signature freshness.
 *
 * The scanner's fail-closed logic is only half the repair. The other half lives
 * in the image: if the Dockerfile silently swallows a failed signature download,
 * or bakes a database that can never be refreshed, or leaves the database
 * directory unwritable by the runtime user, or runs the API as PID 1 with no
 * updater behind it, then the runtime is permanently fail-closed and resume
 * ingestion can never be activated at all.
 *
 * These are static assertions over the committed image contract. They run
 * offline in CI; the live `docker build` + container rehearsal is the operator
 * procedure in docs/runbooks/ashby-runtime-activation.md §5a.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const apiRoot = join(import.meta.dirname, '..', '..');
const read = (rel: string): string => readFileSync(join(apiRoot, rel), 'utf8');

const dockerfile = read('Dockerfile');
const freshclamConf = read('docker/freshclam.conf');
const flyToml = read('fly.toml');

/** Dockerfile lines with comments and blanks removed — the executable contract. */
const directives = dockerfile
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l !== '' && !l.startsWith('#'));
const directiveText = directives.join('\n');

describe('Dockerfile — signature freshness contract', () => {
  it('installs the ClamAV scanner and updater', () => {
    expect(directiveText).toMatch(/apt-get install[^\n]*clamav\b/);
    expect(directiveText).toMatch(/clamav-freshclam/);
  });

  it('does not install a ClamAV daemon (the scanner shells out to clamscan)', () => {
    expect(directiveText).not.toMatch(/clamav-daemon/);
    expect(directiveText).not.toMatch(/clamd/);
  });

  it('NEVER swallows a failed signature update with `|| true`', () => {
    // The original defect: `(freshclam --quiet || true)` produced a green build
    // shipping an empty database directory, and nothing downstream noticed.
    expect(directiveText).not.toMatch(/\|\|\s*true/);
    expect(directiveText).not.toMatch(/\|\|\s*:/);
  });

  it('bakes no signature database into the image', () => {
    // A baked database is frozen at build time and ages forever in a container
    // that has no updater. The runtime updater owns the whole lifecycle.
    //
    // `freshclam` may only appear as the apt package name and as the config
    // file that is copied in — never as a command the build executes.
    const invocations = directiveText
      .replace(/clamav-freshclam/g, '')
      .replace(/freshclam\.conf/g, '')
      .match(/freshclam/g) ?? [];
    expect(invocations).toEqual([]);
  });

  it('gives the database directory to the unprivileged runtime user', () => {
    expect(directiveText).toMatch(/chown\s+appuser:appuser\s+\/var\/lib\/clamav/);
    expect(directiveText).toMatch(/chmod\s+0700\s+\/var\/lib\/clamav/);
  });

  it('keeps the updater configuration root-owned and read-only', () => {
    // The runtime user must not be able to repoint its own updater at another
    // mirror, so it may read this file and never write it.
    expect(directiveText).toMatch(/COPY docker\/freshclam\.conf \/etc\/clamav\/freshclam\.conf/);
    expect(directiveText).toMatch(/chown\s+root:root\s+\/etc\/clamav\/freshclam\.conf/);
    expect(directiveText).toMatch(/chmod\s+0444\s+\/etc\/clamav\/freshclam\.conf/);
  });

  it('runs as a non-root user', () => {
    expect(directiveText).toMatch(/^USER appuser$/m);
    // ...and the USER directive is the last privilege change before CMD.
    const userIndex = directives.findIndex((l) => l === 'USER appuser');
    const cmdIndex = directives.findIndex((l) => l.startsWith('CMD'));
    expect(userIndex).toBeGreaterThan(-1);
    expect(cmdIndex).toBeGreaterThan(userIndex);
    expect(directives.slice(userIndex).some((l) => /^(RUN|COPY|ADD)\b/.test(l))).toBe(false);
  });

  it('makes the supervisor PID 1, not the API', () => {
    // A PID 1 with no signal handlers ignores SIGTERM, stalling every graceful
    // stop until SIGKILL; the supervisor also owns the updater lifecycle.
    expect(directiveText).toMatch(/CMD \["node", "dist\/src\/container\/entrypoint\.js"\]/);
    expect(directiveText).not.toMatch(/CMD \["node", "dist\/src\/index\.js"\]/);
  });

  it('declares no HEALTHCHECK that could claim readiness the app has not proven', () => {
    expect(directiveText).not.toMatch(/^HEALTHCHECK/m);
  });
});

describe('freshclam.conf — least-privilege updater configuration', () => {
  const lines = freshclamConf
    .split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
  const directive = (name: string): string | undefined =>
    lines.find((l) => l.startsWith(`${name} `))?.slice(name.length + 1).trim();

  it('writes only to the directory the runtime user owns', () => {
    expect(directive('DatabaseDirectory')).toBe('/var/lib/clamav');
  });

  it('drops the root-only directives the Debian default ships', () => {
    // Each of these is either unusable as a non-root process or points at a
    // path the runtime user cannot write.
    for (const rootOnly of ['DatabaseOwner', 'UpdateLogFile', 'PidFile', 'NotifyClamd']) {
      expect(lines.some((l) => l.startsWith(rootOnly))).toBe(false);
    }
  });

  it('runs in the foreground with no daemon and no socket', () => {
    expect(directive('Foreground')).toBe('yes');
  });

  it('verifies a downloaded database before installing it', () => {
    expect(directive('TestDatabases')).toBe('yes');
  });

  it('bounds its own network behaviour', () => {
    expect(Number(directive('ConnectTimeout'))).toBeGreaterThan(0);
    expect(Number(directive('ReceiveTimeout'))).toBeGreaterThan(0);
    expect(Number(directive('MaxAttempts'))).toBeGreaterThan(0);
  });

  it('uses only official ClamAV distribution endpoints', () => {
    expect(directive('DatabaseMirror')).toBe('database.clamav.net');
  });
});

describe('fly.toml — production scanner configuration', () => {
  const env = (name: string): string | undefined =>
    flyToml.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'))?.[1];

  it('selects the production ClamAV scanner', () => {
    expect(env('RESUME_SCANNER')).toBe('clamav');
  });

  it('pins the database directory the image prepares', () => {
    expect(env('RESUME_SCANNER_DB_DIR')).toBe('/var/lib/clamav');
  });

  it('sets a maximum signature age far stricter than ClamAV\'s own 7-day warning', () => {
    const hours = Number(env('RESUME_SCANNER_MAX_DB_AGE_HOURS'));
    expect(Number.isFinite(hours)).toBe(true);
    expect(hours).toBeGreaterThan(0);
    expect(hours).toBeLessThan(7 * 24);
  });

  it('refreshes signatures often enough to clear the ceiling many times over', () => {
    const intervalMs = Number(env('AV_UPDATER_INTERVAL_MS'));
    const maxAgeMs = Number(env('RESUME_SCANNER_MAX_DB_AGE_HOURS')) * 3_600_000;
    expect(intervalMs).toBeGreaterThan(0);
    // At least ten refresh opportunities inside the freshness window, so a run
    // of transient CDN failures does not immediately block ingestion.
    expect(maxAgeMs / intervalMs).toBeGreaterThanOrEqual(10);
  });

  it('bounds the updater below the freshness window', () => {
    const timeoutMs = Number(env('AV_UPDATER_TIMEOUT_MS'));
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThan(Number(env('AV_UPDATER_INTERVAL_MS')));
  });
});
