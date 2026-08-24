#!/usr/bin/env node

/**
 * exec.mjs — the ONE subprocess boundary for `scripts/phone-canary/`.
 *
 * `node:child_process` is imported here and nowhere else in this directory,
 * and `canary0.mjs`'s static scan enforces that. The rule exists because this
 * canary's whole claim is that it reaches nothing: keeping every process
 * launch behind one named door means a reviewer can read this file and know
 * what the canary can start, rather than grepping five.
 *
 * Two callers, both local by construction:
 *   * `db.mjs` — `docker exec … psql` against a LOCAL container.
 *   * `canary0.mjs` — `git rev-parse` / `git status`, for the manifest's
 *     provenance fields.
 *
 * Nothing here opens a socket. A subprocess that does (psql does, to a local
 * container) does it in ITS address space, which is exactly why the canary
 * can trap every egress primitive in its own process and still read a
 * database.
 */

import { spawn, spawnSync } from 'node:child_process';

/** No shell, ever. An argv array cannot grow a pipeline or a substitution. */
export function run(command, argv, options = {}) {
  const result = spawnSync(command, argv, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 600_000,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    input: options.input,
    env: options.env,
  });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** A long-lived child whose stdin stays open. Used for lock-race sessions. */
export function start(command, argv, options = {}) {
  return spawn(command, argv, { stdio: ['pipe', 'pipe', 'pipe'], env: options.env });
}

/**
 * Repository provenance for the manifest.
 *
 * `dirty` is RECORDED, never enforced. A manifest produced from a dirty tree
 * is a real fact about that run, and suppressing it would be the lie.
 */
export function gitState(repoDir) {
  const sha = run('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { timeoutMs: 30_000 });
  const status = run('git', ['-C', repoDir, 'status', '--porcelain'], { timeoutMs: 60_000 });
  return { gitSha: sha.stdout.trim(), gitDirty: status.stdout.trim() !== '' };
}
