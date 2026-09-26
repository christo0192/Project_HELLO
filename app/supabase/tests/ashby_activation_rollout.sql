\set ON_ERROR_STOP on
-- Execute the ACTUAL 0106 migration in an isolated rollback transaction.
-- Simulate an existing enabled pre-0106 row (NULL activation_at, old updated_at)
-- on local Postgres; rollback undoes both fixture and reapplication.
begin;
insert into screening_v2.roles (title) values ('0106 rollout synthetic role');
select id as role_id from screening_v2.roles order by id limit 1 \gset
insert into screening_v2.ashby_job_mappings
  (provider, external_job_id, role_id, ai_screening_stage_id, ta_screening_stage_id,
   owner_id, delivery_mode, invite_ttl_hours, status, updated_at)
values
  ('ashby', 'sql0106-rollout-job', :'role_id',
   'sql0106-rollout-ai', 'sql0106-rollout-ta',
   '00000000-0000-4000-8000-000000000106', 'manual', 24, 'enabled',
   '2020-01-01T00:00:00Z');

\ir :migration_file

do $$
declare v record;
begin
  select activation_at, activation_epoch into v
    from screening_v2.ashby_job_mappings
   where external_job_id = 'sql0106-rollout-job';
  if v.activation_at is null then raise exception '0106 rollout did not initialize activation_at'; end if;
  if v.activation_epoch <> 1 then raise exception '0106 rollout generation is %, wanted 1', v.activation_epoch; end if;
  if v.activation_at is distinct from transaction_timestamp() then
    raise exception '0106 rollout activation_at was not stamped at transaction time';
  end if;
  if v.activation_at = '2020-01-01T00:00:00Z'::timestamptz then
    raise exception '0106 rollout reused old updated_at';
  end if;
end $$;
rollback;
