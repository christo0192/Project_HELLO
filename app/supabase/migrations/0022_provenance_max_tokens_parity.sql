-- Restore SQL/Python/TypeScript provenance parity: max_tokens is bounded at
-- 100,000 everywhere. Migration 0019's active validator accidentally retained
-- the older 200,000 ceiling.

do $migration$
declare
  target regprocedure;
  previous_definition text;
  updated_definition text;
begin
  foreach target in array array[
    'screening_v2.is_valid_model_provenance(jsonb)'::regprocedure,
    'screening_v2.valid_model_provenance(jsonb)'::regprocedure
  ] loop
    select pg_get_functiondef(target) into previous_definition;

    updated_definition := replace(
      previous_definition,
      'mt_val > 200000',
      'mt_val > 100000'
    );

    if updated_definition = previous_definition then
      raise exception 'expected max_tokens ceiling was not found';
    end if;

    execute updated_definition;
  end loop;
end;
$migration$;
