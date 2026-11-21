/**
 * Ashby interview-schedule fixtures for R1-over-Meet (M034 S01). Test support only: never shipped
 * (`tsconfig.build.json` excludes `src/__tests__`). Reused by S03 (webhook routing, signing the raw
 * body) and S06 (runtime) tests.
 *
 * The objects mirror Ashby's webhook payload for `interviewScheduleCreate` /
 * `interviewScheduleUpdate` (`data.interviewSchedule`), INCLUDING the fields the parser must drop
 * (names, emails, roles, location, feedback link, `extraData`, the interview and interviewer-pool
 * objects, the calendar event id), so PII-minimisation is tested against a realistic shape.
 *
 * Synthetic data only: fixed fake UUIDs, `Example` names and `*@example.invalid` emails.
 * Every builder returns a fresh, mutable plain object; tests may edit or delete keys.
 */

export const FIXTURE_DEX_USER_ID = 'd3c0a1b2-7e4f-4a5b-9c6d-0e1f2a3b4c5d';
export const FIXTURE_HR_USER_ID = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e';
export const FIXTURE_OTHER_INTERVIEWER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
export const FIXTURE_APPLICATION_ID = '9e8d7c6b-5a49-4382-a716-05f4e3d2c1b0';
export const FIXTURE_STAGE_ID = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
export const FIXTURE_SCHEDULE_ID = '7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2918';
export const FIXTURE_EVENT_ID = '4e5f6a7b-8c9d-4e0f-a1b2-c3d4e5f6a7b8';
export const FIXTURE_INTERVIEW_ID = '6a7b8c9d-0e1f-4a2b-b3c4-d5e6f7a8b9c0';
export const FIXTURE_CANDIDATE_ID = '8b9c0d1e-2f3a-4b4c-95d6-e7f8a9b0c1d2';
export const FIXTURE_POOL_ID = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a';

/** The canonical Meet URL of the fixture event (Ashby sends it with `?authuser=0`). */
export const FIXTURE_MEET_URL = 'https://meet.google.com/abc-defg-hij';
export const FIXTURE_MEETING_LINK = `${FIXTURE_MEET_URL}?authuser=0`;

export const FIXTURE_START_TIME = '2026-12-01T10:30:00.000Z';
/** 45 minutes after the start. */
export const FIXTURE_END_TIME = '2026-12-01T11:15:00.000Z';
export const FIXTURE_SCHEDULE_CREATED_AT = '2026-11-20T08:59:00.000Z';
export const FIXTURE_SCHEDULE_UPDATED_AT = '2026-11-20T09:00:00.000Z';
/** Later than the schedule's `updatedAt`, so it is the fixture's `latestUpdatedAt`. */
export const FIXTURE_EVENT_UPDATED_AT = '2026-11-20T09:00:05.000Z';

/** Values the parser must drop; the PII test looks for each of them in the parsed output. */
export const FIXTURE_DROPPED_VALUES = Object.freeze({
  location: 'Example Office, Floor 3',
  feedbackLinkPrefix: 'https://app.example.invalid/interview-feedback/',
  extraDataValue: 'example-extra-data-value',
  calendarEventId: 'example-calendar-event-0001',
  interviewTitle: 'Example R1 interview',
  poolTitle: 'Example interviewer pool',
});

type FixtureObject = Record<string, unknown>;

export interface AshbyUserOptions {
  id?: string;
  firstName?: string;
  lastName?: string;
  email?: unknown;
  globalRole?: string;
  isEnabled?: boolean;
  updatedAt?: string;
}

/** A full Ashby user object (as in `scheduledBy` and `interviewers[]`). */
export function makeAshbyUser(options: AshbyUserOptions = {}): FixtureObject {
  return {
    id: options.id ?? FIXTURE_OTHER_INTERVIEWER_ID,
    firstName: options.firstName ?? 'Example',
    lastName: options.lastName ?? 'Interviewer',
    email: options.email === undefined ? 'interviewer@example.invalid' : options.email,
    globalRole: options.globalRole ?? 'Limited Access',
    isEnabled: options.isEnabled ?? true,
    updatedAt: options.updatedAt ?? '2026-10-01T00:00:00.000Z',
  };
}

/** An `interviewers[]` entry: the user plus the interviewer-only fields Ashby adds. */
function makeAshbyInterviewer(id: string): FixtureObject {
  return {
    ...makeAshbyUser({ id }),
    role: 'Interviewer',
    interviewerPool: { id: FIXTURE_POOL_ID, title: FIXTURE_DROPPED_VALUES.poolTitle },
  };
}

export interface AshbyInterviewEventOptions {
  id?: string;
  interviewId?: string;
  startTime?: unknown;
  endTime?: unknown;
  updatedAt?: unknown;
  /** Default: the fixture Meet link with `?authuser=0`. Pass null for "no link". */
  meetingLink?: unknown;
  /** The interviewer ids used for both `interviewers[]` and the deprecated `interviewerUserIds`. Default: Dex, then another interviewer. */
  interviewerIds?: readonly string[];
  /** Raw `interviewers` value; overrides the users built from `interviewerIds`. */
  interviewers?: unknown;
  /** Raw deprecated `interviewerUserIds` value; overrides `interviewerIds`. */
  interviewerUserIds?: unknown;
}

