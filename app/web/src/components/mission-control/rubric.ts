import type { ScoreValue } from '../../types';

/**
 * The four rubric levels, Poor → Excellent — Ashby's four-point Score. Its own
 * module so component files export only components (fast refresh).
 */
export const RUBRIC_LEVELS: ScoreValue[] = [1, 2, 3, 4];
