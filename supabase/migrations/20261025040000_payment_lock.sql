-- Payment lock. While PayPal pays for a fix (the payment is authorized, submitted, pending or being
-- checked), the task the money is for must not change under it: a revision that deletes it (or a
-- group or work package holding it: Bryntum lists every removed descendant) or changes any of its
-- fields is refused. Only its place among its siblings may change (another task added or moved
-- beside it renumbers it), and the fix's own publication may still put its approved dates in. The app keeps people from trying (apps/web/src/gantt/payment-lock.ts);
-- this is the guarantee. A payment PayPal is still processing cannot be deleted either, so
-- `pnpm demo:reset` waits for it; `pnpm demo:reset:force` abandons it first.

-- The tasks whose money is moving, with the payment.
create or replace function public.payment_locked_tasks(p_project uuid)
returns table (task_id bigint, payment_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select b.task_id, pa.id
    from public.payment_authorizations pa
    join public.proposal_versions v on v.id = pa.proposal_version_id
    join public.proposals p on p.id = v.proposal_id
    join public.equipment_bookings b on b.id = p.booking_id
   where pa.project_id = p_project
     and pa.status in ('authorized', 'submitted', 'pending', 'unknown');
$$;

revoke execute on function public.payment_locked_tasks(uuid) from public, anon;
grant execute on function public.payment_locked_tasks(uuid) to authenticated, service_role;

-- The records of one kind of change in a store's changes (`updated`, `removed`), both as Bryntum
-- sends them and inside `$input` (the user's own input, when it travels).
create or replace function public.revision_store_records(p_store jsonb, p_kind text)
returns setof jsonb
language sql
immutable
set search_path = ''
as $$
  select e.value
    from jsonb_array_elements(case when jsonb_typeof(p_store -> p_kind) = 'array' then p_store -> p_kind else '[]'::jsonb end) e
  union all
  select e.value
    from jsonb_array_elements(case when jsonb_typeof(p_store -> '$input' -> p_kind) = 'array' then p_store -> '$input' -> p_kind else '[]'::jsonb end) e;
$$;

revoke execute on function public.revision_store_records(jsonb, text) from public, anon, authenticated;

create or replace function public.project_revisions_payment_lock()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tasks  jsonb := case when jsonb_typeof(new.changes -> 'tasks') = 'object' then new.changes -> 'tasks' else null end;
  v_locked bigint;
  v_record jsonb;
  v_field  text;
begin
  if v_tasks is null then
    return new;
  end if;
  for v_locked in select distinct l.task_id from public.payment_locked_tasks(new.project_id) l loop
    for v_record in select r from public.revision_store_records(v_tasks, 'removed') r where r ->> 'id' = v_locked::text loop
      raise exception 'payment_lock: task % is locked while PayPal pays the supplier; it (and the group holding it) cannot be deleted until PayPal confirms', v_locked
        using errcode = '55006';
    end loop;
    for v_record in select r from public.revision_store_records(v_tasks, 'updated') r where r ->> 'id' = v_locked::text loop
      -- The fix's own publication (its decisionRef names a pending publication of this project) goes
      -- through: publication_revision_check already keeps it to the booked task's approved dates.
      if v_record ? 'decisionRef' and exists (
        select 1 from public.publications pu
         where pu.project_id = new.project_id and pu.status = 'pending' and pu.id::text = v_record ->> 'decisionRef'
      ) then
        continue;
      end if;
      for v_field in select jsonb_object_keys(v_record) loop
        if v_field not in ('id', 'parentIndex', 'orderedParentIndex') then
          raise exception 'payment_lock: task % is locked while PayPal pays the supplier; its % cannot change until PayPal confirms', v_locked, v_field
            using errcode = '55006';
        end if;
      end loop;
    end loop;
  end loop;
  return new;
end;
$$;

revoke execute on function public.project_revisions_payment_lock() from public, anon, authenticated;

create trigger project_revisions_payment_lock
  before insert on public.project_revisions
  for each row execute function public.project_revisions_payment_lock();

-- A payment PayPal is still processing stays (the demo reset deletes payments).
create or replace function public.payment_authorizations_keep_moving()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status in ('authorized', 'submitted', 'pending', 'unknown')
     and coalesce(current_setting('collab.abandon_payments', true), '') <> 'on' then
    raise exception 'payment_lock: PayPal is still processing payment % (%); wait for it to settle, or run `pnpm demo:reset:force` to abandon it', old.id, old.status
      using errcode = '55006';
  end if;
  return old;
end;
$$;

revoke execute on function public.payment_authorizations_keep_moving() from public, anon, authenticated;

create trigger payment_authorizations_keep_moving
  before delete on public.payment_authorizations
  for each row execute function public.payment_authorizations_keep_moving();

-- reset_demo that also abandons payments PayPal is still processing (service role only).
create or replace function public.reset_demo_abandoning_payments(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform set_config('collab.abandon_payments', 'on', true);
  return public.reset_demo(p_project);
end;
$$;

revoke execute on function public.reset_demo_abandoning_payments(uuid) from public, anon, authenticated;
grant execute on function public.reset_demo_abandoning_payments(uuid) to service_role;
