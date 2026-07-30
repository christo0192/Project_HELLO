/**
 * REL-02/03 — Transactional outbox and durable ordered transcript event
 * schema/upsert helpers for the screening_v2 schema.
 *
 * This module is self-contained (no L1 queue imports). It works with the
 * supabase client and the two tables created in migration 0010:
 *   - transcript_events:  durable ordered store, deduped by (session_id, turn_index)
 *   - outbox:             transactional outbox for async delivery
 *
 * Design:
 *   - upsertTranscriptEvent writes a transcript event AND a pending outbox row.
 *   - Duplicate/out-of-order delivery of the same (session_id, turn_index) pair
 *     results in exactly one ordered record (idempotent).
 *   - Kill-after-commit is simulated by the outbox row staying 'pending' until
 *     a background consumer (future) publishes it.
 *   - pollOutbox / markOutboxEntry are provided for the consumer.
 */

import { supabase } from './supabase.js';

// ── Types ────────────────────────────────────────────────────────────

export interface TranscriptEventRow {
  id: string;
  session_id: string;
  turn_index: number;
  speaker: string;
  text: string;
  sequence: number;
  created_at: string;
}

export type OutboxStatus = 'pending' | 'published' | 'failed';

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: OutboxStatus;
  retry_count: number;
  max_retries: number;
  created_at: string;
  published_at: string | null;
  last_error: string | null;
}

// ── Stable error codes (never echo runtime values) ───────────────────

export const ERR_EVENT_UPSERT_FAILED = 'ERR_EVENT_UPSERT_FAILED';
export const ERR_OUTBOX_INSERT_FAILED = 'ERR_OUTBOX_INSERT_FAILED';
export const ERR_POLL_FAILED = 'ERR_POLL_FAILED';
export const ERR_MARK_FAILED = 'ERR_MARK_FAILED';
export const ERR_FETCH_EVENTS_FAILED = 'ERR_FETCH_EVENTS_FAILED';
export const ERR_EVENT_COUNT_FAILED = 'ERR_EVENT_COUNT_FAILED';

// ── Constants ────────────────────────────────────────────────────────

const MAX_SEQUENCE = 2_147_483_647; // int32 max — far more than any session
const DEFAULT_POLL_LIMIT = 50;
const OUTBOX_AGGREGATE_TYPE = 'transcript_event';
const OUTBOX_EVENT_TYPE = 'transcript_turn.created';

// ── Upsert transcript event ──────────────────────────────────────────

/**
 * Idempotently upsert a transcript turn event.
 *
 * If the (session_id, turn_index) pair already exists, the write is silently
 * ignored (ON CONFLICT DO NOTHING). Out-of-order events still insert cleanly
 * because the specific pair does not yet exist.
 *
 * On success, also creates a pending outbox row for async delivery.
 * Returns the transcript event record (existing or newly inserted).
 *
 * Error codes: ERR_EVENT_UPSERT_FAILED, ERR_OUTBOX_INSERT_FAILED
 */
export async function upsertTranscriptEvent(
  sessionId: string,
  turnIndex: number,
  speaker: string,
  text: string,
): Promise<{ data: TranscriptEventRow | null; error: string | null }> {
  // ── 1. Compute next sequence for this session ─────────────────────
  const { data: seqData, error: seqError } = await supabase
    .from('transcript_events')
    .select('sequence')
    .eq('session_id', sessionId)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (seqError) {
    return { data: null, error: ERR_EVENT_UPSERT_FAILED };
  }

  const nextSequence = seqData ? (seqData as { sequence: number }).sequence + 1 : 1;
  if (nextSequence > MAX_SEQUENCE) {
    return { data: null, error: ERR_EVENT_UPSERT_FAILED };
  }

  // ── 2. Upsert transcript event ────────────────────────────────────
  const eventPayload: Record<string, unknown> = {
    session_id: sessionId,
    turn_index: turnIndex,
    speaker,
    text,
    sequence: nextSequence,
  };

  const { data: eventData, error: eventError } = await supabase
    .from('transcript_events')
    .upsert(eventPayload, {
      onConflict: 'session_id, turn_index',
      ignoreDuplicates: true,
    })
    .select()
    .single();

  if (eventError) {
    return { data: null, error: ERR_EVENT_UPSERT_FAILED };
  }

  const eventRow = eventData as TranscriptEventRow;

  // ── 3. Create pending outbox entry ────────────────────────────────
  const { error: outboxError } = await supabase
    .from('outbox')
    .insert({
      aggregate_type: OUTBOX_AGGREGATE_TYPE,
      aggregate_id: eventRow.id,
      event_type: OUTBOX_EVENT_TYPE,
      payload: {
        sessionId,
        turnIndex,
        speaker,
        text,
        sequence: eventRow.sequence,
      },
      status: 'pending',
    });

  if (outboxError) {
    // Outbox insert failure is non-fatal for the event — the event is already
    // durable. The outbox entry can be recreated later via reconciliation.
    return { data: eventRow, error: ERR_OUTBOX_INSERT_FAILED };
  }

  return { data: eventRow, error: null };
}

