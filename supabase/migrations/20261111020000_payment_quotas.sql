-- PayPal on the hosted demo: caps per copy and per day, and a progress payout that may be asked for again.
--
--   quota_limits       three more kinds, counted by the PayPal functions when GANTRY_HOSTED=1:
--                        payout        payouts sent (a progress payment's batch, or a rental's payout)
--                        payout_minor  what those payouts pay, in minor units
--                        invoice       invoices made at PayPal for the tenant
--                      Each limit is a row, so it can be changed in place (null: no limit of that kind).
--   use_payment_quota  counts a payout and its amount together, or neither; an invoice by itself (service role)
--   claim_pay_gate_payout  the same payout sent again in the same batch, after its answer was lost, is let through
--                      on the approval it already used: PayPal never pays a batch id twice
--
-- Safe to apply again: rows are added only where missing, functions are replaced.

insert into public.quota_limits (kind, per_copy, per_day) values
  ('payout', 6, 120),
  ('payout_minor', 10000000, 40000000),
  ('invoice', 6, 120)
on conflict (kind) do nothing;

-- use_payment_quota('payout', project, amount) -> true when one more payout of that amount fits under every limit,
-- and then counts both; false, counting neither, when it doesn't. use_payment_quota('invoice', project) counts one
-- invoice.
create or replace function public.use_payment_quota(p_kind text, p_project uuid, p_amount_minor bigint default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_kind = 'invoice' then
    return public.use_quota('invoice', p_project, 1);
  end if;
  if p_kind is distinct from 'payout' then
    raise exception 'use_payment_quota: there is no payment quota called %', p_kind using errcode = '22023';
  end if;
  if p_amount_minor is null or p_amount_minor < 1 or p_amount_minor > 2147483647 then
    raise exception 'use_payment_quota: a payout needs its amount, in minor units' using errcode = '22023';
  end if;
  -- The count and the amount together: an amount that doesn't fit takes the count back with it.
  begin
    if not public.use_quota('payout', p_project, 1) then
      return false;
    end if;
    if not public.use_quota('payout_minor', p_project, p_amount_minor::int) then
      raise exception 'use_payment_quota: over the amount' using errcode = 'GQ001';
    end if;
    return true;
  exception when sqlstate 'GQ001' then
    return false;
  end;
end;
$$;
revoke execute on function public.use_payment_quota(text, uuid, bigint) from public, anon, authenticated;
grant execute on function public.use_payment_quota(text, uuid, bigint) to service_role;

-- claim_pay_gate_payout, as in 20261108010000_pay_gate_approvals.sql, with one more case: the approval was used, within
-- the last day, by this sender, for this very batch and exactly these firms and amounts. That is the same payout sent
-- again after its answer was lost; PayPal refuses a second batch with the same id, so the payout server reads back the
-- one PayPal has rather than the page being told the approval is used up.
create or replace function public.claim_pay_gate_payout(
  p_project uuid, p_gate bigint, p_amount_minor bigint, p_currency text, p_lines jsonb, p_approval uuid, p_sender_batch_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member  public.project_members := public.workflow_member(p_project, 'claim_pay_gate_payout');
  v_over    bigint;
  v_row     public.pay_gate_approvals;
  v_decider public.project_members;
begin
  if not v_member.can_view_costs then
    raise exception 'claim_pay_gate_payout: only members who see costs pay the firms' using errcode = '42501';
  end if;
  perform public.check_pay_gate_lines(p_lines, p_amount_minor, 'claim_pay_gate_payout');
  if p_amount_minor > v_member.approval_limit_minor then
    raise exception 'claim_pay_gate_payout: the payout of % minor units exceeds your approval limit of %', p_amount_minor, v_member.approval_limit_minor
      using errcode = '42501';
  end if;
  select p.second_approval_over_minor into v_over from public.projects p where p.id = p_project;
  if p_amount_minor <= v_over then
    return jsonb_build_object('needed', false, 'over_minor', v_over, 'approval_id', null);
  end if;
  if p_approval is null then
    raise exception 'claim_pay_gate_payout: payouts over % minor units need a second person who sees costs to approve them first', v_over
      using errcode = '42501';
  end if;

  select a.* into v_row from public.pay_gate_approvals a where a.id = p_approval for update;
  if not found or v_row.project_id <> p_project or v_row.gate_id <> p_gate then
    raise exception 'claim_pay_gate_payout: that approval is not for this payment' using errcode = '42501';
  end if;
  if v_row.status = 'used' and v_row.sender_batch_id = left(p_sender_batch_id, 80) and v_row.requested_by = v_member.user_id
     and v_row.used_at > now() - interval '1 day'
     and v_row.amount_minor = p_amount_minor and v_row.currency = coalesce(p_currency, '')
     and public.pay_gate_lines_key(v_row.lines) = public.pay_gate_lines_key(p_lines) then
    return jsonb_build_object('needed', true, 'over_minor', v_over, 'approval_id', v_row.id,
                              'approved_by', v_row.decided_by, 'approved_at', v_row.decided_at, 'resumed', true);
  end if;
  if v_row.status <> 'approved' then
    raise exception 'claim_pay_gate_payout: the approval is %, not approved', v_row.status using errcode = '42501';
  end if;
  if v_row.requested_by <> v_member.user_id or v_row.decided_by is null or v_row.decided_by = v_member.user_id then
    raise exception 'claim_pay_gate_payout: the person who asked sends it, once someone else has approved it' using errcode = '42501';
  end if;
  if v_row.decided_at < now() - interval '30 minutes' then
    raise exception 'claim_pay_gate_payout: the approval is more than 30 minutes old; ask again' using errcode = '42501';
  end if;
  if v_row.amount_minor <> p_amount_minor or v_row.currency <> coalesce(p_currency, '')
     or public.pay_gate_lines_key(v_row.lines) <> public.pay_gate_lines_key(p_lines) then
    raise exception 'claim_pay_gate_payout: this is not the payout that was approved (the firms or amounts differ)' using errcode = '42501';
  end if;
  select m.* into v_decider from public.project_members m where m.project_id = p_project and m.user_id = v_row.decided_by;
  if not found or not v_decider.can_view_costs or v_decider.approval_limit_minor < p_amount_minor then
    raise exception 'claim_pay_gate_payout: whoever approved it can no longer approve a payout this size' using errcode = '42501';
  end if;

  update public.pay_gate_approvals
     set status = 'used', used_at = now(), sender_batch_id = left(p_sender_batch_id, 80), updated_at = now()
   where id = v_row.id
  returning * into v_row;
  return jsonb_build_object('needed', true, 'over_minor', v_over, 'approval_id', v_row.id,
                            'approved_by', v_row.decided_by, 'approved_at', v_row.decided_at);
end;
$$;
revoke execute on function public.claim_pay_gate_payout(uuid, bigint, bigint, text, jsonb, uuid, text) from public, anon;
grant execute on function public.claim_pay_gate_payout(uuid, bigint, bigint, text, jsonb, uuid, text) to authenticated, service_role;
