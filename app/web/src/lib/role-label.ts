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
  return numberDuplicates(
    roles.map((role) => ({
      id: role.id,
      label: (baseCounts.get(agentLabel(role)) ?? 0) > 1 ? agentWithRoleLabel(role) : agentLabel(role),
    })),
  );
}

/** Between a role title and its agent name when two titles clash. An em dash, title first. */
const TITLE_AGENT_SEPARATOR = ' — ';

/** `Title — Agent` when the role has an agent name, otherwise the title alone. */
export function roleWithAgentLabel(role: NamedRole): string {
  const agent = roleAgentName(role);
  const title = role.title.trim();
  return agent ? `${title}${TITLE_AGENT_SEPARATOR}${agent}` : title;
}

/**
 * The ROLE TITLE for every role, keyed by id — the name a role filter shows
 * (the same name a live Ashby job mapping shows as "Role: …"). Made
 * distinguishable wherever two would read the same, in two steps, each only
 * where needed:
 *
 *   1. Roles that share a title are told apart by their agent name, title
 *      first: `Sales — Gopu`, `Sales — Meera`. A role without an agent name
 *      keeps its bare title.
 *   2. Whatever still reads the same — two same-titled roles with no agent
 *      name, or with the same one — is numbered in list order after a middle
 *      dot: `Sales`, `Sales · 2`.
 *
 * Display only: callers keep the role id as the option value.
 */
export function uniqueRoleLabels<T extends NamedRole & { id: string }>(
  roles: readonly T[],
): Map<string, string> {
  const titleCounts = countBy(roles, (role) => role.title.trim());
  return numberDuplicates(
    roles.map((role) => ({
      id: role.id,
      label: (titleCounts.get(role.title.trim()) ?? 0) > 1 ? roleWithAgentLabel(role) : role.title.trim(),
    })),
  );
}

/**
 * Numbers every repeat of a label in list order (`X`, `X · 2`, …), never
 * handing out a number some other entry already reads as, so the result is
 * unique whatever the inputs are.
 */
function numberDuplicates(named: ReadonlyArray<{ id: string; label: string }>): Map<string, string> {
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
