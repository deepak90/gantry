-- Proposal workflow: versions, evaluations, reviews and corrections, approvals bound to the
-- approved content, payment authorizations, and the publication of the approved schedule change
-- as a normal Bryntum revision.
--
-- Every RPC is security definer, takes the actor from auth.uid(), locks the proposal row so the
-- steps of one proposal are serialized, and refuses with SQLSTATE 42501 (not allowed), 22023
-- (invalid argument), P0002 (not found) or 55000 (the proposal is not in a state that allows the
-- step). Evaluations are computed in a browser on the real scheduling engine (an isolated
-- ProjectModel) and recorded here; the money lines are re-derived from the inputs before they are
-- accepted, so no client can record a payment amount the inputs do not produce.

-- -------------------------------------------------------------------------------------------
-- Schema additions
-- -------------------------------------------------------------------------------------------
alter table public.proposal_versions
  add column evaluated_by uuid references auth.users (id) on delete set null;

-- One open proposal per booking; published and cancelled proposals are history.
create unique index proposals_one_open_per_booking
  on public.proposals (booking_id) where state not in ('published', 'cancelled');

alter table public.publications
  add column claimed_by uuid references auth.users (id) on delete set null,
  add column claimed_at timestamptz not null default now(),
  add column error      text;
create unique index publications_one_live_per_version
  on public.publications (proposal_version_id) where status in ('pending', 'published');

alter table public.payment_authorizations
  add column message      text,
  add column submitted_at timestamptz,
  add column attempts     int not null default 0 check (attempts >= 0);
-- One live payment operation per approval. A failed payout can be authorized again, which creates
-- a new row and therefore a new PayPal operation id.
create unique index payment_authorizations_one_live_per_approval
  on public.payment_authorizations (approval_id) where status <> 'failed';

-- -------------------------------------------------------------------------------------------
-- Internal helpers (no client grants; security definer callers run them as the owner)
-- -------------------------------------------------------------------------------------------
create or replace function public.workflow_actor(p_fn text)
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception '%: not authenticated', p_fn using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create or replace function public.workflow_member(p_project uuid, p_fn text)
returns public.project_members
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.project_members;
begin
  select m.* into v_member
    from public.project_members m
   where m.project_id = p_project and m.user_id = public.workflow_actor(p_fn);
  if not found then
    raise exception '%: not a member of project %', p_fn, p_project using errcode = '42501';
  end if;
  return v_member;
end;
$$;

-- A non-negative safe integer (minor units, day counts) from a JSON number.
create or replace function public.json_safe_int(p_value jsonb, p_field text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_number numeric;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'number' then
    raise exception '% must be a JSON number', p_field using errcode = '22023';
  end if;
  v_number := (p_value #>> '{}')::numeric;
  if v_number <> trunc(v_number) or v_number < 0 or v_number > 9007199254740991 then
    raise exception '% must be a non-negative safe integer, got %', p_field, v_number using errcode = '22023';
  end if;
  return v_number::bigint;
end;
$$;

-- A calendar date from a JSON 'YYYY-MM-DD' string; impossible dates (Feb 30) are refused.
create or replace function public.json_date_only(p_value jsonb, p_field text)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_text text;
  v_date date;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    raise exception '% must be a YYYY-MM-DD string', p_field using errcode = '22023';
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '% must be a YYYY-MM-DD string, got "%"', p_field, v_text using errcode = '22023';
  end if;
  begin
    v_date := v_text::date;
  exception when others then
    raise exception '% is not a calendar date: "%"', p_field, v_text using errcode = '22023';
  end;
  if to_char(v_date, 'YYYY-MM-DD') <> v_text then
    raise exception '% is not a calendar date: "%"', p_field, v_text using errcode = '22023';
  end if;
  return v_date;
end;
$$;

-- ProposalInputs (packages/shared/src/schemas.ts) in canonical form: exactly the five fields.
create or replace function public.proposal_inputs_canonical(p_inputs jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_key   text;
  v_start date;
  v_end   date;
begin
  if p_inputs is null or jsonb_typeof(p_inputs) <> 'object' then
    raise exception 'proposal inputs must be a JSON object' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_inputs) loop
    if v_key not in ('charge_basis', 'rebooking_minor', 'transport_minor', 'new_start', 'new_end') then
      raise exception 'proposal inputs: unknown field "%"', v_key using errcode = '22023';
    end if;
  end loop;
  if coalesce(p_inputs ->> 'charge_basis', '') not in ('one_time', 'daily') then
    raise exception 'proposal inputs: charge_basis must be one_time or daily' using errcode = '22023';
  end if;
  v_start := public.json_date_only(p_inputs -> 'new_start', 'new_start');
  v_end   := public.json_date_only(p_inputs -> 'new_end', 'new_end');
  if v_end <= v_start then
    raise exception 'proposal inputs: new_end (%) must be after new_start (%)', v_end, v_start using errcode = '22023';
  end if;
  return jsonb_build_object(
    'charge_basis',    p_inputs ->> 'charge_basis',
    'rebooking_minor', public.json_safe_int(p_inputs -> 'rebooking_minor', 'rebooking_minor'),
    'transport_minor', public.json_safe_int(p_inputs -> 'transport_minor', 'transport_minor'),
    'new_start',       to_char(v_start, 'YYYY-MM-DD'),
    'new_end',         to_char(v_end, 'YYYY-MM-DD'));
end;
$$;

-- ProposalAssumption[]: unique keys, answer and resolved_by both set or both null.
create or replace function public.proposal_assumptions_canonical(p_assumptions jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_item   jsonb;
  v_key    text;
  v_field  text;
  v_keys   text[] := '{}';
  v_result jsonb := '[]'::jsonb;
begin
  if p_assumptions is null or jsonb_typeof(p_assumptions) <> 'array' then
    raise exception 'assumptions must be a JSON array' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_assumptions) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'each assumption must be an object' using errcode = '22023';
    end if;
    for v_field in select jsonb_object_keys(v_item) loop
      if v_field not in ('key', 'question', 'answer', 'resolved_by') then
        raise exception 'assumption: unknown field "%"', v_field using errcode = '22023';
      end if;
    end loop;
    v_key := v_item ->> 'key';
    if jsonb_typeof(v_item -> 'key') is distinct from 'string' or length(v_key) not between 1 and 64 then
      raise exception 'assumption key must be 1-64 characters' using errcode = '22023';
    end if;
    if v_key = any (v_keys) then
      raise exception 'assumption key "%" appears twice', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(v_item -> 'question') is distinct from 'string' or v_item ->> 'question' = '' then
      raise exception 'assumption "%" needs a question', v_key using errcode = '22023';
    end if;
    if coalesce(jsonb_typeof(v_item -> 'answer'), 'null') not in ('string', 'null')
       or coalesce(v_item ->> 'resolved_by', 'human') not in ('human', 'agent')
       or ((v_item ->> 'answer') is null) <> ((v_item ->> 'resolved_by') is null) then
      raise exception 'assumption "%": answer and resolved_by (human or agent) are both set or both null', v_key
        using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'key', v_key,
      'question', v_item ->> 'question',
      'answer', v_item -> 'answer',
      'resolved_by', v_item -> 'resolved_by'));
  end loop;
  return v_result;
