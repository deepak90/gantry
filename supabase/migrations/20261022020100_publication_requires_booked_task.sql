-- A publication must not complete against a deleted activity. The server keeps no task table: the
-- plan is the snapshot plus the revisions after it, so the booked task is in the plan when the latest
-- revision after the snapshot that adds or removes it adds it, or, without such a revision, when the
-- snapshot's task tree holds it (Bryntum lists every task of a removed subtree in "removed", and a task
-- re-added by an undo in "added"). publication_revision_check refuses the publication otherwise. Also,
-- an empty `$input` (Bryntum attaches one to every store a revision mentions) counts as no input.

-- -------------------------------------------------------------------------------------------
-- task_in_plan(p_project, p_task): whether the task is in the project as of its latest revision.
-- -------------------------------------------------------------------------------------------
create or replace function public.task_in_plan(p_project uuid, p_task bigint)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_project public.projects;
  v_added   boolean;
begin
  select p.* into v_project from public.projects p where p.id = p_project;
  if not found then
    return false;
  end if;

  select events.added into v_added
    from (
      select r.revision_no,
             exists (
               select 1
                 from jsonb_array_elements(
                        case when jsonb_typeof(r.changes -> 'tasks' -> 'added') = 'array'
                             then r.changes -> 'tasks' -> 'added' else '[]'::jsonb end) e
                where e ->> 'id' = p_task::text) as added,
             exists (
               select 1
                 from jsonb_array_elements(
                        case when jsonb_typeof(r.changes -> 'tasks' -> 'removed') = 'array'
                             then r.changes -> 'tasks' -> 'removed' else '[]'::jsonb end) e
                where e ->> 'id' = p_task::text) as removed
        from public.project_revisions r
       where r.project_id = p_project
         and r.revision_no > v_project.snapshot_revision
    ) events
   where events.added or events.removed
   order by events.revision_no desc
   limit 1;
  if found then
    return v_added;
  end if;

  return exists (
    with recursive node(task) as (
      select t.value
        from jsonb_array_elements(
               case when jsonb_typeof(coalesce(v_project.snapshot -> 'tasksData', v_project.snapshot -> 'tasks')) = 'array'
                    then coalesce(v_project.snapshot -> 'tasksData', v_project.snapshot -> 'tasks') else '[]'::jsonb end) t
      union all
      select c.value
        from node
        cross join lateral jsonb_array_elements(
               case when jsonb_typeof(node.task -> 'children') = 'array' then node.task -> 'children' else '[]'::jsonb end) c
    )
    select 1 from node where node.task ->> 'id' = p_task::text
  );
end;
$$;

revoke execute on function public.task_in_plan(uuid, bigint) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------
-- publication_revision_check, as in 20261022010000_proposal_workflow.sql plus the two rules above.
-- -------------------------------------------------------------------------------------------
create or replace function public.publication_revision_check(
  p_project     uuid,
  p_client_id   uuid,
  p_publication uuid,
  p_changes     jsonb
)
returns public.publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pub      public.publications;
  v_version  public.proposal_versions;
  v_proposal public.proposals;
  v_booking  public.equipment_bookings;
  v_store    text;
  v_input    jsonb;
  v_record   jsonb;
  v_field    text;
  v_count    int := 0;
begin
  select pu.* into v_pub from public.publications pu where pu.id = p_publication and pu.project_id = p_project for update;
  if not found then
    raise exception 'submit_revision: publication % not found in this project', p_publication using errcode = 'P0002';
  end if;
  if v_pub.status <> 'pending' or v_pub.executor_session is distinct from p_client_id then
    raise exception 'submit_revision: publication % is % and not held by client %', p_publication, v_pub.status, p_client_id
      using errcode = '55000';
  end if;
  select v.* into v_version from public.proposal_versions v where v.id = v_pub.proposal_version_id;
  select p.* into v_proposal from public.proposals p where p.id = v_version.proposal_id for update;
  if v_proposal.state <> 'approved' or v_proposal.current_version_no <> v_version.version_no then
    raise exception 'submit_revision: the proposal of publication % is no longer approved at this version', p_publication
      using errcode = '55000';
  end if;
  if not exists (
    select 1 from public.approvals a
     where a.proposal_version_id = v_version.id and a.scope = 'schedule' and a.status = 'active'
       and a.content_hash = public.proposal_content_hash(v_version.id, 'schedule')) then
    raise exception 'submit_revision: the schedule approval of publication % is no longer valid', p_publication
      using errcode = '55000';
  end if;
  select b.* into v_booking from public.equipment_bookings b where b.id = v_proposal.booking_id;

  for v_store in select jsonb_object_keys(p_changes) loop
    v_input := p_changes -> v_store -> '$input';
    -- Bryntum gives every store a revision mentions an `$input`, empty when nothing in it was user
    -- input (a reschedule's calculated changes): that is no input.
    if v_input is null or jsonb_typeof(v_input) = 'null' or v_input = '{}'::jsonb then
      continue;
    end if;
    if v_store <> 'tasks'
       or jsonb_array_length(coalesce(v_input -> 'added', '[]'::jsonb)) > 0
       or jsonb_array_length(coalesce(v_input -> 'removed', '[]'::jsonb)) > 0 then
      raise exception 'submit_revision: a publication may only update the booked task (input in store "%")', v_store
        using errcode = '22023';
    end if;
    for v_record in select value from jsonb_array_elements(coalesce(v_input -> 'updated', '[]'::jsonb)) loop
      if (v_record ->> 'id') is distinct from v_booking.task_id::text then
        raise exception 'submit_revision: a publication may only update task %, not %', v_booking.task_id, v_record ->> 'id'
          using errcode = '22023';
      end if;
      for v_field in select jsonb_object_keys(v_record) loop
        if v_field not in ('id', 'constraintType', 'constraintDate', 'decisionRef') then
          raise exception 'submit_revision: a publication may not change task field "%"', v_field using errcode = '22023';
        end if;
      end loop;
      if v_record ? 'constraintType' and v_record ->> 'constraintType' <> 'startnoearlierthan' then
        raise exception 'submit_revision: a publication sets a startnoearlierthan constraint' using errcode = '22023';
      end if;
      if v_record ? 'constraintDate' and left(v_record ->> 'constraintDate', 10) <> v_version.inputs ->> 'new_start' then
        raise exception 'submit_revision: the constraint date must be the approved start %', v_version.inputs ->> 'new_start'
          using errcode = '22023';
      end if;
      if (v_record ->> 'decisionRef') is distinct from p_publication::text then
        raise exception 'submit_revision: the published task must carry decisionRef %', p_publication using errcode = '22023';
      end if;
      v_count := v_count + 1;
    end loop;
  end loop;
  if v_count <> 1 then
    raise exception 'submit_revision: a publication revision updates the booked task exactly once (found %)', v_count
      using errcode = '22023';
  end if;
  -- Another client may have deleted the booked activity after the publication was claimed; its
  -- deletion is ordered before this revision, which would then change nothing in any plan.
  if not public.task_in_plan(p_project, v_booking.task_id::bigint) then
    raise exception 'submit_revision: the booked activity (task %) is no longer in the project', v_booking.task_id
      using errcode = '55000';
  end if;
  return v_pub;
end;
$$;

revoke execute on function public.publication_revision_check(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
