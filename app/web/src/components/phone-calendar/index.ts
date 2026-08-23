/**
 * Phone calendar barrel.
 *
 * Every export here is local to the phone calendar surface. Nothing in this
 * folder is imported by another feature, and nothing here reaches into one:
 * the only shared code it consumes is the design system, the mission-control
 * confirmation primitive and the IST datetime helper.
 */
export { PhoneWeekTable } from './PhoneWeekTable';
export type { PhoneWeekTableProps } from './PhoneWeekTable';
export {
  windowBands,
  placeAppointments,
  groupByIstDay,
  parseIstHour,
  cellKey,
} from './phoneGrid';
export type { PhoneTimeBand, PlacedAppointments, QueueGroup } from './phoneGrid';
export { PhoneQueueList } from './PhoneQueueList';
export type { PhoneQueueListProps } from './PhoneQueueList';
export { PhoneAppointmentButton } from './PhoneAppointmentButton';
export type { PhoneAppointmentButtonProps } from './PhoneAppointmentButton';
export { PhoneAppointmentDetail } from './PhoneAppointmentDetail';
export type { PhoneAppointmentDetailProps } from './PhoneAppointmentDetail';
export { PhoneBookingPanel } from './PhoneBookingPanel';
export type { PhoneBookingPanelProps } from './PhoneBookingPanel';
export { PhoneSlotPicker } from './PhoneSlotPicker';
export type { PhoneSlotPickerProps } from './PhoneSlotPicker';
export { PhoneFilterBar } from './PhoneFilterBar';
export type { PhoneFilterBarProps } from './PhoneFilterBar';
export {
  PHONE_STATUS_ORDER,
  PHONE_STATE_ORDER,
  parsePhoneCalendarFilters,
  buildPhoneCalendarSearch,
  hasActivePhoneFilters,
  matchesPhoneFilters,
  phoneFacets,
  togglePhoneFacet,
} from './phoneCalendarFilters';
export type {
  PhoneCalendarFilters,
  PhoneCalendarView,
  PhoneFacet,
} from './phoneCalendarFilters';
export {
  appointmentAccessibleName,
  appointmentStatusTerm,
  candidateReferenceText,
  cancelReasonLabel,
  engagementStateTerm,
  isAttemptInFlight,
  isLiveAppointment,
  isTerminalEngagementState,
  slotRefusalLabel,
  OPERATOR_CANCEL_REASONS,
} from './phoneVocabulary';
export {
  phoneErrorMessage,
  phoneErrorRequiresRefresh,
  isVersionConflict,
} from './phoneErrors';
