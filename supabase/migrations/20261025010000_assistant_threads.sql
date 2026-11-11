-- Assistant threads, actions and selection context (packages/shared/src/agent.ts):
--   agent_threads         conversations within a project. A message with no thread belongs to the
--                         project's main thread ("General"), which always exists and cannot be
--                         renamed or deleted. Any member starts a thread; its starter or a project
--                         manager renames or deletes it (its messages go with it).
--   agent_messages        gains thread_id and context: what the person had selected in the plan
--                         and how they let the assistant's changes apply, when they wrote.
--   agent_edit_decisions  what people decided about each change the assistant drafted (applied by
--                         hand, applied automatically, declined), written by the database from the
--                         stored card when the person's message arrives. It outlives the thread, so
--                         the changelog keeps every decision.
-- The agent topic also carries `thread` {id, op} when a thread is started, renamed or deleted.

-- -------------------------------------------------------------------------------------------
-- agent_threads
-- -------------------------------------------------------------------------------------------
create table public.agent_threads (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  title           text not null check (length(btrim(title)) between 1 and 80),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Moves with every message, so the list shows the busiest threads first.
  last_message_at timestamptz not null default now()
);
create index agent_threads_project_id_last_message_at_idx on public.agent_threads (project_id, last_message_at desc);

alter table public.agent_threads enable row level security;
revoke all on table public.agent_threads from anon;
revoke insert, update, delete on table public.agent_threads from authenticated;

create policy "agent_threads: members can read"
  on public.agent_threads for select to authenticated
  using (public.is_project_member(project_id));

-- -------------------------------------------------------------------------------------------
-- agent_messages: the thread and the context
-- -------------------------------------------------------------------------------------------
alter table public.agent_messages
  add column thread_id uuid references public.agent_threads (id) on delete cascade,
  -- AgentMessageContext: {"selected_tasks":[{"id":..,"name":..,"wbs":..}], "approval_mode":"ask"|"risky"|"auto"}
  add column context jsonb check (context is null or (jsonb_typeof(context) = 'object' and length(context::text) <= 8000));
create index agent_messages_thread_id_created_at_idx on public.agent_messages (thread_id, created_at);

-- A message goes to a thread of its own project, and moves that thread up the list.
create or replace function public.agent_messages_thread_check()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.thread_id is not null then
    update public.agent_threads t
       set last_message_at = greatest(t.last_message_at, new.created_at)
     where t.id = new.thread_id and t.project_id = new.project_id;
    if not found then
      raise exception 'agent_messages: thread % is not a thread of project %', new.thread_id, new.project_id using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.agent_messages_thread_check() from public, anon, authenticated;

create trigger agent_messages_thread_check
  before insert on public.agent_messages
  for each row execute function public.agent_messages_thread_check();

-- -------------------------------------------------------------------------------------------
-- agent_edit_decisions
-- -------------------------------------------------------------------------------------------
create table public.agent_edit_decisions (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  thread_id   uuid references public.agent_threads (id) on delete set null,
  -- The show_plan_edit card (its tool call id) and the person's message that decided it.
  card_id     text not null check (length(card_id) between 1 and 64),
  message_id  uuid references public.agent_messages (id) on delete set null,
  -- Mirrors AgentEditDecision in packages/shared/src/agent.ts.
  decision    text not null check (decision in ('applied', 'auto_applied', 'declined')),
  decided_by  uuid references auth.users (id) on delete set null,
  -- From the stored card: the change's title and its operations in words.
  title       text not null check (length(title) between 1 and 200),
  lines       jsonb not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),
  created_at  timestamptz not null default now(),
  constraint agent_edit_decisions_once unique (project_id, card_id)
);
create index agent_edit_decisions_project_id_created_at_idx on public.agent_edit_decisions (project_id, created_at);

alter table public.agent_edit_decisions enable row level security;
revoke all on table public.agent_edit_decisions from anon;
revoke insert, update, delete on table public.agent_edit_decisions from authenticated;

create policy "agent_edit_decisions: members can read"
  on public.agent_edit_decisions for select to authenticated
  using (public.is_project_member(project_id));

-- A person's apply_edit or dismiss_edit message records the decision about the card it names. The
-- title and lines come from the assistant's stored card, never from the person's message; the first
-- decision about a card is the one that counts.
create or replace function public.agent_messages_record_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_kind  text := new.action ->> 'kind';
  v_card  jsonb;
  v_lines jsonb;
