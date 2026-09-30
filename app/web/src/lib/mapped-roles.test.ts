import { describe, expect, it } from 'vitest';
import type { AshbyMcMapping } from '../types';
import {
  mappedRoleIds,
  roleFilterOptions,
  shouldResetRoleFilter,
  type MappedRoles,
} from './mapped-roles';

function mapping(roleId: string | null | undefined, status: AshbyMcMapping['status']): AshbyMcMapping {
  return {
    id: `m-${String(roleId)}-${status}`, externalJobId: 'job', status, statusReason: null,
    deliveryMode: 'email', hasAiStage: true, hasTaStage: true, label: null, roleId,
    updatedAt: '2026-09-16T06:00:00Z',
  };
}

const ready = (...ids: string[]): MappedRoles => ({ status: 'ready', roleIds: new Set(ids) });
const loading: MappedRoles = { status: 'loading', roleIds: new Set() };
const unavailable: MappedRoles = { status: 'unavailable', roleIds: new Set() };

const ROLES = [
  { id: 'r1', title: 'Sales Program Advisor', agent_name: 'Gopu' },
  { id: 'r2', title: 'Customer Support' },
  { id: 'r3', title: 'Backend Engineer' },
];

describe('mappedRoleIds', () => {
  it('counts a mapping in ANY status — live, paused or drift — that names a role', () => {
    const ids = mappedRoleIds([
      mapping('r1', 'enabled'),
      mapping('r2', 'paused'),
      mapping('r3', 'drift'),
      mapping(null, 'enabled'),
      mapping(undefined, 'enabled'),
      mapping('r4', 'enabled'),
      mapping('r4', 'paused'),
    ]);
    expect([...ids].sort()).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('counts nothing when there are no mappings', () => {
    expect(mappedRoleIds([]).size).toBe(0);
  });
});

describe('roleFilterOptions', () => {
  it('lists only mapped roles when the read succeeded, sorted by title, values = ids', () => {
    expect(roleFilterOptions(ROLES, ready('r1', 'r3', 'gone'), null)).toEqual([
      { id: 'r3', label: 'Backend Engineer' },
      { id: 'r1', label: 'Sales Program Advisor' },
    ]);
  });

  it('lists every role when the read failed', () => {
    expect(roleFilterOptions(ROLES, unavailable, null).map((o) => o.id)).toEqual(['r3', 'r2', 'r1']);
  });

  it('lists only the current selection while loading', () => {
    expect(roleFilterOptions(ROLES, loading, null)).toEqual([]);
    expect(roleFilterOptions(ROLES, loading, 'r2')).toEqual([{ id: 'r2', label: 'Customer Support' }]);
  });
});

describe('shouldResetRoleFilter', () => {
  const options = roleFilterOptions(ROLES, ready('r1'), 'r2');

  it('resets a selection the mapped set does not offer', () => {
    expect(shouldResetRoleFilter('r2', ready('r1'), true, options)).toBe(true);
  });

  it('keeps a mapped selection, and never resets with nothing selected', () => {
    expect(shouldResetRoleFilter('r1', ready('r1'), true, options)).toBe(false);
    expect(shouldResetRoleFilter(null, ready('r1'), true, options)).toBe(false);
    expect(shouldResetRoleFilter('', ready('r1'), true, options)).toBe(false);
  });

  it('never resets while loading, after a failed read, or before roles load', () => {
    expect(shouldResetRoleFilter('r2', loading, true, [])).toBe(false);
    expect(shouldResetRoleFilter('r2', unavailable, true, [])).toBe(false);
    expect(shouldResetRoleFilter('r2', ready('r1'), false, [])).toBe(false);
  });
});
