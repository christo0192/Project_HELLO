#!/usr/bin/env node

/**
 * ci-voice-test-scope.mjs: may this run of quality.yml skip the voice worker tests?
 *
 * The voice tests are about two thirds of the Quality job, and a pull request that
 * changes only the web app cannot reach the worker. So a pull request may skip them,
 * and only when every file it changes is on the short list below.
 *
 * It fails towards running. Anything else runs the tests: any event but a pull
 * request into main (so every push to main runs them, and deploy-fly.yml waits on
 * that run), a diff that cannot be read, an empty diff, or one path off the list.
 * Whatever goes wrong here, the worst case is a slower run, never a skipped test.
 *
 * Some voice tests read files outside app/voice-livekit, which is why this is a short
 * list rather than "anything that is not the worker": API files (parity tests) and
 * some docs are read directly. scripts/ci-voice-test-scope.test.mjs scans the worker's
 * Python for the plain ways of reading a path the list lets through. It is a static
 * scan, so a read built some other way would not show up in it.
 *
 * Writes voice_tests=run|skip to $GITHUB_OUTPUT. On a pull request the checkout is
 * GitHub's merge commit, so HEAD^1 is the base and the diff is what would land.
 *
 * Usage: node scripts/ci-voice-test-scope.mjs
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Paths that cannot reach the voice worker or its tests. */
export const WEB_ONLY_PATHS = Object.freeze([
  /^app\/web\//,
  /^docs\/design\/[^/]+\.md$/,
  /^scripts\/validate-hr-design-system(\.test)?\.mjs$/,
]);

/** Web files a voice test reads, so a change to one runs the voice tests. */
export const WEB_FILES_VOICE_TESTS_READ = Object.freeze(['app/web/src/lib/r1/r1-phase.ts']);

/** The first path that needs the voice tests, or null when all of them are web only. */
export function firstVoiceRelevantPath(paths) {
  for (const path of paths) {
    if (WEB_FILES_VOICE_TESTS_READ.includes(path)) return path;
    if (!WEB_ONLY_PATHS.some((pattern) => pattern.test(path))) return path;
  }
  return null;
}

export function decideVoiceTests({ event, baseRef, paths }) {
  if (event !== 'pull_request') {
    return { voiceTests: 'run', reason: `event is ${event || 'unknown'}, not a pull request` };
  }
  // A retarget starts no new run, so a skip decided against another base would stand.
  if (baseRef !== 'main') return { voiceTests: 'run', reason: `the base is ${baseRef || 'unknown'}, not main` };
  if (!Array.isArray(paths)) return { voiceTests: 'run', reason: 'the changed files could not be read' };
  if (paths.length === 0) return { voiceTests: 'run', reason: 'the diff is empty' };
  const relevant = firstVoiceRelevantPath(paths);
  if (relevant !== null) return { voiceTests: 'run', reason: `${relevant} can reach the voice worker` };
  return { voiceTests: 'skip', reason: `all ${paths.length} changed file(s) are web only` };
}

function changedPaths() {
  // --no-renames lists both ends of a move, so a file moved out of the worker is seen.
  const diff = spawnSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], { encoding: 'utf8' });
  if (diff.status !== 0) return null;
  return diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME ?? '';
  const { voiceTests, reason } = decideVoiceTests({
    event,
    baseRef: process.env.GITHUB_BASE_REF,
    paths: event === 'pull_request' ? changedPaths() : null,
  });
  console.log(`voice tests: ${voiceTests} (${reason})`);
  if (voiceTests === 'skip') console.log(`::notice title=Voice tests skipped::${reason}. They still run on main.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `voice_tests=${voiceTests}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
