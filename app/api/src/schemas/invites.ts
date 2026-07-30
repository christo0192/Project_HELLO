import { z } from 'zod';

/**
 * POST /api/livekit/invite
 * Recruiter/admin issues a one-time invite token for a candidate.
 * Requires authenticated admin/interviewer context (injected by middleware).
 */
export const inviteCreateSchema = z
  .object({
    candidate_id: z.string().uuid('candidate_id must be a valid UUID'),
    session_id: z.string().uuid('session_id must be a valid UUID'),
  })
  .strict();

export type InviteCreateInput = z.infer<typeof inviteCreateSchema>;

/**
 * Response after creating an invite.
 * The plaintext token is returned exactly once.
 */
export interface InviteCreateResponse {
  token: string;
  expires_at: string;
}

/**
 * POST /api/livekit/exchange
 * Candidate exchanges an invite token for a short-lived access grant.
 */
export const inviteExchangeSchema = z
  .object({
    token: z.string().regex(/^[a-f0-9]{64}$/, 'invite token is invalid'),
  })
  .strict();

export type InviteExchangeInput = z.infer<typeof inviteExchangeSchema>;

/**
 * Response after exchanging an invite token.
 * Contains a short-lived opaque access grant and LiveKit connection details.
 */
export interface InviteExchangeResponse {
  grant_token: string;
  url: string;
  room_name: string;
  session_id: string;
  expires_at: string;
  livekit_token: string;
}
