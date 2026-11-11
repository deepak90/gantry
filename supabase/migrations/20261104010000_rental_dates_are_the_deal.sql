-- A rental's dates are the deal: whoever sets them, by hand or through the assistant, that is what gets paid, and they
-- stay open to change until the money moves. An approved fix no longer holds them: a fix is now only the record a
-- payment is made against, written when someone presses Pay, for the dates as they stand then.
--
-- The dates as first quoted stay on the booking, so what a change saved can be read at any time.

alter table public.equipment_bookings
  add column quoted_start date,
  add column quoted_end date;

update public.equipment_bookings set quoted_start = billable_start, quoted_end = billable_end;

create or replace function public.equipment_bookings_quote()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.quoted_start := coalesce(new.quoted_start, new.billable_start);
  new.quoted_end := coalesce(new.quoted_end, new.billable_end);
  return new;
end;
$$;

revoke execute on function public.equipment_bookings_quote() from public, anon, authenticated;

create trigger equipment_bookings_quote
  before insert on public.equipment_bookings
  for each row execute function public.equipment_bookings_quote();

alter table public.equipment_bookings
  alter column quoted_start set not null,
  alter column quoted_end set not null;

-- Only money moving, or a publication under way, holds a rental's dates.
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
      then 'A change to this rental is going into the plan right now. Try again in a moment.'
  end;
$$;

