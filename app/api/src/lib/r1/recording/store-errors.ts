/**
 * Closed, queue-safe error codes for object-store failures, shared by every R1 recording job
 * (finalize, erase, sweep, DSAR).
 *
 * An {@link R1StoreError} carries a provider-neutral code and never a key, URL, upload id or provider
 * message. These helpers turn it into a plain `Error` whose message is one of a few fixed strings the
 * queue runner may persist (`sanitizeErrorCode`) and the handlers may branch on:
 *
 *   r1_storage_unavailable  transient (5xx, timeout, SlowDown): the job may be DEFERRED (bounded)
 *   r1_storage_access       rejected credentials / signature: waiting cannot fix it
 *   r1_storage_rejected     the provider refused the request itself
 *   r1_storage_error        anything else (a response the adapter could not read, a failed delete, ...)
 */

import { isR1StoreError } from './store.js';

export function storageError(error: unknown): Error {
  if (isR1StoreError(error)) {
    if (error.code === 'unavailable') return new Error('r1_storage_unavailable');
    if (error.code === 'access_denied') return new Error('r1_storage_access');
    if (error.code === 'invalid_request') return new Error('r1_storage_rejected');
  }
  return new Error('r1_storage_error');
}

/** Run an object-store call; anything it throws leaves as a closed `r1_*` code. */
export async function guardStore<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof Error && /^r1_/.test(error.message)) throw error;
    throw storageError(error);
  }
}

/**
 * The first `max` entries of a lazy listing. More than `max` is NOT an error: the caller works through
 * the batch and lists again, so a very large prefix still makes progress on every pass. A listing that
 * fails is an error (a closed code), never a shorter list.
 */
export async function takeListing<T>(listing: AsyncIterable<T>, max: number): Promise<T[]> {
  const out: T[] = [];
  try {
    for await (const item of listing) {
      out.push(item);
      if (out.length >= max) break;
    }
  } catch (error) {
    throw storageError(error);
  }
  return out;
}