end;
$$;

-- Applies answers [{key, answer, resolved_by?}] to open or answered assumptions by key.
create or replace function public.proposal_assumptions_answered(p_assumptions jsonb, p_answers jsonb)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_answer jsonb;
  v_key    text;
  v_by     text;
  v_result jsonb := p_assumptions;
  v_index  int;
begin
  if p_answers is null or jsonb_typeof(p_answers) = 'null' then
    return p_assumptions;
  end if;
  if jsonb_typeof(p_answers) <> 'array' then
    raise exception 'answers must be a JSON array' using errcode = '22023';
  end if;
  for v_answer in select value from jsonb_array_elements(p_answers) loop
    v_key := v_answer ->> 'key';
    v_by := coalesce(v_answer ->> 'resolved_by', 'human');
    if jsonb_typeof(v_answer -> 'answer') is distinct from 'string' or v_answer ->> 'answer' = '' or v_by not in ('human', 'agent') then
      raise exception 'answer for "%" needs a non-empty answer and resolved_by human or agent', v_key using errcode = '22023';
    end if;
    select e.ordinality - 1 into v_index
      from jsonb_array_elements(v_result) with ordinality as e
     where e.value ->> 'key' = v_key;
    if v_index is null then
      raise exception 'there is no assumption "%" to answer', v_key using errcode = '22023';
    end if;
    v_result := jsonb_set(v_result, array[v_index::text], (v_result -> v_index)
      || jsonb_build_object('answer', v_answer ->> 'answer', 'resolved_by', v_by));
  end loop;
  return v_result;
end;
$$;

-- What an approval binds to: the version, its inputs and assumptions, the evaluated schedule impact
-- and costs, and the exact payment (amount, currency, recipient) with the booking it concerns.
create or replace function public.proposal_content(p_version uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'proposal_version_id', v.id,
    'inputs',              v.inputs,
    'assumptions',         v.assumptions,
    'schedule_impact',     v.evaluation -> 'schedule_impact',
    'cost_comparison',     v.evaluation -> 'cost_comparison',
    'booking_days',        v.evaluation -> 'booking_days',
    'amount_minor',        v.evaluation -> 'cost_comparison' -> 'supplier_payment_minor',
    'currency',            v.evaluation -> 'cost_comparison' -> 'currency',
    'recipient',           b.supplier_payout_email,
    'task_id',             b.task_id,
    'resource_id',         b.resource_id)
  from public.proposal_versions v
  join public.proposals p on p.id = v.proposal_id
  join public.equipment_bookings b on b.id = p.booking_id
  where v.id = p_version;
$$;

create or replace function public.proposal_content_hash(p_version uuid, p_scope text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(convert_to(p_scope || ':' || public.proposal_content(p_version)::text, 'UTF8'), 'sha256'),
    'hex');
$$;

create or replace function public.invalidate_approvals(p_version uuid, p_reason text)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.approvals
     set status = 'invalidated', invalidated_reason = p_reason, invalidated_at = now()
   where proposal_version_id = p_version and status = 'active';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A payment operation that is not failed exists for any version of the proposal.
create or replace function public.proposal_has_live_payment(p_proposal uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.payment_authorizations pa
      join public.proposal_versions pv on pv.id = pa.proposal_version_id
     where pv.proposal_id = p_proposal and pa.status <> 'failed');
$$;

-- A publication is in progress in a session that is still heartbeating.
create or replace function public.proposal_has_live_publication(p_proposal uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.publications pu
      join public.proposal_versions pv on pv.id = pu.proposal_version_id
      join public.sessions s on s.id = pu.executor_session
     where pv.proposal_id = p_proposal
       and pu.status = 'pending'
       and s.last_seen > now() - interval '90 seconds');
