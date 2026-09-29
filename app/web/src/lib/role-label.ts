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

/** Separator for the last-resort number. NOT a bracket: `(…)` means "the role". */
const DUPLICATE_SEPARATOR = ' · ';

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

/**
 * `agentLabel` for every role, keyed by id — made distinguishable wherever two
 * would read the same, because a picker must never show two identical options
 * that mean different things. Resolved in two steps, each only where needed:
 *
 *   1. A clash involving an agent name says WHICH ROLE, in the same
 *      "Agent (Role title)" form used everywhere else: two roles both called
 *      `Gopu` become `Gopu (Sales)` and `Gopu (Support)`.
 *   2. Whatever still reads the same — two roles with one title and no agent
 *      name, or the same agent on two same-titled roles — is numbered in list
 *      order after a middle dot: `Sales`, `Sales · 2`. Never `Sales (2)`,
 *      which reads as a role called "2".
 *
 * A number is never handed out if some other role's label already reads that
 * way, so the result is unique whatever the titles are.
 */
export function uniqueAgentLabels<T extends NamedRole & { id: string }>(
  roles: readonly T[],
): Map<string, string> {
  const baseCounts = countBy(roles, agentLabel);
  const named = roles.map((role) => ({
    id: role.id,
    label: (baseCounts.get(agentLabel(role)) ?? 0) > 1 ? agentWithRoleLabel(role) : agentLabel(role),
  }));

  const taken = new Set(named.map((entry) => entry.label));
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const { id, label } of named) {
    const nth = (seen.get(label) ?? 0) + 1;
    seen.set(label, nth);
    if (nth === 1) {
      labels.set(id, label);
      continue;
    }
    let n = nth;
    while (taken.has(`${label}${DUPLICATE_SEPARATOR}${n}`)) n += 1;
    const numbered = `${label}${DUPLICATE_SEPARATOR}${n}`;
    taken.add(numbered);
    labels.set(id, numbered);
  }
  return labels;
}
