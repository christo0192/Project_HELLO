#!/usr/bin/env node
/**
 * Delete the storage objects belonging to the test candidates being purged.
 *
 * SQL cannot do this: résumé files and call recordings live in Supabase
 * Storage, and deleting the database row leaves the file behind.
 *
 * RUN THIS **BEFORE** purge_test_data.sql. It derives the object keys from the
 * database itself using the same "not one of the three kept candidates" rule,
 * so it cannot delete a kept candidate's file — but once the SQL purge has run,
 * the rows that name those keys are gone and nothing can derive them any more.
 *
 *   Dry run (prints the plan, deletes nothing — always do this first):
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/purge-test-storage.mjs
 *
 *   For real:
 *     SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/purge-test-storage.mjs --confirm
 *
 * PowerShell:
 *     $env:SUPABASE_URL="..."; $env:SUPABASE_SERVICE_ROLE_KEY="..."
 *     node scripts/purge-test-storage.mjs --confirm
 *
 * The service-role key is read from the environment and never printed.
 */

const KEEP_CANDIDATES = [
  'cb6f90c6-7168-44fe-94e8-58ca7dc0221a',
  'd48630dd-f4a4-4f77-bf4a-ea88ddc9f3cd',
  'fdac8ee6-e605-496d-8be5-f051fb732739',
];

const RESUME_BUCKET = process.env.RESUME_BUCKET ?? 'resumes_v2';
const RECORDINGS_BUCKET = process.env.RECORDINGS_BUCKET ?? 'recordings_v2';
const SCHEMA = process.env.SUPABASE_SCHEMA ?? 'screening_v2';

const url = (process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const confirm = process.argv.includes('--confirm');

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY first. Nothing was done.');
  process.exit(1);
}

const restHeaders = {
  apikey: key,
  authorization: `Bearer ${key}`,
  'accept-profile': SCHEMA,
  accept: 'application/json',
};

async function rest(path) {
  const res = await fetch(`${url}/rest/v1/${path}`, { headers: restHeaders });
  if (!res.ok) {
    throw new Error(`read failed (${res.status}) on ${path.split('?')[0]}`);
  }
  return res.json();
}

/** Page through a table so a >1000-row result is never silently truncated. */
async function readAll(path) {
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await rest(`${path}${sep}limit=${pageSize}&offset=${offset}`);
    out.push(...page);
    if (page.length < pageSize) return out;
  }
}

async function removeObjects(bucket, keys) {
  const deleted = [];
  const failed = [];
  for (let i = 0; i < keys.length; i += 100) {
    const batch = keys.slice(i, i + 100);
    const res = await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: 'DELETE',
      headers: { ...restHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ prefixes: batch }),
    });
    if (!res.ok) {
      failed.push(...batch);
      console.error(`  batch of ${batch.length} failed (HTTP ${res.status})`);
      continue;
    }
    deleted.push(...batch);
  }
  return { deleted, failed };
}

const keepList = KEEP_CANDIDATES.map((id) => `"${id}"`).join(',');

// Résumés: the table has no candidate column, so the kept set is whatever the
// kept candidates point AT. Everything else is orphaned by the purge.
const keptCandidates = await readAll(
  `candidates?select=resume_id&id=in.(${KEEP_CANDIDATES.join(',')})`,
);
const keptResumeIds = new Set(keptCandidates.map((c) => c.resume_id).filter(Boolean));
const allResumes = await readAll('resumes?select=id,file_path&file_path=not.is.null');
const resumeKeys = allResumes.filter((r) => !keptResumeIds.has(r.id)).map((r) => r.file_path);

// Recordings: sessions of any candidate that is not kept, plus orphaned sessions.
const sessions = await readAll(
  `call_sessions?select=recording_object_key&recording_object_key=not.is.null` +
    `&or=(candidate_id.is.null,candidate_id.not.in.(${keepList}))`,
);
const recordingKeys = sessions.map((s) => s.recording_object_key);

console.log(`Kept candidates: ${KEEP_CANDIDATES.length}, whose résumés are preserved: ${keptResumeIds.size}`);
console.log(`${RESUME_BUCKET}: ${resumeKeys.length} object(s) to delete`);
console.log(`${RECORDINGS_BUCKET}: ${recordingKeys.length} object(s) to delete`);

if (!confirm) {
  console.log('\nDRY RUN — nothing deleted. First few keys:');
  for (const k of resumeKeys.slice(0, 3)) console.log(`  ${RESUME_BUCKET}/${k}`);
  for (const k of recordingKeys.slice(0, 3)) console.log(`  ${RECORDINGS_BUCKET}/${k}`);
  console.log('\nRe-run with --confirm to delete.');
  process.exit(0);
}

let failedTotal = 0;
for (const [bucket, keys] of [[RESUME_BUCKET, resumeKeys], [RECORDINGS_BUCKET, recordingKeys]]) {
  if (keys.length === 0) continue;
  console.log(`\nDeleting ${keys.length} object(s) from ${bucket}…`);
  const { deleted, failed } = await removeObjects(bucket, keys);
  console.log(`  deleted ${deleted.length}, failed ${failed.length}`);
  failedTotal += failed.length;
}

console.log(failedTotal === 0
  ? '\nStorage clean. Now run purge_test_data.sql.'
  : `\n${failedTotal} object(s) failed — re-run to retry them, then run purge_test_data.sql.`);
process.exit(failedTotal === 0 ? 0 : 1);
