-- Allow the current DeepSeek provider in immutable model provenance payloads.
-- Existing validation remains unchanged except provider may now be either
-- the legacy Anthropic value or the current DeepSeek value.

create or replace function screening_v2.is_valid_model_provenance(p jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = pg_catalog
as $$
declare
  key text;
  allowed_keys constant text[] := array[
    'schema_version', 'provider', 'requestedModel', 'workload',
    'prompt_template_version', 'timestamp', 'inference_params'
  ];
  param_key text;
  allowed_param_keys constant text[] := array['temperature', 'max_tokens'];
  val text;
  ts_val text;
  temp_val numeric;
  mt_val numeric;
  id_re constant text := '^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$';
  ver_re constant text := '^[a-zA-Z0-9][a-zA-Z0-9_\-.:/]{0,98}[a-zA-Z0-9]$|^[a-zA-Z0-9]$';
  ts_re constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$';
  url_re constant text := '(https?://|ftp://|file://|[\s(]/[\w./-]|^/[\w./-]|\.\.[/\\]|\\[\w.-]+\\[\w.-]+|[A-Za-z]:\\(?:[\w.-]+\\)*[\w.-]+|\\\\[\w.-]+(?:\\[\w.-]+)+|[\w.\-]+:[\w.\-]+@[\w.\-]+\.[a-z]{2,})';
  cred_re constant text := '\m(sk-[a-zA-Z0-9_\-]{10,}|api[_-]?key|secret[_-]?key|token[_-]?[a-zA-Z0-9]{10,}|key_[a-zA-Z0-9]{10,}|eyJ[a-zA-Z0-9_-]{10,}\.|BEGIN\s+(RSA\s+)?PRIVATE\s+KEY|ghp_[a-zA-Z0-9]{10,}|gho_[a-zA-Z0-9]{10,}|xox[baprs]-[a-zA-Z0-9-]{10,})\M';
  ctl_re constant text := '[\x00-\x1f\x7f]';
  y int; m int; d int; hh int; mi int; ss int;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    return false;
  end if;

  if p = '{"schema_version":0,"provider":"legacy","requestedModel":"unknown","workload":"unknown","prompt_template_version":"legacy","timestamp":"1970-01-01T00:00:00Z"}'::jsonb then
    return true;
  end if;

  if not (p ? 'schema_version')
     or not (p ? 'provider')
     or not (p ? 'requestedModel')
     or not (p ? 'workload')
     or not (p ? 'prompt_template_version')
     or not (p ? 'timestamp')
  then
    return false;
  end if;

  if p->>'schema_version' <> '1' or jsonb_typeof(p->'schema_version') <> 'number' then
    return false;
  end if;

  if p->>'provider' not in ('anthropic', 'deepseek') or jsonb_typeof(p->'provider') <> 'string' then
    return false;
  end if;

  if jsonb_typeof(p->'requestedModel') <> 'string' then
    return false;
  end if;
  val := p->>'requestedModel';
  if length(val) = 0 or length(val) > 200 then
    return false;
  end if;
  if val !~ id_re then
    return false;
  end if;
  if val ~ url_re then
    return false;
  end if;
  if val ~ cred_re then
    return false;
  end if;
  if val ~ ctl_re then
    return false;
  end if;

  if p->>'workload' not in ('screening', 'scoring')
     or jsonb_typeof(p->'workload') <> 'string'
  then
    return false;
  end if;

  if jsonb_typeof(p->'prompt_template_version') <> 'string' then
    return false;
  end if;
  val := p->>'prompt_template_version';
  if length(val) = 0 or length(val) > 100 then
    return false;
  end if;
  if val !~ ver_re then
    return false;
  end if;
  if val ~ ctl_re then
    return false;
  end if;

  if jsonb_typeof(p->'timestamp') <> 'string' then
    return false;
  end if;
  ts_val := p->>'timestamp';
  if ts_val !~ ts_re then
    return false;
  end if;
  y := substring(ts_val from 1 for 4)::int;
  m := substring(ts_val from 6 for 2)::int;
  d := substring(ts_val from 9 for 2)::int;
  hh := substring(ts_val from 12 for 2)::int;
  mi := substring(ts_val from 15 for 2)::int;
  ss := substring(ts_val from 18 for 2)::int;
  if y < 2020 or y > 2100 or m < 1 or m > 12 or d < 1 or d > 31
     or hh < 0 or hh > 23 or mi < 0 or mi > 59 or ss < 0 or ss > 59 then
    return false;
  end if;

  for key in select jsonb_object_keys(p) loop
    if not (key = any(allowed_keys)) then
      return false;
    end if;
  end loop;

  if p ? 'inference_params' then
    if jsonb_typeof(p->'inference_params') <> 'object' then
      return false;
    end if;
    for param_key in select jsonb_object_keys(p->'inference_params') loop
      if not (param_key = any(allowed_param_keys)) then
        return false;
      end if;
    end loop;
    if p->'inference_params' ? 'temperature' then
      if jsonb_typeof(p->'inference_params'->'temperature') <> 'number' then
        return false;
      end if;
      temp_val := (p->'inference_params'->>'temperature')::numeric;
      if temp_val < 0 or temp_val > 2 then
        return false;
      end if;
    end if;
    if p->'inference_params' ? 'max_tokens' then
      if jsonb_typeof(p->'inference_params'->'max_tokens') <> 'number' then
        return false;
      end if;
      mt_val := (p->'inference_params'->>'max_tokens')::numeric;
      if mt_val < 1 or mt_val > 200000 or mt_val <> trunc(mt_val) then
        return false;
      end if;
    end if;
  end if;

  return true;
exception
  when others then
    return false;
end;
$$;
