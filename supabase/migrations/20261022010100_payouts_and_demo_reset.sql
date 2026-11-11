-- PayPal payout bookkeeping for the Edge Functions (paypal-execute-payout, paypal-reconcile,
-- paypal-webhook) and the demo reset. Every function here is for the service role only: the
-- functions authenticate the browser user themselves and pass the actor in where it matters.
--
-- A payment_authorizations row is the payout operation. Its id is the PayPal sender_batch_id, the
-- PayPal-Request-Id and the sender_item_id, so every retry of the same operation is the same
-- request to PayPal. Status moves forward only:
--   authorized → submitted | unknown → pending → succeeded | failed
-- (a succeeded item can still become failed when PayPal reports it returned, reversed or refunded).

-- -------------------------------------------------------------------------------------------
-- payout_take_action: what the caller must do with an operation now (claiming the attempt when
-- the answer is submit, under the row lock its callers hold).
--   submit: send it to PayPal (first attempt, or a retry of an attempt whose outcome never arrived)
--   check:  PayPal knows it; read its status
--   wait:   an attempt is in flight right now
--   none:   nothing to do (not started by its cost manager yet, or settled)
-- -------------------------------------------------------------------------------------------
create or replace function public.payout_take_action(p_row public.payment_authorizations, p_may_start boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.payment_authorizations := p_row;
  v_action text;
begin
  if v_row.status = 'authorized' then
    v_action := case when p_may_start then 'submit' else 'none' end;
  elsif v_row.status in ('succeeded', 'failed') then
    v_action := 'none';
  elsif v_row.paypal_batch_id is not null then
    v_action := 'check';
  elsif v_row.attempts >= 5 then
    -- Five sends without a batch id (PayPal keeps refusing, or says it already has the operation but
    -- cannot be asked for it by sender_batch_id): stop re-sending; the stored message says what to check.
    v_action := 'none';
  elsif v_row.submitted_at is null or v_row.submitted_at < now() - interval '20 seconds' then
    v_action := 'submit';
  else
    v_action := 'wait';
  end if;

  if v_action = 'submit' then
    update public.payment_authorizations
       set status = 'submitted', submitted_at = now(), attempts = attempts + 1
     where id = v_row.id
    returning * into v_row;
  end if;
  return jsonb_build_object('action', v_action, 'authorization', to_jsonb(v_row));
end;
$$;

-- The cost manager presses "Send payout": starts the operation (or resumes a stalled one).
create or replace function public.payout_begin(p_authorization uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.payment_authorizations;
begin
  select pa.* into v_row from public.payment_authorizations pa where pa.id = p_authorization for update;
  if not found then
    raise exception 'payout_begin: payment authorization % not found', p_authorization using errcode = 'P0002';
  end if;
  if not exists (
    select 1 from public.project_members m
     where m.project_id = v_row.project_id and m.user_id = p_actor and m.role = 'cm' and m.can_view_costs) then
    raise exception 'payout_begin: only the cost manager of the project sends payouts' using errcode = '42501';
  end if;
  return public.payout_take_action(v_row, true);
end;
$$;

-- Any member refreshing the status: checks known operations and re-sends stalled attempts with the
-- same ids, but never starts an operation its cost manager has not sent.
create or replace function public.payout_resume(p_authorization uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.payment_authorizations;
begin
  select pa.* into v_row from public.payment_authorizations pa where pa.id = p_authorization for update;
  if not found then
    raise exception 'payout_resume: payment authorization % not found', p_authorization using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.project_members m where m.project_id = v_row.project_id and m.user_id = p_actor) then
    raise exception 'payout_resume: not a member of the project' using errcode = '42501';
  end if;
  return public.payout_take_action(v_row, false);
end;
$$;

-- Records what PayPal said. Identifiers and the fee are only ever filled in, never replaced by
-- null; a status older than the stored one (an out-of-order webhook) is ignored.
create or replace function public.payout_record(
  p_authorization uuid,
  p_status        text,
  p_batch_id      text default null,
  p_item_id       text default null,
  p_fee_minor     bigint default null,
  p_message       text default null,
  p_raw           jsonb default null
)
returns public.payment_authorizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.payment_authorizations;
  v_status text;
  v_rank   jsonb := '{"authorized":0,"submitted":1,"unknown":1,"pending":2,"succeeded":3,"failed":3}';
begin
  if p_status is null or not v_rank ? p_status then
    raise exception 'payout_record: unknown status %', p_status using errcode = '22023';
  end if;
  select pa.* into v_row from public.payment_authorizations pa where pa.id = p_authorization for update;
  if not found then
    raise exception 'payout_record: payment authorization % not found', p_authorization using errcode = 'P0002';
  end if;

  v_status := case
    when (v_rank ->> p_status)::int > (v_rank ->> v_row.status)::int then p_status
    when v_row.status = 'succeeded' and p_status = 'failed' then p_status
    when (v_rank ->> p_status)::int = (v_rank ->> v_row.status)::int and v_row.status not in ('succeeded', 'failed') then p_status
    else v_row.status
  end;

  update public.payment_authorizations
     set status          = v_status,
         paypal_batch_id = coalesce(paypal_batch_id, p_batch_id),
         paypal_item_id  = coalesce(paypal_item_id, p_item_id),
         fee_minor       = coalesce(p_fee_minor, fee_minor),
         -- The message and the raw answer describe the status they came with: replaced when that
         -- status is recorded (also when unchanged, so an UNCLAIMED note goes once it is pending
         -- again), kept when an older status is ignored.
         message         = case when p_status = v_status then p_message else message end,
         raw             = case when p_status = v_status then coalesce(p_raw, raw) else raw end,
         last_checked_at = now()
   where id = p_authorization
  returning * into v_row;
  return v_row;
end;
$$;

-- A webhook event, once. Returns false for an event id already recorded (a PayPal retry or replay).
create or replace function public.payout_record_event(
  p_authorization uuid,
  p_event_id      text,
  p_event_type    text,
  p_verified      boolean,
  p_payload       jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid;
  v_id      uuid;
begin
  select pa.project_id into v_project from public.payment_authorizations pa where pa.id = p_authorization;
  if not found then
    raise exception 'payout_record_event: payment authorization % not found', p_authorization using errcode = 'P0002';
  end if;
  insert into public.payment_events (project_id, authorization_id, paypal_event_id, event_type, verified, payload)
  values (v_project, p_authorization, p_event_id, p_event_type, coalesce(p_verified, false), coalesce(p_payload, '{}'::jsonb))
  on conflict (paypal_event_id) do nothing
  returning id into v_id;
  return v_id is not null;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Demo reset: the seed project as it was after `supabase db reset`, without re-running the seed.
-- seed_snapshot.sql (generated) stores the seed snapshot and booking here.
-- -------------------------------------------------------------------------------------------
create table public.demo_seeds (
  project_id uuid primary key references public.projects (id) on delete cascade,
  snapshot   jsonb not null,
  booking    jsonb not null
);
alter table public.demo_seeds enable row level security;
revoke all on table public.demo_seeds from anon, authenticated;

-- Removes every revision, session, proposal, approval, payment record, transcript and note of the
-- project and restores its seed snapshot and booking. The supplier's payout email is kept: it is
-- the machine-specific sandbox payee (scripts/gen-seed-local.ts). Open browsers must reload.
create or replace function public.reset_demo(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seed public.demo_seeds;
begin
  select d.* into v_seed from public.demo_seeds d where d.project_id = p_project;
  if not found then
    raise exception 'reset_demo: no seed stored for project % (run `pnpm db:reset` once)', p_project using errcode = 'P0002';
  end if;

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

  return jsonb_build_object('project_id', p_project, 'reset_at', now());
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'payout_take_action(public.payment_authorizations,boolean)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'payout_begin(uuid,uuid)', 'payout_resume(uuid,uuid)', 'payout_record(uuid,text,text,text,bigint,text,jsonb)',
    'payout_record_event(uuid,text,text,boolean,jsonb)', 'reset_demo(uuid)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end;
$$;
