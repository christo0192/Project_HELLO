/**
 * Which roles have an Ashby job mapping, for the role filters.
 *
 * Owner decision (M008): a role filter lists only the roles that have an
 * Ashby job mapping, each named by its role title. Every mapping in the
 * mappings list counts, whatever its status — `enabled` (live), `paused` or
 * `drift` are all still a mapped job on the Mission Control screen. A role
 * with no mapping is not listed. An archived (deleted) mapping does not
 * count: the API never returns one (it is filtered out in the query).
 *
 * FALLBACK. The mappings read is interviewer+ and depends on the Ashby
 * integration being on, so it can fail (403 for a viewer, 503 when the
 * integration is disabled, or the network). A failed read is `unavailable`
 * and the filter shows EVERY role — the behaviour before M008 — never an
 * empty or broken control.
 *
 * LOADING. Until the read settles the filter offers "All roles" plus the role
 * already selected (if any), so the closed control never changes what it says
 * and no one can pick a role that is about to disappear from the list.
 */
import { useEffect, useState } from 'react';
import { api } from '../api';
import type { AshbyMcMapping } from '../types';
import { uniqueRoleLabels } from './role-label';

export type MappedRolesStatus = 'loading' | 'ready' | 'unavailable';

export interface MappedRoles {
  status: MappedRolesStatus;
  /** Role ids with at least one (non-archived) mapping. Empty unless `ready`. */
  roleIds: ReadonlySet<string>;
}

const LOADING: MappedRoles = { status: 'loading', roleIds: new Set() };
const UNAVAILABLE: MappedRoles = { status: 'unavailable', roleIds: new Set() };

/** The role ids that have a mapping, in any status. A mapping with no role adds nothing. */
export function mappedRoleIds(mappings: readonly AshbyMcMapping[]): Set<string> {
  const ids = new Set<string>();
  for (const mapping of mappings) {
    if (typeof mapping.roleId === 'string' && mapping.roleId) ids.add(mapping.roleId);
  }
  return ids;
}

/**
 * One mappings read per mount. Any failure — including a malformed payload or
 * an API client without the method — resolves to `unavailable`.
 */
export function useMappedRoleIds(): MappedRoles {
  const [state, setState] = useState<MappedRoles>(LOADING);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => api.listAshbyMappings())
      .then((res) => {
        if (cancelled) return;
        if (!res || res.ok === false || !Array.isArray(res.mappings)) {
          setState(UNAVAILABLE);
          return;
        }
        setState({ status: 'ready', roleIds: mappedRoleIds(res.mappings) });
      })
      .catch(() => {
        if (!cancelled) setState(UNAVAILABLE);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export interface RoleFilterOption {
  /** The role id: the option VALUE the filter sends. */
  id: string;
  /** The role title, disambiguated by `uniqueRoleLabels`. */
  label: string;
}

type FilterableRole = { id: string; title: string; agent_name?: string | null };

/**
 * The options a role filter lists after "All roles", sorted by label:
 *  - `ready`:       only mapped roles;
 *  - `unavailable`: every role (the read failed, so fall back to all);
 *  - `loading`:     only the role already selected, if any.
 */
export function roleFilterOptions(
  roles: readonly FilterableRole[],
  mapped: MappedRoles,
  selectedId: string | null,
): RoleFilterOption[] {
  const listed =
    mapped.status === 'unavailable'
      ? roles
      : mapped.status === 'loading'
        ? roles.filter((role) => role.id === selectedId)
        : roles.filter((role) => mapped.roleIds.has(role.id));
  const labels = uniqueRoleLabels(listed);
  return listed
    .map((role) => ({ id: role.id, label: labels.get(role.id) ?? role.title }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/**
 * True when `selectedId` must fall back to "All roles": the mapped set is
 * known, the roles are loaded, and the selection is not among the options.
 * Never true while loading or after a failed read, so a slow or forbidden
 * mappings request can never clear a filter the user set.
 */
export function shouldResetRoleFilter(
  selectedId: string | null,
  mapped: MappedRoles,
  rolesLoaded: boolean,
  options: readonly RoleFilterOption[],
): boolean {
  if (!selectedId || mapped.status !== 'ready' || !rolesLoaded) return false;
  return !options.some((option) => option.id === selectedId);
}
