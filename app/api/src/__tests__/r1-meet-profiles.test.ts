/**
 * The R1-over-Meet objective-profile registry: frozen, fail-closed lookups, and timers that agree
 * with the R1 worker. The worker's own files are read here (as `r1-personas-sync.test.ts` does), so
 * a change to the worker's rejoin grace, maximum residency or no-show wait fails this build until
 * the bot's automatic-leave timers are re-aligned.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  R1_MEET_CONSENT_MODES,
  R1_MEET_DEFAULT_PROFILE_ID,
  R1_MEET_PROFILES,
  R1_MEET_PROFILE_IDS,
  getR1MeetProfile,
} from '../lib/r1/meet/profiles.js';

/** D-M034-9 / D-M034-11: the exact notice Dex posts in the meeting chat (AI + recorded). */
const DISCLOSURE = 'Dex is an AI interviewer from Interview Kickstart. This call is recorded.';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(path.resolve(here, relative), 'utf8');

const workerFlyToml = read('../../../voice-livekit/fly.toml');
const workerSession = read('../../../voice-livekit/r1_session.py');
const roundMigration = read('../../../supabase/migrations/0115_r1_round_foundation.sql');

/** `NAME = "123"` from the worker's fly.toml [env]. */
function flyEnvSeconds(name: string): number {
  const match = new RegExp(`^\\s*${name}\\s*=\\s*"(\\d+)"\\s*$`, 'm').exec(workerFlyToml);
  if (!match) throw new Error(`${name} not found in app/voice-livekit/fly.toml`);
  return Number(match[1]);
}

/** Default and upper bound of `bounded_seconds("NAME", default, min, max)` in r1_session.py. */
function workerBoundedSeconds(name: string): { defaultSec: number; maxSec: number } {
  const match = new RegExp(
    `bounded_seconds\\(\\s*"${name}"\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*\\)`,
  ).exec(workerSession);
  if (!match) throw new Error(`bounded_seconds("${name}", ...) not found in r1_session.py`);
  return { defaultSec: Number(match[1]), maxSec: Number(match[3]) };
}

function workerNoShowSeconds(): number {
  const match = /^NO_SHOW_SECONDS\s*=\s*([\d.]+)\s*$/m.exec(workerSession);
  if (!match) throw new Error('NO_SHOW_SECONDS not found in r1_session.py');
  return Number(match[1]);
}

/** The values allowed by `interview_rounds.kind`'s CHECK in migration 0115. */
function allowedRoundKinds(): string[] {
  const match = /^\s*kind text not null[^\n]*check \(kind in \(([^)]*)\)\)/m.exec(roundMigration);
  if (!match) throw new Error('interview_rounds.kind CHECK not found in 0115_r1_round_foundation.sql');
  return [...match[1].matchAll(/'([a-z0-9_]+)'/g)].map((item) => item[1]);
}

const profiles = Object.values(R1_MEET_PROFILES);

