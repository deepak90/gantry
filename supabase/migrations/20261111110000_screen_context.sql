-- What was on the screen of the person who wrote to Remy: a short, flat snapshot their tab sends with the message
-- (packages/shared/src/agent.ts ScreenContext), next to the selected tasks and the approval mode. Remy reads it to
-- know what "close that", "go back" and "play this out" mean. It is checked here as the other parts are: an object of
-- known fields, each as ScreenContext has it (yes/no, a day, one of a few words, or short text) or empty, at most
-- 1,200 bytes in all. Re-applying this file replaces the function with itself.

create or replace function public.agent_context_canonical(p_context jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key    text;
  v_tasks  jsonb;
  v_task   jsonb;
  v_screen jsonb;
  v_field  record;
  v_bad    boolean;
  v_out    jsonb := '{}'::jsonb;
  v_list   jsonb := '[]'::jsonb;
begin
  if p_context is null or jsonb_typeof(p_context) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_context) <> 'object' then
    raise exception 'the context must be a JSON object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_context) loop
    if v_key not in ('selected_tasks', 'approval_mode', 'screen') then
      raise exception 'context: unknown field "%"', v_key using errcode = '22023';
    end if;
  end loop;
  if p_context ? 'approval_mode' then
    if p_context ->> 'approval_mode' is null or p_context ->> 'approval_mode' not in ('ask', 'risky', 'auto') then
      raise exception 'context: approval_mode must be ask, risky or auto' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_object('approval_mode', p_context ->> 'approval_mode');
  end if;
  if p_context ? 'selected_tasks' then
    v_tasks := p_context -> 'selected_tasks';
    if jsonb_typeof(v_tasks) <> 'array' or jsonb_array_length(v_tasks) > 30 then
      raise exception 'context: selected_tasks must be a list of at most 30 tasks' using errcode = '22023';
    end if;
    for v_task in select value from jsonb_array_elements(v_tasks) loop
      if jsonb_typeof(v_task) <> 'object' or jsonb_typeof(v_task -> 'id') <> 'number'
         or jsonb_typeof(v_task -> 'name') <> 'string' or length(v_task ->> 'name') > 160
         or (v_task ? 'wbs' and jsonb_typeof(v_task -> 'wbs') not in ('string', 'null'))
         or length(coalesce(v_task ->> 'wbs', '')) > 40 then
        raise exception 'context: each selected task is {id, name, wbs}' using errcode = '22023';
      end if;
      v_list := v_list || jsonb_build_array(jsonb_build_object('id', v_task -> 'id', 'name', v_task -> 'name', 'wbs', coalesce(v_task -> 'wbs', 'null'::jsonb)));
    end loop;
    v_out := v_out || jsonb_build_object('selected_tasks', v_list);
  end if;
  if p_context ? 'screen' then
    v_screen := p_context -> 'screen';
    if jsonb_typeof(v_screen) <> 'object' or octet_length(v_screen::text) > 1200 then
      raise exception 'context: screen must be an object of at most 1,200 bytes' using errcode = '22023';
    end if;
    for v_field in select key, value from jsonb_each(v_screen) loop
      if v_field.key not in ('view', 'site_day', 'playing', 'crane_ride', 'level', 'panel', 'modal', 'modal_about', 'odds',
                             'snippet', 'search', 'filter', 'from', 'to', 'zoom', 'call') then
        raise exception 'context: unknown screen field "%"', v_field.key using errcode = '22023';
      end if;
      continue when jsonb_typeof(v_field.value) = 'null';
      -- Each field as ScreenContext has it: yes/no, a day, one of a few words, or text up to its length.
      v_bad := case
        when v_field.key in ('playing', 'crane_ride', 'odds') then jsonb_typeof(v_field.value) <> 'boolean'
        when jsonb_typeof(v_field.value) <> 'string' then true
        when v_field.key in ('site_day', 'from', 'to') then (v_field.value #>> '{}') !~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$'
        when v_field.key = 'view' then (v_field.value #>> '{}') not in ('chart', 'site')
        when v_field.key = 'modal' then (v_field.value #>> '{}') not in ('payment_review', 'invoice', 'drop_card', 'snippet_editor')
        when v_field.key = 'call' then (v_field.value #>> '{}') not in ('host', 'guest')
        when v_field.key = 'level' then length(v_field.value #>> '{}') > 60
        when v_field.key in ('panel', 'zoom') then length(v_field.value #>> '{}') > 30
        when v_field.key = 'search' then length(v_field.value #>> '{}') > 80
        else length(v_field.value #>> '{}') > 120
      end;
      if v_bad then
        raise exception 'context: screen field "%" doesn''t fit', v_field.key using errcode = '22023';
      end if;
    end loop;
    if v_screen ->> 'view' is null or v_screen ->> 'view' not in ('chart', 'site') then
      raise exception 'context: screen view must be chart or site' using errcode = '22023';
    end if;
    v_out := v_out || jsonb_build_object('screen', v_screen);
  end if;
  return v_out;
end;
$$;
revoke execute on function public.agent_context_canonical(jsonb) from public, anon, authenticated;
