/**
 * Candidate-scoped additive primitives.
 *
 * A separate entry from `design/index.ts` on purpose: that barrel is
 * imported by Mission Control, Session Detail, the Dashboard and the auth
 * pages, none of which render inside `.candidate-scope`. Re-exporting these
 * from there would make every one of those surfaces load modules it can
 * never use, and would leave `design/index.ts` no longer identical to main
 * for no benefit.
 *
 * Colour here resolves only under `.candidate-scope` — see
 * src/styles/candidate-palette.css.
 */

export { SurfaceCard, MAX_SURFACE_DEPTH } from './SurfaceCard';
export type { SurfaceCardProps, SurfaceLevel } from './SurfaceCard';
export {
  Meter,
  meterBand,
  clampScore,
  BAND_LABEL,
  DEFAULT_THRESHOLDS,
} from './Meter';
export type { MeterProps, MeterBand, MeterThresholds } from './Meter';
export { Tag } from './Tag';
export type { TagProps, TagTone } from './Tag';
export {
  CandidateButton,
  CandidateSpinner,
  CandidateLabel,
  CandidateInput,
  CandidateSelect,
  CandidateLoadingState,
  CandidateErrorState,
  CandidateEmptyState,
} from './CandidateControls';
export type {
  CandidateButtonProps,
  CandidateButtonVariant,
} from './CandidateControls';
