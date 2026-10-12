/**
 * Static guarantees for migration 0127 (R1 interview recordings). The behavioural SQL assertions run
 * in supabase-ci (app/supabase/tests/r1_recordings_assert.sql, wired by scripts/test-r1-recordings.sh);
 * these text-level checks keep the file to exactly what the cross-module contract (C3) says and in
 * step with the TypeScript constants that consume it.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_PARTS, MAX_URLS } from '../lib/r1/recording/config.js';
import { R1_RECORDING_MODES } from '../lib/r1/recording/keys.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrations = path.resolve(here, '../../../supabase/migrations');
const FILE = '0127_r1_recordings.sql';
const sql = readFileSync(path.join(migrations, FILE), 'utf8').replace(/\r\n/g, '\n');
/** Comments removed, whitespace collapsed: a layout-independent view of the executable SQL. */
const code = sql.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim();
const lc = code.toLowerCase();

function block(startMarker: string, endMarker: string): string {
  const start = code.indexOf(startMarker);
  expect(start, startMarker).toBeGreaterThan(-1);
  const end = code.indexOf(endMarker, start);
  expect(end, endMarker).toBeGreaterThan(start);
  return code.slice(start, end);
}
const recordings = block('create table if not exists screening_v2.interview_round_recordings (', 'create index if not exists idx_r1_recordings_round');
const purge = block('create table if not exists screening_v2.r1_recording_purge (', 'create index if not exists idx_r1_recording_purge_open');

describe('migration 0127: file and frame', () => {
  it('is the only migration with its number and carries the _r1_ infix', () => {
    const number = FILE.slice(0, 4);
    expect(readdirSync(migrations).filter((name) => name.startsWith(`${number}_`))).toEqual([FILE]);
    expect(FILE).toMatch(/^\d{4}_r1_/);
    // Not "the newest": a later forward fix (0128+) must not turn this test red.
    const numbered = readdirSync(migrations).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    expect(numbered.indexOf(FILE)).toBeGreaterThan(numbered.indexOf('0126_r1_score_incomplete_attempts.sql'));
  });

  it('sets a local lock_timeout as its first statement', () => {
    expect(code.startsWith("set local lock_timeout = '10s';")).toBe(true);
  });

  it('is additive: no table is dropped or truncated, no row deleted, no column dropped or retyped', () => {
    expect(lc).not.toMatch(/\bdrop\s+(table|column|schema|function|index|constraint)\b/);
    expect(lc).not.toMatch(/\btruncate\b|\bdelete\s+from\b|\bupdate\s+screening_v2\b|\balter\s+column\b|\bdrop\s+not\s+null\b/);
    // The only guarded drops are the idempotent trigger re-creations.
    expect([...lc.matchAll(/\bdrop\s+trigger\b(?! if exists)/g)]).toEqual([]);
  });

  it('touches R1-only objects and nothing from the phone lane or the legacy recording path', () => {
    const alters = [...lc.matchAll(/alter table ([a-z_.0-9]+)/g)].map((m) => m[1]);
    expect(alters.filter((t) => t !== 'screening_v2.r1_settings' && !t!.endsWith('interview_round_recordings') && !t!.endsWith('r1_recording_purge'))).toEqual([]);
    const triggerTables = [...lc.matchAll(/create trigger [a-z_0-9]+ (?:after|before) [a-z_ ]+? on ([a-z_.0-9]+)/g)].map((m) => m[1]);
    expect(triggerTables.sort()).toEqual([
      'screening_v2.interview_round_consents',
      'screening_v2.interview_round_recordings',
      'screening_v2.interview_round_recordings',
    ]);
    for (const forbidden of ['call_sessions', 'recordings_v2', 'consent_records', 'consent_templates', 'recording_egress', 'phone_']) {
      expect(lc, forbidden).not.toContain(forbidden);
    }
  });

  it('documents its rollback and the dedup scope in the header', () => {
    expect(sql).toMatch(/Rollback note: additive and forward-only/);
    expect(sql).toMatch(/NEVER drop these tables or the column while R2 objects exist/);
    expect(sql).toMatch(/uq_job_queue_dedup_active.*PARTIAL/s);
  });
});

