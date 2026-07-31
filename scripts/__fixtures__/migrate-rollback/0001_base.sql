-- =====================================================================
-- Seeded BASE fixture for TST-15 on-disk negative control.
-- Creates a minimal forward-compatible schema contract (mirrors the shape
-- of the real additive migrations) so the negative migration below fails
-- against a REAL accumulated contract, exactly as it would in production.
-- This file must pass the verifier (it is additive and guarded).
-- =====================================================================

create table screening_v2.roles (
  id uuid primary key,
  name text not null
);

create table screening_v2.candidates (
  id uuid primary key,
  email text not null,
  role_id uuid references screening_v2.roles(id)
);

create table screening_v2.transcript_events (
  id uuid primary key,
  session_id uuid not null,
  turn_index integer not null,
  payload jsonb not null,
  unique (session_id, turn_index)
);
