-- The assistant (packages/shared/src/agent.ts): the thread of messages between the project's people
-- and the AI assistant, the commands the assistant asks a person's browser to carry out, and the
-- private Realtime topic project:<id>:agent that announces both.
--
-- Writes:
--   agent_messages   a person through post_agent_message; the assistant's replies by the agent
--                    service with the service role (no member may write an assistant row)
--   agent_commands   inserted by the agent service (service role); a person's tab claims one with
--                    claim_agent_command and reports the outcome with complete_agent_command
-- The agent topic carries `message` {id} and `command` {id, status} from the triggers below and the
-- agent service's `stream` events; members receive on it and may not send (so nobody can forge a
-- stream event or announce a message that was never stored).

-- -------------------------------------------------------------------------------------------
-- agent_messages
-- -------------------------------------------------------------------------------------------
create table public.agent_messages (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  -- The assistant's turn this message belongs to.
  turn_id    text check (turn_id is null or length(turn_id) between 1 and 64),
  -- Mirrors AgentMessageRole in packages/shared/src/agent.ts (packages/shared/test keeps them equal).
  role       text not null check (role in ('assistant', 'person')),
  -- The person who wrote it (set by post_agent_message); null for the assistant, and for a person's
  -- message once their account is deleted.
  author_id  uuid references auth.users (id) on delete set null,
  -- Mirrors AgentChannel: typed, spoken, or written by the assistant on its own after an app event.
  channel    text not null check (channel in ('text', 'voice', 'app')),
  text       text not null check (length(text) <= 4000),
  -- AgentCard[] (validated and grounded by the agent service).
  cards      jsonb not null default '[]'::jsonb check (jsonb_typeof(cards) = 'array' and jsonb_array_length(cards) <= 6),
  -- AgentAction: the card button a person pressed with this message.
  action     jsonb check (action is null or jsonb_typeof(action) = 'object'),
  created_at timestamptz not null default now(),
  constraint agent_messages_assistant_has_no_author check (role = 'person' or author_id is null)
);
create index agent_messages_project_id_created_at_idx on public.agent_messages (project_id, created_at);

-- A person's message names its author when it is written (the foreign key may clear it later).
create or replace function public.agent_messages_person_has_author()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.role = 'person' and new.author_id is null then
    raise exception 'agent_messages: a person''s message needs its author' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.agent_messages_person_has_author() from public, anon, authenticated;

create trigger agent_messages_person_has_author
  before insert on public.agent_messages
  for each row execute function public.agent_messages_person_has_author();

alter table public.agent_messages enable row level security;
revoke all on table public.agent_messages from anon;
revoke insert, update, delete on table public.agent_messages from authenticated;

create policy "agent_messages: members can read"
  on public.agent_messages for select to authenticated
  using (public.is_project_member(project_id));

-- -------------------------------------------------------------------------------------------
-- post_agent_message: a person writes to the assistant, or presses a card button (the text is what
-- they "said", the action which button). Text is trimmed to 1-2000 characters; the channel is text
-- or voice (app messages are the assistant's own).
--   p_action: {"kind":"prepare_fix"|"not_now","issue_id":"..."} or {"kind":"choice","card_id":"..."}
-- -------------------------------------------------------------------------------------------
create or replace function public.agent_action_canonical(p_action jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_kind  text;
  v_field text;
  v_value text;
  v_max   int;
  v_key   text;
begin
  if p_action is null or jsonb_typeof(p_action) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_action) <> 'object' then
    raise exception 'the action must be a JSON object' using errcode = '22023';
  end if;
  v_kind := p_action ->> 'kind';
  if v_kind in ('prepare_fix', 'not_now') then
    v_field := 'issue_id';
    v_max := 200;
  elsif v_kind = 'choice' then
    v_field := 'card_id';
    v_max := 64;
  else
    raise exception 'the action kind must be prepare_fix, not_now or choice' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_action) loop
    if v_key not in ('kind', v_field) then
      raise exception 'action %: unknown field "%"', v_kind, v_key using errcode = '22023';
    end if;
  end loop;
  v_value := p_action ->> v_field;
  if jsonb_typeof(p_action -> v_field) is distinct from 'string' or length(v_value) not between 1 and v_max then
    raise exception 'action %: % must be a string of 1-% characters', v_kind, v_field, v_max using errcode = '22023';
  end if;
  return jsonb_build_object('kind', v_kind, v_field, v_value);
end;
$$;

revoke execute on function public.agent_action_canonical(jsonb) from public, anon, authenticated;

