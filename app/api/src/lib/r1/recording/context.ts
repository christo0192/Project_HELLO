/**
 * The `recording` block of the worker's start context (IMPLEMENTER-RULES C5):
 * `POST /api/internal/r1/context` answers `"recording": { "mode": "off" | "audio" | "av" }`.
 *
 * `off` unless ALL of these hold: R1 is enabled, the recording config is `enabled`,
 * `r1_settings.recording_mode != 'off'`, and the round's live consent contains
 * `video_audio_recording`; then the DB `recording_mode`. The worker still takes the lower of this and
 * its own capability, and every recording route re-checks the same conditions.
 *
 * This is computed in its OWN guarded read, deliberately apart from the context route's required
 * reads: any failure here (a read error, the column not migrated yet, a thrown config check) is
 * `off`. A recording problem must never turn the interview's start context into a 503.
 */

import type { R1DbClient } from '../../../services/r1-assessment.js';
import { loadRoundLiveConsent } from '../../../services/r1-assessment.js';
import { getR1Config } from '../config.js';
import { getR1RecordingConfig, type R1RecordingConfig } from './config.js';
import { R1_RECORDING_CONSENT } from './gate.js';
import { asRecordingMode } from './service.js';

export type R1ContextRecordingMode = 'off' | 'audio' | 'av';

export interface R1RecordingContextOverrides {
  readonly r1Enabled?: () => boolean;
  readonly recordingConfig?: () => R1RecordingConfig;
}

export async function projectRecordingContext(
  db: R1DbClient,
  roundId: string,
  overrides: R1RecordingContextOverrides = {},
): Promise<{ mode: R1ContextRecordingMode }> {
  return { mode: await projectMode(db, roundId, overrides) };
}

async function projectMode(db: R1DbClient, roundId: string, overrides: R1RecordingContextOverrides): Promise<R1ContextRecordingMode> {
  try {
    if (!(overrides.r1Enabled ?? ((): boolean => getR1Config().enabled))()) return 'off';
    if (!(overrides.recordingConfig ?? ((): R1RecordingConfig => getR1RecordingConfig()))().enabled) return 'off';
    const { data, error } = await db.from('r1_settings').select('recording_mode').eq('singleton', true).maybeSingle();
    if (error || !data) return 'off';
    const mode = asRecordingMode((data as { recording_mode?: unknown }).recording_mode);
    if (mode === 'off') return 'off';
    const consent = await loadRoundLiveConsent(db, roundId);
    if (!consent || !Array.isArray(consent.consents) || !consent.consents.includes(R1_RECORDING_CONSENT)) return 'off';
    return mode;
  } catch {
    return 'off';
  }
}
