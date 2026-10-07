import { describe, expect, it } from 'vitest';
import {
  candidateMatchesJobState,
  candidatesCarryJobStatus,
  hasMappingFlag,
  hasMappingStatuses,
  listedRoles,
  roleMatchesJobState,
  roleFilterOptions,
  shouldResetRoleFilter,
  type FilterableRole,
} from './mapped-roles';

// The server computes `has_ashby_mapping` from every non-archived mapping in
// ANY status, so a live, a paused-only and a drift-only role all arrive as
// `true`; a role with none (or only archived ones) arrives as `false`.
const FLAGGED: FilterableRole[] = [
  { id: 'r1', title: 'Sales Program Advisor', agent_name: 'Gopu', has_ashby_mapping: true }, // live
  { id: 'r2', title: 'Customer Support', has_ashby_mapping: true }, // paused-only
  { id: 'r3', title: 'Backend Engineer', has_ashby_mapping: true }, // drift
  { id: 'r4', title: 'Unmapped Role', has_ashby_mapping: false },
];

/** The same roles from an API older than the flag. */
const UNFLAGGED: FilterableRole[] = FLAGGED.map(({ has_ashby_mapping: _flag, ...role }) => role);

describe('hasMappingFlag', () => {
  it('is true only when every row carries a boolean flag', () => {
    expect(hasMappingFlag(FLAGGED)).toBe(true);
    expect(hasMappingFlag(UNFLAGGED)).toBe(false);
    expect(hasMappingFlag([...UNFLAGGED.slice(0, 1), ...FLAGGED.slice(1)])).toBe(false);
    expect(hasMappingFlag([{ id: 'x', title: 'X', has_ashby_mapping: null }])).toBe(false);
  });
});

describe('roleFilterOptions', () => {
  it('lists only roles flagged true, sorted by title, values = ids', () => {
    expect(roleFilterOptions(FLAGGED)).toEqual([
      { id: 'r3', label: 'Backend Engineer' },
      { id: 'r2', label: 'Customer Support' },
      { id: 'r1', label: 'Sales Program Advisor' },
    ]);
  });

  it('hides a role flagged false', () => {
    expect(roleFilterOptions(FLAGGED).map((o) => o.id)).not.toContain('r4');
  });

  it('lists EVERY role when the flag is absent (an API older than the flag)', () => {
    expect(roleFilterOptions(UNFLAGGED).map((o) => o.id)).toEqual(['r3', 'r2', 'r1', 'r4']);
  });

  it('lists nothing when no role is mapped, or there are no roles', () => {
    expect(roleFilterOptions(FLAGGED.map((r) => ({ ...r, has_ashby_mapping: false })))).toEqual([]);
    expect(roleFilterOptions([])).toEqual([]);
  });

  it('labels by role TITLE, disambiguating only among the listed roles', () => {
    const roles: FilterableRole[] = [
      { id: 'a', title: 'Sales', agent_name: 'Gopu', has_ashby_mapping: true },
      { id: 'b', title: 'Sales', agent_name: 'Meera', has_ashby_mapping: true },
      { id: 'c', title: 'Ops', agent_name: 'Nova', has_ashby_mapping: true },
      { id: 'd', title: 'Ops', agent_name: 'Other', has_ashby_mapping: false },
    ];
    expect(roleFilterOptions(roles)).toEqual([
      { id: 'c', label: 'Ops' },
      { id: 'a', label: 'Sales — Gopu' },
      { id: 'b', label: 'Sales — Meera' },
    ]);
  });
});

describe('listedRoles', () => {
  it('keeps the role objects themselves', () => {
    expect(listedRoles(FLAGGED)).toEqual(FLAGGED.slice(0, 3));
    expect(listedRoles(UNFLAGGED)).toEqual(UNFLAGGED);
  });
});

describe('shouldResetRoleFilter', () => {
  const options = roleFilterOptions(FLAGGED);

  it('resets a selection the flagged roles do not offer', () => {
    expect(shouldResetRoleFilter('r4', true, options)).toBe(true);
    expect(shouldResetRoleFilter('gone', true, options)).toBe(true);
  });

  it('keeps an offered selection, and never resets with nothing selected', () => {
    expect(shouldResetRoleFilter('r1', true, options)).toBe(false);
    expect(shouldResetRoleFilter(null, true, options)).toBe(false);
    expect(shouldResetRoleFilter('', true, options)).toBe(false);
  });

  it('never resets before the roles load (or when their read failed)', () => {
    expect(shouldResetRoleFilter('r4', false, [])).toBe(false);
  });

  it('keeps any real role on an older API, where every role is offered', () => {
    expect(shouldResetRoleFilter('r4', true, roleFilterOptions(UNFLAGGED))).toBe(false);
  });
});