begin
  if new.role <> 'person' or v_kind is null or v_kind not in ('apply_edit', 'dismiss_edit') then
    return null;
  end if;
  select c.value into v_card
    from public.agent_messages m, jsonb_array_elements(m.cards) c(value)
   where m.project_id = new.project_id
     and m.role = 'assistant'
     and c.value ->> 'id' = new.action ->> 'card_id'
     and c.value ->> 'component' = 'show_plan_edit'
   order by m.created_at desc
   limit 1;
  v_lines := coalesce(v_card -> 'props' -> 'lines', '[]'::jsonb);
  if jsonb_typeof(v_lines) <> 'array' then
    v_lines := '[]'::jsonb;
  end if;
  insert into public.agent_edit_decisions (project_id, thread_id, card_id, message_id, decision, decided_by, title, lines)
  values (
    new.project_id,
    new.thread_id,
    new.action ->> 'card_id',
    new.id,
    case
      when v_kind = 'dismiss_edit' then 'declined'
      when new.context ->> 'approval_mode' = 'auto' then 'auto_applied'
      else 'applied'
    end,
    new.author_id,
    left(coalesce(nullif(btrim(v_card -> 'props' ->> 'title'), ''), 'A change the assistant drafted'), 200),
    v_lines
  )
  on conflict on constraint agent_edit_decisions_once do nothing;
  return null;
end;
$$;

revoke execute on function public.agent_messages_record_decision() from public, anon, authenticated;

create trigger agent_messages_record_decision
  after insert on public.agent_messages
  for each row execute function public.agent_messages_record_decision();

-- -------------------------------------------------------------------------------------------
-- post_agent_message, now with the thread and the context. The context is checked here for shape
-- and size only (selected_tasks: at most 30 of {id, name, wbs}; approval_mode one of three); the
-- agent service validates it again against the plan.
-- -------------------------------------------------------------------------------------------
drop function if exists public.post_agent_message(uuid, text, text, jsonb);

create or replace function public.agent_context_canonical(p_context jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key   text;
  v_tasks jsonb;
  v_task  jsonb;
  v_out   jsonb := '{}'::jsonb;
  v_list  jsonb := '[]'::jsonb;
begin
  if p_context is null or jsonb_typeof(p_context) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_context) <> 'object' then
    raise exception 'the context must be a JSON object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_context) loop
    if v_key not in ('selected_tasks', 'approval_mode') then
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
  return v_out;
end;
$$;

revoke execute on function public.agent_context_canonical(jsonb) from public, anon, authenticated;

create or replace function public.post_agent_message(
  p_project uuid,
  p_text    text,
  p_channel text default 'text',
  p_action  jsonb default null,
  p_thread  uuid default null,
  p_context jsonb default null
)
returns public.agent_messages
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := public.workflow_actor('post_agent_message');
  v_member public.project_members := public.workflow_member(p_project, 'post_agent_message');
  v_text   text := btrim(coalesce(p_text, ''), E' \t\r\n');
  v_row    public.agent_messages;
begin
  if length(v_text) = 0 or length(v_text) > 2000 then
    raise exception 'post_agent_message: a message is 1-2000 characters' using errcode = '22023';
  end if;
  if p_channel is null or p_channel not in ('text', 'voice') then
    raise exception 'post_agent_message: p_channel must be text or voice' using errcode = '22023';
  end if;
  if p_thread is not null and not exists (select 1 from public.agent_threads t where t.id = p_thread and t.project_id = p_project) then
    raise exception 'post_agent_message: thread % is not in this project (it may have been deleted)', p_thread using errcode = 'P0002';
  end if;
  insert into public.agent_messages (project_id, thread_id, role, author_id, channel, text, action, context)
  values (p_project, p_thread, 'person', v_uid, p_channel, v_text, public.agent_action_canonical(p_action), public.agent_context_canonical(p_context))
  returning * into v_row;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Threads: start, rename, delete
-- -------------------------------------------------------------------------------------------
create or replace function public.create_agent_thread(p_project uuid, p_title text)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := public.workflow_actor('create_agent_thread');
  v_member public.project_members := public.workflow_member(p_project, 'create_agent_thread');
  v_title  text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_row    public.agent_threads;
begin
  if length(v_title) = 0 or length(v_title) > 80 then
    raise exception 'create_agent_thread: a title is 1-80 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.agent_threads t where t.project_id = p_project) >= 100 then
    raise exception 'create_agent_thread: a project keeps at most 100 threads; delete one first' using errcode = '54000';
  end if;
  insert into public.agent_threads (project_id, title, created_by)
  values (p_project, v_title, v_uid)
  returning * into v_row;
  return v_row;
end;
$$;

-- The thread for an owner check: its starter or a project manager may change it.
create or replace function public.agent_thread_for_owner(p_thread uuid, p_fn text)
returns public.agent_threads
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor(p_fn);
  v_row public.agent_threads;
