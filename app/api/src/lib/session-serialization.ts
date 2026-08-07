/**
 * Session response normalization.
 *
 * `call_sessions` has no `created_at` column — rows carry `started_at`
 * (NOT NULL DEFAULT now(), set at row creation), `ended_at`, and
 * `duration_sec`. The OpenAPI `CallSession` schema and the web `Session`
 * type both declare a non-null `created_at`, and the recruiter UI parses it
 * with `new Date(...)`. Returning the raw row leaves `created_at` undefined,
 * which renders as the literal string "Invalid Date".
 *
 * This helper makes the contract truthful without a schema migration: it
 * surfaces `created_at` as the session's creation instant, using the existing
 * `started_at` default when no explicit `created_at` column value is present.
 * All other fields are preserved unchanged.
 */

type SessionRow = Record<string, unknown> & {
  created_at?: string | null;
  started_at?: string | null;
};

/**
 * Ensure a session object exposes a `created_at` instant. Falls back to
 * `started_at` (the row-creation default) when the column is absent/null.
 * Returns the input unchanged when it is null/undefined.
 */
export function withSessionCreatedAt<T extends SessionRow>(
  row: T | null | undefined,
): (T & { created_at: string | null }) | null {
  if (row == null) return null;
  const createdAt = row.created_at ?? row.started_at ?? null;
  return { ...row, created_at: createdAt };
}

/** Map {@link withSessionCreatedAt} across a list of session rows. */
export function withSessionCreatedAtList<T extends SessionRow>(
  rows: readonly T[] | null | undefined,
): Array<T & { created_at: string | null }> {
  if (rows == null) return [];
  return rows.map((row) => withSessionCreatedAt(row)!);
}
