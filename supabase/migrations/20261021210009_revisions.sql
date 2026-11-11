-- Revision log and the server side of the Bryntum Revisions protocol (Bryntum guide
-- Gantt/guides/revisions/protocol.md). The RPCs are security definer: the actor is
-- auth.uid(), membership is checked inside, and a row lock on projects serializes revisions.

create sequence public.bryntum_record_id_seq as bigint start with 100000 increment by 1;
revoke all on sequence public.bryntum_record_id_seq from anon, authenticated;

create table public.project_revisions (
  id                      uuid primary key default gen_random_uuid(),
  project_id              uuid not null references public.projects (id) on delete cascade,
  revision_no             int not null check (revision_no > 0),
  client_id               uuid not null,
  local_revision_id       text not null,
  conflict_resolution_for text,
  changes                 jsonb not null,
  actor_user_id           uuid references auth.users (id) on delete set null,
  origin                  text not null default 'human' check (origin in ('human', 'agent', 'engine')),
  created_at              timestamptz not null default now(),
  unique (project_id, revision_no),
  unique (project_id, client_id, local_revision_id)
);

-- Phantom id -> real id, so a record re-sent as "added" keeps the id it was given first.
create table public.record_ids (
  project_id uuid not null references public.projects (id) on delete cascade,
  store      text not null,
  phantom_id text not null,
  real_id    bigint not null,
  created_at timestamptz not null default now(),
  primary key (project_id, store, phantom_id)
);

alter table public.project_revisions enable row level security;
alter table public.record_ids        enable row level security;
revoke all on table public.project_revisions, public.record_ids from anon;
revoke insert, update, delete on table public.project_revisions from authenticated;
revoke all on table public.record_ids from authenticated;

create policy "project_revisions: members can read"
  on public.project_revisions for select to authenticated
  using (public.is_project_member(project_id));

