/**
 * Ashby workflow domain — import identity, application-id-only identity, and
 * terminal cancellation planning (Wave 2 work item 3).
 */

import { describe, it, expect } from 'vitest';
import {
  decideImport,
  resolveApplicationIdentity,
  isSameApplicationIdentity,
  planTerminalCancellation,
  isHumanStageDeparture,
  type MappingActivity,
  type WorkflowOperation,
} from '../integrations/ashby/workflow.js';

const enabled: MappingActivity = { status: 'enabled', aiScreeningStageId: 'stage_ai' };

describe('decideImport', () => {
  it('imports only at the enabled mapping current AI stage', () => {
    expect(decideImport({ applicationId: 'a1', jobId: 'j1', currentStageId: 'stage_ai' }, enabled, null)).toEqual({
      action: 'import',
      applicationId: 'a1',
      jobId: 'j1',
      stageId: 'stage_ai',
    });
  });

  it('skips when the current stage is not the AI stage (human/TA/other)', () => {
    expect(decideImport({ applicationId: 'a1', jobId: 'j1', currentStageId: 'stage_human' }, enabled, null)).toEqual({
      action: 'skip',
      reason: 'stage_not_ai',
    });
  });

  it('skips a paused/drift/unknown mapping', () => {
    for (const m of [
      { status: 'paused' as const, aiScreeningStageId: 'stage_ai' },
      { status: 'drift' as const, aiScreeningStageId: 'stage_ai' },
      { status: 'unknown' as const },
    ]) {
      expect(decideImport({ applicationId: 'a1', jobId: 'j1', currentStageId: 'stage_ai' }, m, null).action).toBe('skip');
    }
  });

  it('skips a terminal link and missing ids', () => {
    expect(decideImport({ applicationId: 'a1', jobId: 'j1', currentStageId: 'stage_ai' }, enabled, 'withdrawn')).toEqual({
      action: 'skip',
      reason: 'terminal',
    });
    expect(decideImport({ jobId: 'j1', currentStageId: 'stage_ai' }, enabled, null)).toEqual({
      action: 'skip',
      reason: 'no_application',
    });
    expect(decideImport({ applicationId: 'a1', currentStageId: 'stage_ai' }, enabled, null)).toEqual({
      action: 'skip',
      reason: 'no_job',
    });
  });
});

describe('application-id-only identity (never merge by contact)', () => {
  it('reuses a non-terminal link, blocks a terminal one, creates when absent', () => {
    expect(resolveApplicationIdentity('a1', null)).toEqual({ action: 'create' });
    expect(resolveApplicationIdentity('a1', { id: 'L1', externalApplicationId: 'a1' })).toEqual({
      action: 'reuse',
      linkId: 'L1',
    });
    expect(
      resolveApplicationIdentity('a1', { id: 'L1', externalApplicationId: 'a1', terminalState: 'deleted' }),
    ).toEqual({ action: 'blocked_terminal', linkId: 'L1' });
  });

  it('treats two applications with the same email as DISTINCT', () => {
    const a = { externalApplicationId: 'app_1', email: 'same@x.com' };
    const b = { externalApplicationId: 'app_2', email: 'same@x.com' };
    expect(isSameApplicationIdentity(a, b)).toBe(false);
    expect(isSameApplicationIdentity(a, { ...a })).toBe(true);
  });
});

describe('planTerminalCancellation', () => {
  const ops: WorkflowOperation[] = [
    { id: 'o1', type: 'invite_delivery', state: 'pending' },
    { id: 'o2', type: 'scorecard_write', state: 'succeeded' },
    { id: 'o3', type: 'stage_move', state: 'blocked' },
    { id: 'o4', type: 'stage_move', state: 'running' },
    { id: 'o5', type: 'invite_delivery', state: 'cancelled' },
  ];

  it('cancels only in-flight operations + in-flight ingestion; never reverses succeeded', () => {
    const plan = planTerminalCancellation('withdrawn', ops, 'scanning');
    expect(plan.terminalState).toBe('withdrawn');
    expect(plan.cancelOperationIds.sort()).toEqual(['o1', 'o3', 'o4']);
    expect(plan.cancelIngestion).toBe(true);
  });

  it('does not cancel a terminal (ready/cancelled) ingestion', () => {
    expect(planTerminalCancellation('deleted', [], 'ready').cancelIngestion).toBe(false);
    expect(planTerminalCancellation('deleted', [], 'cancelled').cancelIngestion).toBe(false);
    expect(planTerminalCancellation('deleted', [], null).cancelIngestion).toBe(false);
  });
});

describe('isHumanStageDeparture', () => {
  it('detects a move away from the AI stage', () => {
    expect(isHumanStageDeparture('stage_ai', 'stage_ai', 'stage_human')).toBe(true);
  });
  it('is not a departure when staying at the AI stage or never at it', () => {
    expect(isHumanStageDeparture('stage_ai', 'stage_ai', 'stage_ai')).toBe(false);
    expect(isHumanStageDeparture('stage_ai', 'stage_other', 'stage_human')).toBe(false);
    expect(isHumanStageDeparture('stage_ai', 'stage_ai', null)).toBe(false);
  });
});
