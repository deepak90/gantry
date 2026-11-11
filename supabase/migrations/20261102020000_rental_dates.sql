-- Rental dates edited by hand: the Equipment cell's editor. Until now only a fix someone approved could
-- change them. An edit moves no task and pays nobody; each one is kept, so the history can say who
-- changed which dates.
--
-- Refused while money depends on the dates as they stand: PayPal is paying for the rental, an approved
-- fix is going into the plan, or a fix in the plan is waiting to be paid (its approved amount is for
-- those dates, and a published fix cannot be approved again or dropped). A fix still open is left to
-- equipment_bookings_invalidate_approvals: its check goes stale and its approvals stop counting.
--
-- `idle_days` stays as the booking was made: the live idle days come from the scheduling engine.

create table public.rental_date_changes (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  booking_id  uuid not null references public.equipment_bookings (id) on delete cascade,
  changed_by  uuid references auth.users (id) on delete set null,
  from_start  date not null,
  -- Exclusive, like equipment_bookings.billable_end.
  from_end    date not null,
  to_start    date not null,
  to_end      date not null,
  created_at  timestamptz not null default now()
);
create index rental_date_changes_project_id_idx on public.rental_date_changes (project_id);

alter table public.rental_date_changes enable row level security;
revoke all on table public.rental_date_changes from anon;
revoke insert, update, delete on table public.rental_date_changes from authenticated;
create policy "rental_date_changes: members can read" on public.rental_date_changes
  for select to authenticated using (public.is_project_member(project_id));

-- A side left null keeps what the booking holds now, so an edit someone else made to the other date
-- while the editor was open is kept. `p_end` is exclusive. Saving the dates it already has changes nothing.
create or replace function public.set_rental_dates(p_booking uuid, p_start date default null, p_end date default null)
returns public.equipment_bookings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.workflow_actor('set_rental_dates');
  v_booking public.equipment_bookings;
  v_start   date;
  v_end     date;
begin
  select b.* into v_booking
    from public.equipment_bookings b
   where b.id = p_booking and public.is_project_member(b.project_id)
     for update;
  if not found then
    raise exception 'set_rental_dates: booking % not found', p_booking using errcode = 'P0002';
  end if;

  v_start := coalesce(p_start, v_booking.billable_start);
  v_end := coalesce(p_end, v_booking.billable_end);
  if v_end <= v_start then
    raise exception 'set_rental_dates: The end date cannot be before the start date.' using errcode = '22023';
  end if;
  if v_start = v_booking.billable_start and v_end = v_booking.billable_end then
    return v_booking;
  end if;

  if exists (
    select 1
      from public.payment_authorizations pa
      join public.proposal_versions v on v.id = pa.proposal_version_id
      join public.proposals p on p.id = v.proposal_id
     where p.booking_id = p_booking and pa.status in ('authorized', 'submitted', 'pending', 'unknown')
  ) then
    raise exception 'set_rental_dates: PayPal is paying for this rental. The dates unlock as soon as PayPal confirms.' using errcode = '55006';
  end if;
  if exists (
    select 1 from public.proposals p where p.booking_id = p_booking and public.proposal_has_live_publication(p.id)
  ) then
    raise exception 'set_rental_dates: An approved fix is going into the plan right now. Try again in a moment.' using errcode = '55000';
  end if;
  -- The newest fix only: a newer one replaces a fix that was never paid.
  if exists (
    select 1
      from public.proposals p
      join public.proposal_versions v on v.proposal_id = p.id and v.version_no = p.current_version_no
     where p.id = (select l.id from public.proposals l where l.booking_id = p_booking order by l.created_at desc limit 1)
       and p.state = 'published'
       and not exists (
         select 1 from public.payment_authorizations pa where pa.proposal_version_id = v.id and pa.status = 'succeeded')
  ) then
    raise exception 'set_rental_dates: An approved fix set these dates and is waiting to be paid. Pay it first, then the dates can change.' using errcode = '55000';
  end if;

  insert into public.rental_date_changes (project_id, booking_id, changed_by, from_start, from_end, to_start, to_end)
  values (v_booking.project_id, p_booking, v_uid, v_booking.billable_start, v_booking.billable_end, v_start, v_end);

  update public.equipment_bookings b
     set billable_start = v_start, billable_end = v_end
   where b.id = p_booking
  returning b.* into v_booking;
  return v_booking;
end;
$$;

revoke execute on function public.set_rental_dates(uuid, date, date) from public, anon;
grant execute on function public.set_rental_dates(uuid, date, date) to authenticated, service_role;

-- Reset: the same as before, and the rental date history goes too.
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

  delete from public.rental_date_changes where project_id = p_project;
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