-- -------------------------------------------------------------------------------------------
-- replace_phantom_ids(doc, mapping): mapping is {"<phantom id>": <real id>, ...}. Every JSON
-- string anywhere in doc that equals a phantom id (field values at any depth, array elements,
-- inside $input) becomes the real id as a JSON number. The value of a "$PhantomId" key is kept,
-- and every object carrying a mapped "$PhantomId" gets "id" set to the real id.
-- -------------------------------------------------------------------------------------------
create or replace function public.replace_phantom_ids(doc jsonb, mapping jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key     text;
  v_value   jsonb;
  v_result  jsonb;
  v_phantom text;
begin
  if doc is null then
    return null;
  end if;
  if mapping is null or mapping = '{}'::jsonb then
    return doc;
  end if;

  case jsonb_typeof(doc)
    when 'string' then
      return coalesce(mapping -> (doc #>> '{}'), doc);

    when 'array' then
      select coalesce(jsonb_agg(public.replace_phantom_ids(e.value, mapping) order by e.ordinality), '[]'::jsonb)
        into v_result
        from jsonb_array_elements(doc) with ordinality as e;
      return v_result;

    when 'object' then
      v_result := '{}'::jsonb;
      for v_key, v_value in select key, value from jsonb_each(doc) loop
        if v_key = '$PhantomId' then
          v_result := v_result || jsonb_build_object(v_key, v_value);
        else
          v_result := v_result || jsonb_build_object(v_key, public.replace_phantom_ids(v_value, mapping));
        end if;
      end loop;
      v_phantom := doc ->> '$PhantomId';
      if v_phantom is not null and mapping ? v_phantom then
        v_result := v_result || jsonb_build_object('id', mapping -> v_phantom);
      end if;
      return v_result;

    else
      return doc;
  end case;
end;
$$;

revoke execute on function public.replace_phantom_ids(jsonb, jsonb) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------
-- load_project(p_project) -> LoadProjectResult (packages/shared/src/revisions.ts)
-- -------------------------------------------------------------------------------------------
create or replace function public.load_project(p_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_project   public.projects;
  v_member    public.project_members;
  v_revisions jsonb;
begin
  if v_uid is null then
    raise exception 'load_project: not authenticated' using errcode = '42501';
  end if;

  select m.* into v_member
    from public.project_members m
   where m.project_id = p_project and m.user_id = v_uid;
  if not found then
    raise exception 'load_project: not a member of project %', p_project using errcode = '42501';
  end if;

  select p.* into v_project from public.projects p where p.id = p_project;

  select coalesce(jsonb_agg(to_jsonb(r) order by r.revision_no), '[]'::jsonb)
    into v_revisions
    from public.project_revisions r
   where r.project_id = p_project
     and r.revision_no > v_project.snapshot_revision;

  return jsonb_build_object(
    'project', jsonb_build_object(
      'id',               v_project.id,
      'name',             v_project.name,
      'currency',         v_project.currency,
      'handover_task_id', v_project.handover_task_id::text),
    'membership', jsonb_build_object(
      'role',                 v_member.role,
      'can_view_costs',       v_member.can_view_costs,
      'approval_limit_minor', v_member.approval_limit_minor),
    'snapshot',          v_project.snapshot,
    'snapshot_revision', v_project.snapshot_revision,
    'current_revision',  v_project.current_revision,
    'revisions',         v_revisions);
end;
$$;

revoke execute on function public.load_project(uuid) from public, anon;
grant execute on function public.load_project(uuid) to authenticated, service_role;

-- -------------------------------------------------------------------------------------------
-- submit_revision: accept one OutgoingRevision, assign revision_no, resolve phantom ids,
-- persist, bump the head. Returns the stored row (also the broadcast payload). Resubmitting
-- the same (client_id, local_revision_id) returns the existing row unchanged.
-- -------------------------------------------------------------------------------------------
create or replace function public.submit_revision(
  p_project           uuid,
  p_client_id         uuid,
  p_local_revision_id text,
  p_conflict_for      text,
  p_changes           jsonb,
  p_origin            text default 'human'
)
returns public.project_revisions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid            uuid := (select auth.uid());
  v_role           text;
  v_current        int;
  v_existing       public.project_revisions;
  v_store          text;
  v_record         jsonb;
  v_phantom        text;
  v_real           bigint;
  v_mapping        jsonb := '{}'::jsonb;   -- phantom id -> real id
  v_phantom_stores jsonb := '{}'::jsonb;   -- phantom id -> store (guards against reuse across stores)
  v_row            public.project_revisions;
begin
  if v_uid is null then
    raise exception 'submit_revision: not authenticated' using errcode = '42501';
  end if;
  if p_client_id is null or coalesce(p_local_revision_id, '') = '' then
    raise exception 'submit_revision: p_client_id and p_local_revision_id are required' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'submit_revision: p_changes must be a JSON object keyed by store id' using errcode = '22023';
  end if;
  if p_origin is null or p_origin not in ('human', 'agent', 'engine') then
    raise exception 'submit_revision: p_origin must be one of human, agent, engine' using errcode = '22023';
  end if;

  select m.role into v_role
    from public.project_members m
   where m.project_id = p_project and m.user_id = v_uid;
  if v_role is null then
    raise exception 'submit_revision: not a member of project %', p_project using errcode = '42501';
  end if;

  -- The client id is the caller's own sessions row (sessions.id doubles as the Bryntum
  -- clientId). Co-members can read each other's session ids, so without this check a member could
  -- file revisions under another tab's identity and squat its (client_id, local_revision_id) keys.
  if not exists (
    select 1 from public.sessions s
     where s.id = p_client_id and s.user_id = v_uid and s.project_id = p_project
  ) then
    raise exception 'submit_revision: client % is not a session of the caller in project %', p_client_id, p_project
      using errcode = '42501';
  end if;
  update public.sessions set last_seen = now() where id = p_client_id;

  -- Store whitelist, checked before the lock so rejected submissions never block others.
  for v_store in select jsonb_object_keys(p_changes) loop
    if jsonb_typeof(p_changes -> v_store) <> 'object' then
      raise exception 'submit_revision: changes for store "%" must be an object', v_store using errcode = '22023';
    end if;
    case
      when v_store in ('tasks', 'dependencies', 'assignments') then
        null;
      -- The project model's own fields (calculated endDate/duration/percentDone and, when the
      -- user edited the project, a $input) ride along with record changes; it holds no records.
      when v_store = 'project' then
        null;
      when v_store = 'resources' then
        if v_role <> 'cm' then
          raise exception 'submit_revision: store "resources" may only be changed by the cost manager (role cm); caller role is %', v_role
            using errcode = '42501';
        end if;
      when v_store = 'calendars' then
        raise exception 'submit_revision: store "calendars" is read-only; calendars cannot be changed through revisions'
          using errcode = '22023';
      else
        raise exception 'submit_revision: unknown store "%" (accepted: tasks, dependencies, assignments, resources, project)', v_store
          using errcode = '22023';
    end case;
  end loop;

  -- Serialize every submission for this project; the lock also orders the dedupe check.
  select p.current_revision into v_current
    from public.projects p
   where p.id = p_project
     for update;

  select r.* into v_existing
    from public.project_revisions r
   where r.project_id = p_project
     and r.client_id = p_client_id
     and r.local_revision_id = p_local_revision_id;
  if found then
    return v_existing;
  end if;

  -- Phantom ids already known for this project that appear anywhere in the submission. A client
  -- keeps referencing a phantom (dependency endpoints, removals) until it receives the revision
  -- carrying the real id, so earlier mappings must apply to every string in the document.
  with recursive walk(node) as (
    select p_changes
    union all
    select c.child
      from walk
      cross join lateral (
        select value as child
          from jsonb_each(case when jsonb_typeof(walk.node) = 'object' then walk.node else '{}'::jsonb end)
        union all
        select value
          from jsonb_array_elements(case when jsonb_typeof(walk.node) = 'array' then walk.node else '[]'::jsonb end)
      ) c
  )
  select coalesce(jsonb_object_agg(ri.phantom_id, ri.real_id), '{}'::jsonb),
         coalesce(jsonb_object_agg(ri.phantom_id, ri.store), '{}'::jsonb)
    into v_mapping, v_phantom_stores
    from (select distinct node #>> '{}' as phantom_id from walk where jsonb_typeof(node) = 'string') found
    join public.record_ids ri on ri.project_id = p_project and ri.phantom_id = found.phantom_id;

  -- Phantom ids of added records: reuse the mapping or allocate the next real id.
  for v_store in select jsonb_object_keys(p_changes) loop
    for v_record in
      select value from jsonb_array_elements(coalesce(p_changes -> v_store -> 'added', '[]'::jsonb))
      union all
      select value from jsonb_array_elements(coalesce(p_changes -> v_store -> '$input' -> 'added', '[]'::jsonb))
    loop
      if jsonb_typeof(v_record) <> 'object' then
        continue;
      end if;
      if jsonb_typeof(v_record -> '$PhantomId') is distinct from 'string' then
        continue;
      end if;
      v_phantom := v_record ->> '$PhantomId';

      if v_mapping ? v_phantom then
        if (v_phantom_stores ->> v_phantom) <> v_store then
          raise exception 'submit_revision: phantom id "%" is used by stores "%" and "%"',
            v_phantom, v_phantom_stores ->> v_phantom, v_store using errcode = '22023';
        end if;
        continue;
      end if;

      v_real := nextval('public.bryntum_record_id_seq');
      insert into public.record_ids (project_id, store, phantom_id, real_id)
      values (p_project, v_store, v_phantom, v_real);

      v_mapping        := v_mapping || jsonb_build_object(v_phantom, v_real);
      v_phantom_stores := v_phantom_stores || jsonb_build_object(v_phantom, v_store);
    end loop;
  end loop;

  insert into public.project_revisions
    (project_id, revision_no, client_id, local_revision_id, conflict_resolution_for, changes, actor_user_id, origin)
  values
    (p_project, v_current + 1, p_client_id, p_local_revision_id, nullif(p_conflict_for, ''),
     public.replace_phantom_ids(p_changes, v_mapping), v_uid, p_origin)
  returning * into v_row;

  update public.projects set current_revision = v_current + 1 where id = p_project;

  return v_row;
end;
$$;

revoke execute on function public.submit_revision(uuid, uuid, text, text, jsonb, text) from public, anon;
grant execute on function public.submit_revision(uuid, uuid, text, text, jsonb, text) to authenticated, service_role;

-- -------------------------------------------------------------------------------------------
-- save_snapshot: store Bryntum inline data for the current head. Returns true when accepted,
-- false when p_revision is no longer the head (the caller simply tries again later).
-- -------------------------------------------------------------------------------------------
create or replace function public.save_snapshot(p_project uuid, p_revision int, p_snapshot jsonb, p_session uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'save_snapshot: not authenticated' using errcode = '42501';
  end if;
  if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'save_snapshot: p_snapshot must be a JSON object (Bryntum inline data)' using errcode = '22023';
  end if;
  if p_revision is null or p_revision < 0 then
    raise exception 'save_snapshot: p_revision must be a non-negative revision number' using errcode = '22023';
  end if;
  if not exists (select 1 from public.project_members m where m.project_id = p_project and m.user_id = v_uid) then
    raise exception 'save_snapshot: not a member of project %', p_project using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.sessions s
     where s.id = p_session and s.user_id = v_uid and s.project_id = p_project
  ) then
    raise exception 'save_snapshot: session % does not belong to the caller in project %', p_session, p_project
      using errcode = '42501';
  end if;

  update public.sessions set last_seen = now() where id = p_session;

  -- Compare-and-set against the head revision.
  update public.projects
     set snapshot = p_snapshot,
         snapshot_revision = p_revision
   where id = p_project
     and current_revision = p_revision;
  return found;
end;
$$;

revoke execute on function public.save_snapshot(uuid, int, jsonb, uuid) from public, anon;
grant execute on function public.save_snapshot(uuid, int, jsonb, uuid) to authenticated, service_role;

-- -------------------------------------------------------------------------------------------
-- Broadcast every accepted revision (the full row) on the private topic
-- project:<id>:revisions, originator included (protocol.md "Distributing Revisions").
-- realtime.send is installed by the Realtime service; the guard keeps inserts working on a
-- database that does not have it.
-- -------------------------------------------------------------------------------------------
create or replace function public.broadcast_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(to_jsonb(new), 'revision', 'project:' || new.project_id::text || ':revisions', true);
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_revision() from public, anon, authenticated;

create trigger project_revisions_broadcast
  after insert on public.project_revisions
  for each row execute function public.broadcast_revision();

-- -------------------------------------------------------------------------------------------
-- Realtime authorization. Topics: project:<uuid>:<channel> with channel in
-- revisions | presence | view | cursor | commercial. Members may receive on the first four and
-- on commercial when can_view_costs. Clients may send only on presence, view and cursor:
-- revisions and commercial carry database-originated payloads (the triggers above run as the
-- function owner and bypass these policies), and a member who could publish on them would make
-- every other browser apply changes that were never persisted or validated. Only private
-- channels are served.
-- -------------------------------------------------------------------------------------------
create or replace function public.project_topic_channel(p_topic text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(
    p_topic,
    '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(revisions|presence|view|cursor|commercial)$'))[1];
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
  return exists (
    select 1
    from public.project_members m
    where m.project_id = split_part(p_topic, ':', 2)::uuid
      and m.user_id = v_uid
      and (v_channel <> 'commercial' or m.can_view_costs)
  );
end;
$$;

create or replace function public.can_send_on_project_topic(p_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.project_topic_channel(p_topic) in ('presence', 'view', 'cursor'), false)
     and public.can_join_project_topic(p_topic);
$$;

create policy "project members can receive on project topics"
  on realtime.messages for select to authenticated
  using (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_join_project_topic((select realtime.topic()))
  );

create policy "project members can send on ephemeral project topics"
  on realtime.messages for insert to authenticated
  with check (
    realtime.messages.extension in ('broadcast', 'presence')
    and public.can_send_on_project_topic((select realtime.topic()))
  );
