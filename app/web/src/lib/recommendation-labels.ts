/**
 * The words HR reads for a screening recommendation, on every surface: phone
 * and R1, on screen and in the downloaded report.
 *
 * Display only. The stored values stay `advance` / `hold` / `reject`: the
 * database CHECKs, API enums, `?recommendation=` URL tokens, the CSV export,
 * DB views and the LLM contract all speak those. Key anything that is not a
 * label (tone maps, filters, links) on the raw value, and read the words from
 * here. A surface keeps its own wording for `human_review` and its own
 * fallback for a value it does not know.
 */

/** A stored recommendation, in words. */
export const RECOMMENDATION_LABELS = {
  advance: 'Select',
  hold: 'Borderline',
  reject: 'Reject',
} as const;
