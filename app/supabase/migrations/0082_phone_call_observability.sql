-- 0082: per-call phone observability, persisted at completion.
--
-- Phone call quality signals (the no_first_audio watchdog, the deterministic
-- recovery fallback, headline turn-taking latency, and provider first-signal
-- timings) were LOG-ONLY: emitted through a NO-OP metrics sink and visible only
-- in live Fly logs, so a call could not be measured after the fact. This adds a
-- single jsonb column that the phone worker writes ONCE at /assessment/complete
-- with a compact, content-free summary of the call. GET /api/screening/:id
-- already SELECT *s call_sessions, so the summary surfaces with no route change.
--
-- The written snapshot shape (all fields optional; content-free — counts and
-- millisecond durations only, never transcript / room / candidate / request
-- IDs):
--   {
--     "watchdog_fired_count": <int>,
--     "deterministic_fallback_count": <int>,
--     "headline_latency_ms": {"median": <ms>, "p95": <ms>, "max": <ms>, "count": <int>},
--     "provider_first_signal_ms": {"llm": <ms|null>, "tts": <ms|null>, "stt": <ms|null>}
--   }
--
-- ADDITIVE ONLY. One nullable-free jsonb column DEFAULT '{}'::jsonb, so every
-- prior and every clean/never-instrumented call reads as an empty object rather
-- than null. The write at completion is a FULL SNAPSHOT applied last-write-wins
-- (an idempotent replace): the completion endpoint is retried up to 20x and
-- re-driven by reconnect legs, and each attempt carries the same snapshot, so a
-- repeated write is a no-op. Service-role writes the column; reads ride the
-- existing call_sessions policy, so no RLS or grant change is required.
--
-- Idempotent (add column if not exists).

alter table screening_v2.call_sessions
  add column if not exists observability jsonb not null default '{}'::jsonb;

comment on column screening_v2.call_sessions.observability is
  '0082: per-call phone observability summary written at /assessment/complete '
  '(watchdog_fired_count, deterministic_fallback_count, headline_latency_ms '
  '{median,p95,max,count}, provider_first_signal_ms {llm,tts,stt} medians). '
  'Content-free: counts and millisecond durations only. Full snapshot written '
  'last-write-wins (idempotent replace across completion retries and reconnect '
  'legs). Defaults {} so prior/clean/never-instrumented calls are unaffected.';