begin
  select t.* into v_row from public.agent_threads t where t.id = p_thread and public.is_project_member(t.project_id);
  if not found then
    raise exception '%: thread % not found', p_fn, p_thread using errcode = 'P0002';
  end if;
  if v_row.created_by is distinct from v_uid and public.member_role(v_row.project_id) is distinct from 'pm' then
    raise exception '%: only the person who started the thread or a project manager may change it', p_fn using errcode = '42501';
  end if;
  return v_row;
end;
$$;

revoke execute on function public.agent_thread_for_owner(uuid, text) from public, anon, authenticated;

create or replace function public.rename_agent_thread(p_thread uuid, p_title text)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row   public.agent_threads := public.agent_thread_for_owner(p_thread, 'rename_agent_thread');
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
begin
  if length(v_title) = 0 or length(v_title) > 80 then
    raise exception 'rename_agent_thread: a title is 1-80 characters' using errcode = '22023';
  end if;
  update public.agent_threads set title = v_title where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.delete_agent_thread(p_thread uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.agent_threads := public.agent_thread_for_owner(p_thread, 'delete_agent_thread');
begin
  delete from public.agent_threads where id = v_row.id;
  return v_row.id;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'post_agent_message(uuid,text,text,jsonb,uuid,jsonb)', 'create_agent_thread(uuid,text)',
    'rename_agent_thread(uuid,text)', 'delete_agent_thread(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- The agent topic hears about threads (started, renamed, deleted).
-- -------------------------------------------------------------------------------------------
create or replace function public.broadcast_agent_thread_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.agent_threads := case when tg_op = 'DELETE' then old else new end;
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(jsonb_build_object('id', v_row.id, 'op', lower(tg_op)), 'thread',
                          'project:' || v_row.project_id::text || ':agent', true);
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_agent_thread_change() from public, anon, authenticated;

-- Only a start, a rename or a deletion is news; a new message moving last_message_at is announced as the message.
create trigger agent_threads_agent_broadcast
  after insert or delete or update of title on public.agent_threads
  for each row execute function public.broadcast_agent_thread_change();

-- -------------------------------------------------------------------------------------------
-- reset_demo, as in 20261024010000_library.sql, now also clearing threads and decisions.
-- -------------------------------------------------------------------------------------------
create or replace function public.reset_demo(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seed    public.demo_seeds;
  v_objects jsonb;
begin
  select d.* into v_seed from public.demo_seeds d where d.project_id = p_project;
  if not found then
    raise exception 'reset_demo: no seed stored for project % (run `pnpm db:reset` once)', p_project using errcode = 'P0002';
  end if;

  delete from public.project_documents d
   where d.project_id = p_project and not (d.created_via = 'system' and d.kind <> 'receipt');
  delete from public.agent_edit_decisions where project_id = p_project;
  delete from public.agent_messages where project_id = p_project;
  delete from public.agent_threads where project_id = p_project;
  delete from public.payment_events where project_id = p_project;
  delete from public.payment_authorizations where project_id = p_project;
  delete from public.publications where project_id = p_project;
  delete from public.decision_notes where project_id = p_project;
  delete from public.agent_commands where project_id = p_project;
  delete from public.transcript_segments where project_id = p_project;
  delete from public.proposals where project_id = p_project;
  delete from public.project_revisions where project_id = p_project;
  delete from public.record_ids where project_id = p_project;
  delete from public.sessions where project_id = p_project;

  update public.projects
     set snapshot = v_seed.snapshot, snapshot_revision = 0, current_revision = 0
   where id = p_project;

  if v_seed.library is not null then
    perform public.seed_library(p_project, v_seed.library);
  end if;

  update public.equipment_bookings b
     set task_id         = (v_seed.booking ->> 'task_id')::bigint,
         resource_id     = (v_seed.booking ->> 'resource_id')::bigint,
         supplier_name   = v_seed.booking ->> 'supplier_name',
         rental_rate_minor = (v_seed.booking ->> 'rental_rate_minor')::bigint,
         currency        = v_seed.booking ->> 'currency',
         billable_start  = (v_seed.booking ->> 'billable_start')::date,
         billable_end    = (v_seed.booking ->> 'billable_end')::date,
         idle_days       = (v_seed.booking ->> 'idle_days')::int,
         evidence_path   = v_seed.booking ->> 'evidence_path'
   where b.id = (v_seed.booking ->> 'id')::uuid;

  select coalesce(jsonb_agg(o.name order by o.name), '[]'::jsonb) into v_objects
    from storage.objects o
   where o.bucket_id = 'documents'
     and o.name like p_project::text || '/%'
     and not exists (select 1 from public.project_documents d where d.storage_path = o.name);

  return jsonb_build_object('project_id', p_project, 'reset_at', now(), 'document_objects', v_objects);
end;
$$;

revoke execute on function public.reset_demo(uuid) from public, anon, authenticated;
grant execute on function public.reset_demo(uuid) to service_role;