create or replace function public.post_agent_message(
  p_project uuid,
  p_text    text,
  p_channel text default 'text',
  p_action  jsonb default null
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
  insert into public.agent_messages (project_id, role, author_id, channel, text, action)
  values (p_project, 'person', v_uid, p_channel, v_text, public.agent_action_canonical(p_action))
  returning * into v_row;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- agent_commands (table and member read policy: 20261021210010_commercial.sql; inserted by the
-- service role only). claim_agent_command: one tab takes a pending command and runs it. The tabs of
-- the person who asked have it first; AGENT_COMMAND_OPEN_AFTER_MS (5 s) after it was made, any
-- member's tab may take it (the requester closed their browser). The row lock serializes claims, so
-- exactly one tab wins and the others get 55000.
-- -------------------------------------------------------------------------------------------
create or replace function public.claim_agent_command(p_command uuid, p_session uuid)
returns public.agent_commands
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor('claim_agent_command');
  v_row public.agent_commands;
begin
  select c.* into v_row
    from public.agent_commands c
   where c.id = p_command and public.is_project_member(c.project_id)
     for update;
  if not found then
    raise exception 'claim_agent_command: command % not found', p_command using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.sessions s
     where s.id = p_session and s.user_id = v_uid and s.project_id = v_row.project_id) then
    raise exception 'claim_agent_command: session % does not belong to the caller in this project', p_session
      using errcode = '42501';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'claim_agent_command: command % is already % (another tab took it)', p_command, v_row.status
      using errcode = '55000';
  end if;
  if v_row.requested_by is distinct from v_uid and now() < v_row.created_at + interval '5 seconds' then
    raise exception 'claim_agent_command: command % is reserved for the tabs of the person who asked until %',
      p_command, v_row.created_at + interval '5 seconds' using errcode = '55000';
  end if;

  update public.sessions set last_seen = now() where id = p_session;
  update public.agent_commands
     set status = 'running', executor_session = p_session
   where id = p_command
  returning * into v_row;
  return v_row;
end;
$$;

-- complete_agent_command: the claiming tab reports how the command ended. The result is
-- AgentCommandResult (at most 8 KB): proposal_id, version_id, version_no, message, all optional.
create or replace function public.complete_agent_command(p_command uuid, p_session uuid, p_status text, p_result jsonb)
returns public.agent_commands
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := public.workflow_actor('complete_agent_command');
  v_row    public.agent_commands;
  v_result jsonb := case when p_result is null or jsonb_typeof(p_result) = 'null' then null else p_result end;
begin
  if p_status is null or p_status not in ('succeeded', 'failed', 'rejected') then
    raise exception 'complete_agent_command: p_status must be succeeded, failed or rejected' using errcode = '22023';
  end if;
  if v_result is not null then
    if jsonb_typeof(v_result) <> 'object' then
      raise exception 'complete_agent_command: the result must be a JSON object' using errcode = '22023';
    end if;
    if octet_length(v_result::text) > 8192 then
      raise exception 'complete_agent_command: the result is limited to 8 KB' using errcode = '22023';
    end if;
    -- CASE keeps each cast behind its type test (OR does not promise an evaluation order).
    if (v_result ? 'proposal_id' and case when jsonb_typeof(v_result -> 'proposal_id') = 'string'
          then (v_result ->> 'proposal_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' else true end)
       or (v_result ? 'version_id' and case when jsonb_typeof(v_result -> 'version_id') = 'string'
          then (v_result ->> 'version_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' else true end)
       or (v_result ? 'version_no' and case when jsonb_typeof(v_result -> 'version_no') = 'number'
          then (v_result ->> 'version_no')::numeric <> trunc((v_result ->> 'version_no')::numeric)
               or (v_result ->> 'version_no')::numeric < 1 else true end)
       or (v_result ? 'message' and case when jsonb_typeof(v_result -> 'message') = 'string'
          then length(v_result ->> 'message') > 500 else true end) then
      raise exception 'complete_agent_command: the result has proposal_id and version_id (uuids), version_no (a positive integer) and message (at most 500 characters)'
        using errcode = '22023';
    end if;
  end if;

  select c.* into v_row
    from public.agent_commands c
   where c.id = p_command and public.is_project_member(c.project_id)
     for update;
  if not found then
    raise exception 'complete_agent_command: command % not found', p_command using errcode = 'P0002';
  end if;
  if v_row.executor_session is distinct from p_session
     or not exists (select 1 from public.sessions s where s.id = p_session and s.user_id = v_uid) then
    raise exception 'complete_agent_command: only the tab that claimed command % reports its outcome', p_command
      using errcode = '42501';
  end if;
  if v_row.status <> 'running' then
    raise exception 'complete_agent_command: command % is %, not running', p_command, v_row.status using errcode = '55000';
  end if;

  update public.agent_commands
     set status = p_status, result = v_result, completed_at = now()
   where id = p_command
  returning * into v_row;
  return v_row;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'post_agent_message(uuid,text,text,jsonb)', 'claim_agent_command(uuid,uuid)', 'complete_agent_command(uuid,uuid,text,jsonb)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Realtime: the agent topic. Database-originated `message` {id} and `command` {id, status}; clients
-- re-read the row through RLS. The topic joins the project topics (receive: members; send: only
-- presence, view and cursor, so members never send here).
-- -------------------------------------------------------------------------------------------
create or replace function public.project_topic_channel(p_topic text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(
    p_topic,
    '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(revisions|presence|view|cursor|commercial|workflow|agent)$'))[1];
$$;

create or replace function public.broadcast_agent_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    if tg_table_name = 'agent_messages' then
      perform realtime.send(jsonb_build_object('id', new.id), 'message', 'project:' || new.project_id::text || ':agent', true);
    else
      perform realtime.send(jsonb_build_object('id', new.id, 'status', new.status), 'command',
                            'project:' || new.project_id::text || ':agent', true);
    end if;
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_agent_change() from public, anon, authenticated;

create trigger agent_messages_agent_broadcast
  after insert on public.agent_messages
  for each row execute function public.broadcast_agent_change();

create trigger agent_commands_agent_broadcast
  after insert or update on public.agent_commands
  for each row execute function public.broadcast_agent_change();

-- -------------------------------------------------------------------------------------------
-- reset_demo, as in 20261022030100_project_documents.sql, now also clearing the assistant thread.
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
  delete from public.agent_messages where project_id = p_project;
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
