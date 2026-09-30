/**
 * Which roles a role filter lists (Dashboard and Candidates).
 *
 * Owner decision (M008): a role filter lists only the roles that have an
 * Ashby job mapping, each named by its role title. The SERVER decides which
 * roles those are: `GET /api/roles` flags every row with `has_ashby_mapping`
 * (true iff a non-archived mapping names the role, in any status — `enabled`
 * (live), `paused` or `drift`). The filters use the roles they already load;
 * they make no mappings request of their own.
 *
 * Why not the Mission Control mappings list, as before: that read is
 * interviewer+ (a viewer got 403 and saw every role), capped at the 200
 * newest mappings (an older mapped role vanished, and Candidates cleared a
 * valid `?role=`), and audited (every page load wrote a `resource.list` row).
 *
 * FALLBACK. The web app and the API deploy independently. A payload whose
 * rows do not all carry a boolean `has_ashby_mapping` comes from an API older
 * than the flag, and the filter lists EVERY role — the behaviour before
 * M008 — never an empty or broken control. Once the flag is present, only
 * `has_ashby_mapping === true` is listed.
 */
import { uniqueRoleLabels } from './role-label';

export interface RoleFilterOption {
  /** The role id: the option VALUE the filter sends. */
  id: string;
  /** The role title, disambiguated by `uniqueRoleLabels`. */
  label: string;
}

export type FilterableRole = {
  id: string;
  title: string;
  agent_name?: string | null;
  has_ashby_mapping?: boolean | null;
};

/**
 * True when the payload carries the server's mapping flag — every row has a
 * boolean `has_ashby_mapping`. False means an older API: list every role.
 */
export function hasMappingFlag(roles: readonly FilterableRole[]): boolean {
  return roles.every((role) => typeof role.has_ashby_mapping === 'boolean');
}

/** The roles a filter lists: the mapped ones, or every role on an older API. */
export function listedRoles<T extends FilterableRole>(roles: readonly T[]): T[] {
  return hasMappingFlag(roles) ? roles.filter((role) => role.has_ashby_mapping === true) : [...roles];
}

/** The options a role filter lists after "All roles", sorted by label. */
export function roleFilterOptions(roles: readonly FilterableRole[]): RoleFilterOption[] {
  const listed = listedRoles(roles);
  const labels = uniqueRoleLabels(listed);
  return listed
    .map((role) => ({ id: role.id, label: labels.get(role.id) ?? role.title }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

/**
 * True when `selectedId` must fall back to "All roles": the roles are loaded
 * and the selection is not among the options. Never true before the roles
 * load (or when their read failed), so a slow or failed request can never
 * clear a filter the user set.
 */
export function shouldResetRoleFilter(
  selectedId: string | null,
  rolesLoaded: boolean,
  options: readonly RoleFilterOption[],
): boolean {
  if (!selectedId || !rolesLoaded) return false;
  return !options.some((option) => option.id === selectedId);
}