$$;

-- Derives the proposal state from its current version, reviews and approvals; published and
-- cancelled are terminal and only set by their RPCs.
create or replace function public.refresh_proposal_state(p_proposal uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal  public.proposals;
  v_version   public.proposal_versions;
  v_active    text[];
  v_evaluated boolean;
  v_reviewed  boolean;
  v_state     text;
begin
  select p.* into v_proposal from public.proposals p where p.id = p_proposal;
  if v_proposal.state in ('published', 'cancelled') then
    return v_proposal.state;
  end if;
  select v.* into v_version
    from public.proposal_versions v
   where v.proposal_id = p_proposal and v.version_no = v_proposal.current_version_no;
  select coalesce(array_agg(a.scope), '{}') into v_active
    from public.approvals a
   where a.proposal_version_id = v_version.id and a.status = 'active';
  v_evaluated := v_version.evaluation is not null and not v_version.stale;
  v_reviewed := v_proposal.current_version_no > 1
    or exists (
      select 1 from public.reviews r join public.proposal_versions pv on pv.id = r.proposal_version_id
       where pv.proposal_id = p_proposal)
    or exists (
      select 1 from public.approvals a join public.proposal_versions pv on pv.id = a.proposal_version_id
       where pv.proposal_id = p_proposal);
  v_state := case
    when v_evaluated and v_active @> array['schedule', 'payment'] then 'approved'
    when v_reviewed then 'in_review'
    when v_evaluated then 'evaluated'
    else 'draft'
  end;
  if v_state is distinct from v_proposal.state then
    update public.proposals set state = v_state where id = p_proposal;
  end if;
  return v_state;
end;
$$;

-- Loads a version the caller can see and locks its proposal. Returns null when not visible.
create or replace function public.lock_proposal_version(p_version uuid, p_fn text)
returns public.proposal_versions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_version public.proposal_versions;
begin
  perform public.workflow_actor(p_fn);
  select v.* into v_version
    from public.proposal_versions v
   where v.id = p_version and public.is_project_member(v.project_id);
  if not found then
    raise exception '%: proposal version % not found', p_fn, p_version using errcode = 'P0002';
  end if;
  perform 1 from public.proposals p where p.id = v_version.proposal_id for update;
  -- Re-read under the lock: a concurrent correction may have committed meanwhile.
  select v.* into v_version from public.proposal_versions v where v.id = p_version;
  return v_version;
end;
$$;

-- The version must be the proposal's current one and the proposal still open.
create or replace function public.require_current_version(p_version public.proposal_versions, p_fn text, p_states text[])
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals;
begin
  select p.* into v_proposal from public.proposals p where p.id = p_version.proposal_id;
  if v_proposal.current_version_no <> p_version.version_no then
    raise exception '%: version % is no longer current; the proposal is at version %',
      p_fn, p_version.version_no, v_proposal.current_version_no using errcode = '55000';
  end if;
  if not (v_proposal.state = any (p_states)) then
    raise exception '%: the proposal is %; this step needs it to be %', p_fn, v_proposal.state, array_to_string(p_states, ' or ')
      using errcode = '55000';
  end if;
  return v_proposal;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'workflow_actor(text)', 'workflow_member(uuid,text)', 'json_safe_int(jsonb,text)', 'json_date_only(jsonb,text)',
    'proposal_inputs_canonical(jsonb)', 'proposal_assumptions_canonical(jsonb)', 'proposal_assumptions_answered(jsonb,jsonb)',
    'proposal_content(uuid)', 'proposal_content_hash(uuid,text)', 'invalidate_approvals(uuid,text)',
    'proposal_has_live_payment(uuid)', 'proposal_has_live_publication(uuid)', 'refresh_proposal_state(uuid)',
    'lock_proposal_version(uuid,text)', 'require_current_version(public.proposal_versions,text,text[])'
  ] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- create_proposal: a new proposal with version 1 for a booking that has no open proposal.