describe('R1 Meet profile registry', () => {
  it('has exactly the one Dex R1 sales profile', () => {
    expect(R1_MEET_DEFAULT_PROFILE_ID).toBe('r1_dex_sales');
    expect(R1_MEET_PROFILE_IDS).toEqual(['r1_dex_sales']);
    expect(Object.keys(R1_MEET_PROFILES)).toEqual([...R1_MEET_PROFILE_IDS]);
  });

  it('pins the r1_dex_sales values', () => {
    expect(getR1MeetProfile('r1_dex_sales')).toStrictEqual({
      id: 'r1_dex_sales',
      interviewKind: 'sales_r1',
      consentMode: 'hr_attested_ashby',
      botDisplayName: 'Dex',
      maxCallMinutes: 45,
      botJoinLeadSec: 120,
      automaticLeave: {
        waitingRoomTimeoutSec: 600,
        nooneJoinedTimeoutSec: 900,
        everyoneLeftTimeoutSec: 90,
        inCallNotRecordingTimeoutSec: 900,
        inCallRecordingTimeoutSec: 2700,
      },
      disclosureChatMessage: DISCLOSURE,
      participantMetadataRetentionHours: 1,
    });
  });

  it('records consent as HR-attested at Ashby scheduling (D-M034-11)', () => {
    expect(R1_MEET_CONSENT_MODES).toEqual(['hr_attested_ashby']);
    expect(Object.isFrozen(R1_MEET_CONSENT_MODES)).toBe(true);
    expect(() => {
      (R1_MEET_CONSENT_MODES as string[]).push('candidate_web');
    }).toThrow(TypeError);
    expect(R1_MEET_CONSENT_MODES).toEqual(['hr_attested_ashby']);
    expect(getR1MeetProfile('r1_dex_sales')!.consentMode).toBe('hr_attested_ashby');
  });

  it('posts exactly the owner-approved disclosure: Dex is an AI and the call is recorded', () => {
    const profile = getR1MeetProfile('r1_dex_sales')!;
    expect(profile.disclosureChatMessage).toBe(DISCLOSURE);
    expect(profile.disclosureChatMessage).toMatch(/\bAI\b/);
    expect(profile.disclosureChatMessage).toContain('recorded');
    expect(profile.disclosureChatMessage).toContain(profile.botDisplayName);
  });

  it('is deep-frozen', () => {
    expect(Object.isFrozen(R1_MEET_PROFILES)).toBe(true);
    expect(Object.isFrozen(R1_MEET_PROFILE_IDS)).toBe(true);
    for (const profile of profiles) {
      expect(Object.isFrozen(profile), profile.id).toBe(true);
      expect(Object.isFrozen(profile.automaticLeave), profile.id).toBe(true);
    }
    const profile = getR1MeetProfile('r1_dex_sales')!;
    expect(() => {
      (profile as { botDisplayName: string }).botDisplayName = 'Someone else';
    }).toThrow(TypeError);
    expect(() => {
      (profile.automaticLeave as { everyoneLeftTimeoutSec: number }).everyoneLeftTimeoutSec = 2;
    }).toThrow(TypeError);
    expect(() => {
      (R1_MEET_PROFILES as Record<string, unknown>).r1_other = profile;
    }).toThrow(TypeError);
    expect(() => {
      (R1_MEET_PROFILE_IDS as string[]).push('r1_other');
    }).toThrow(TypeError);
    expect(getR1MeetProfile('r1_dex_sales')!.botDisplayName).toBe('Dex');
  });

  it('keys every profile by its own id', () => {
    for (const [id, profile] of Object.entries(R1_MEET_PROFILES)) expect(profile.id).toBe(id);
  });

  it('resolves known ids to the registry entry', () => {
    expect(getR1MeetProfile(R1_MEET_DEFAULT_PROFILE_ID)).toBe(R1_MEET_PROFILES.r1_dex_sales);
  });

  it.each([
    ['an unknown id', 'r1_unknown'],
    ['an empty id', ''],
    ['a different case', 'R1_DEX_SALES'],
    ['a padded id', ' r1_dex_sales'],
    ['__proto__', '__proto__'],
    ['toString', 'toString'],
    ['constructor', 'constructor'],
    ['hasOwnProperty', 'hasOwnProperty'],
    ['valueOf', 'valueOf'],
  ])('fails closed on %s', (_name, id) => {
    expect(getR1MeetProfile(id)).toBeNull();
  });

  it('fails closed on non-strings', () => {
    for (const id of [null, undefined, 0, 1, true, {}, ['r1_dex_sales'], Symbol('r1_dex_sales')]) {
      expect(getR1MeetProfile(id)).toBeNull();
    }
  });
});

