-- Preserve historical Anthropic/DeepSeek provenance while allowing the direct
-- Gemini provider for new voice-screening sessions. Both the legacy validator
-- name and the active validator introduced later are updated so existing check
-- constraints and worker claims remain consistent.

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
      $old$not in ('anthropic', 'deepseek')$old$,
      $new$not in ('anthropic', 'deepseek', 'gemini')$new$
    );

    if updated_definition = previous_definition then
      raise exception 'expected provenance provider allowlist was not found';
    end if;

    execute updated_definition;
  end loop;
end;
$migration$;
