-- Rental dates per task: the dates move from the machine to the machine on a task (the assignment), so
-- changing them on one task leaves its other tasks alone, as when a supplier sends several of a machine.
-- A machine on a task with no dates of its own goes by the task's days. `rentalEnd` stays exclusive.
--
-- A rental (equipment_bookings) belongs to one machine on one task, and only that assignment's dates are
-- copied to it: dates on any other task pay nobody. The locks are as they were, for the rental's own task.

-- The task and the machine an assignment joins, from the plan: the snapshot with later revisions over it.
create or replace function public.plan_assignment_ends(p_project uuid, p_assignment text)
returns table (task_id text, resource_id text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_record jsonb;
begin
  select a.value ->> 'event', a.value ->> 'resource' into task_id, resource_id
    from public.projects p
   cross join lateral jsonb_array_elements(
           case when jsonb_typeof(p.snapshot -> 'assignmentsData') = 'array' then p.snapshot -> 'assignmentsData' else '[]'::jsonb end) a
   where p.id = p_project and a.value ->> 'id' = p_assignment;

  for v_record in
    select x.record
      from public.project_revisions r
      join public.projects p on p.id = r.project_id
     cross join lateral (
       select s as record from public.revision_store_records(r.changes -> 'assignments', 'added') s
       union all
       select s from public.revision_store_records(r.changes -> 'assignments', 'updated') s
     ) x
     where r.project_id = p_project and r.revision_no > p.snapshot_revision and x.record ->> 'id' = p_assignment
     order by r.revision_no
  loop
    task_id := coalesce(v_record ->> 'event', v_record ->> 'eventId', task_id);
    resource_id := coalesce(v_record ->> 'resource', v_record ->> 'resourceId', resource_id);
  end loop;
  return next;
end;
$$;

revoke execute on function public.plan_assignment_ends(uuid, text) from public, anon, authenticated;

create or replace function public.project_revisions_rental_dates()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_record  jsonb;
  v_booking public.equipment_bookings;
  v_start   date;
  v_end     date;
  v_lock    text;
begin
  if jsonb_typeof(new.changes -> 'assignments') is distinct from 'object' then
    return new;
  end if;
  -- A fix's own publication: publication_complete writes the booking once the proposal is published.
  -- Written here, while the proposal is still approved, the change would void the approvals it carries out.
  if exists (
    select 1
      from public.revision_store_records(new.changes -> 'tasks', 'updated') r
      join public.publications pu on pu.project_id = new.project_id and pu.status = 'pending' and pu.id::text = r ->> 'decisionRef'
  ) then
    return new;
  end if;

  for v_record in
    select r from public.revision_store_records(new.changes -> 'assignments', 'updated') r
     where r ? 'rentalStart' or r ? 'rentalEnd'
  loop
    for v_booking in
      select b.*
        from public.plan_assignment_ends(new.project_id, v_record ->> 'id') e
        join public.equipment_bookings b
          on b.project_id = new.project_id and b.task_id::text = e.task_id and b.resource_id::text = e.resource_id
         for update of b
    loop
      v_start := coalesce(public.rental_day(v_record -> 'rentalStart'), v_booking.billable_start);
      v_end := coalesce(public.rental_day(v_record -> 'rentalEnd'), v_booking.billable_end);
      if v_end <= v_start then
        raise exception 'rental_dates: a rental must end after it starts (assignment %)', v_record ->> 'id' using errcode = '22023';
      end if;
      -- Bryntum lists a record both in the changes and in the user's input: the second is no change.
      continue when v_start = v_booking.billable_start and v_end = v_booking.billable_end;
      v_lock := public.rental_date_lock(v_booking.id);
      if v_lock is not null then
        raise exception 'rental_dates: %', v_lock using errcode = '55006';
      end if;
      update public.equipment_bookings b set billable_start = v_start, billable_end = v_end where b.id = v_booking.id;
    end loop;
  end loop;
  return new;
end;
$$;

revoke execute on function public.project_revisions_rental_dates() from public, anon, authenticated;

-- publication_revision_check, as in 20261102030000: a fix puts its approved dates on the booked machine
-- on the booked task.
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
  v_task     text;
  v_machine  text;
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
    if v_store = 'assignments'
       and jsonb_array_length(coalesce(v_input -> 'added', '[]'::jsonb)) = 0
       and jsonb_array_length(coalesce(v_input -> 'removed', '[]'::jsonb)) = 0 then
      for v_record in select value from jsonb_array_elements(coalesce(v_input -> 'updated', '[]'::jsonb)) loop
        select e.task_id, e.resource_id into v_task, v_machine from public.plan_assignment_ends(p_project, v_record ->> 'id') e;
        if v_task is distinct from v_booking.task_id::text or v_machine is distinct from v_booking.resource_id::text then
          raise exception 'submit_revision: a publication may only date machine % on task %', v_booking.resource_id, v_booking.task_id
            using errcode = '22023';
        end if;
        for v_field in select jsonb_object_keys(v_record) loop
          if v_field not in ('id', 'rentalStart', 'rentalEnd') then
            raise exception 'submit_revision: a publication may not change assignment field "%"', v_field using errcode = '22023';
          end if;
        end loop;
        if (v_record ? 'rentalStart' and v_record ->> 'rentalStart' <> v_version.inputs ->> 'new_start')
           or (v_record ? 'rentalEnd' and v_record ->> 'rentalEnd' <> v_version.inputs ->> 'new_end') then
          raise exception 'submit_revision: the machine''s rental dates must be the approved dates' using errcode = '22023';
        end if;
      end loop;
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

-- Plans that exist already: the dates come off the machines, and each rental's go on its machine on its
-- task. Machines on other tasks start with none, so they go by those tasks' days. (A fresh database gets
-- this from the seed itself.)
create function pg_temp.dates_on_assignments(p_snapshot jsonb, p_bookings jsonb)
returns jsonb
language sql
as $$
  select p_snapshot
    || jsonb_build_object('resourcesData', (
         select coalesce(jsonb_agg(r.value - 'rentalStart' - 'rentalEnd' order by r.ordinality), '[]'::jsonb)
           from jsonb_array_elements(coalesce(p_snapshot -> 'resourcesData', '[]'::jsonb)) with ordinality r))
    || jsonb_build_object('assignmentsData', (
         select coalesce(jsonb_agg(
                  case when b.value is null then a.value
                       else a.value || jsonb_build_object('rentalStart', b.value ->> 'billable_start', 'rentalEnd', b.value ->> 'billable_end') end
                  order by a.ordinality), '[]'::jsonb)
           from jsonb_array_elements(coalesce(p_snapshot -> 'assignmentsData', '[]'::jsonb)) with ordinality a
           left join lateral (
             select e.value from jsonb_array_elements(p_bookings) e
              where e.value ->> 'resource_id' = a.value ->> 'resource' and e.value ->> 'task_id' = a.value ->> 'event'
              limit 1
           ) b on true));
$$;

update public.projects p
   set snapshot = pg_temp.dates_on_assignments(p.snapshot, (select jsonb_agg(to_jsonb(b)) from public.equipment_bookings b where b.project_id = p.id))
 where exists (select 1 from public.equipment_bookings b where b.project_id = p.id);

update public.demo_seeds d
   set snapshot = pg_temp.dates_on_assignments(d.snapshot, coalesce(d.bookings, jsonb_build_array(d.booking)))
 where d.bookings is not null or d.booking is not null;

drop function pg_temp.dates_on_assignments(jsonb, jsonb);
