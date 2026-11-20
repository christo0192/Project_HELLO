/**
 * recall/types.ts — the Recall.ai request types we send (vendor snake_case) and the closed,
 * camelCase Bot shape we keep.
 *
 * The request types are deliberately NARROWER than Recall's API: they only admit what R1-over-Meet
 * uses. In particular the output-media camera kind is the literal `'webpage'` and nothing else (S01
 * plan R8): the client re-checks it at run time, because a cast can defeat a type.
 *
 * Field names and enums follow Recall's Create Bot OpenAPI (BotRequest, AutomaticLeaveRequest,
 * BotRecordingConfigRequest, ChatOnBotJoinRequest, OutputMediaWebpageRequest, GoogleMeetRequest).
 */

/** Every REST operation the client performs; the name used in logs and errors. */
export type RecallOperation =
  | 'bot.create'
  | 'bot.get'
  | 'bot.delete_scheduled'
  | 'bot.leave_call'
  | 'bot.output_media.start'
  | 'bot.output_media.stop';

/** Google Meet bot machine sizes Recall offers. R1 uses `web_4_core`. */
export const RECALL_GOOGLE_MEET_VARIANTS = Object.freeze(['web', 'web_4_core', 'web_gpu'] as const);
export type RecallGoogleMeetVariant = (typeof RECALL_GOOGLE_MEET_VARIANTS)[number];

/** The only output media we ever send: our own web page as the bot's camera. */
export interface RecallOutputMediaRequest {
  readonly camera: {
    readonly kind: 'webpage';
    readonly config: { readonly url: string };
  };
}

export interface RecallAutomaticLeaveRequest {
  readonly waiting_room_timeout?: number;
  readonly noone_joined_timeout?: number;
  readonly everyone_left_timeout?: { readonly timeout: number; readonly activate_after?: number | null };
  readonly in_call_not_recording_timeout?: number;
  readonly in_call_recording_timeout?: number;
}

/** The realtime events R1 asks for: whether a human is in the call. */
export type RecallRealtimeEvent = 'participant_events.join' | 'participant_events.leave';

export interface RecallRealtimeWebhookEndpoint {
  readonly type: 'webhook';
  readonly url: string;
  readonly events: readonly RecallRealtimeEvent[];
}

/**
 * The minimal recording config (S01 plan R10): no video, no transcript, no meeting metadata, only
 * participant events, retained for an hour, pushed to our realtime webhook.
 */
export interface RecallRecordingConfigRequest {
  readonly transcript?: null;
  readonly video_mixed_mp4?: null;
  readonly meeting_metadata?: null;
  readonly participant_events?: Readonly<Record<string, never>>;
  readonly start_recording_on?: 'call_join' | 'participant_join' | 'participant_speak';
  readonly retention?: { readonly type: 'timed'; readonly hours: number };
  readonly realtime_endpoints?: readonly RecallRealtimeWebhookEndpoint[];
}

export interface RecallChatOnBotJoinRequest {
  readonly send_to: 'host' | 'everyone' | 'everyone_except_host';
  readonly message: string;
  readonly pin?: boolean;
}

/** `POST /api/v1/bot/` body. Only `meeting_url` is required by Recall. */
export interface RecallCreateBotRequest {
  /** Must already be the canonical `https://meet.google.com/<code>` (normalizeGoogleMeetUrl). */
  readonly meeting_url: string;
  readonly bot_name?: string;
  /** ISO 8601. At least 10 min ahead makes a scheduled bot, which never gets 507. */
  readonly join_at?: string;
  readonly variant?: { readonly google_meet: RecallGoogleMeetVariant };
  readonly output_media?: RecallOutputMediaRequest;
  readonly automatic_leave?: RecallAutomaticLeaveRequest;
  readonly recording_config?: RecallRecordingConfigRequest | null;
  readonly chat?: { readonly on_bot_join: RecallChatOnBotJoinRequest };
  readonly google_meet?: { readonly google_login_group_id: string };
  readonly metadata?: Readonly<Record<string, string>>;
}

/** One entry of a bot's status history, without Recall's free-text `message`. */
export interface RecallBotStatusChange {
  readonly code: string;
  readonly subCode: string | null;
  readonly createdAt: string;
}

/**
 * The parsed Bot (S01 plan R18): a closed shape that drops `meeting_url`, `recordings`,
 * `recording_config`, `output_media` and every other field we do not need.
 */
export interface RecallBot {
  readonly id: string;
  readonly joinAt: string | null;
  /** Oldest first, at most the last 50. */
  readonly statusChanges: ReadonlyArray<RecallBotStatusChange>;
  /** The code of the newest kept status change, or null when there is none. */
  readonly latestStatus: string | null;
  /** At most 16 string entries. */
  readonly metadata: Readonly<Record<string, string>>;
}
