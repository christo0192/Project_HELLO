/**
 * The `recording` block of the worker's start context (IMPLEMENTER-RULES C5): the projection matrix
 * over R1 x storage config x recording_mode x consent, and the guarantee that no failure in it can
 * ever surface as anything but `{ mode: 'off' }`.
 */
import { describe, expect, it } from 'vitest';
import { projectRecordingContext } from '../lib/r1/recording/context.js';
import type { R1RecordingConfig } from '../lib/r1/recording/config.js';
import { ROOM_ROUND, createRecordingFakeDb, liveRecordingTables } from './support/r1-recording-fake-db.js';
import { enabledRecordingConfig } from './support/r1-recording-harness.js';

const DISABLED: R1RecordingConfig = { enabled: false, status: 'disabled' };
const INVALID: R1RecordingConfig = { enabled: false, status: 'invalid', reason: 'x' };
const ALL_CONSENTS = ['ai_interview', 'video_audio_recording', 'ai_evaluation', 'data_processing'];

type Cell = { r1: boolean; config: R1RecordingConfig; mode: string; consents: string[] | null; expected: 'off' | 'audio' | 'av' };

// The full matrix: the mode comes out only when ALL four locks are open.
const CELLS: Cell[] = [];
for (const r1 of [true, false]) {
  for (const config of [enabledRecordingConfig(), DISABLED, INVALID]) {
    for (const mode of ['off', 'audio', 'av']) {
      for (const consents of [ALL_CONSENTS, ['ai_interview'], null]) {
        const open = r1 && config.enabled && mode !== 'off' && consents === ALL_CONSENTS;
        CELLS.push({ r1, config, mode, consents, expected: open ? (mode as 'audio' | 'av') : 'off' });
      }
    }
  }
}

describe('projectRecordingContext', () => {
  it('has the full matrix (54 cells) and exactly 2 open ones (audio and av)', () => {
    expect(CELLS).toHaveLength(54);
    expect(CELLS.filter((c) => c.expected !== 'off')).toHaveLength(2);
  });

  it.each(CELLS.map((c) => [`r1=${c.r1} config=${c.config.status} mode=${c.mode} consent=${c.consents === null ? 'none' : c.consents.length === 4 ? 'full' : 'no-recording'} -> ${c.expected}`, c] as const))(
    '%s',
    async (_label, cell) => {
      const db = createRecordingFakeDb(liveRecordingTables({ recordingMode: cell.mode, consents: cell.consents }));
      const result = await projectRecordingContext(db.client as never, ROOM_ROUND, {
        r1Enabled: () => cell.r1,
        recordingConfig: () => cell.config,
      });
      expect(result).toEqual({ mode: cell.expected });
    },
  );

  it('a withdrawn consent is off (no live row)', async () => {
    const tables = liveRecordingTables({ recordingMode: 'av' });
    tables.interview_round_consents![0]!.withdrawn_at = '2026-10-12T09:00:00.000Z';
    const db = createRecordingFakeDb(tables);
    expect(await projectRecordingContext(db.client as never, ROOM_ROUND, { r1Enabled: () => true, recordingConfig: () => enabledRecordingConfig() })).toEqual({ mode: 'off' });
  });

  it('only the live round\'s consent counts', async () => {
    const tables = liveRecordingTables({ recordingMode: 'av', consents: null });
    tables.interview_round_consents!.push({ id: 'other', round_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', consents: ALL_CONSENTS, withdrawn_at: null });
    const db = createRecordingFakeDb(tables);
    expect(await projectRecordingContext(db.client as never, ROOM_ROUND, { r1Enabled: () => true, recordingConfig: () => enabledRecordingConfig() })).toEqual({ mode: 'off' });
  });

  it.each([
    ['the settings read errors', (db: ReturnType<typeof createRecordingFakeDb>) => db.failOn('r1_settings', 'select')],
    ['the consent read errors', (db: ReturnType<typeof createRecordingFakeDb>) => db.failOn('interview_round_consents', 'select')],
    ['the settings row is missing', (db: ReturnType<typeof createRecordingFakeDb>) => { db.tables.r1_settings!.length = 0; }],
    ['the recording_mode column does not exist yet', (db: ReturnType<typeof createRecordingFakeDb>) => { delete db.tables.r1_settings![0]!.recording_mode; }],
  ])('is off, not an error, when %s', async (_label, arrange) => {
    const db = createRecordingFakeDb(liveRecordingTables({ recordingMode: 'av' }));
    arrange(db);
    await expect(projectRecordingContext(db.client as never, ROOM_ROUND, { r1Enabled: () => true, recordingConfig: () => enabledRecordingConfig() })).resolves.toEqual({ mode: 'off' });
  });

  it('is off when anything it calls throws, instead of throwing', async () => {
    const throwing = { from: () => { throw new Error('connection refused'); }, rpc: async () => ({ data: null, error: null }) };
    await expect(projectRecordingContext(throwing as never, ROOM_ROUND, { r1Enabled: () => true, recordingConfig: () => enabledRecordingConfig() })).resolves.toEqual({ mode: 'off' });
    const badConfig = createRecordingFakeDb(liveRecordingTables({ recordingMode: 'av' }));
    await expect(projectRecordingContext(badConfig.client as never, ROOM_ROUND, { r1Enabled: () => true, recordingConfig: () => { throw new Error('boom'); } })).resolves.toEqual({ mode: 'off' });
    await expect(projectRecordingContext(badConfig.client as never, ROOM_ROUND, { r1Enabled: () => { throw new Error('boom'); }, recordingConfig: () => enabledRecordingConfig() })).resolves.toEqual({ mode: 'off' });
  });

  it('reads nothing from the database while the storage config is off', async () => {
    const db = createRecordingFakeDb(liveRecordingTables({ recordingMode: 'av' }));
    await projectRecordingContext(db.client as never, ROOM_ROUND, { r1Enabled: () => true, recordingConfig: () => DISABLED });
    expect(db.ops).toEqual([]);
  });
});
