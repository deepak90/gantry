-- Payment integrity on the hosted demo, the stored plan and the stored files.
--
--   pay_gate_amounts        what a payment gate of a demo's seed plan pays each firm, by the demo (projects.template) and
--                           the gate (its milestone's task id). Harbor's footings (gate 25) pay Granite Ridge Concrete
--                           $31,320 and Pinecrest Sitework $6,480, $37,800 in all: their tasks' budgets, all reported
--                           done, less the 10% kept back (packages/shared/src/progress-payments.ts). One row per firm, so
--                           a row can be changed in place.
--   pay_gate_payouts        what each payout from a copy of the demo claimed, firm by firm, with the batch and the item
--                           it went to PayPal in, and whether PayPal turned that firm's payment down. A copy that is
--                           freed (free_copy) or claimed anew forgets them.
--   claim_pay_gate_payout   on a copy of the demo (a project in copy_pool) pays only a gate the seed pays, only its firms,
--                           and never more than the seed owes a firm, or the gate in all, across every payout of the visit
--                           that PayPal has not turned down. The same batch sent again counts once. Gates a visitor added
--                           can't be paid there. Every other project (Harbor itself, the other demos, anything made
--                           locally) pays as before.
--   settle_pay_gate_payout  the payout function, when PayPal says a firm's payment in a batch failed, was returned or was
--                           turned down: it no longer counts, so the next try pays what is left (pay-gates.ts
--                           recordPartlyPaid). Service role only.
--   save_snapshot           no longer for members: nothing in the apps calls it, and it stored any plan as the project's.
--   submit_revision         refuses a change over 256 KB.
--   payment_locked_tasks    no longer for members: no app calls it, and it told any signed-in person another project's
--                           payments. The payment lock's trigger still reads it.
--   documents bucket        PDF, PNG, JPEG and plain text only, 5 MB each; at most 20 files in a copy's folder, the seed's
--                           quote among them.
--
-- Safe to apply again: tables and indexes only where missing, functions replaced, the seed's amounts written as they are.

-- What the seed owes -----------------------------------------------------------------------------------------------

create table if not exists public.pay_gate_amounts (
  template     text not null check (template ~ '^[a-z][a-z0-9_-]{0,31}$'),
  gate_id      bigint not null check (gate_id > 0),
  firm         text not null check (char_length(firm) between 1 and 200),
  amount_minor bigint not null check (amount_minor > 0),
  primary key (template, gate_id, firm)
);

comment on table public.pay_gate_amounts is
  'What a payment gate of a demo''s seed plan pays each firm, in minor units; a copy of the demo pays no more (claim_pay_gate_payout).';

insert into public.pay_gate_amounts (template, gate_id, firm, amount_minor) values
  ('harbor', 25, 'Granite Ridge Concrete', 3132000),
  ('harbor', 25, 'Pinecrest Sitework', 648000)
on conflict (template, gate_id, firm) do update set amount_minor = excluded.amount_minor;

alter table public.pay_gate_amounts enable row level security;
revoke all on table public.pay_gate_amounts from anon, authenticated;

-- What each payout claimed ------------------------------------------------------------------------------------------

create table if not exists public.pay_gate_payouts (
  project_id      uuid not null references public.projects (id) on delete cascade,
  -- Our id for the PayPal batch (its sender_batch_id), and the id of this firm's payment in it (its sender_item_id).
  sender_batch_id text not null check (char_length(sender_batch_id) between 1 and 80),
  firm            text not null check (char_length(firm) between 1 and 200),
  gate_id         bigint not null check (gate_id > 0),
  -- Null once the batch was sent again with its firms and items paired otherwise: PayPal's word on an item no longer
  -- says which firm it was, so nothing of that batch is taken back.
  item_id         text check (item_id is null or char_length(item_id) between 1 and 80),
  amount_minor    bigint not null check (amount_minor > 0),
  claimed_by      uuid references auth.users (id) on delete set null,
  claimed_at      timestamptz not null default now(),
  -- When PayPal said this firm's payment was not made (failed, returned, blocked, refunded, reversed, denied): it no
  -- longer counts toward what the gate has paid.
  refused_at      timestamptz,
  primary key (project_id, sender_batch_id, firm)
);
create unique index if not exists pay_gate_payouts_item_key on public.pay_gate_payouts (project_id, sender_batch_id, item_id);
create index if not exists pay_gate_payouts_gate_idx on public.pay_gate_payouts (project_id, gate_id);

