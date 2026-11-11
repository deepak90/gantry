-- Two people for a large progress payment (pay to proceed, apps/web/src/gantt/pay-gates.ts).
--
-- A payout over the project's threshold ($25,000 unless a project sets its own) goes out only once a second
-- member who sees costs, and whose approval limit covers it, has approved that exact payout:
--   1. the person who will send it asks (request_pay_gate_approval), with the firms and amounts they reviewed;
--   2. someone else approves or declines it on their own screen (decide_pay_gate_approval);
--   3. right before it calls PayPal, the payout server claims the approval with the sender's own token
--      (claim_pay_gate_payout), which refuses unless it was approved by someone else, for this gate and these
--      exact firms and amounts, within the last 30 minutes, and never used before. A claimed approval is used up,
--      whatever PayPal then says: a payout that fails is asked for again.
-- Members hear every change on the workflow topic ({table, id, op}: no figures) and re-read the row under RLS,
-- which only members who see costs pass.
--
-- The proposal approvals (public.approvals) bind to a proposal version's content and stay as they are; a payment
-- gate is a milestone in the plan, not a proposal, so its approvals have their own table.

alter table public.projects
  add column second_approval_over_minor bigint not null default 2500000
    constraint projects_second_approval_over_minor_check check (second_approval_over_minor >= 0);

comment on column public.projects.second_approval_over_minor is
  'Progress payouts (payment gates) over this amount, in minor units, need a second member who sees costs to approve them first.';

create table public.pay_gate_approvals (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  -- The payment gate: a milestone's task id in the plan.
  gate_id          bigint not null check (gate_id > 0),
  gate_name        text not null check (char_length(gate_name) between 1 and 200),
  amount_minor     bigint not null check (amount_minor > 0),
  currency         text not null check (currency ~ '^[A-Z]{3}$'),
  -- Each firm's payment as reviewed: [{ "firm": text, "amount_minor": int, ... what it is for }].
  lines            jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 50),
  -- The project's threshold when it was asked: why a second person was needed.
  over_minor       bigint not null check (over_minor >= 0),
  requested_by     uuid not null references auth.users (id) on delete cascade,
  status           text not null default 'requested'
                   check (status in ('requested', 'approved', 'declined', 'withdrawn', 'used')),
  decided_by       uuid references auth.users (id) on delete set null,
  decided_at       timestamptz,
  used_at          timestamptz,
  -- Our id for the PayPal batch the approval was used for (the batch's sender_batch_id).
  sender_batch_id  text check (sender_batch_id is null or char_length(sender_batch_id) <= 80),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint pay_gate_approvals_decided
    check (status not in ('approved', 'declined', 'used') or decided_at is not null),
  constraint pay_gate_approvals_two_people
    check (decided_by is null or decided_by <> requested_by)
);

create index pay_gate_approvals_project_idx on public.pay_gate_approvals (project_id, created_at);
-- One open request per gate: asking again for a different payout replaces it.
create unique index pay_gate_approvals_one_open
  on public.pay_gate_approvals (project_id, gate_id) where status in ('requested', 'approved');

alter table public.pay_gate_approvals enable row level security;
create policy "members who see costs read payment approvals" on public.pay_gate_approvals
  for select to authenticated
  using (public.is_project_member(project_id) and public.member_can_view_costs(project_id));
revoke insert, update, delete, truncate on public.pay_gate_approvals from anon, authenticated;

-- A payout's firms and amounts, as compared: in one order whatever order they were sent in.
create or replace function public.pay_gate_lines_key(p_lines jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object('firm', k.firm, 'amount_minor', k.amount) order by k.firm, k.amount), '[]'::jsonb)
    from (select btrim(l ->> 'firm') as firm, (l ->> 'amount_minor')::bigint as amount
            from jsonb_array_elements(p_lines) as l) k;
$$;

