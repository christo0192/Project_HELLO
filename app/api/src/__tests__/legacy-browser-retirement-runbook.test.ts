/**
 * PR-L: the retirement runbook is part of the deliverable. These checks keep it
 * honest: it names every retired entry point and the stable code, its usage SQL
 * is read-only and scoped to legacy rows, the only write is the single labelled
 * owner-run cancellation, and the drain and rollback sections exist.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runbookPath = join(here, '..', '..', '..', '..', 'docs', 'runbooks', 'r1-operations.md');
const runbook = readFileSync(runbookPath, 'utf8').replace(/\r\n/g, '\n');

const START = '## Legacy browser screening retirement (PR-L';
const section = runbook.slice(
  runbook.indexOf(START),
  runbook.indexOf('## Incident handling and rollback'),
);
const sqlBlocks = [...section.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1]!);
const readOnly = sqlBlocks.filter((block) => !block.includes('OWNER-RUN WRITE'));
const writes = sqlBlocks.filter((block) => block.includes('OWNER-RUN WRITE'));

/** The statement text with `--` comments removed. */
function code(block: string): string {
  return block
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
}

describe('PR-L runbook section', () => {
  it('exists, between the key rotation and incident handling sections', () => {
    expect(runbook.indexOf(START)).toBeGreaterThan(runbook.indexOf('## Key rotation'));
    expect(section.length).toBeGreaterThan(2000);
  });

  it('has the drain procedure, the read-only SQL and the rollback', () => {
    for (const heading of [
      '### What PR-L changes',
      '### Read-only SQL',
      '### Drain procedure',
      '### Rollback',
    ]) {
      expect(section).toContain(heading);
    }
  });

  it('names the switch, the stable code and every retired entry point', () => {
    expect(section).toContain('LEGACY_BROWSER_SCREENING_ENABLED');
    expect(section).toContain('browser_screening_retired');
    for (const route of [
      'POST /api/livekit/start',
      'POST /api/livekit/invite',
      'POST /api/livekit/preflight',
      'POST /api/livekit/exchange',
    ]) {
      expect(section).toContain(route);
    }
    expect(section).toContain('410');
  });

  it('documents what stays open for the drain', () => {
    for (const open of ['worker-context', '/:id/complete', '/:id/recording', '/grant/recording']) {
      expect(section).toContain(open);
    }
  });

  it('orders the close-out before R1_LANE_MODE=r1_only', () => {
    expect(section).toContain('R1_LANE_MODE=r1_only');
    expect(section.indexOf('Close out')).toBeLessThan(section.indexOf('R1_LANE_MODE=r1_only'));
  });
});

describe('PR-L runbook SQL', () => {
  it('has six read-only statements and exactly one labelled owner-run write', () => {
    expect(readOnly).toHaveLength(6);
    expect(writes).toHaveLength(1);
  });

  it.each(readOnly.map((block, index) => [`Q${index + 1}`, block] as const))(
    '%s is a single read-only select',
    (_name, block) => {
      const text = code(block).trim();
      expect(text).toMatch(/^select\b/i);
      expect(text).not.toMatch(
        /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|begin|commit|rollback|set)\b/i,
      );
      expect(text.match(/;/g)).toHaveLength(1);
    },
  );

  it('scopes every call_sessions query to legacy rows (browser, no round id)', () => {
    const sessionQueries = readOnly.filter((block) => block.includes('screening_v2.call_sessions'));
    expect(sessionQueries.length).toBeGreaterThanOrEqual(5);
    for (const block of sessionQueries) {
      expect(block).toMatch(/mode = 'browser'/);
      expect(block).toMatch(/interview_round_id is null/);
    }
  });

  it('reads recent usage (Q1 by week, Q2 the latest sessions) without candidate PII', () => {
    expect(readOnly[0]).toMatch(/date_trunc\('week', created_at\)/);
    expect(readOnly[1]).toMatch(/order by created_at desc/);
    for (const block of readOnly) {
      expect(block).not.toMatch(/\b(name|email|phone|resume)\b/i);
    }
  });

  it('limits the write to non-live legacy sessions created before T0', () => {
    const write = code(writes[0]!);
    expect(write).toMatch(/status in \('created', 'waiting'\)/);
    expect(write).not.toMatch(/in_progress/);
    expect(write).toMatch(/interview_round_id is null/);
    expect(write).toMatch(/mode = 'browser'/);
    expect(write).toMatch(/terminal_reason = 'recruiter_cancelled'/);
    expect(write).toMatch(/created_at < /);
    expect(write).not.toMatch(/\bdelete\b|\bdrop\b|\btruncate\b/i);
  });
});

/** The section with every run of whitespace collapsed, so wrapped lines compare. */
const flat = section.replace(/\s+/g, ' ');