create or replace function public.record_evaluation(p_version uuid, p_evaluation jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.workflow_actor('record_evaluation');
  v_version     public.proposal_versions := public.lock_proposal_version(p_version, 'record_evaluation');
  v_proposal    public.proposals;
  v_booking     public.equipment_bookings;
  v_ev          jsonb := p_evaluation;
  v_key         text;
  v_impact      jsonb;
  v_cc          jsonb;
  v_days        jsonb;
  v_head        int;
  v_source      bigint;
  v_published   bigint;
  v_revised     bigint;
  v_avoided     bigint;
  v_booked      bigint;
  v_supplier    bigint;
  v_unresolved  jsonb;
  v_invalidated int := 0;
  v_changed     boolean := true;
begin
  v_proposal := public.require_current_version(v_version, 'record_evaluation', array['draft', 'evaluated', 'in_review', 'approved']);
  select b.* into v_booking from public.equipment_bookings b where b.id = v_proposal.booking_id;

  -- Shape ---------------------------------------------------------------------------------
  if v_ev is null or jsonb_typeof(v_ev) <> 'object' then
    raise exception 'record_evaluation: the evaluation must be a JSON object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(v_ev) loop
    if v_key not in ('source_revision', 'inputs', 'assumptions', 'schedule_impact', 'cost_comparison',
                     'booking_days', 'unresolved_assumptions', 'evaluated_at') then
      raise exception 'record_evaluation: unknown field "%"', v_key using errcode = '22023';
    end if;
  end loop;
  if v_ev -> 'inputs' is distinct from v_version.inputs then
    raise exception 'record_evaluation: the evaluation was computed for other inputs than version %', v_version.version_no
      using errcode = '22023';
  end if;
  if v_ev -> 'assumptions' is distinct from v_version.assumptions then
    raise exception 'record_evaluation: the evaluation was computed for other assumptions than version %', v_version.version_no
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_ev -> 'evaluated_at') is distinct from 'string' then
    raise exception 'record_evaluation: evaluated_at must be a timestamp string' using errcode = '22023';
  end if;
  v_impact := v_ev -> 'schedule_impact';
  if jsonb_typeof(v_impact) is distinct from 'object'
     or jsonb_typeof(v_impact -> 'handover') is distinct from 'object'
     or jsonb_typeof(v_impact -> 'affected_tasks') is distinct from 'array'
     or jsonb_typeof(v_impact -> 'over_allocations') is distinct from 'array' then
    raise exception 'record_evaluation: schedule_impact needs handover, affected_tasks and over_allocations' using errcode = '22023';
  end if;
  perform public.json_date_only(v_impact -> 'handover' -> 'published_end', 'handover.published_end');
  perform public.json_date_only(v_impact -> 'handover' -> 'proposed_end', 'handover.proposed_end');
  if jsonb_typeof(v_impact -> 'handover' -> 'delta_days') is distinct from 'number' then
    raise exception 'record_evaluation: handover.delta_days must be a number' using errcode = '22023';
  end if;

  -- Revision: computed on a project that had caught up with the version and is not ahead of the log.
  v_source := public.json_safe_int(v_ev -> 'source_revision', 'source_revision');
  select p.current_revision into v_head from public.projects p where p.id = v_version.project_id;
  if v_source < v_version.source_revision or v_source > v_head then
    raise exception 'record_evaluation: source_revision % is outside % .. % (version created at %, project head %)',
      v_source, v_version.source_revision, v_head, v_version.source_revision, v_head using errcode = '22023';
  end if;

  -- Unresolved assumptions are exactly the unanswered ones.
  select coalesce(jsonb_agg(e.value -> 'key' order by e.ordinality), '[]'::jsonb) into v_unresolved
    from jsonb_array_elements(v_version.assumptions) with ordinality as e
   where e.value ->> 'answer' is null;
  if v_ev -> 'unresolved_assumptions' is distinct from v_unresolved then
    raise exception 'record_evaluation: unresolved_assumptions must list the unanswered assumptions %', v_unresolved
      using errcode = '22023';
  end if;

  -- Booking days and the cost lines they imply -----------------------------------------------
  v_days := v_ev -> 'booking_days';
  if jsonb_typeof(v_days) is distinct from 'object' then
    raise exception 'record_evaluation: booking_days must be an object' using errcode = '22023';
  end if;
  v_published := public.json_safe_int(v_days -> 'published_billable_days', 'booking_days.published_billable_days');
  v_revised   := public.json_safe_int(v_days -> 'revised_billable_days', 'booking_days.revised_billable_days');
  v_avoided   := public.json_safe_int(v_days -> 'avoided_billable_days', 'booking_days.avoided_billable_days');
  perform public.json_safe_int(v_days -> 'revised_idle_days', 'booking_days.revised_idle_days');
  -- What was booked is measured against the dates as first quoted: the rental may be shorter by now.
  if v_published > v_booking.quoted_end - v_booking.quoted_start
     or v_revised > (v_version.inputs ->> 'new_end')::date - (v_version.inputs ->> 'new_start')::date then
    raise exception 'record_evaluation: billable days exceed the calendar days of the booking interval' using errcode = '22023';
  end if;
  if v_avoided <> greatest(v_published - v_revised, 0) then
    raise exception 'record_evaluation: avoided_billable_days must be published minus revised billable days' using errcode = '22023';
  end if;

  v_cc := v_ev -> 'cost_comparison';
  if jsonb_typeof(v_cc) is distinct from 'object' then
    raise exception 'record_evaluation: cost_comparison must be an object' using errcode = '22023';
  end if;
  -- The supplier is paid the revised rental; the saving is negative when the rental gets longer.
  v_booked   := v_booking.rental_rate_minor * v_published;
  v_supplier := v_booking.rental_rate_minor * v_revised;
  if v_cc is distinct from jsonb_build_object(
       'currency',               v_booking.currency,
       'booked_rental_minor',      v_booked,
       'supplier_payment_minor', v_supplier,
       'saving_minor',           v_booked - v_supplier) then
    raise exception 'record_evaluation: cost_comparison does not follow from the booking days (expected supplier payment %, saving % %)',
      v_supplier, v_booked - v_supplier, v_booking.currency using errcode = '22023';
  end if;

  -- Same result again: approvals stay valid; only a newer source revision is kept. --------------
  if v_version.evaluation is not null and not v_version.stale
     and (v_version.evaluation - 'source_revision' - 'evaluated_at') = (v_ev - 'source_revision' - 'evaluated_at') then
    v_changed := false;
    if v_source > (v_version.evaluation ->> 'source_revision')::bigint then
      update public.proposal_versions set evaluation = v_ev, evaluated_by = v_uid where id = v_version.id;
    end if;
  else
    if v_version.evaluation is not null and public.proposal_has_live_payment(v_version.proposal_id) then
      raise exception 'record_evaluation: the payment for this proposal is already authorized; its evaluation cannot change'
        using errcode = '55000';
    end if;
    if v_version.evaluation is not null then
      v_invalidated := public.invalidate_approvals(v_version.id,
        format('Re-evaluated at revision %s with a different schedule impact or cost result', v_source));
    end if;
    update public.proposal_versions
       set evaluation = v_ev, stale = false, evaluated_by = v_uid
     where id = v_version.id;
  end if;

  return jsonb_build_object(
    'version_id', v_version.id,
    'state', public.refresh_proposal_state(v_version.proposal_id),
    'changed', v_changed,
    'invalidated_approvals', v_invalidated);
end;
$$;