alter table public.pay_gate_payouts enable row level security;
revoke all on table public.pay_gate_payouts from anon, authenticated;

-- An amount in minor units as a visitor reads it: "$31,320", "$1,234.56".
create or replace function public.pay_gate_money(p_minor bigint)
returns text
language sql
immutable
set search_path = ''
as $$
  select '$' || regexp_replace(to_char(p_minor / 100.0, 'FM999,999,999,999,990.00'), '\.00$', '');
$$;

-- claim_copy_payout: claim_pay_gate_payout's part on a copy of the demo. Records the payout's lines and refuses (rolling
-- them back with the claim) a gate the seed doesn't pay, a firm it doesn't pay there, a firm named twice, or more than
-- the seed owes. p_lines has been checked already (check_pay_gate_lines); each line may carry `item_id`, the id of the
-- firm's payment in the batch.
create or replace function public.claim_copy_payout(p_project uuid, p_gate bigint, p_lines jsonb, p_sender_batch_id text, p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template text;
  v_batch    text := btrim(coalesce(p_sender_batch_id, ''));
  v_total    bigint;
  v_count    int;
  v_firms    text;
  v_in       jsonb;
  v_before   bigint;
  v_claimed  bigint;
  v_owed     record;
begin
  select p.template into v_template from public.projects p where p.id = p_project;
  select coalesce(sum(a.amount_minor), 0), count(*)::int, string_agg(a.firm, ', ' order by a.firm)
    into v_total, v_count, v_firms
    from public.pay_gate_amounts a
   where a.template = v_template and a.gate_id = p_gate;
  if v_count = 0 then
    raise exception 'Only the footings payment can be paid in the online demo.'
      using errcode = '42501', hint = 'claim_pay_gate_payout: the seed pays nothing at this gate';
  end if;
  if v_batch !~ '^[A-Za-z0-9._-]{1,80}$' then
    raise exception 'claim_pay_gate_payout: the payout needs the id of its batch' using errcode = '22023';
  end if;

  -- The lines as they go to PayPal: each firm, its amount, and the id of its payment in the batch when there is one.
  select jsonb_agg(jsonb_build_object(
           'firm', btrim(l ->> 'firm'),
           'amount', (l ->> 'amount_minor')::bigint,
           'item', case when jsonb_typeof(l -> 'item_id') = 'string' and char_length(l ->> 'item_id') between 1 and 80
                        then l ->> 'item_id' end))
    into v_in
    from jsonb_array_elements(p_lines) l;
  if (select count(distinct i.firm) from jsonb_to_recordset(v_in) as i(firm text)) <> jsonb_array_length(v_in) then
    raise exception 'A payout pays each firm once.' using errcode = '22023', hint = 'claim_pay_gate_payout: a firm is named twice';
  end if;
  if (select count(i.item) <> count(distinct i.item) from jsonb_to_recordset(v_in) as i(item text)) then
    raise exception 'claim_pay_gate_payout: each payment in a batch needs an id of its own' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_to_recordset(v_in) as i(firm text)
              where not exists (select 1 from public.pay_gate_amounts a
                                 where a.template = v_template and a.gate_id = p_gate and a.firm = i.firm)) then
    raise exception 'Only % % paid from this payment in the online demo.',
      regexp_replace(v_firms, ', ([^,]*)$', ' and \1'), case when v_count = 1 then 'is' else 'are' end
      using errcode = '42501', hint = 'claim_pay_gate_payout: a firm the seed does not pay at this gate';
  end if;

  -- One claim at a time for this gate of this copy, so the sums below hold.
  perform pg_advisory_xact_lock(hashtextextended('pay_gate_payouts:' || p_project::text || ':' || p_gate::text, 0));
  if exists (select 1 from public.pay_gate_payouts o
              where o.project_id = p_project and o.sender_batch_id = v_batch and o.gate_id <> p_gate) then
    raise exception 'claim_pay_gate_payout: that batch went out for another payment' using errcode = '42501';
  end if;

  -- Everything the other payouts of this visit sent for the gate, less what PayPal turned down.
  select coalesce(sum(o.amount_minor), 0) into v_before
    from public.pay_gate_payouts o
   where o.project_id = p_project and o.gate_id = p_gate and o.refused_at is null and o.sender_batch_id <> v_batch;
  if v_before >= v_total then
    raise exception 'This payment has already been paid.'
      using errcode = '42501', hint = 'claim_pay_gate_payout: what the seed owes at this gate has gone out in full';
  end if;

  -- The same batch sent again (its answer was lost) counts once, at the most it ever asked of each firm: PayPal pays a
  -- batch id once, in one of the forms it was asked for. Each firm keeps the item it first went out in, so what PayPal
  -- says of an item is what it says of that firm; paired otherwise, the batch can no longer be read firm by firm, and
  -- none of it is ever taken back (settle_pay_gate_payout).
  if exists (select 1 from jsonb_to_recordset(v_in) as i(firm text, item text)
               join public.pay_gate_payouts o on o.project_id = p_project and o.sender_batch_id = v_batch
              where (o.firm = i.firm and o.item_id is distinct from i.item)
                 or (o.firm <> i.firm and o.item_id = i.item)) then
    update public.pay_gate_payouts o set item_id = null where o.project_id = p_project and o.sender_batch_id = v_batch;
    select jsonb_agg(e || jsonb_build_object('item', null)) into v_in from jsonb_array_elements(v_in) e;
  end if;
  insert into public.pay_gate_payouts as o (project_id, sender_batch_id, firm, gate_id, item_id, amount_minor, claimed_by)
  select p_project, v_batch, i.firm, p_gate, i.item, i.amount, p_user
    from jsonb_to_recordset(v_in) as i(firm text, amount bigint, item text)
  on conflict (project_id, sender_batch_id, firm) do update
    set amount_minor = greatest(o.amount_minor, excluded.amount_minor);

  -- Never more than the seed owes a firm, or the gate in all.
  for v_owed in
    select a.firm, a.amount_minor as owed,
           coalesce(sum(o.amount_minor) filter (where o.sender_batch_id <> v_batch), 0)::bigint as before,
           coalesce(sum(o.amount_minor), 0)::bigint as claimed
      from public.pay_gate_amounts a
      left join public.pay_gate_payouts o
        on o.project_id = p_project and o.gate_id = p_gate and o.firm = a.firm and o.refused_at is null
     where a.template = v_template and a.gate_id = p_gate
     group by a.firm, a.amount_minor
     order by a.firm
  loop
    if v_owed.claimed > v_owed.owed then
      if v_owed.before > 0 then
        raise exception '% has already been sent % of the % it is owed for this payment.',
          v_owed.firm, public.pay_gate_money(v_owed.before), public.pay_gate_money(v_owed.owed)
          using errcode = '42501', hint = 'claim_pay_gate_payout: more than the seed owes this firm';
      end if;
      raise exception 'That is more than % is owed for this payment, which is % in all.', v_owed.firm, public.pay_gate_money(v_owed.owed)
        using errcode = '42501', hint = 'claim_pay_gate_payout: more than the seed owes this firm';
    end if;
  end loop;
  select coalesce(sum(o.amount_minor), 0) into v_claimed
    from public.pay_gate_payouts o
   where o.project_id = p_project and o.gate_id = p_gate and o.refused_at is null;
  if v_claimed > v_total then
    raise exception 'That is more than this payment owes in all, which is %.', public.pay_gate_money(v_total)
      using errcode = '42501', hint = 'claim_pay_gate_payout: more than the seed owes at this gate';
  end if;