-- Refuses lines that aren't firms with whole positive amounts adding up to the payout.
create or replace function public.check_pay_gate_lines(p_lines jsonb, p_amount_minor bigint, p_fn text)
returns void
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_sum bigint;
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception '%: the payout needs a positive amount', p_fn using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception '%: a payout pays 1 to 50 firms', p_fn using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) as l
     where jsonb_typeof(l) <> 'object'
        or jsonb_typeof(l -> 'firm') is distinct from 'string'
        or char_length(btrim(l ->> 'firm')) not between 1 and 200
        or jsonb_typeof(l -> 'amount_minor') is distinct from 'number'
        or (l ->> 'amount_minor') !~ '^[1-9][0-9]{0,15}$') then
    raise exception '%: each line needs a firm and a whole positive amount in minor units', p_fn using errcode = '22023';
  end if;
  select sum((l ->> 'amount_minor')::bigint) into v_sum from jsonb_array_elements(p_lines) as l;
  if v_sum <> p_amount_minor then
    raise exception '%: the firms'' amounts add up to %, not %', p_fn, v_sum, p_amount_minor using errcode = '22023';
  end if;
end;
$$;

-- request_pay_gate_approval: the person who will send the payout asks for a second person's approval of it.
-- Asking again for the same payout while it is open returns the same request; a different payout replaces it.
create or replace function public.request_pay_gate_approval(
  p_project uuid, p_gate bigint, p_gate_name text, p_amount_minor bigint, p_currency text, p_lines jsonb)
returns public.pay_gate_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member public.project_members := public.workflow_member(p_project, 'request_pay_gate_approval');
  v_over   bigint;
  v_open   public.pay_gate_approvals;
  v_row    public.pay_gate_approvals;
begin
  if not v_member.can_view_costs then
    raise exception 'request_pay_gate_approval: only members who see costs pay the firms' using errcode = '42501';
  end if;
  perform public.check_pay_gate_lines(p_lines, p_amount_minor, 'request_pay_gate_approval');
  if p_amount_minor > v_member.approval_limit_minor then
    raise exception 'request_pay_gate_approval: the payout of % minor units exceeds your approval limit of %', p_amount_minor, v_member.approval_limit_minor
      using errcode = '42501';
  end if;
  if p_currency is null or p_currency !~ '^[A-Z]{3}$' then
    raise exception 'request_pay_gate_approval: p_currency must be a three-letter code' using errcode = '22023';
  end if;
  if p_gate is null or p_gate <= 0 or p_gate_name is null or char_length(btrim(p_gate_name)) not between 1 and 200 then
    raise exception 'request_pay_gate_approval: the payment gate needs its task id and name' using errcode = '22023';
  end if;
  select p.second_approval_over_minor into v_over from public.projects p where p.id = p_project;

  select a.* into v_open
    from public.pay_gate_approvals a
   where a.project_id = p_project and a.gate_id = p_gate and a.status in ('requested', 'approved')
   for update;
  if found then
    if v_open.requested_by = v_member.user_id
       and v_open.amount_minor = p_amount_minor and v_open.currency = p_currency
       and public.pay_gate_lines_key(v_open.lines) = public.pay_gate_lines_key(p_lines)
       and (v_open.status = 'requested' or v_open.decided_at > now() - interval '30 minutes') then
      return v_open;
    end if;
    update public.pay_gate_approvals set status = 'withdrawn', updated_at = now() where id = v_open.id;
  end if;

  insert into public.pay_gate_approvals (project_id, gate_id, gate_name, amount_minor, currency, lines, over_minor, requested_by)
  values (p_project, p_gate, btrim(p_gate_name), p_amount_minor, p_currency, p_lines, v_over, v_member.user_id)
  returning * into v_row;
  return v_row;
end;
$$;

-- decide_pay_gate_approval: someone other than the person who asked, who sees costs and (to approve) whose
-- approval limit covers the payout, approves or declines it.
create or replace function public.decide_pay_gate_approval(p_approval uuid, p_approve boolean)
returns public.pay_gate_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.pay_gate_approvals;
  v_member public.project_members;
