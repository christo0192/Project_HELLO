export { cx } from './cx';
export { Skeleton, SkeletonText, ChartSkeleton } from './Skeleton';
export type {
  SkeletonProps,
  SkeletonTextProps,
  ChartSkeletonProps,
} from './Skeleton';
export { KpiCard } from './KpiCard';
export type { KpiCardProps, KpiTone } from './KpiCard';
export { Table, THead, TBody, TFoot, Tr, Th, Td } from './Table';
export type { TableProps } from './Table';
export { PageHeader } from './PageHeader';
export type { PageHeaderProps } from './PageHeader';
export { StatusBadge } from './StatusBadge';
export type { StatusBadgeProps, StatusTone } from './StatusBadge';
export { ChartCard } from './ChartCard';
export type { ChartCardProps } from './ChartCard';
export { ThemeToggle } from './ThemeToggle';
export type { ThemeToggleProps } from './ThemeToggle';

/* ── Candidate-scoped additive primitives (see styles/candidate-palette.css) ── */
export { SurfaceCard, MAX_SURFACE_DEPTH } from './SurfaceCard';
export type { SurfaceCardProps, SurfaceLevel } from './SurfaceCard';
export { Meter, meterBand, clampScore, BAND_LABEL, DEFAULT_THRESHOLDS } from './Meter';
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
