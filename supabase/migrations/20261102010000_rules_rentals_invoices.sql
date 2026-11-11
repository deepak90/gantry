-- Plain-English rules, several rentals on a project, and invoices.
--
--   projects.listed                 false: not offered in the project menu (a link still opens it)
--   projects.client_name/_email     who the project bills for finished work
--   demo_seeds.bookings             every rental of the project; reset_demo restores them all
--   watch_rules.thread_id           the conversation the rule was drafted in: what it finds is told there
--   watch_rules.condition           also any/all of several conditions, and all_done
--   watch_rules.action              also prepare_invoice
--   invoices                        what the project bills its client, sent through PayPal Invoicing

alter table public.projects
  add column listed boolean not null default true,
  add column client_name text check (length(client_name) <= 120),
  add column client_email text check (length(client_email) <= 254);

alter table public.demo_seeds add column bookings jsonb;

-- Rules -----------------------------------------------------------------------------------------

alter table public.watch_rules add column thread_id uuid references public.agent_threads (id) on delete set null;

alter table public.watch_rules drop constraint watch_rules_condition_check;
alter table public.watch_rules add constraint watch_rules_condition_check check (
  jsonb_typeof(condition) = 'object'
  and condition ->> 'kind' in ('finish_slip', 'start_slip', 'slack_below', 'over_budget', 'spent_ahead', 'in_window', 'starts_soon', 'idle_rental', 'crew_overbooked', 'all_done', 'any', 'all')
  and length(condition::text) <= 1000);

alter table public.watch_rules drop constraint watch_rules_action_check;
alter table public.watch_rules add constraint watch_rules_action_check check (
  jsonb_typeof(action) = 'object'
  and action ->> 'kind' in ('alert', 'ask_assistant', 'prepare_invoice')
  and length(action::text) <= 1000);

drop function public.save_watch_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb, jsonb);

create or replace function public.save_watch_rule(
  p_project   uuid,
  p_rule      uuid,
  p_name      text,
  p_scope     jsonb,
  p_condition jsonb,
  p_enabled   boolean default true,
  p_trigger   jsonb default '{"kind":"change"}'::jsonb,
  p_action    jsonb default '{"kind":"alert"}'::jsonb,
  p_thread    uuid default null
)
returns public.watch_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.workflow_actor('save_watch_rule');
  v_member  public.project_members := public.workflow_member(p_project, 'save_watch_rule');
  v_name    text := btrim(coalesce(p_name, ''), E' \t\r\n');
  v_trigger jsonb := coalesce(p_trigger, '{"kind":"change"}'::jsonb);
  v_action  jsonb := coalesce(p_action, '{"kind":"alert"}'::jsonb);
  v_row     public.watch_rules;
begin
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'save_watch_rule: a name is 1-120 characters' using errcode = '22023';
  end if;
  if p_thread is not null and not exists (select 1 from public.agent_threads t where t.id = p_thread and t.project_id = p_project) then
    raise exception 'save_watch_rule: conversation % is not in this project', p_thread using errcode = 'P0002';
  end if;
  if p_rule is null then
    if (select count(*) from public.watch_rules r where r.project_id = p_project) >= 60 then
      raise exception 'save_watch_rule: a project keeps at most 60 rules' using errcode = '54000';
    end if;
    insert into public.watch_rules (project_id, name, scope, condition, trigger, action, enabled, created_by, thread_id)
    values (p_project, v_name, p_scope, p_condition, v_trigger, v_action, coalesce(p_enabled, true), v_uid, p_thread)
    returning * into v_row;
    return v_row;
  end if;
  select r.* into v_row from public.watch_rules r where r.id = p_rule and r.project_id = p_project for update;
  if not found then
    raise exception 'save_watch_rule: rule % not found', p_rule using errcode = 'P0002';
  end if;
  if v_row.created_by is distinct from v_uid and v_member.role <> 'pm' then
    raise exception 'save_watch_rule: only the person who made the rule or a project manager may change it' using errcode = '42501';
  end if;
  update public.watch_rules
     set name = v_name, scope = p_scope, condition = p_condition, trigger = v_trigger, action = v_action,
         enabled = coalesce(p_enabled, true), thread_id = coalesce(p_thread, thread_id), updated_at = now()
   where id = p_rule
  returning * into v_row;
  -- A changed rule starts afresh: what it saw before was about another sentence.
  update public.watch_runs set resolved_at = now() where rule_id = p_rule and resolved_at is null;
  return v_row;