begin
  select a.* into v_row from public.pay_gate_approvals a where a.id = p_approval for update;
  if not found then
    raise exception 'decide_pay_gate_approval: there is no such request' using errcode = 'P0002';
  end if;
  v_member := public.workflow_member(v_row.project_id, 'decide_pay_gate_approval');
  if v_member.user_id = v_row.requested_by then
    raise exception 'decide_pay_gate_approval: someone other than the person who asked has to approve it' using errcode = '42501';
  end if;
  if not v_member.can_view_costs then
    raise exception 'decide_pay_gate_approval: only members who see costs approve payments' using errcode = '42501';
  end if;
  if coalesce(p_approve, false) and v_row.amount_minor > v_member.approval_limit_minor then
    raise exception 'decide_pay_gate_approval: the payout of % minor units exceeds your approval limit of %', v_row.amount_minor, v_member.approval_limit_minor
      using errcode = '42501';
  end if;
  if v_row.status <> 'requested' then
    raise exception 'decide_pay_gate_approval: the request is already %', v_row.status using errcode = '55000';
  end if;
  update public.pay_gate_approvals
     set status = case when coalesce(p_approve, false) then 'approved' else 'declined' end,
         decided_by = v_member.user_id, decided_at = now(), updated_at = now()
   where id = v_row.id
  returning * into v_row;
  return v_row;
end;
$$;

-- withdraw_pay_gate_approval: the person who asked takes it back (they closed the review without sending).
create or replace function public.withdraw_pay_gate_approval(p_approval uuid)
returns public.pay_gate_approvals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row    public.pay_gate_approvals;
  v_member public.project_members;
begin
  select a.* into v_row from public.pay_gate_approvals a where a.id = p_approval for update;
  if not found then
    raise exception 'withdraw_pay_gate_approval: there is no such request' using errcode = 'P0002';
  end if;
  v_member := public.workflow_member(v_row.project_id, 'withdraw_pay_gate_approval');
  if v_member.user_id <> v_row.requested_by then
    raise exception 'withdraw_pay_gate_approval: only the person who asked can take it back' using errcode = '42501';
  end if;
  if v_row.status in ('requested', 'approved') then
    update public.pay_gate_approvals set status = 'withdrawn', updated_at = now() where id = v_row.id returning * into v_row;
  end if;
  return v_row;
end;
$$;

-- claim_pay_gate_payout: the payout server, with the sender's own token, right before it calls PayPal. Up to
-- the project's threshold the sender alone may pay (a member who sees costs, within their approval limit); over
-- it, only with an approval of this exact payout by someone else, which this uses up.
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

revoke execute on function public.pay_gate_lines_key(jsonb) from public, anon;
revoke execute on function public.check_pay_gate_lines(jsonb, bigint, text) from public, anon;
revoke execute on function public.request_pay_gate_approval(uuid, bigint, text, bigint, text, jsonb) from public, anon;
revoke execute on function public.decide_pay_gate_approval(uuid, boolean) from public, anon;
revoke execute on function public.withdraw_pay_gate_approval(uuid) from public, anon;
revoke execute on function public.claim_pay_gate_payout(uuid, bigint, bigint, text, jsonb, uuid, text) from public, anon;
grant execute on function public.request_pay_gate_approval(uuid, bigint, text, bigint, text, jsonb) to authenticated, service_role;
grant execute on function public.decide_pay_gate_approval(uuid, boolean) to authenticated, service_role;
grant execute on function public.withdraw_pay_gate_approval(uuid) to authenticated, service_role;
grant execute on function public.claim_pay_gate_payout(uuid, bigint, bigint, text, jsonb, uuid, text) to authenticated, service_role;

-- Everyone on the project hears a change on the workflow topic and re-reads the row under RLS.
create trigger pay_gate_approvals_workflow_broadcast
  after insert or update or delete on public.pay_gate_approvals
  for each row execute function public.broadcast_workflow_change();

-- A demo reset (reset_demo) puts the plan back to revision 0: the approvals asked for on the old plan go with it.
create or replace function public.forget_pay_gate_approvals_on_reset()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pay_gate_approvals where project_id = new.id;
  return null;
end;
$$;
revoke execute on function public.forget_pay_gate_approvals_on_reset() from public, anon, authenticated;

create trigger projects_reset_forgets_pay_gate_approvals
  after update of current_revision on public.projects
  for each row when (new.current_revision = 0 and old.current_revision <> 0)
  execute function public.forget_pay_gate_approvals_on_reset();
