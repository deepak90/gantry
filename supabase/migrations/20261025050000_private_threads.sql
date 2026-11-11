-- Assistant threads that name themselves, and private conversations.
--
--   agent_threads.title_source   'auto' while the title is the first words of the first message (the
--                                assistant may name it once, from that message: 'agent'); 'person'
--                                once someone typed a name. Only an 'auto' title is replaced.
--   agent_threads.visibility     'project' (everyone in the project reads it; the main thread and
--                                older threads) or 'private' (its starter and the people they invite).
--   agent_thread_members         who was invited into a private thread (the starter is implied).
--
-- A private thread's messages and the decisions taken in it are read only by the people in it. Its
-- live reply streams on its own Realtime topic, project:<id>:thread:<thread id>, which only they can
-- join; the project's agent topic still announces every message and thread change by id, so other
-- members learn nothing but that something changed.

-- -------------------------------------------------------------------------------------------
-- Columns and members
-- -------------------------------------------------------------------------------------------
alter table public.agent_threads
  add column title_source text not null default 'person' check (title_source in ('auto', 'agent', 'person')),
  add column visibility   text not null default 'project' check (visibility in ('project', 'private'));

create table public.agent_thread_members (
  thread_id  uuid not null references public.agent_threads (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  added_by   uuid references auth.users (id) on delete set null,
  added_at   timestamptz not null default now(),
  primary key (thread_id, user_id)
);
create index agent_thread_members_user_id_idx on public.agent_thread_members (user_id);

alter table public.agent_thread_members enable row level security;
revoke all on table public.agent_thread_members from anon;
revoke insert, update, delete on table public.agent_thread_members from authenticated;

-- Whether the caller may read a thread: a project thread, every member; a private one, its starter
-- and the people in it.
create or replace function public.can_see_agent_thread(p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.agent_threads t
     where t.id = p_thread
       and public.is_project_member(t.project_id)
       and (
         t.visibility = 'project'
         or t.created_by = (select auth.uid())
         or exists (select 1 from public.agent_thread_members m where m.thread_id = t.id and m.user_id = (select auth.uid()))
       )
  );
$$;

revoke execute on function public.can_see_agent_thread(uuid) from public, anon;
grant execute on function public.can_see_agent_thread(uuid) to authenticated, service_role;

drop policy "agent_threads: members can read" on public.agent_threads;
create policy "agent_threads: who is in them can read"
  on public.agent_threads for select to authenticated
  using (public.can_see_agent_thread(id));

create policy "agent_thread_members: who is in the thread can read"
  on public.agent_thread_members for select to authenticated
  using (public.can_see_agent_thread(thread_id));

drop policy "agent_messages: members can read" on public.agent_messages;
create policy "agent_messages: who is in the thread can read"
  on public.agent_messages for select to authenticated
  using (public.is_project_member(project_id) and (thread_id is null or public.can_see_agent_thread(thread_id)));

drop policy "agent_edit_decisions: members can read" on public.agent_edit_decisions;
create policy "agent_edit_decisions: who is in the thread can read"
  on public.agent_edit_decisions for select to authenticated
  using (public.is_project_member(project_id) and (thread_id is null or public.can_see_agent_thread(thread_id)));

-- -------------------------------------------------------------------------------------------
-- Realtime: project:<project>:thread:<thread> streams a private thread's reply to the people in it.
-- -------------------------------------------------------------------------------------------
create or replace function public.project_topic_channel(p_topic text)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (regexp_match(
      p_topic,
      '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(revisions|presence|view|cursor|commercial|workflow|agent|library)$'))[1],
    case when p_topic ~ '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:thread:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then 'thread' end);
$$;

create or replace function public.can_join_project_topic(p_topic text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_channel text := public.project_topic_channel(p_topic);
begin
  if v_uid is null or v_channel is null then
    return false;
  end if;
  if v_channel = 'thread' then
    return exists (
      select 1 from public.agent_threads t
       where t.id = split_part(p_topic, ':', 4)::uuid
         and t.project_id = split_part(p_topic, ':', 2)::uuid
    ) and public.can_see_agent_thread(split_part(p_topic, ':', 4)::uuid);
  end if;
  return exists (
    select 1
    from public.project_members m
    where m.project_id = split_part(p_topic, ':', 2)::uuid
      and m.user_id = v_uid
      and (v_channel <> 'commercial' or m.can_view_costs)
  );
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Starting, naming, sharing and inviting
-- -------------------------------------------------------------------------------------------
drop function if exists public.create_agent_thread(uuid, text);

-- p_auto: the title is the first words of the first message (the assistant names it after its first
-- answer). p_private: only the starter (and whoever they invite) sees it.
create or replace function public.create_agent_thread(p_project uuid, p_title text, p_auto boolean default false, p_private boolean default false)
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
  insert into public.agent_threads (project_id, title, created_by, title_source, visibility)
  values (p_project, v_title, v_uid, case when coalesce(p_auto, false) then 'auto' else 'person' end,
          case when coalesce(p_private, false) then 'private' else 'project' end)
  returning * into v_row;
  return v_row;
end;
$$;

-- A person's name for a thread wins over the assistant's from then on.
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
  update public.agent_threads set title = v_title, title_source = 'person' where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

-- The assistant's name for a thread it answered first (service role). Replaces only a title still made
-- from the first words; returns null when someone named the thread meanwhile.
create or replace function public.name_agent_thread(p_thread uuid, p_title text)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text := btrim(regexp_replace(coalesce(p_title, ''), '[\r\n\t"“”]+', ' ', 'g'), ' .');
  v_row   public.agent_threads;
begin
  if length(v_title) = 0 then
    return null;
  end if;
  update public.agent_threads
     set title = left(v_title, 80), title_source = 'agent'
   where id = p_thread and title_source = 'auto'
  returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.name_agent_thread(uuid, text) from public, anon, authenticated;
grant execute on function public.name_agent_thread(uuid, text) to service_role;

-- Shares a private thread with the whole project, or makes a project thread private again (its starter).
create or replace function public.set_agent_thread_visibility(p_thread uuid, p_visibility text)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor('set_agent_thread_visibility');
  v_row public.agent_threads;
begin
  if p_visibility is null or p_visibility not in ('project', 'private') then
    raise exception 'set_agent_thread_visibility: visibility is project or private' using errcode = '22023';
  end if;
  select t.* into v_row from public.agent_threads t where t.id = p_thread and public.can_see_agent_thread(t.id);
  if not found then
    raise exception 'set_agent_thread_visibility: thread % not found', p_thread using errcode = 'P0002';
  end if;
  if v_row.created_by is distinct from v_uid then
    raise exception 'set_agent_thread_visibility: only the person who started the thread may share it or make it private' using errcode = '42501';
  end if;
  update public.agent_threads set visibility = p_visibility where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

-- Brings a project member into a thread the caller is in (anyone in it may invite; the thread stays
-- private, now including them).
create or replace function public.invite_to_agent_thread(p_thread uuid, p_user uuid)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor('invite_to_agent_thread');
  v_row public.agent_threads;
begin
  select t.* into v_row from public.agent_threads t where t.id = p_thread and public.can_see_agent_thread(t.id);
  if not found then
    raise exception 'invite_to_agent_thread: thread % not found', p_thread using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.project_members m where m.project_id = v_row.project_id and m.user_id = p_user) then
    raise exception 'invite_to_agent_thread: % is not a member of this project', p_user using errcode = 'P0002';
  end if;
  if p_user is distinct from v_row.created_by then
    insert into public.agent_thread_members (thread_id, user_id, added_by)
    values (v_row.id, p_user, v_uid)
    on conflict do nothing;
  end if;
  -- Announce the change (the thread row itself did not change).
  update public.agent_threads set visibility = visibility where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

-- Takes someone out of a private thread: its starter removes anyone, anyone leaves.
create or replace function public.remove_from_agent_thread(p_thread uuid, p_user uuid)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor('remove_from_agent_thread');
  v_row public.agent_threads;
begin
  select t.* into v_row from public.agent_threads t where t.id = p_thread and public.can_see_agent_thread(t.id);
  if not found then
    raise exception 'remove_from_agent_thread: thread % not found', p_thread using errcode = 'P0002';
  end if;
  if v_row.created_by is distinct from v_uid and p_user is distinct from v_uid then
    raise exception 'remove_from_agent_thread: only the person who started the thread removes others; anyone may leave' using errcode = '42501';
  end if;
  delete from public.agent_thread_members m where m.thread_id = v_row.id and m.user_id = p_user;
  update public.agent_threads set visibility = visibility where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_agent_thread(uuid,text,boolean,boolean)', 'rename_agent_thread(uuid,text)',
    'set_agent_thread_visibility(uuid,text)', 'invite_to_agent_thread(uuid,uuid)', 'remove_from_agent_thread(uuid,uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Writing into a thread needs to be in it.
-- -------------------------------------------------------------------------------------------
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
  if p_thread is not null and not exists (
    select 1 from public.agent_threads t where t.id = p_thread and t.project_id = p_project and public.can_see_agent_thread(t.id)
  ) then
    raise exception 'post_agent_message: thread % is not in this project (it may have been deleted)', p_thread using errcode = 'P0002';
  end if;
  insert into public.agent_messages (project_id, thread_id, role, author_id, channel, text, action, context)
  values (p_project, p_thread, 'person', v_uid, p_channel, v_text, public.agent_action_canonical(p_action), public.agent_context_canonical(p_context))
  returning * into v_row;
  return v_row;
end;
$$;

-- The thread for an owner check, now also requiring that the caller can see it.
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
  select t.* into v_row from public.agent_threads t where t.id = p_thread and public.can_see_agent_thread(t.id);
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

-- -------------------------------------------------------------------------------------------
-- The agent topic hears about naming, sharing and invitations too (an invitation touches visibility);
-- a new message moving last_message_at is still announced as the message only.
-- -------------------------------------------------------------------------------------------
drop trigger agent_threads_agent_broadcast on public.agent_threads;
create trigger agent_threads_agent_broadcast
  after insert or delete or update of title, title_source, visibility on public.agent_threads
  for each row execute function public.broadcast_agent_thread_change();