end;
$$;

revoke execute on function public.save_watch_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.save_watch_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb, jsonb, uuid) to authenticated, service_role;

-- Invoices --------------------------------------------------------------------------------------

create table public.invoices (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  rule_id           uuid references public.watch_rules (id) on delete set null,
  group_task_id     bigint not null,
  title             text not null check (length(title) between 1 and 200),
  client_name       text not null check (length(client_name) between 1 and 120),
  client_email      text not null check (length(client_email) between 3 and 254),
  lines             jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 40),
  amount_minor      bigint not null check (amount_minor > 0),
  currency          text not null,
  status            text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'cancelled', 'failed')),
  paypal_invoice_id text unique,
  paypal_number     text,
  payer_url         text,
  message           text check (length(message) <= 500),
  created_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  sent_at           timestamptz,
  paid_at           timestamptz,
  updated_at        timestamptz not null default now()
);
create index invoices_project_idx on public.invoices (project_id, created_at);
create unique index invoices_one_per_group on public.invoices (project_id, group_task_id) where status <> 'cancelled';

alter table public.invoices enable row level security;
revoke all on table public.invoices from anon;
revoke insert, update, delete on table public.invoices from authenticated;

create policy "invoices: members who see costs can read"
  on public.invoices for select to authenticated
  using (public.is_project_member(project_id) and public.member_can_view_costs(project_id));

create trigger invoices_workflow_broadcast
  after insert or update or delete on public.invoices
  for each row execute function public.broadcast_workflow_change();

-- A person prepares the invoice: one per floor, checked to add up, billed to the project's client.
create or replace function public.prepare_invoice(
  p_project    uuid,
  p_group_task bigint,
  p_rule       uuid,
  p_title      text,
  p_lines      jsonb
)
returns public.invoices
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := public.workflow_actor('prepare_invoice');
  v_member  public.project_members := public.workflow_member(p_project, 'prepare_invoice');
  v_project public.projects;
  v_total   bigint;
  v_row     public.invoices;
begin
  if not v_member.can_view_costs then
    raise exception 'prepare_invoice: only someone who sees costs may bill the client' using errcode = '42501';
  end if;
  select p.* into v_project from public.projects p where p.id = p_project;
  if v_project.client_email is null or v_project.client_name is null then
    raise exception 'prepare_invoice: this project has no client to bill' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 40 then
    raise exception 'prepare_invoice: an invoice has 1-40 lines' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) l
     where length(coalesce(l ->> 'label', '')) not between 1 and 200
        or jsonb_typeof(l -> 'amount_minor') is distinct from 'number'
        or (l ->> 'amount_minor')::numeric <= 0
        or (l ->> 'amount_minor')::numeric <> trunc((l ->> 'amount_minor')::numeric)
  ) then
    raise exception 'prepare_invoice: each line needs a label and an amount above zero' using errcode = '22023';
  end if;
  select sum((l ->> 'amount_minor')::bigint) into v_total from jsonb_array_elements(p_lines) l;

  select i.* into v_row from public.invoices i
   where i.project_id = p_project and i.group_task_id = p_group_task and i.status <> 'cancelled';
  if found then
    return v_row;
  end if;

  insert into public.invoices (project_id, rule_id, group_task_id, title, client_name, client_email, lines, amount_minor, currency, created_by)
  values (p_project, p_rule, p_group_task, left(btrim(p_title), 200), v_project.client_name, v_project.client_email, p_lines, v_total, v_project.currency, v_uid)
  returning * into v_row;
  return v_row;
end;
$$;
revoke execute on function public.prepare_invoice(uuid, bigint, uuid, text, jsonb) from public, anon;
grant execute on function public.prepare_invoice(uuid, bigint, uuid, text, jsonb) to authenticated, service_role;

-- Who the project bills, for the invoice card.
create or replace function public.project_client(p_project uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_member public.project_members := public.workflow_member(p_project, 'project_client');
  v_row    public.projects;
begin
  select p.* into v_row from public.projects p where p.id = p_project;
  if v_row.client_name is null then return null; end if;
  return jsonb_build_object('name', v_row.client_name, 'email', case when v_member.can_view_costs then v_row.client_email end);
end;
$$;
revoke execute on function public.project_client(uuid) from public, anon;
grant execute on function public.project_client(uuid) to authenticated, service_role;

-- Reset: every rental of the project, and its invoices ----------------------------------------------

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
