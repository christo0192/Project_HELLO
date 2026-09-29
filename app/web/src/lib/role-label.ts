/**
 * How a role is NAMED on operator surfaces.
 *
 * A role has two names: `title` (the job the candidate applied for — the only
 * name the phone worker ever says aloud) and `agent_name` (0100, an optional
 * operator-facing label for the screening agent). Operator screens lead with
 * the agent name when there is one and fall back to the title, so a label is
 * never blank. `agent_name` is display-only: filters and keys stay on `id`.
 */
import type { Role } from '../types';

type NamedRole = Pick<Role, 'title'> & { agent_name?: string | null };

/** The trimmed agent name, or null when the role has none. */
export function roleAgentName(role: NamedRole): string | null {
  const name = role.agent_name?.trim();
  return name ? name : null;
}

/** The agent name when set, otherwise the role title. Never blank. */
export function agentLabel(role: NamedRole): string {
  return roleAgentName(role) ?? role.title;
}

/** `Agent (Role title)` when the role has an agent name, otherwise the title alone. */
export function agentWithRoleLabel(role: NamedRole): string {
  const agent = roleAgentName(role);
  return agent ? `${agent} (${role.title})` : role.title;
}

/**
 * `agentLabel` for every role, keyed by id, with exact duplicates made
 * distinguishable in list order (`Sales`, `Sales (2)`, …). Two roles can share
 * a title and have no agent name; a picker must never show two identical
 * options that mean different things.
 */
export function uniqueAgentLabels<T extends NamedRole & { id: string }>(
  roles: readonly T[],
): Map<string, string> {
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const role of roles) {
    const base = agentLabel(role);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    labels.set(role.id, count === 1 ? base : `${base} (${count})`);
  }
  return labels;
}
