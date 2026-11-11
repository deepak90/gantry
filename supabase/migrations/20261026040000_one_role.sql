-- One role: no project manager / cost manager split.
-- The permission model stays (roles, cost visibility and approval limits still exist and are tested),
-- but approving no longer depends on the role: any member approves the dates, and a member who can
-- see costs approves the payment within their limit. approve_fix approves both in one call, which is
-- what the app's single "Approve the fix" does. The demo seed makes every member a full member.

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
  -- Any member approves the dates; the payment needs someone who sees costs (within their limit).
  if p_scope = 'payment' and not v_member.can_view_costs then
    raise exception 'approve_proposal: only a member who can see costs approves the payment' using errcode = '42501';
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
    -- The dates come first: the payment approval completes the proposal, it never precedes the
    -- project manager's decision on the schedule change it pays for.
    if not exists (
      select 1 from public.approvals a
       where a.proposal_version_id = v_version.id and a.scope = 'schedule' and a.status = 'active'
         and a.content_hash = public.proposal_content_hash(v_version.id, 'schedule')) then
      raise exception 'approve_proposal: the dates are approved first (version % has no schedule approval)',
        v_version.version_no using errcode = '55000';
    end if;
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

-- Both approvals at once, dates first, by the same person: the app's "Approve the fix".
create or replace function public.approve_fix(p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_schedule public.approvals := public.approve_proposal(p_version, 'schedule');
  v_payment  public.approvals := public.approve_proposal(p_version, 'payment');
begin
  return jsonb_build_object('schedule', to_jsonb(v_schedule), 'payment', to_jsonb(v_payment));
end;
$$;

revoke execute on function public.approve_fix(uuid) from public, anon;
grant execute on function public.approve_fix(uuid) to authenticated, service_role;