describe('migration 0127: screening_v2.interview_round_recordings (C3)', () => {
  it('has exactly the contract columns, with their types', () => {
    const columns = [...recordings.matchAll(/(?:\(|, ) ?([a-z][a-z0-9_]*) (uuid|text|integer|bigint|boolean|numeric\(5, 2\)|timestamptz)(?=[ ,])/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(columns).toEqual([
      'session_id uuid',
      'round_id uuid',
      'bucket text',
      'prefix text',
      'requested_mode text',
      'status text',
      'layout text',
      'has_video boolean',
      'upload_id text',
      'parts_issued integer',
      'urls_issued integer',
      'video_key text',
      'video_bytes bigint',
      'video_sha256 text',
      'video_etag text',
      'video_content_type text',
      'audio_key text',
      'audio_bytes bigint',
      'audio_sha256 text',
      'audio_etag text',
      'started_at_ms bigint',
      'duration_ms integer',
      'width integer',
      'height integer',
      'fps numeric(5, 2)',
      'frames_encoded integer',
      'frames_dropped integer',
      'camera_off_ms integer',
      'degraded_at_ms integer',
      'reported_stream_bytes bigint',
      'reported_parts integer',
      'degraded_reason text',
      'failure_reason text',
      'finalize_attempts integer',
      'created_at timestamptz',
      'updated_at timestamptz',
      'finalize_requested_at timestamptz',
      'finalized_at timestamptz',
      'delete_after timestamptz',
      'delete_requested_at timestamptz',
      'delete_reason text',
      'deleted_at timestamptz',
    ]);
  });

  it.each([
    ['session_id is the primary key', 'session_id uuid primary key'],
    ['round_id is required', 'round_id uuid not null'],
    ['bucket and prefix are required', 'bucket text not null, prefix text not null'],
    ['the requested mode is audio or av', "requested_mode text not null check (requested_mode in ('audio', 'av'))"],
    [
      'the status machine',
      "status text not null default 'preparing' check (status in ('preparing', 'uploading', 'finishing', 'ready', 'partial', 'failed', 'deleted'))",
    ],
    ['layout is combined, split or audio_only', "layout text check (layout in ('combined', 'split', 'audio_only'))"],
    ['has_video is nullable until finalize', 'has_video boolean,'],
    ['the upload id is bounded and Secret-class', 'upload_id text check (upload_id is null or length(upload_id) between 1 and 1024)'],
    ['parts_issued is 0..60', 'parts_issued integer not null default 0 check (parts_issued between 0 and 60)'],
    ['urls_issued is 0..400', 'urls_issued integer not null default 0 check (urls_issued between 0 and 400)'],
    ['the MP4 content type allowlist', "video_content_type text check (video_content_type is null or video_content_type in ('video/mp4', 'audio/mp4'))"],
    ['sha256 columns are 64 lower-case hex', "video_sha256 text check (video_sha256 is null or video_sha256 ~ '^[a-f0-9]{64}$')"],
    ['the audio sha256 too', "audio_sha256 text check (audio_sha256 is null or audio_sha256 ~ '^[a-f0-9]{64}$')"],
    ['started_at_ms has the 2020..2100 window', 'started_at_ms bigint check (started_at_ms is null or started_at_ms between 1577836800000 and 4102444800000)'],
    ['duration window', 'duration_ms integer check (duration_ms is null or duration_ms between 1 and 86400000)'],
    ['width window', 'width integer check (width is null or width between 16 and 4096)'],
    ['height window', 'height integer check (height is null or height between 16 and 4096)'],
    ['fps window', 'fps numeric(5, 2) check (fps is null or fps between 1 and 60)'],
    ['frames_encoded window', 'frames_encoded integer check (frames_encoded is null or frames_encoded between 0 and 10000000)'],
    ['frames_dropped window', 'frames_dropped integer check (frames_dropped is null or frames_dropped between 0 and 10000000)'],
    ['degraded_at_ms window', 'degraded_at_ms integer check (degraded_at_ms is null or degraded_at_ms between 0 and 86400000)'],
    ['reported stream bytes window', 'reported_stream_bytes bigint check (reported_stream_bytes is null or reported_stream_bytes between 0 and 1099511627776)'],
    ['reported parts window', 'reported_parts integer check (reported_parts is null or reported_parts between 0 and 60)'],
    ['degraded_reason vocabulary shape', "degraded_reason text check (degraded_reason is null or degraded_reason ~ '^[a-z0-9_.:-]{1,64}$')"],
    ['failure_reason vocabulary shape', "failure_reason text check (failure_reason is null or failure_reason ~ '^[a-z0-9_.:-]{1,64}$')"],
    ['finalize_attempts starts at 0', 'finalize_attempts integer not null default 0 check (finalize_attempts >= 0)'],
    ['created_at defaults to now()', 'created_at timestamptz not null default now()'],
    ['updated_at defaults to now() (code sets it on every write)', 'updated_at timestamptz not null default now()'],
    ['delete_after is required (fixed at prepare)', 'delete_after timestamptz not null'],
    [
      'delete_reason vocabulary',
      "delete_reason text check (delete_reason is null or delete_reason in ('retention', 'consent_withdrawn', 'dsar', 'row_deleted', 'admin'))",
    ],
    ['deleted_at is a nullable timestamp', 'deleted_at timestamptz,'],
  ])('%s', (_label, fragment) => {
    expect(recordings).toContain(fragment);
  });

  it('references the attempt by the (session_id, round_id) pair and cascades', () => {
    expect(recordings).toContain(
      'constraint fk_r1_recording_attempt foreign key (session_id, round_id) references screening_v2.interview_round_attempts (session_id, round_id) on delete cascade',
    );
  });

  it('pins the prefix, the keys-under-prefix rule and the deleted/deleted_at pairing', () => {
    expect(recordings).toContain("check (prefix = 'r1/' || round_id::text || '/' || session_id::text || '/')");
    expect(recordings).toContain('check ( (video_key is null or starts_with(video_key, prefix)) and (audio_key is null or starts_with(audio_key, prefix)) )');
    expect(recordings).toContain("check ((status = 'deleted') = (deleted_at is not null))");
  });

  it('keeps the SQL limits in step with the TypeScript constants', () => {
    expect(recordings).toContain(`parts_issued between 0 and ${MAX_PARTS}`);
    expect(recordings).toContain(`reported_parts between 0 and ${MAX_PARTS}`);
    expect(recordings).toContain(`urls_issued between 0 and ${MAX_URLS}`);
    expect(recordings).toContain(`requested_mode in (${R1_RECORDING_MODES.map((m) => `'${m}'`).join(', ')})`);
  });

  it('has the three contract indexes', () => {
    expect(code).toContain('create index if not exists idx_r1_recordings_round on screening_v2.interview_round_recordings (round_id);');
    expect(code).toContain(
      "create index if not exists idx_r1_recordings_live on screening_v2.interview_round_recordings (updated_at) where status in ('preparing', 'uploading', 'finishing');",
    );
    expect(code).toContain(
      'create index if not exists idx_r1_recordings_retention on screening_v2.interview_round_recordings (delete_after) where deleted_at is null;',
    );
  });
});

describe('migration 0127: screening_v2.r1_recording_purge and r1_settings.recording_mode', () => {
  it('the purge outbox has the contract columns', () => {
    expect(purge).toContain('id uuid primary key default gen_random_uuid()');
    for (const column of [
      'bucket text not null',
      'prefix text not null',
      'upload_id text,',
      'reason text not null',
      'queued_at timestamptz not null default now()',
      'attempts integer not null default 0',
      'last_error_code text,',
      'done_at timestamptz',
    ]) {
      expect(purge, column).toContain(column);
    }
  });

  it('adds recording_mode off|audio|av with default off to the R1-only settings table', () => {
    expect(code).toContain(
      "alter table screening_v2.r1_settings add column if not exists recording_mode text not null default 'off' constraint chk_r1_settings_recording_mode check (recording_mode in ('off', 'audio', 'av'));",
    );
    expect(code).toContain(`recording_mode in ('off', ${R1_RECORDING_MODES.map((m) => `'${m}'`).join(', ')})`);
    expect(lc).not.toContain("'video'");
  });
});

describe('migration 0127: the three triggers', () => {
  it.each([
    ['enqueue_r1_recording_finalize', 'r1.recording.finalize', "'r1.recording.finalize:' || new.session_id::text", "jsonb_build_object('session_id', new.session_id)"],
    ['enqueue_r1_recording_erase', 'r1.recording.erase', "'r1.recording.erase:' || new.id::text", "jsonb_build_object('round_id', new.round_id, 'reason', 'consent_withdrawn')"],
  ])('%s enqueues %s into job_queue with max_attempts 5 and a dedup key', (fn, queue, dedup, payload) => {
    const body = block(`create or replace function screening_v2.${fn}()`, '$$; drop trigger');
    expect(body).toContain('returns trigger language plpgsql security invoker set search_path = pg_catalog');
    expect(body).toContain('insert into screening_v2.job_queue (name, payload, dedup_key, max_attempts)');
    expect(body).toContain(`'${queue}'`);
    expect(body).toContain(dedup);
    expect(body).toContain(payload);
    expect(body).toMatch(/, 5\) on conflict do nothing; return new;/);
    // Both names are already mapped to the `recording` funnel category (0122: r1.recording.%).
    expect(queue.startsWith('r1.recording.')).toBe(true);
  });

  it('finalize fires only on the transition INTO finishing, after an UPDATE OF status', () => {
    expect(code).toContain(
      "drop trigger if exists enqueue_r1_recording_finalize on screening_v2.interview_round_recordings; create trigger enqueue_r1_recording_finalize after update of status on screening_v2.interview_round_recordings for each row when (new.status = 'finishing' and old.status is distinct from 'finishing') execute function screening_v2.enqueue_r1_recording_finalize();",
    );
  });

  it('erase fires only for a withdrawn or declined decision, never on withdrawn_at alone', () => {
    expect(code).toContain(
      "create trigger enqueue_r1_recording_erase after update of withdrawn_at on screening_v2.interview_round_consents for each row when (old.withdrawn_at is null and new.withdrawn_at is not null and new.proof ->> 'decision' in ('withdrawn', 'declined')) execute function screening_v2.enqueue_r1_recording_erase();",
    );
    const when = code.slice(code.indexOf('create trigger enqueue_r1_recording_erase'), code.indexOf('execute function screening_v2.enqueue_r1_recording_erase'));
    expect(when).not.toContain('superseded');
    // The erase job is keyed on the consent row (a consent is withdrawn once), not the round.
    expect(code).toContain("'r1.recording.erase:' || new.id::text");
  });

  it('a row delete (including cascades) leaves a purge outbox row unless the row is already a tombstone', () => {
    expect(code).toContain(
      'insert into screening_v2.r1_recording_purge (bucket, prefix, upload_id, reason) values (old.bucket, old.prefix, old.upload_id, \'row_deleted\'); return old;',
    );
    expect(code).toContain(
      'create trigger purge_on_r1_recording_delete before delete on screening_v2.interview_round_recordings for each row when (old.deleted_at is null) execute function screening_v2.purge_on_r1_recording_delete();',
    );
  });

  it('every trigger function is security invoker with a pinned search_path and a revoked ACL', () => {
    const fns = [...code.matchAll(/create or replace function (screening_v2\.[a-z_0-9]+)\(\)/g)].map((m) => m[1]!);
    expect(fns.sort()).toEqual([
      'screening_v2.enqueue_r1_recording_erase',
      'screening_v2.enqueue_r1_recording_finalize',
      'screening_v2.purge_on_r1_recording_delete',
    ]);
    expect(lc).not.toContain('security definer');
    expect(code.match(/security invoker set search_path = pg_catalog/g)).toHaveLength(3);
    for (const fn of fns) {
      expect(code).toContain(`revoke all on function ${fn}() from public, anon, authenticated;`);
    }
  });
});

describe('migration 0127: SQL test wiring', () => {
  const root = path.resolve(here, '../../../..');
  const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

  it('runs the assertions from supabase-test.sh and triggers supabase-ci on the helper', () => {
    const script = read('scripts/test-r1-recordings.sh');
    expect(script).toContain('r1_recordings_assert.sql');
    expect(script).toContain('ON_ERROR_STOP=1');
    expect(read('scripts/supabase-test.sh')).toContain('bash scripts/test-r1-recordings.sh');
    // Both the `push` and the `pull_request` path filters name the helper.
    expect(read('.github/workflows/supabase-ci.yml').match(/scripts\/test-r1-recordings\.sh/g)).toHaveLength(2);
  });

  it('keeps the fixtures self-contained, unique and cleaned up', () => {
    const assertions = read('app/supabase/tests/r1_recordings_assert.sql');
    expect(assertions).toContain('encode(sha256(');
    expect(assertions).toContain('drop schema _r1_rec_tests cascade;');
    // Every scenario row id lives in the dedicated 7e000000 namespace so it cannot collide with another suite.
    const ids = [...assertions.matchAll(/'([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'/g)].map((m) => m[1]!);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('7e000000-'), id).toBe(true);
  });
});

describe('migration 0127: privileges', () => {
  it('enables RLS with no policy and grants service_role only', () => {
    expect(code).toContain('alter table screening_v2.interview_round_recordings enable row level security;');
    expect(code).toContain('alter table screening_v2.r1_recording_purge enable row level security;');
    expect(lc).not.toMatch(/create policy/);
    expect(code).toContain(
      'revoke all on screening_v2.interview_round_recordings, screening_v2.r1_recording_purge from public, anon, authenticated;',
    );
    expect(code).toContain(
      'grant all privileges on screening_v2.interview_round_recordings, screening_v2.r1_recording_purge to service_role;',
    );
    expect(lc).not.toMatch(/grant [a-z ]+ to (anon|authenticated|public)/);
  });
});