describe('Ashby job state (Active / Paused)', () => {
  const STATUSED: FilterableRole[] = [
    { id: 'live', title: 'Live Role', has_ashby_mapping: true, ashby_mapping_statuses: ['enabled'] },
    { id: 'paused', title: 'Paused Role', has_ashby_mapping: true, ashby_mapping_statuses: ['paused'] },
    { id: 'both', title: 'Both Role', has_ashby_mapping: true, ashby_mapping_statuses: ['enabled', 'paused'] },
    { id: 'drift', title: 'Drift Role', has_ashby_mapping: true, ashby_mapping_statuses: ['drift'] },
    { id: 'none', title: 'Unmapped', has_ashby_mapping: false, ashby_mapping_statuses: [] },
  ];

  it('hasMappingStatuses needs the array on every row (older API: false)', () => {
    expect(hasMappingStatuses(STATUSED)).toBe(true);
    expect(hasMappingStatuses(FLAGGED)).toBe(false);
    expect(hasMappingStatuses([])).toBe(false);
  });

  it('Active = includes enabled, Paused = includes paused, drift is in neither', () => {
    const ids = (state: 'active' | 'paused' | null) =>
      STATUSED.filter((r) => roleMatchesJobState(r, state)).map((r) => r.id);
    expect(ids('active')).toEqual(['live', 'both']);
    expect(ids('paused')).toEqual(['paused', 'both']);
    expect(ids(null)).toHaveLength(5);
  });

  it('scopes the role dropdown options to the state', () => {
    expect(roleFilterOptions(STATUSED, 'paused').map((o) => o.id).sort()).toEqual(['both', 'paused']);
    expect(roleFilterOptions(STATUSED).map((o) => o.id)).toHaveLength(4);
    expect(listedRoles(STATUSED, 'active').map((r) => r.id)).toEqual(['live', 'both']);
  });

  it('resets a role outside the scoped options', () => {
    expect(shouldResetRoleFilter('live', true, roleFilterOptions(STATUSED, 'paused'))).toBe(true);
    expect(shouldResetRoleFilter('both', true, roleFilterOptions(STATUSED, 'paused'))).toBe(false);
  });
});

describe('per-candidate Ashby job status', () => {
  const ROLES_BY_ID: FilterableRole[] = [
    { id: 'live', title: 'Live Role', has_ashby_mapping: true, ashby_mapping_statuses: ['enabled'] },
    { id: 'both', title: 'Both Role', has_ashby_mapping: true, ashby_mapping_statuses: ['enabled', 'paused'] },
  ];
  const byId = new Map(ROLES_BY_ID.map((r) => [r.id, r]));
  const c = (role_id: string | null, ashby_job_status?: 'enabled' | 'paused' | 'drift' | null) => ({
    role_id,
    ...(ashby_job_status === undefined ? {} : { ashby_job_status }),
  });

  it('detects the field only when every row carries it (null counts, absent does not)', () => {
    expect(candidatesCarryJobStatus([])).toBe(false);
    expect(candidatesCarryJobStatus([c('live', null), c('both', 'paused')])).toBe(true);
    expect(candidatesCarryJobStatus([c('live', null), c('both')])).toBe(false);
  });

  it('attributes through the candidate own job, not the role', () => {
    // `both` has a live AND a paused job; this candidate applied via the paused one.
    expect(candidateMatchesJobState(c('both', 'paused'), 'active', true, byId)).toBe(false);
    expect(candidateMatchesJobState(c('both', 'paused'), 'paused', true, byId)).toBe(true);
    expect(candidateMatchesJobState(c('both', 'drift'), 'paused', true, byId)).toBe(false);
    expect(candidateMatchesJobState(c('both', null), 'active', true, byId)).toBe(false);
  });

  it('falls back to the role-level rule without the field, and a role-less candidate is in neither', () => {
    expect(candidateMatchesJobState(c('both'), 'active', false, byId)).toBe(true);
    expect(candidateMatchesJobState(c('both'), 'paused', false, byId)).toBe(true);
    expect(candidateMatchesJobState(c(null), 'active', false, byId)).toBe(false);
  });
});
