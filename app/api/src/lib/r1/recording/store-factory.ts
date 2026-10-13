/**
 * The process-wide {@link R1ObjectStore} for the configured bucket.
 *
 * One store (and so one S3 client with its connection pool) is shared by the routes, the finalize
 * job and the later erase/sweep jobs. It is rebuilt only when the connection settings change, which
 * in production means never (a Fly secret change restarts the machine). Building a store is cheap
 * and imports nothing: the AWS SDK is loaded on the first real call (`s3-store.ts`), so merely
 * asking for a store at boot or in a test never loads it.
 */

import { createHash } from 'node:crypto';
import type { R1RecordingConfig } from './config.js';
import { createS3Store } from './s3-store.js';
import type { R1ObjectStore } from './store.js';

let cached: { signature: string; store: R1ObjectStore } | null = null;

export function getR1RecordingStore(config: Extract<R1RecordingConfig, { enabled: true }>): R1ObjectStore {
  // The signature is a hash, so the secret is never held in a second place or compared as text.
  const signature = createHash('sha256')
    .update([config.s3.endpoint, config.s3.region, config.s3.bucket, config.s3.accessKeyId, config.s3.secretAccessKey].join('\n'))
    .digest('hex');
  if (cached?.signature === signature) return cached.store;
  const store = createS3Store(config.s3);
  cached = { signature, store };
  return store;
}

/** Test seam: forget the cached store. */
export function resetR1RecordingStoreCache(): void {
  cached = null;
}