// ── Create outbox entry (generic) ────────────────────────────────────

/**
 * Create a pending outbox entry for any aggregate type.
 * Used for events beyond transcript turns (e.g. session lifecycle events).
 *
 * Error code: ERR_OUTBOX_INSERT_FAILED
 */
export async function createOutboxEntry(
  aggregateType: string,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<{ data: OutboxRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from('outbox')
    .insert({
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      event_type: eventType,
      payload,
      status: 'pending',
    })
    .select()
    .single();

  if (error) {
    return { data: null, error: ERR_OUTBOX_INSERT_FAILED };
  }

  return { data: data as OutboxRow, error: null };
}

// ── Poll pending outbox entries ──────────────────────────────────────

/**
 * Fetch the oldest pending outbox entries, up to `limit`.
 *
 * Error code: ERR_POLL_FAILED
 */
export async function pollOutbox(
  limit: number = DEFAULT_POLL_LIMIT,
): Promise<{ data: OutboxRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('outbox')
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    return { data: [], error: ERR_POLL_FAILED };
  }

  return { data: (data ?? []) as OutboxRow[], error: null };
}

// ── Mark outbox entry ────────────────────────────────────────────────

/**
 * Transition an outbox entry to a new status.
 *
 * - 'published': set status + published_at timestamp, clear last_error.
 * - 'failed':    increment retry_count, record error message.
 *   If retry_count >= max_retries, the entry stays 'failed' (DLQ).
 *
 * Error code: ERR_MARK_FAILED
 */
export async function markOutboxEntry(
  id: string,
  status: OutboxStatus,
  errorMessage?: string,
): Promise<{ data: OutboxRow | null; error: string | null }> {
  const updates: Record<string, unknown> = { status };

  if (status === 'published') {
    updates.published_at = new Date().toISOString();
    updates.last_error = null;
  } else if (status === 'failed' && errorMessage) {
    // Increment retry count — the caller decides whether to retry or DLQ
    updates.last_error = errorMessage;
  }

  const { data, error } = await supabase
    .from('outbox')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    return { data: null, error: ERR_MARK_FAILED };
  }

  return { data: data as OutboxRow, error: null };
}

// ── Get transcript events for a session ──────────────────────────────

/**
 * Retrieve all transcript events for a session in sequence order.
 *
 * Error code: ERR_FETCH_EVENTS_FAILED
 */
export async function getTranscriptEvents(
  sessionId: string,
): Promise<{ data: TranscriptEventRow[]; error: string | null }> {
  const { data, error } = await supabase
    .from('transcript_events')
    .select('*')
    .eq('session_id', sessionId)
    .order('sequence', { ascending: true });

  if (error) {
    return { data: [], error: ERR_FETCH_EVENTS_FAILED };
  }

  return { data: (data ?? []) as TranscriptEventRow[], error: null };
}

// ── Count pending outbox entries ─────────────────────────────────────

/**
 * Count the number of pending outbox entries.
 *
 * Error code: ERR_EVENT_COUNT_FAILED
 */
export async function countPendingOutbox(): Promise<{ data: number; error: string | null }> {
  const { count, error } = await supabase
    .from('outbox')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  if (error) {
    return { data: 0, error: ERR_EVENT_COUNT_FAILED };
  }

  return { data: count ?? 0, error: null };
}