-- -------------------------------------------------------------------------------------------
create or replace function public.create_proposal(
  p_booking                uuid,
  p_inputs                 jsonb,
  p_assumptions            jsonb default '[]'::jsonb,
  p_created_via            text default 'human',
  p_transcript_segment_ids uuid[] default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.workflow_actor('create_proposal');
  v_booking     public.equipment_bookings;
  v_inputs      jsonb;
  v_assumptions jsonb;
  v_open        uuid;
  v_head        int;
  v_proposal    uuid;
  v_version     uuid;
begin
  select b.* into v_booking
    from public.equipment_bookings b
   where b.id = p_booking and public.is_project_member(b.project_id)
     for update;
  if not found then
    raise exception 'create_proposal: booking % not found', p_booking using errcode = 'P0002';
  end if;
  if coalesce(p_created_via, '') not in ('human', 'agent') then
    raise exception 'create_proposal: p_created_via must be human or agent' using errcode = '22023';
  end if;
  v_inputs := public.proposal_inputs_canonical(p_inputs);
  v_assumptions := public.proposal_assumptions_canonical(coalesce(p_assumptions, '[]'::jsonb));

  select p.id into v_open
    from public.proposals p
   where p.booking_id = p_booking and p.state not in ('published', 'cancelled');
  if found then
    raise exception 'create_proposal: booking % already has an open proposal %', p_booking, v_open using errcode = '55000';
  end if;

  select p.current_revision into v_head from public.projects p where p.id = v_booking.project_id;

  insert into public.proposals (project_id, booking_id, state, current_version_no, created_by)
  values (v_booking.project_id, p_booking, 'draft', 1, v_uid)
  returning id into v_proposal;

  insert into public.proposal_versions
    (project_id, proposal_id, version_no, source_revision, inputs, assumptions, created_by, created_via, transcript_segment_ids)
  values
    (v_booking.project_id, v_proposal, 1, v_head, v_inputs, v_assumptions, v_uid, p_created_via,
     coalesce(p_transcript_segment_ids, '{}'))
  returning id into v_version;

  insert into public.supplier_confirmations (proposal_id, project_id) values (v_proposal, v_booking.project_id);

  return jsonb_build_object('proposal_id', v_proposal, 'version_id', v_version, 'version_no', 1, 'state', 'draft');
end;
$$;

-- -------------------------------------------------------------------------------------------
-- record_evaluation: store the Evaluation (packages/shared/src/schemas.ts) a browser computed for
-- the current version. The cost lines must follow from the inputs, the booking's rental rate and the
-- evaluated booking days. Re-recording the same result keeps approvals; a different result
-- invalidates them.
-- -------------------------------------------------------------------------------------------
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
  v_rebooking   bigint;
  v_transport   bigint;
  v_supplier    bigint;
  v_avoided_rental bigint;
  v_forecast    bigint;
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
  if v_published > v_booking.billable_end - v_booking.billable_start
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
  v_rebooking := (v_version.inputs ->> 'rebooking_minor')::bigint
                 * case when v_version.inputs ->> 'charge_basis' = 'daily' then v_revised else 1 end;
  v_transport := (v_version.inputs ->> 'transport_minor')::bigint;
  v_supplier := v_rebooking + v_transport;
  v_avoided_rental := v_booking.rental_rate_minor * v_avoided;
  v_forecast := v_avoided_rental - v_supplier;
  if v_cc is distinct from jsonb_build_object(
       'currency',                          v_booking.currency,
       'avoided_idle_rental_minor',           v_avoided_rental,
       'rebooking_charge_minor',            v_rebooking,
       'transport_charge_minor',            v_transport,
       'supplier_payment_minor',            v_supplier,
       'forecast_saving_before_fees_minor', v_forecast,
       'payout_fee_minor',                  null,
       'net_saving_minor',                  null) then
    raise exception 'record_evaluation: cost_comparison does not follow from the inputs (expected supplier payment %, forecast saving % %)',
      v_supplier, v_forecast, v_booking.currency using errcode = '22023';
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

-- -------------------------------------------------------------------------------------------
-- review_proposal: a comment, or a correction that creates the next version with merged inputs
-- (and answered assumptions), marks it stale until re-evaluated and invalidates every active
-- approval of the version it replaces.
--   comment:    p_payload = { "text": "..." }
--   correction: p_payload = { "changes": {<ProposalInputs fields>}, "answers": [{key, answer, resolved_by}],
--                             "reason": "...", "created_via": "human" | "agent" }
-- -------------------------------------------------------------------------------------------
create or replace function public.review_proposal(p_version uuid, p_kind text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid         uuid := public.workflow_actor('review_proposal');
  v_version     public.proposal_versions := public.lock_proposal_version(p_version, 'review_proposal');
  v_proposal    public.proposals;
  v_review      uuid;
  v_text        text;
  v_reason      text;
  v_via         text;
  v_inputs      jsonb;
  v_assumptions jsonb;
  v_diff        jsonb := '{}'::jsonb;
  v_summary     text;
  v_key         text;
  v_next        uuid;
  v_head        int;
  v_invalidated int;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'review_proposal: p_payload must be a JSON object' using errcode = '22023';
  end if;

  if p_kind = 'comment' then
    v_proposal := public.require_current_version(v_version, 'review_proposal', array['draft', 'evaluated', 'in_review', 'approved']);
    v_text := p_payload ->> 'text';
    if jsonb_typeof(p_payload -> 'text') is distinct from 'string' or length(btrim(v_text)) = 0 or length(v_text) > 2000 then
      raise exception 'review_proposal: a comment needs text of 1-2000 characters' using errcode = '22023';
    end if;
    insert into public.reviews (project_id, proposal_version_id, reviewer_id, kind, payload)
    values (v_version.project_id, v_version.id, v_uid, 'comment', jsonb_build_object('text', v_text))
    returning id into v_review;
    return jsonb_build_object(
      'review_id', v_review, 'version_id', v_version.id, 'version_no', v_version.version_no,
      'state', public.refresh_proposal_state(v_version.proposal_id), 'invalidated_approvals', 0);
  end if;

  if p_kind is distinct from 'correction' then
    raise exception 'review_proposal: p_kind must be comment or correction' using errcode = '22023';
  end if;

  v_proposal := public.require_current_version(v_version, 'review_proposal', array['draft', 'evaluated', 'in_review', 'approved']);
  if public.proposal_has_live_payment(v_version.proposal_id) then
    raise exception 'review_proposal: the payment for this proposal is already authorized; it can no longer be corrected'
      using errcode = '55000';
  end if;
  if public.proposal_has_live_publication(v_version.proposal_id) then
    raise exception 'review_proposal: the schedule change is being published; correct it afterwards with a new proposal'
      using errcode = '55000';
  end if;

  v_reason := btrim(coalesce(p_payload ->> 'reason', ''));
  if length(v_reason) = 0 or length(v_reason) > 500 then
    raise exception 'review_proposal: a correction needs a reason of 1-500 characters' using errcode = '22023';
  end if;
  v_via := coalesce(p_payload ->> 'created_via', 'human');
  if v_via not in ('human', 'agent') then
    raise exception 'review_proposal: created_via must be human or agent' using errcode = '22023';
  end if;
  if p_payload ? 'changes' and jsonb_typeof(p_payload -> 'changes') <> 'object' then
    raise exception 'review_proposal: changes must be an object of proposal input fields' using errcode = '22023';
  end if;

  v_inputs := public.proposal_inputs_canonical(v_version.inputs || coalesce(p_payload -> 'changes', '{}'::jsonb));
  v_assumptions := public.proposal_assumptions_canonical(
    public.proposal_assumptions_answered(v_version.assumptions, p_payload -> 'answers'));
  if v_inputs = v_version.inputs and v_assumptions = v_version.assumptions then
    raise exception 'review_proposal: the correction changes nothing' using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(v_inputs) loop
    if v_inputs -> v_key is distinct from v_version.inputs -> v_key then
      v_diff := v_diff || jsonb_build_object(v_key, jsonb_build_object('from', v_version.inputs -> v_key, 'to', v_inputs -> v_key));
    end if;
  end loop;
  -- Names only: the reason is shown to every member, amounts only to those who can view costs.
  select string_agg(
           case d.key
             when 'charge_basis' then 'charge basis'
             when 'rebooking_minor' then 'rebooking charge'
             when 'transport_minor' then 'transport charge'
             when 'new_start' then 'rental start'
             when 'new_end' then 'off-rent date'
           end || ' changed', ', ' order by d.key)
    into v_summary
    from jsonb_each(v_diff) d;
  if v_assumptions <> v_version.assumptions then
    v_summary := concat_ws(', ', v_summary, 'assumptions answered');
  end if;

  insert into public.reviews (project_id, proposal_version_id, reviewer_id, kind, payload)
  values (v_version.project_id, v_version.id, v_uid, 'correction', jsonb_build_object(
    'changes', v_diff,
    'answers', coalesce(p_payload -> 'answers', '[]'::jsonb),
    'reason', v_reason,
    'created_via', v_via,
    'next_version_no', v_version.version_no + 1))
  returning id into v_review;

  select p.current_revision into v_head from public.projects p where p.id = v_version.project_id;
  insert into public.proposal_versions
    (project_id, proposal_id, version_no, source_revision, inputs, assumptions, stale, created_by, created_via)
  values
    (v_version.project_id, v_version.proposal_id, v_version.version_no + 1, v_head, v_inputs, v_assumptions, true, v_uid, v_via)
  returning id into v_next;

  v_invalidated := public.invalidate_approvals(v_version.id,
    format('Superseded by version %s (%s): %s', v_version.version_no + 1, v_summary, v_reason));

  update public.proposals set current_version_no = v_version.version_no + 1 where id = v_version.proposal_id;

  return jsonb_build_object(
    'review_id', v_review, 'version_id', v_next, 'version_no', v_version.version_no + 1,
    'state', public.refresh_proposal_state(v_version.proposal_id), 'invalidated_approvals', v_invalidated);
end;
$$;

-- -------------------------------------------------------------------------------------------
-- approve_proposal: the project manager approves the schedule change, the cost manager
-- (who can view costs, within their approval limit) the payment. The approval records the actor,
-- the evaluated source revision, the money for the payment scope and a hash of the content.
-- -------------------------------------------------------------------------------------------
create or replace function public.approve_proposal(p_version uuid, p_scope text)
returns public.approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.workflow_actor('approve_proposal');
  v_version  public.proposal_versions := public.lock_proposal_version(p_version, 'approve_proposal');
  v_member   public.project_members;
  v_proposal public.proposals;
  v_booking  public.equipment_bookings;
  v_amount   bigint;
  v_hash     text;
  v_existing public.approvals;
  v_row      public.approvals;
begin
  if p_scope is null or p_scope not in ('schedule', 'payment') then
    raise exception 'approve_proposal: p_scope must be schedule or payment' using errcode = '22023';
  end if;
  v_member := public.workflow_member(v_version.project_id, 'approve_proposal');
  if p_scope = 'schedule' and v_member.role <> 'pm' then
    raise exception 'approve_proposal: only the project manager approves the schedule change' using errcode = '42501';
  end if;
  if p_scope = 'payment' and (v_member.role <> 'cm' or not v_member.can_view_costs) then
    raise exception 'approve_proposal: only the cost manager approves the payment' using errcode = '42501';
  end if;

  v_proposal := public.require_current_version(v_version, 'approve_proposal', array['evaluated', 'in_review', 'approved']);
  if v_version.evaluation is null or v_version.stale then
    raise exception 'approve_proposal: version % has not been evaluated with its current inputs', v_version.version_no
      using errcode = '55000';
  end if;
  if jsonb_array_length(v_version.evaluation -> 'unresolved_assumptions') > 0 then
    raise exception 'approve_proposal: answer the open assumptions first: %', v_version.evaluation -> 'unresolved_assumptions'
      using errcode = '55000';
  end if;

  select b.* into v_booking from public.equipment_bookings b where b.id = v_proposal.booking_id;
  v_amount := (v_version.evaluation -> 'cost_comparison' ->> 'supplier_payment_minor')::bigint;
  if p_scope = 'payment' then
    if v_amount <= 0 then
      raise exception 'approve_proposal: there is no supplier payment to approve' using errcode = '55000';
    end if;
    if v_amount > v_member.approval_limit_minor then
      raise exception 'approve_proposal: the payment of % minor units exceeds your approval limit of %', v_amount, v_member.approval_limit_minor
        using errcode = '42501';
    end if;
  end if;

  v_hash := public.proposal_content_hash(v_version.id, p_scope);
  select a.* into v_existing
    from public.approvals a
   where a.proposal_version_id = v_version.id and a.scope = p_scope and a.status = 'active';
  if found then
    if v_existing.content_hash = v_hash then
      return v_existing;
    end if;
    perform public.invalidate_approvals(v_version.id, 'The approved content changed');
  end if;

  insert into public.approvals
    (project_id, proposal_version_id, approver_id, scope, content_hash, amount_minor, currency, recipient, source_revision)
  values
    (v_version.project_id, v_version.id, v_uid, p_scope, v_hash,
     case when p_scope = 'payment' then v_amount end,
     case when p_scope = 'payment' then v_booking.currency end,
     case when p_scope = 'payment' then v_booking.supplier_payout_email end,
     (v_version.evaluation ->> 'source_revision')::int)
  returning * into v_row;

  perform public.refresh_proposal_state(v_version.proposal_id);
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- authorize_payment: the cost manager turns the active payment approval of an approved
-- proposal into one immutable payment operation for the exact amount, currency and recipient.
-- Repeating the call returns the same operation; after a failed payout it creates a new one.
-- -------------------------------------------------------------------------------------------
create or replace function public.authorize_payment(p_version uuid)
returns public.payment_authorizations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.workflow_actor('authorize_payment');
  v_version  public.proposal_versions := public.lock_proposal_version(p_version, 'authorize_payment');
  v_member   public.project_members;
  v_approval public.approvals;
  v_row      public.payment_authorizations;
begin
  v_member := public.workflow_member(v_version.project_id, 'authorize_payment');
  if v_member.role <> 'cm' or not v_member.can_view_costs then
    raise exception 'authorize_payment: only the cost manager authorizes payments' using errcode = '42501';
  end if;
  perform public.require_current_version(v_version, 'authorize_payment', array['approved', 'published']);

  select a.* into v_approval
    from public.approvals a
   where a.proposal_version_id = v_version.id and a.scope = 'payment' and a.status = 'active';
  if not found or not exists (
    select 1 from public.approvals a
     where a.proposal_version_id = v_version.id and a.scope = 'schedule' and a.status = 'active') then
    raise exception 'authorize_payment: version % needs active schedule and payment approvals', v_version.version_no
      using errcode = '55000';
  end if;
  -- Every path that changes the content invalidates the approval first (corrections, re-evaluations,
  -- booking changes); this check is the last line of defense.
  if v_approval.content_hash <> public.proposal_content_hash(v_version.id, 'payment') then
    raise exception 'authorize_payment: the payment content changed after it was approved; approve it again' using errcode = '55000';
  end if;
  if v_approval.amount_minor > v_member.approval_limit_minor then
    raise exception 'authorize_payment: the payment exceeds your approval limit' using errcode = '42501';
  end if;

  select pa.* into v_row
    from public.payment_authorizations pa
   where pa.approval_id = v_approval.id and pa.status <> 'failed';
  if found then
    return v_row;
  end if;

  insert into public.payment_authorizations
    (project_id, approval_id, proposal_version_id, amount_minor, currency, recipient_email, authorized_by)
  values
    (v_version.project_id, v_approval.id, v_version.id, v_approval.amount_minor, v_approval.currency, v_approval.recipient, v_uid)
  returning * into v_row;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- claim_publication: the calling browser session becomes the executor that applies the approved
-- schedule change. A claim held by a session that stopped heartbeating can be taken over.
-- Returns { publication, task_id, new_start, new_end, created_via }.
-- -------------------------------------------------------------------------------------------
create or replace function public.claim_publication(p_version uuid, p_session uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid      uuid := public.workflow_actor('claim_publication');
  v_version  public.proposal_versions := public.lock_proposal_version(p_version, 'claim_publication');
  v_proposal public.proposals;
  v_booking  public.equipment_bookings;
  v_row      public.publications;
  v_live     boolean;
begin
  if not exists (
    select 1 from public.sessions s
     where s.id = p_session and s.user_id = v_uid and s.project_id = v_version.project_id) then
    raise exception 'claim_publication: session % does not belong to the caller in this project', p_session using errcode = '42501';
  end if;
  update public.sessions set last_seen = now() where id = p_session;

  v_proposal := public.require_current_version(v_version, 'claim_publication', array['approved', 'published']);
  select b.* into v_booking from public.equipment_bookings b where b.id = v_proposal.booking_id;

  select pu.* into v_row
    from public.publications pu
   where pu.proposal_version_id = v_version.id and pu.status in ('pending', 'published');
  if found then
    if v_row.status = 'pending' and v_row.executor_session is distinct from p_session then
      select s.last_seen > now() - interval '90 seconds' into v_live from public.sessions s where s.id = v_row.executor_session;
      if coalesce(v_live, false) then
        raise exception 'claim_publication: another session is publishing this change' using errcode = '55000';
      end if;
      update public.publications
         set executor_session = p_session, claimed_by = v_uid, claimed_at = now(), error = null
       where id = v_row.id
      returning * into v_row;
    end if;
  else
    if v_proposal.state <> 'approved' then
      raise exception 'claim_publication: the proposal is %, not approved', v_proposal.state using errcode = '55000';
    end if;
    insert into public.publications (project_id, proposal_version_id, executor_session, status, claimed_by)
    values (v_version.project_id, v_version.id, p_session, 'pending', v_uid)
    returning * into v_row;
  end if;

  return jsonb_build_object(
    'publication', to_jsonb(v_row),
    'task_id', v_booking.task_id,
    'new_start', v_version.inputs ->> 'new_start',
    'new_end', v_version.inputs ->> 'new_end',
    'created_via', v_version.created_via);
end;
$$;

-- The executor gives up (its revision was refused, or the change could not be applied locally).
create or replace function public.fail_publication(p_publication uuid, p_session uuid, p_error text)
returns public.publications
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor('fail_publication');
  v_row public.publications;
begin
  update public.publications pu
     set status = 'failed', error = left(coalesce(nullif(btrim(p_error), ''), 'Publication failed'), 1000)
   where pu.id = p_publication
     and pu.status = 'pending'
     and pu.executor_session = p_session
     and exists (select 1 from public.sessions s where s.id = p_session and s.user_id = v_uid)
  returning * into v_row;
  if not found then
    raise exception 'fail_publication: no pending publication % held by session %', p_publication, p_session using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- cancel_proposal and set_supplier_confirmation
-- -------------------------------------------------------------------------------------------
create or replace function public.cancel_proposal(p_proposal uuid, p_reason text)
returns public.proposals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal public.proposals;
  v_version  public.proposal_versions;
begin
  perform public.workflow_actor('cancel_proposal');
  select p.* into v_proposal
    from public.proposals p
   where p.id = p_proposal and public.is_project_member(p.project_id)
     for update;
  if not found then
    raise exception 'cancel_proposal: proposal % not found', p_proposal using errcode = 'P0002';
  end if;
  if v_proposal.state in ('published', 'cancelled') then
    raise exception 'cancel_proposal: the proposal is already %', v_proposal.state using errcode = '55000';
  end if;
  if public.proposal_has_live_payment(p_proposal) or public.proposal_has_live_publication(p_proposal) then
    raise exception 'cancel_proposal: the payment or publication is already under way' using errcode = '55000';
  end if;
  select v.* into v_version
    from public.proposal_versions v
   where v.proposal_id = p_proposal and v.version_no = v_proposal.current_version_no;
  perform public.invalidate_approvals(v_version.id,
    'Proposal canceled: ' || coalesce(nullif(btrim(p_reason), ''), 'no reason given'));
  update public.proposals set state = 'cancelled' where id = p_proposal returning * into v_proposal;
  return v_proposal;
end;
$$;

create or replace function public.set_supplier_confirmation(p_proposal uuid, p_status text, p_note text default null)
returns public.supplier_confirmations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.workflow_actor('set_supplier_confirmation');
  v_project uuid;
  v_member  public.project_members;
  v_row     public.supplier_confirmations;
begin
  if p_status is null or p_status not in ('pending', 'confirmed') then
    raise exception 'set_supplier_confirmation: p_status must be pending or confirmed' using errcode = '22023';
  end if;
  select p.project_id into v_project
    from public.proposals p
   where p.id = p_proposal and public.is_project_member(p.project_id);
  if not found then
    raise exception 'set_supplier_confirmation: proposal % not found', p_proposal using errcode = 'P0002';
  end if;
  v_member := public.workflow_member(v_project, 'set_supplier_confirmation');
  if v_member.role <> 'cm' then
    raise exception 'set_supplier_confirmation: only the cost manager records supplier confirmation' using errcode = '42501';
  end if;
  insert into public.supplier_confirmations (proposal_id, project_id, status, confirmed_by, confirmed_at, note)
  values (p_proposal, v_project, p_status,
          case when p_status = 'confirmed' then v_uid end,
          case when p_status = 'confirmed' then now() end,
          left(nullif(btrim(p_note), ''), 1000))
  on conflict (proposal_id) do update set
    status       = excluded.status,
    confirmed_by = excluded.confirmed_by,
    confirmed_at = excluded.confirmed_at,
    note         = excluded.note
  returning * into v_row;
  return v_row;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- A booking change reaches the open proposal: a new recipient invalidates its approvals; a new
-- rental rate, currency, activity, resource or published billable interval also makes its
-- evaluation stale. (Publication changes the interval after the proposal is already published.)
-- -------------------------------------------------------------------------------------------
create or replace function public.equipment_bookings_invalidate_approvals()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_proposal uuid;
  v_version  uuid;
  v_stale    boolean;
begin
  v_stale := new.rental_rate_minor is distinct from old.rental_rate_minor
          or new.currency is distinct from old.currency
          or new.task_id is distinct from old.task_id
          or new.resource_id is distinct from old.resource_id
          or new.billable_start is distinct from old.billable_start
          or new.billable_end is distinct from old.billable_end;
  if not v_stale and new.supplier_payout_email is not distinct from old.supplier_payout_email then
    return null;
  end if;
  for v_proposal, v_version in
    select p.id, v.id
      from public.proposals p
      join public.proposal_versions v on v.proposal_id = p.id and v.version_no = p.current_version_no
     where p.booking_id = new.id and p.state not in ('published', 'cancelled')
  loop
    perform public.invalidate_approvals(v_version, 'The booking changed after approval (recipient, rate, activity or billable interval)');
    if v_stale then
      update public.proposal_versions set stale = true where id = v_version;
    end if;
    perform public.refresh_proposal_state(v_proposal);
  end loop;
  return null;
end;
$$;

revoke execute on function public.equipment_bookings_invalidate_approvals() from public, anon, authenticated;

create trigger equipment_bookings_invalidate_approvals
  after update on public.equipment_bookings
  for each row execute function public.equipment_bookings_invalidate_approvals();

do $$
declare
  f text;
begin
  foreach f in array array[
    'create_proposal(uuid,jsonb,jsonb,text,uuid[])', 'record_evaluation(uuid,jsonb)', 'review_proposal(uuid,text,jsonb)',
    'approve_proposal(uuid,text)', 'authorize_payment(uuid)', 'claim_publication(uuid,uuid)',
    'fail_publication(uuid,uuid,text)', 'cancel_proposal(uuid,text)', 'set_supplier_confirmation(uuid,text,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

-- -------------------------------------------------------------------------------------------
-- Publication through the revision log. publication_revision_check validates a revision that
-- claims to publish p_publication: the claim is held by the submitting session, the proposal is
-- still approved on the same content, and the revision's user input touches nothing but the
-- booked task's start-no-earlier-than constraint and its decisionRef (= the publication id).
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
    if v_input is null or jsonb_typeof(v_input) = 'null' then
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
  return v_pub;
end;
$$;

-- Marks the publication done in the transaction that accepted its revision, so a lost response or a
-- retried submission can never leave the revision accepted and the publication pending.
create or replace function public.publication_complete(p_publication uuid, p_revision_no int)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pub     public.publications;
  v_version public.proposal_versions;
begin
  update public.publications
     set status = 'published', published_revision = p_revision_no, published_at = now(), error = null
   where id = p_publication
  returning * into v_pub;
  select v.* into v_version from public.proposal_versions v where v.id = v_pub.proposal_version_id;
  update public.proposals set state = 'published' where id = v_version.proposal_id;
  update public.equipment_bookings b
     set billable_start = (v_version.inputs ->> 'new_start')::date,
         billable_end   = (v_version.inputs ->> 'new_end')::date,
         idle_days      = coalesce((v_version.evaluation -> 'booking_days' ->> 'revised_idle_days')::int, b.idle_days)
   where b.id = (select p.booking_id from public.proposals p where p.id = v_version.proposal_id);
end;
$$;

revoke execute on function public.publication_revision_check(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.publication_complete(uuid, int) from public, anon, authenticated;

-- -------------------------------------------------------------------------------------------
-- submit_revision, now with an optional publication. Unchanged otherwise (see the revisions
-- migration for the protocol notes).
-- -------------------------------------------------------------------------------------------
drop function public.submit_revision(uuid, uuid, text, text, jsonb, text);

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

-- -------------------------------------------------------------------------------------------
-- Realtime: the workflow topic. Every member receives { table, id, op, proposal_id } on
-- project:<id>:workflow when a proposal, version, review, approval, publication, payment
-- authorization, supplier confirmation or booking changes, and re-reads the row through RLS.
-- The payload carries no figures, so members who cannot view costs get it too (they need the
-- approval and publication states). Nobody may send on it.
-- -------------------------------------------------------------------------------------------
create or replace function public.project_topic_channel(p_topic text)
returns text
language sql
immutable
set search_path = ''
as $$
  select (regexp_match(
    p_topic,
    '^project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(revisions|presence|view|cursor|commercial|workflow)$'))[1];
$$;

create or replace function public.broadcast_workflow_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row      jsonb := case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end;
  v_proposal text;
begin
  v_proposal := case tg_table_name
    when 'proposals' then v_row ->> 'id'
    when 'proposal_versions' then v_row ->> 'proposal_id'
    when 'supplier_confirmations' then v_row ->> 'proposal_id'
    when 'equipment_bookings' then null
    else (select pv.proposal_id::text from public.proposal_versions pv where pv.id = (v_row ->> 'proposal_version_id')::uuid)
  end;
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null then
    perform realtime.send(
      jsonb_build_object(
        'table', tg_table_name,
        'id', coalesce(v_row ->> 'id', v_row ->> 'proposal_id'),
        'op', tg_op,
        'proposal_id', v_proposal),
      'change',
      'project:' || (v_row ->> 'project_id') || ':workflow',
      true);
  end if;
  return null;
end;
$$;

revoke execute on function public.broadcast_workflow_change() from public, anon, authenticated;

-- Proposals, approvals and payment authorizations move from the cost-gated commercial topic to the
-- workflow topic; payment events, agent commands and decision notes stay where they are.
drop trigger proposals_broadcast on public.proposals;
drop trigger approvals_broadcast on public.approvals;
drop trigger payment_authorizations_broadcast on public.payment_authorizations;

do $$
declare
  t text;
begin
  foreach t in array array[
    'proposals', 'proposal_versions', 'reviews', 'approvals', 'publications', 'payment_authorizations',
    'supplier_confirmations', 'equipment_bookings'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on public.%I for each row execute function public.broadcast_workflow_change()',
      t || '_workflow_broadcast', t);
  end loop;
end;
$$;
