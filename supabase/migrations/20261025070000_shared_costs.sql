-- Sharing costs in a conversation is a choice someone makes, not something the assistant guesses.
-- Bringing a member who cannot see costs into a conversation where someone can (by invitation, or by
-- sharing it with the project) needs that person to confirm they share the costs in it: everything
-- already said and everything the assistant says from then on, amounts included. Who confirmed it
-- and when is kept on the thread (`costs_shared_by`, `costs_shared_at`); the assistant then speaks
-- amounts to everyone in the conversation. Only someone who can see costs may share them.
-- Before this, an invitation went through silently: the invited person read the earlier replies,
-- amounts and all, and the assistant left amounts out from then on.

alter table public.agent_threads
  add column costs_shared_by uuid references auth.users (id) on delete set null,
  add column costs_shared_at timestamptz;

-- Whether a member may see costs on the thread's project.
create or replace function public.member_sees_costs(p_project uuid, p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select m.can_view_costs from public.project_members m where m.project_id = p_project and m.user_id = p_user), false);
$$;

revoke execute on function public.member_sees_costs(uuid, uuid) from public, anon, authenticated;

-- Whether anyone in a thread (its starter, the people invited) may see costs.
create or replace function public.thread_has_cost_viewer(p_thread uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.agent_threads t
     where t.id = p_thread and public.member_sees_costs(t.project_id, t.created_by)
  ) or exists (
    select 1 from public.agent_thread_members m join public.agent_threads t on t.id = m.thread_id
     where m.thread_id = p_thread and public.member_sees_costs(t.project_id, m.user_id)
  );
$$;

revoke execute on function public.thread_has_cost_viewer(uuid) from public, anon, authenticated;

-- Records the caller's choice to share costs in a thread (they must see costs themselves).
create or replace function public.share_thread_costs(p_thread public.agent_threads, p_uid uuid, p_fn text)
returns public.agent_threads
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.agent_threads;
begin
  if not public.member_sees_costs(p_thread.project_id, p_uid) then
    raise exception '%: only someone who can see costs may share them in this conversation', p_fn using errcode = '42501';
  end if;
  update public.agent_threads set costs_shared_by = p_uid, costs_shared_at = now() where id = p_thread.id returning * into v_row;
  return v_row;
end;
$$;

revoke execute on function public.share_thread_costs(public.agent_threads, uuid, text) from public, anon, authenticated;

drop function public.invite_to_agent_thread(uuid, uuid);

-- Brings a project member into a thread the caller is in (anyone in it may invite; the thread stays
-- private, now including them). Inviting someone who cannot see costs into a thread where someone can
-- needs `p_share_costs`, from a caller who sees costs.
create or replace function public.invite_to_agent_thread(p_thread uuid, p_user uuid, p_share_costs boolean default false)
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
  if v_row.costs_shared_by is null
     and not public.member_sees_costs(v_row.project_id, p_user)
     and public.thread_has_cost_viewer(v_row.id) then
    if not coalesce(p_share_costs, false) then
      raise exception 'invite_to_agent_thread: % cannot see costs on this project; inviting them shares the costs in this conversation, which needs confirming', p_user
        using errcode = '22023';
    end if;
    v_row := public.share_thread_costs(v_row, v_uid, 'invite_to_agent_thread');
  end if;
  if p_user is distinct from v_row.created_by then
    insert into public.agent_thread_members (thread_id, user_id, added_by)
    values (v_row.id, p_user, v_uid)
    on conflict do nothing;
  end if;
  -- Announce the change (the thread row itself may not have changed).
  update public.agent_threads set visibility = visibility where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

drop function public.set_agent_thread_visibility(uuid, text);

-- Shares a thread with the project or makes it private again (its starter only). Sharing it with a
-- project where some members cannot see costs, when the thread holds someone who can, needs
-- `p_share_costs` as an invitation does.
create or replace function public.set_agent_thread_visibility(p_thread uuid, p_visibility text, p_share_costs boolean default false)
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
  if p_visibility = 'project'
     and v_row.costs_shared_by is null
     and exists (select 1 from public.project_members m where m.project_id = v_row.project_id and not m.can_view_costs)
     and public.thread_has_cost_viewer(v_row.id) then
    if not coalesce(p_share_costs, false) then
      raise exception 'set_agent_thread_visibility: some members cannot see costs; sharing this conversation with the project shares its costs, which needs confirming'
        using errcode = '22023';
    end if;
    v_row := public.share_thread_costs(v_row, v_uid, 'set_agent_thread_visibility');
  end if;
  update public.agent_threads set visibility = p_visibility where id = v_row.id returning * into v_row;
  return v_row;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array['set_agent_thread_visibility(uuid,text,boolean)', 'invite_to_agent_thread(uuid,uuid,boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;
