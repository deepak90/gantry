-- Crew management for every project member: submit_revision accepts changes to the resources
-- store from any member of the project (previously only the cost manager, role cm). The
-- function is re-created from 20261022010000_proposal_workflow.sql unchanged otherwise; calendars
-- stay read-only and unknown stores are still refused.

create or replace function public.submit_revision(
  p_project           uuid,
  p_client_id         uuid,
  p_local_revision_id text,
  p_conflict_for      text,
  p_changes           jsonb,
  p_origin            text default 'human',
  p_publication       uuid default null
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
  v_origin         text := p_origin;
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
      -- Crews (resources) are managed by every project member, the project manager included.
      when v_store in ('tasks', 'dependencies', 'assignments', 'resources') then
        null;
      -- The project model's own fields (calculated endDate/duration/percentDone and, when the
      -- user edited the project, a $input) ride along with record changes; it holds no records.
      when v_store = 'project' then
        null;
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

  if p_publication is not null then
    perform public.publication_revision_check(p_project, p_client_id, p_publication, p_changes);
    -- The published change is labeled by who prepared the proposal it carries out.
    select case when v.created_via = 'agent' then 'agent' else 'human' end into v_origin
      from public.publications pu
      join public.proposal_versions v on v.id = pu.proposal_version_id
     where pu.id = p_publication;
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
     public.replace_phantom_ids(p_changes, v_mapping), v_uid, v_origin)
  returning * into v_row;

  update public.projects set current_revision = v_current + 1 where id = p_project;

  if p_publication is not null then
    perform public.publication_complete(p_publication, v_row.revision_no);
  end if;

  return v_row;
end;
$$;

revoke execute on function public.submit_revision(uuid, uuid, text, text, jsonb, text, uuid) from public, anon;
grant execute on function public.submit_revision(uuid, uuid, text, text, jsonb, text, uuid) to authenticated, service_role;