end;
$$;

-- claim_pay_gate_payout, as in 20261111020000_payment_quotas.sql, with one more step: on a copy of the demo, the payout
-- must be one the seed owes (claim_copy_payout), checked before any approval is used.
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
  if exists (select 1 from public.copy_pool c where c.project_id = p_project) then
    perform public.claim_copy_payout(p_project, p_gate, p_lines, p_sender_batch_id, v_member.user_id);
  end if;
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

-- settle_pay_gate_payout(project, batch, items, whole batch) -> how many firms' payments no longer count. The payout
-- function calls it with what PayPal said when it read the batch back: the items PayPal did not pay, or the whole batch
-- when PayPal turned it down. Only PayPal's word takes a payment off, never the page's.
create or replace function public.settle_pay_gate_payout(p_project uuid, p_sender_batch_id text, p_item_ids text[], p_whole_batch boolean default false)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  update public.pay_gate_payouts o
     set refused_at = now()
   where o.project_id = p_project
     and o.sender_batch_id = btrim(coalesce(p_sender_batch_id, ''))
     and o.refused_at is null
     and (coalesce(p_whole_batch, false) or o.item_id = any (coalesce(p_item_ids, '{}'::text[])));
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- A copy that is freed (free_copy, which always stamps freed_at) or claimed anew starts a new visit: the last visit's
-- payouts no longer count. Kept on the copy's row rather than in free_copy's body, so it holds however free_copy changes.
create or replace function public.copy_pool_forgets_payouts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.pay_gate_payouts where project_id = new.project_id;
  return null;
