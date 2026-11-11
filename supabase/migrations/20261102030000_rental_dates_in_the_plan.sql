-- Rental dates become part of the plan: each rented machine's resource carries `rentalStart` and
-- `rentalEnd` (the end exclusive, like equipment_bookings.billable_end), so changing them is a revision
-- like any other: numbered in the history, sent to everyone, and undone or redone with the plan.
--
-- equipment_bookings keeps a copy, because the approvals and payments read it. A revision that changes
-- the dates updates it in the same transaction; set_rental_dates and its log are no longer needed.
--
-- Refused while money depends on the dates as they stand, as before: PayPal is paying for the rental, an
-- approved fix is going into the plan, or a fix in the plan is waiting to be paid. The app keeps people
-- from trying (apps/web/src/workflow/rental.ts); this is the guarantee.

drop function public.set_rental_dates(uuid, date, date);
drop table public.rental_date_changes;

-- Why a rental's dates cannot change right now, or null.
create or replace function public.rental_date_lock(p_booking uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when exists (
      select 1
        from public.payment_authorizations pa
        join public.proposal_versions v on v.id = pa.proposal_version_id
        join public.proposals p on p.id = v.proposal_id
       where p.booking_id = p_booking and pa.status in ('authorized', 'submitted', 'pending', 'unknown'))
      then 'PayPal is paying for this rental. The dates unlock as soon as PayPal confirms.'
    when exists (
      select 1 from public.proposals p where p.booking_id = p_booking and public.proposal_has_live_publication(p.id))
      then 'An approved fix is going into the plan right now. Try again in a moment.'
    -- The newest fix only: a newer one replaces a fix that was never paid.
    when exists (
      select 1
        from public.proposals p
        join public.proposal_versions v on v.proposal_id = p.id and v.version_no = p.current_version_no
       where p.id = (select l.id from public.proposals l where l.booking_id = p_booking order by l.created_at desc limit 1)
         and p.state = 'published'
         and not exists (
           select 1 from public.payment_authorizations pa where pa.proposal_version_id = v.id and pa.status = 'succeeded'))
      then 'An approved fix set these dates and is waiting to be paid. Pay it first, then the dates can change.'
  end;
$$;

revoke execute on function public.rental_date_lock(uuid) from public, anon, authenticated;

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
  if jsonb_typeof(new.changes -> 'resources') is distinct from 'object' then
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
    select r from public.revision_store_records(new.changes -> 'resources', 'updated') r
     where r ? 'rentalStart' or r ? 'rentalEnd'
  loop
    for v_booking in
      select b.* from public.equipment_bookings b
       where b.project_id = new.project_id and b.resource_id::text = v_record ->> 'id'
         for update
    loop
      v_start := coalesce(public.rental_day(v_record -> 'rentalStart'), v_booking.billable_start);
      v_end := coalesce(public.rental_day(v_record -> 'rentalEnd'), v_booking.billable_end);
      if v_end <= v_start then
        raise exception 'rental_dates: the rental of machine % must end after it starts', v_record ->> 'id' using errcode = '22023';
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

-- A date from a revision, or null when it has none.
create or replace function public.rental_day(p_value jsonb)
returns date
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_value) <> 'string' or (p_value #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'rental_dates: a rental date must be YYYY-MM-DD, got %', p_value using errcode = '22023';
  end if;
  return (p_value #>> '{}')::date;
end;
$$;

revoke execute on function public.rental_day(jsonb) from public, anon, authenticated;

create trigger project_revisions_rental_dates
  before insert on public.project_revisions
  for each row execute function public.project_revisions_rental_dates();

-- publication_revision_check, as in 20261022020100_publication_requires_booked_task.sql, and a fix also
-- puts its approved dates on the booked machine.
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
    if v_store = 'resources'
       and jsonb_array_length(coalesce(v_input -> 'added', '[]'::jsonb)) = 0
       and jsonb_array_length(coalesce(v_input -> 'removed', '[]'::jsonb)) = 0 then
      for v_record in select value from jsonb_array_elements(coalesce(v_input -> 'updated', '[]'::jsonb)) loop
        if (v_record ->> 'id') is distinct from v_booking.resource_id::text then
          raise exception 'submit_revision: a publication may only update machine %, not %', v_booking.resource_id, v_record ->> 'id'
            using errcode = '22023';
        end if;
        for v_field in select jsonb_object_keys(v_record) loop
          if v_field not in ('id', 'rentalStart', 'rentalEnd') then
            raise exception 'submit_revision: a publication may not change machine field "%"', v_field using errcode = '22023';
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

-- Plans that exist already get each rented machine's dates: as booked now in the live plan, as seeded
-- in the plan a reset goes back to. (A fresh database gets them from the seed itself.)
create function pg_temp.with_rental_dates(p_snapshot jsonb, p_bookings jsonb)
returns jsonb
language sql
as $$
  select case when jsonb_typeof(p_snapshot -> 'resourcesData') <> 'array' then p_snapshot else jsonb_set(p_snapshot, '{resourcesData}', (
    select coalesce(jsonb_agg(
             case when b.value is null then r.value
                  else r.value || jsonb_build_object('rentalStart', b.value ->> 'billable_start', 'rentalEnd', b.value ->> 'billable_end') end
             order by r.ordinality), '[]'::jsonb)
      from jsonb_array_elements(p_snapshot -> 'resourcesData') with ordinality r
      left join lateral (
        select e.value from jsonb_array_elements(p_bookings) e
         where e.value ->> 'resource_id' = r.value ->> 'id'
         order by e.value ->> 'billable_start' limit 1
      ) b on true)) end;
$$;

update public.projects p
   set snapshot = pg_temp.with_rental_dates(p.snapshot, (
     select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from public.equipment_bookings b where b.project_id = p.id));

update public.demo_seeds d
   set snapshot = pg_temp.with_rental_dates(d.snapshot,
     coalesce(d.bookings, case when d.booking is null then '[]'::jsonb else jsonb_build_array(d.booking) end));

drop function pg_temp.with_rental_dates(jsonb, jsonb);

-- Reset: as in 20261102010000_rules_rentals_invoices.sql (the date log is gone).
create or replace function public.reset_demo(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seed    public.demo_seeds;
  v_objects jsonb;
  v_booking jsonb;
begin
  select d.* into v_seed from public.demo_seeds d where d.project_id = p_project;
  if not found then
    raise exception 'reset_demo: no seed stored for project % (run `pnpm db:reset` once)', p_project using errcode = 'P0002';
  end if;

  delete from public.invoices where project_id = p_project;
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
  perform public.seed_watch_rules(p_project);

  for v_booking in
    select value from jsonb_array_elements(coalesce(v_seed.bookings, case when v_seed.booking is null then '[]'::jsonb else jsonb_build_array(v_seed.booking) end))
  loop
    update public.equipment_bookings b
       set task_id         = (v_booking ->> 'task_id')::bigint,
           resource_id     = (v_booking ->> 'resource_id')::bigint,
           supplier_name   = v_booking ->> 'supplier_name',
           rental_rate_minor = (v_booking ->> 'rental_rate_minor')::bigint,
           currency        = v_booking ->> 'currency',
           billable_start  = (v_booking ->> 'billable_start')::date,
           billable_end    = (v_booking ->> 'billable_end')::date,
           idle_days       = (v_booking ->> 'idle_days')::int,
           evidence_path   = v_booking ->> 'evidence_path'
     where b.id = (v_booking ->> 'id')::uuid;
  end loop;

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