describe('PR-L runbook: merge preconditions (review finding P1)', () => {
  const gate = section.slice(
    section.indexOf('### Merge preconditions (hard gate)'),
    section.indexOf('### Drain procedure'),
  );
  const gateFlat = gate.replace(/\s+/g, ' ');

  it('has a hard merge gate placed before the drain procedure', () => {
    expect(section).toContain('### Merge preconditions (hard gate)');
    expect(gate.length).toBeGreaterThan(500);
    expect(section.indexOf('### Merge preconditions (hard gate)')).toBeLessThan(
      section.indexOf('### Drain procedure'),
    );
  });

  it('says merging IS the retirement and that the owner pastes Q1, Q3, Q4 and Q5 into the PR', () => {
    expect(gateFlat).toContain('Merging this PR IS the retirement');
    expect(gateFlat).toContain('deploy-fly.yml');
    expect(gateFlat).toMatch(/Q1, Q3, Q4 and Q5/);
    expect(gateFlat).toMatch(/pasted the four\s+results into the PR/);
  });

  it('gives each query a pass criterion', () => {
    expect(gate).toMatch(/\| Q1 \|/);
    expect(gate).toMatch(/\| Q3 \|[^\n]*`in_progress`[^\n]*`candidate_joined = true`/);
    expect(gate).toMatch(/\| Q4 \|[^\n]*`unconsumed_unexpired = 0`/);
    expect(gate).toMatch(
      /\| Q5 \|[^\n]*`screening_mode = 'browser_primary'`[^\n]*`status = 'enabled'`/,
    );
  });

  it('keeps the 07:00 to 08:30 IST window and offers the inert alternative', () => {
    expect(gateFlat).toContain('07:00 to 08:30 IST');
    expect(gateFlat).toContain('r1_settings.paused = true');
    expect(gateFlat).toContain('drop the `LEGACY_BROWSER_SCREENING_ENABLED` line');
    expect(gateFlat).toContain(
      'fly secrets set LEGACY_BROWSER_SCREENING_ENABLED=false -a project-hello-api',
    );
  });

  it('no longer lets an enabled browser_primary mapping through on the owner say-so', () => {
    expect(flat).not.toContain('the owner accepts any enabled');
    expect(flat).not.toContain('ideally no row');
  });

  it('Q3 says whether a candidate has joined, and stays read-only', () => {
    const q3 = readOnly[2]!;
    expect(q3).toContain('as candidate_joined');
    expect(q3).toMatch(/i\.consumed_at is not null/);
    expect(code(q3)).not.toMatch(/\b(insert|update|delete)\b/i);
  });

  it('step 1 of the drain procedure points back at the gate', () => {
    const drain = section.slice(section.indexOf('### Drain procedure')).replace(/\s+/g, ' ');
    expect(drain).toContain('Meet every merge precondition above');
  });
});

describe('PR-L runbook: fast rollback (review finding P1)', () => {
  const rollback = section.slice(section.indexOf('### Rollback'));
  const rollbackFlat = rollback.replace(/\s+/g, ' ');

  it('leads with a no-PR secret rollback, before the fly.toml edit', () => {
    expect(rollbackFlat).toContain(
      '`fly secrets set LEGACY_BROWSER_SCREENING_ENABLED=true -a project-hello-api`',
    );
    expect(rollback.indexOf('Fast rollback')).toBeLessThan(rollback.indexOf('Durable rollback'));
    expect(rollbackFlat).toContain('no PR');
  });

  it('cites the precedent for a secret overriding [env] and tells the operator to verify', () => {
    expect(rollbackFlat).toContain('ashby-runtime-activation.md');
    expect(rollbackFlat).toContain('ASHBY_RUNTIME_ENABLED');
    expect(rollbackFlat).toContain('Verify it rather than assume it');
    expect(rollbackFlat).toContain('`GET /api/me`');
    expect(rollbackFlat).toContain('`legacyBrowserScreeningEnabled: true`');
  });

  it('removes the secret afterwards so it cannot hide fly.toml', () => {
    expect(rollbackFlat).toContain('fly secrets unset LEGACY_BROWSER_SCREENING_ENABLED');
  });

  it('the precedent it cites really exists in the repo', () => {
    const precedent = readFileSync(
      join(here, '..', '..', '..', '..', 'docs', 'runbooks', 'ashby-runtime-activation.md'),
      'utf8',
    );
    expect(precedent).toMatch(/fly secrets set ASHBY_API_KEY[^\n]*ASHBY_RUNTIME_ENABLED=true/);
    const flyToml = readFileSync(
      join(here, '..', '..', 'fly.toml'),
      'utf8',
    );
    expect(flyToml).toMatch(/^\s*ASHBY_RUNTIME_ENABLED = "false"\s*$/m);
  });
});

describe('PR-L runbook: the consent routes are not part of the drain (review finding P2)', () => {
  it('lists the consent routes as retired entry points', () => {
    expect(section).toMatch(/\| `POST \/api\/candidate-consent\/status` and `\/submit` \| 410/);
    expect(flat).toContain('`GET .../template` stays open');
  });

  it('says why they are not drain, and keeps them out of the open list', () => {
    expect(flat).toContain('The candidate consent routes are NOT part of the drain');
    expect(flat).toContain('phone admission reads');
    const start = flat.indexOf('The drain, meaning');
    const openList = flat.slice(start, flat.indexOf('The candidate consent routes are NOT'));
    expect(openList).toContain('worker-context');
    expect(openList).not.toContain('consent');
  });
});

describe('PR-L runbook: queued Ashby invite operations (review finding P3)', () => {
  it('documents the operation worker retirement and its log marker', () => {
    expect(section).toMatch(/\| Ashby `invite_delivery` operation queued or deferred before T0 \|/);
    expect(flat).toContain('fails it with `browser_screening_retired`');
    expect(flat).toContain('`scorecard_write` is untouched');
  });

  it('tells the operator what to expect after T0, and what stays parked', () => {
    expect(flat).toContain('Ashby effects to expect after T0');
    expect(flat).toContain('`operationsFailed`');
    expect(flat).toContain('`awaiting_manual_delivery` stay parked');
  });

  it('documents the Mission Control invite actions being hidden', () => {
    expect(flat).toContain('"Get invite link" and "Reissue invite link" are not rendered');
  });

  it('after a rollback, covers the applications whose queued invite was failed', () => {
    expect(flat).toContain('failed with `browser_screening_retired`');
  });
});