/** A full Ashby interview event, including the fields the parser must drop. */
export function makeAshbyInterviewEvent(options: AshbyInterviewEventOptions = {}): FixtureObject {
  const id = options.id ?? FIXTURE_EVENT_ID;
  const interviewerIds = options.interviewerIds ?? [FIXTURE_DEX_USER_ID, FIXTURE_OTHER_INTERVIEWER_ID];
  return {
    id,
    interviewId: options.interviewId ?? FIXTURE_INTERVIEW_ID,
    interviewScheduleId: FIXTURE_SCHEDULE_ID,
    interviewerUserIds: options.interviewerUserIds !== undefined ? options.interviewerUserIds : [...interviewerIds],
    interviewers:
      options.interviewers !== undefined ? options.interviewers : interviewerIds.map((userId) => makeAshbyInterviewer(userId)),
    createdAt: '2026-11-20T08:59:30.000Z',
    updatedAt: options.updatedAt !== undefined ? options.updatedAt : FIXTURE_EVENT_UPDATED_AT,
    startTime: options.startTime !== undefined ? options.startTime : FIXTURE_START_TIME,
    endTime: options.endTime !== undefined ? options.endTime : FIXTURE_END_TIME,
    feedbackLink: `${FIXTURE_DROPPED_VALUES.feedbackLinkPrefix}${id}`,
    location: FIXTURE_DROPPED_VALUES.location,
    meetingLink: options.meetingLink !== undefined ? options.meetingLink : FIXTURE_MEETING_LINK,
    hasSubmittedFeedback: false,
    interviewerCalendarEventId: FIXTURE_DROPPED_VALUES.calendarEventId,
    interview: {
      id: options.interviewId ?? FIXTURE_INTERVIEW_ID,
      title: FIXTURE_DROPPED_VALUES.interviewTitle,
      externalTitle: FIXTURE_DROPPED_VALUES.interviewTitle,
      isArchived: false,
    },
    extraData: { fixtureNote: FIXTURE_DROPPED_VALUES.extraDataValue },
  };
}

export interface AshbyInterviewScheduleOptions {
  id?: string;
  status?: unknown;
  applicationId?: string;
  interviewStageId?: string;
  /** Default: the fixture recruiter (Example Recruiter). Pass null for "no scheduler". */
  scheduledBy?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  /** Default: one event from `makeAshbyInterviewEvent()`. */
  interviewEvents?: unknown;
}

/** A full Ashby interview schedule (the `data.interviewSchedule` of the webhook). */
export function makeAshbyInterviewSchedule(options: AshbyInterviewScheduleOptions = {}): FixtureObject {
  return {
    id: options.id ?? FIXTURE_SCHEDULE_ID,
    status: options.status !== undefined ? options.status : 'Scheduled',
    applicationId: options.applicationId ?? FIXTURE_APPLICATION_ID,
    interviewStageId: options.interviewStageId ?? FIXTURE_STAGE_ID,
    scheduledBy:
      options.scheduledBy !== undefined
        ? options.scheduledBy
        : makeAshbyUser({
          id: FIXTURE_HR_USER_ID,
          firstName: 'Example',
          lastName: 'Recruiter',
          email: 'recruiter@example.invalid',
          globalRole: 'Organization Admin',
        }),
    createdAt: options.createdAt !== undefined ? options.createdAt : FIXTURE_SCHEDULE_CREATED_AT,
    updatedAt: options.updatedAt !== undefined ? options.updatedAt : FIXTURE_SCHEDULE_UPDATED_AT,
    interviewEvents: options.interviewEvents !== undefined ? options.interviewEvents : [makeAshbyInterviewEvent()],
  };
}

export interface AshbyScheduleWebhookOptions {
  /** Ashby adds `candidateId` to the schedule on update payloads. */
  candidateId?: string;
}

/** The Ashby webhook body `{ action, data: { interviewSchedule } }`. */
export function makeAshbyScheduleWebhookBody(
  action: string,
  schedule: FixtureObject = makeAshbyInterviewSchedule(),
  options: AshbyScheduleWebhookOptions = {},
): FixtureObject {
  const interviewSchedule: FixtureObject = { ...schedule };
  if (options.candidateId !== undefined) interviewSchedule.candidateId = options.candidateId;
  return { action, data: { interviewSchedule } };
}

/** The raw JSON text of `makeAshbyScheduleWebhookBody(...)` (what S03 signs and receives). */
export function makeAshbyScheduleWebhookRaw(
  action: string,
  schedule: FixtureObject = makeAshbyInterviewSchedule(),
  options: AshbyScheduleWebhookOptions = {},
): string {
  return JSON.stringify(makeAshbyScheduleWebhookBody(action, schedule, options));
}