describe('every profile agrees with the database and the R1 worker', () => {
  it('reads the values it compares from the real files', () => {
    expect(allowedRoundKinds()).toContain('sales_r1');
    expect(flyEnvSeconds('R1_REJOIN_GRACE_SEC')).toBeGreaterThan(0);
    expect(flyEnvSeconds('R1_SESSION_MAX_RESIDENCY_SEC')).toBeGreaterThan(0);
    expect(workerBoundedSeconds('R1_REJOIN_GRACE_SEC').defaultSec).toBeGreaterThan(0);
    expect(workerBoundedSeconds('R1_SESSION_MAX_RESIDENCY_SEC').maxSec).toBeGreaterThan(0);
    expect(workerNoShowSeconds()).toBeGreaterThan(0);
  });

  it.each(profiles)('$id runs an interview kind the rounds table allows', (profile) => {
    expect(allowedRoundKinds()).toContain(profile.interviewKind);
  });

  it.each(profiles)('$id stays in the call through the worker rejoin grace, no shorter and no longer', (profile) => {
    const grace = workerBoundedSeconds('R1_REJOIN_GRACE_SEC');
    expect(profile.automaticLeave.everyoneLeftTimeoutSec).toBe(flyEnvSeconds('R1_REJOIN_GRACE_SEC'));
    expect(profile.automaticLeave.everyoneLeftTimeoutSec).toBe(grace.defaultSec);
    expect(profile.automaticLeave.everyoneLeftTimeoutSec).toBeGreaterThanOrEqual(grace.maxSec);
  });

  it.each(profiles)('$id caps the recorded call at its maximum length, beyond the worker session', (profile) => {
    const leave = profile.automaticLeave;
    expect(leave.inCallRecordingTimeoutSec).toBe(profile.maxCallMinutes * 60);
    const noShow = workerNoShowSeconds();
    expect(leave.inCallRecordingTimeoutSec).toBeGreaterThan(flyEnvSeconds('R1_SESSION_MAX_RESIDENCY_SEC') + noShow);
    // The worker clamps residency to this upper bound whatever its env says.
    expect(leave.inCallRecordingTimeoutSec).toBeGreaterThan(workerBoundedSeconds('R1_SESSION_MAX_RESIDENCY_SEC').maxSec + noShow);
    expect(leave.inCallRecordingTimeoutSec).toBeLessThanOrEqual(3600);
  });

  it.each(profiles)('$id waits for a candidate longer than the bot joins early plus the worker no-show wait', (profile) => {
    const leave = profile.automaticLeave;
    expect(leave.nooneJoinedTimeoutSec).toBeGreaterThan(profile.botJoinLeadSec + workerNoShowSeconds());
    expect(leave.inCallNotRecordingTimeoutSec).toBeGreaterThan(profile.botJoinLeadSec + workerNoShowSeconds());
  });

  it.each(profiles)('$id respects the Recall automatic-leave limits', (profile) => {
    const leave = profile.automaticLeave;
    expect(leave.waitingRoomTimeoutSec).toBeLessThanOrEqual(600);
    for (const value of [
      leave.waitingRoomTimeoutSec,
      leave.nooneJoinedTimeoutSec,
      leave.inCallNotRecordingTimeoutSec,
      leave.inCallRecordingTimeoutSec,
    ]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(30);
    }
    expect(Number.isSafeInteger(leave.everyoneLeftTimeoutSec)).toBe(true);
    expect(leave.everyoneLeftTimeoutSec).toBeGreaterThanOrEqual(1);
  });

  it.each(profiles)('$id has sane scheduling and retention values', (profile) => {
    expect(Number.isSafeInteger(profile.botJoinLeadSec)).toBe(true);
    expect(profile.botJoinLeadSec).toBeGreaterThan(0);
    expect(profile.botJoinLeadSec).toBeLessThan(profile.automaticLeave.waitingRoomTimeoutSec);
    expect(Number.isSafeInteger(profile.maxCallMinutes)).toBe(true);
    expect(profile.maxCallMinutes).toBeGreaterThan(0);
    expect(Number.isSafeInteger(profile.participantMetadataRetentionHours)).toBe(true);
    expect(profile.participantMetadataRetentionHours).toBeGreaterThanOrEqual(1);
    expect(profile.participantMetadataRetentionHours).toBeLessThanOrEqual(24);
  });

  it.each(profiles)('$id shows a bot name Recall accepts', (profile) => {
    expect(profile.botDisplayName.length).toBeGreaterThanOrEqual(1);
    expect(profile.botDisplayName.length).toBeLessThanOrEqual(100);
    expect(profile.botDisplayName).toBe(profile.botDisplayName.trim());
    expect(profile.botDisplayName).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each(profiles)('$id discloses that the interviewer is an AI, by name, and that the call is recorded', (profile) => {
    const message = profile.disclosureChatMessage;
    expect(message.trim().length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(4096);
    expect(message).toMatch(/\bAI\b/);
    expect(message).toMatch(/\brecorded\b/);
    expect(message).toContain(profile.botDisplayName);
  });

  it.each(profiles)('$id uses a consent mode this build knows', (profile) => {
    expect(R1_MEET_CONSENT_MODES).toContain(profile.consentMode);
  });
});
