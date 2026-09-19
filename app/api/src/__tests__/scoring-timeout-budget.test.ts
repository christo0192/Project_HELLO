/**
 * The SCORING timeout is separate from the shared DeepSeek budget, and its
 * clamp must agree with the validator that actually enforces it.
 *
 * WHY THIS EXISTS. Measured on 2026-09-17, every successful scoring run took
 * 133s, 162s, 167s, 174s, 191s or 206s — all above the shared 120s
 * `DEEPSEEK_TIMEOUT_MS`. Even a 9-turn call took 133s, so the floor is the
 * model (v4-pro building a five-metric rubric), not the transcript length.
 * Scoring therefore timed out on essentially every first attempt and only
 * landed when a retry slipped through; two calls burned 3 and 4 of their 5
 * attempts, and exhausting all 5 loses the scorecard with no alert.
 *
 * Raising the SHARED budget fixes scoring but hands the résumé parser (v4-flash,
 * answers in seconds) a 4.5-minute stall on a hung call. Hence a dedicated knob.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_SRC = readFileSync(
  fileURLToPath(new URL('../lib/env.ts', import.meta.url)), 'utf8',
);
const CLAUDE_SRC = readFileSync(
  fileURLToPath(new URL('../lib/claude.ts', import.meta.url)), 'utf8',
);
const FLY_TOML = readFileSync(
  fileURLToPath(new URL('../../fly.toml', import.meta.url)), 'utf8',
);

describe('scoring timeout budget', () => {
  it('has its own env knob, not the shared DeepSeek one', () => {
    expect(ENV_SRC).toContain("positiveInt('DEEPSEEK_SCORING_TIMEOUT_MS'");
    // The shared budget stays where it was: a hung parse must not stall.
    expect(ENV_SRC).toContain("positiveInt('DEEPSEEK_TIMEOUT_MS', 120000");
  });

  it('defaults above every scoring duration measured on 2026-09-17', () => {
    const m = ENV_SRC.match(
      /positiveInt\('DEEPSEEK_SCORING_TIMEOUT_MS',\s*(\d+),\s*(\d+),\s*(\d+)\)/,
    );
    expect(m).not.toBeNull();
    const [, def] = m!;
    // Slowest observed successful run was 206s.
    expect(Number(def)).toBeGreaterThan(206_000);
  });

  it('CLAMPS TO THE SAME CEILING THE VALIDATOR ENFORCES', () => {
    // The bug this pins: the first cut clamped to 600000 while
    // `validateRuntimeOverrides` THROWS above 300000. An operator setting
    // 400000 would have got a TypeError at call time — scoring CRASHING
    // instead of waiting longer, the exact opposite of the intent.
    const envMax = Number(
      ENV_SRC.match(/positiveInt\('DEEPSEEK_SCORING_TIMEOUT_MS',\s*\d+,\s*\d+,\s*(\d+)\)/)![1],
    );
    const validatorMax = Number(
      CLAUDE_SRC.match(/if \(t > ([\d_]+)\) throw new TypeError\('timeoutMs must not exceed/)![1]
        .replace(/_/g, ''),
    );
    expect(envMax).toBe(validatorMax);
  });

  it('the deploy manifest states the value production runs', () => {
    // A Fly SECRET of the same name shadows `[env]`, and a manifest that
    // disagrees with production is what caused two wrong diagnoses in
    // 2026-09-17 (this knob and PHONE_STATIC_ENDPOINTING_MAX_DELAY_SEC).
    expect(FLY_TOML).toMatch(/DEEPSEEK_SCORING_TIMEOUT_MS\s*=\s*"270000"/);
  });

  it('every scoring call site passes the scoring budget, not the default', () => {
    for (const rel of [
      '../lib/scorecards/scorer.ts',
      '../lib/scorecards/integrity.ts',
      '../services/assessment.ts',
    ]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      // Count only OPTION positions — `model: env.deepseekScoringModel` — not
      // every mention. `assessment.ts:364` passes the model name to
      // `scoringProvenance()` for the audit trail, which makes no inference
      // call and needs no timeout; an earlier version of this test counted it
      // and demanded a timeout that would have meant nothing.
      const callSites = (src.match(/model:\s*env\.deepseekScoringModel/g) ?? []).length;
      const timeoutHits = (src.match(/timeoutMs:\s*env\.deepseekScoringTimeoutMs/g) ?? []).length;
      expect(callSites, `${rel} has at least one scoring call`).toBeGreaterThan(0);
      expect(timeoutHits, `${rel} passes the scoring timeout at every call`).toBe(callSites);
    }
  });
});
