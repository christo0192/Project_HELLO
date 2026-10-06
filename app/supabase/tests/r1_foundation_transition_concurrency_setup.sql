-- Two valid, held rounds for deterministic admission-versus-terminal races.
-- The shell harness blocks r1_settings before it launches both callers, which
-- proves cancellation and expiry take the same first lock as admission.
create schema if not exists _r1_race;
create table if not exists _r1_race.fixtures (
  label text primary key,
  round_id uuid not null
);
truncate _r1_race.fixtures;

do $$
declare
  owner constant uuid := '10000000-0000-4000-8000-000000000001';
  role_r1 constant uuid := '10000000-0000-4000-8000-000000000002';
  template_id uuid;
  sent jsonb;
begin
  -- Earlier foundation assertions intentionally leave a retry session live;
  -- terminalize it so these fixtures control the admission predicate.
  update screening_v2.call_sessions
     set status='failed', terminal_reason='provider_error'
   where interview_round_id is not null and status in ('created','waiting','in_progress');
  -- Keep the expiry sweep focused on its fixture; prior assertions deliberately
  -- include an expired round to exercise the admission refusal path.
  update screening_v2.interview_rounds
     set expires_at=now()+interval '1 day'
   where status='invited';
  update screening_v2.r1_settings
     set enabled=true, paused=false, livekit_target='r1', monthly_cap_minutes=10000,
         pause_line_minutes=10000, dashboard_minutes=0, dashboard_read_at=now();
  select id into template_id from screening_v2.interview_round_consent_templates
   where is_active order by version desc limit 1;
  if template_id is null then raise exception 'R1 race setup needs an active consent template'; end if;

  insert into screening_v2.candidates(id,role_id,name) values
    ('20000000-0000-4000-8000-000000000091',role_r1,'admission cancel race'),
    ('20000000-0000-4000-8000-000000000092',role_r1,'admission expiry race');
  sent := screening_v2.r1_send_round('20000000-0000-4000-8000-000000000091',role_r1,owner,repeat('c',64),null,now()+interval '1 hour');
  if sent->>'status' <> 'ok' then raise exception 'cancel race Send failed: %', sent; end if;
  insert into _r1_race.fixtures(label,round_id) values('cancel',(sent->>'id')::uuid);
  sent := screening_v2.r1_send_round('20000000-0000-4000-8000-000000000092',role_r1,owner,repeat('d',64),null,now()+interval '1 hour');
  if sent->>'status' <> 'ok' then raise exception 'expiry race Send failed: %', sent; end if;
  insert into _r1_race.fixtures(label,round_id) values('expiry',(sent->>'id')::uuid);
  insert into screening_v2.interview_round_consents(round_id,template_id)
    select round_id,template_id from _r1_race.fixtures;
end;
$$;