end;
$$;

drop trigger if exists copy_pool_forgets_payouts on public.copy_pool;
create trigger copy_pool_forgets_payouts
  after update of claimed_at, freed_at on public.copy_pool
  for each row when (old.claimed_at is distinct from new.claimed_at or old.freed_at is distinct from new.freed_at)
  execute function public.copy_pool_forgets_payouts();

revoke execute on function public.pay_gate_money(bigint) from public, anon, authenticated;
revoke execute on function public.claim_copy_payout(uuid, bigint, jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.copy_pool_forgets_payouts() from public, anon, authenticated;
revoke execute on function public.settle_pay_gate_payout(uuid, text, text[], boolean) from public, anon, authenticated;
grant execute on function public.settle_pay_gate_payout(uuid, text, text[], boolean) to service_role;
revoke execute on function public.claim_pay_gate_payout(uuid, bigint, bigint, text, jsonb, uuid, text) from public, anon;
grant execute on function public.claim_pay_gate_payout(uuid, bigint, bigint, text, jsonb, uuid, text) to authenticated, service_role;

-- The stored plan ---------------------------------------------------------------------------------------------------

-- save_snapshot took any JSON as the project's plan, past the revision rules and the payment lock. Nothing in the apps
-- calls it; the service role keeps it.
revoke execute on function public.save_snapshot(uuid, int, jsonb, uuid) from public, anon, authenticated;

-- submit_revision, as in 20261022020000_resources_for_members.sql, refusing a change over 256 KB before anything else
-- is read or locked. 256 KB is about fifty new tasks with their notes, costs, crews and links: well over the largest
-- change the app makes (a piece of work dropped onto every floor, one of the assistant's drafts of 40 steps).
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
  v_bytes          int;
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
  v_bytes := octet_length(p_changes::text);
  if v_bytes > 262144 then
    raise exception 'This change is too big to save at once: % KB, and the most is 256 KB. Make it in smaller steps.', ceil(v_bytes / 1024.0)::int
      using errcode = '54000', hint = 'submit_revision: changes over 256 KB';
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
      -- Crews (resources) are managed by every project member, the project manager included.
      when v_store in ('tasks', 'dependencies', 'assignments', 'resources') then
        null;
      -- The project model's own fields (calculated endDate/duration/percentDone and, when the
      -- user edited the project, a $input) ride along with record changes; it holds no records.
      when v_store = 'project' then
        null;
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

-- payment_locked_tasks answered anyone signed in about any project. Only the payment lock's trigger needs it, and it
-- runs as the function's owner.
revoke execute on function public.payment_locked_tasks(uuid) from public, anon, authenticated;

-- Stored files ------------------------------------------------------------------------------------------------------

-- The bucket's own limits (types and size) are set in 20261111090000_documents_bucket_limits.sql, on their own, last:
-- should a hosted project refuse that write to storage.buckets, everything here still applies.

-- Uploading, as in 20261022030100_project_documents.sql (any member, into a fresh path of their project's folder), and
-- into a copy of the demo only while its folder holds fewer than 20 files.
create or replace function public.can_upload_document_object(p_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.document_object_project(p_name) is not null
     and public.is_project_member(public.document_object_project(p_name))
     and not exists (select 1 from public.project_documents d where d.storage_path = p_name)
     and (not exists (select 1 from public.copy_pool c where c.project_id = public.document_object_project(p_name))
          or (select count(*) from storage.objects o
               where o.bucket_id = 'documents' and o.name like public.document_object_project(p_name)::text || '/%') < 20);
$$;

notify pgrst, 'reload schema';
