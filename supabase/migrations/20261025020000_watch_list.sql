-- The watch list (packages/shared/src/watch.ts): rules a project keeps about what deserves a look,
-- and the alerts people dismissed. Rules are checked in each browser against the live plan (no
-- model involved), so everyone sees the same alerts; a dismissal is shared too.
--   watch_rules       what to watch (the whole plan, some tasks and everything under them, the work
--                     in a date window, a crew) and when to speak up (finish or start later than
--                     planned, little slack, over budget, money spent ahead of the work, work falling
--                     in a date window, rented equipment paid while idle, a crew booked twice).
--                     Any member adds a rule; its author or a project manager changes or removes it
--                     (the starter rules belong to the project managers).
--   watch_dismissals  an alert (rule + fingerprint) somebody dismissed; a new situation (a bigger slip,
--                     another task) has a new fingerprint and alerts again.
-- Both tables announce changes on project:<id>:workflow, so open plans reload them with the workflow.

create table public.watch_rules (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 120),
  -- WatchScope: {"kind":"plan"|"tasks"|"dates"|"crew", ...}
  scope      jsonb not null check (jsonb_typeof(scope) = 'object' and scope ->> 'kind' in ('plan', 'tasks', 'dates', 'crew') and length(scope::text) <= 4000),
  -- WatchCondition: {"kind": ..., thresholds}
  condition  jsonb not null check (
    jsonb_typeof(condition) = 'object'
    and condition ->> 'kind' in ('finish_slip', 'start_slip', 'slack_below', 'over_budget', 'spent_ahead', 'in_window', 'idle_rental', 'crew_overbooked')
    and length(condition::text) <= 1000),
  enabled    boolean not null default true,
  -- Null for the starter rules.
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index watch_rules_project_id_idx on public.watch_rules (project_id, created_at);

create table public.watch_dismissals (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  rule_id      uuid not null references public.watch_rules (id) on delete cascade,
  fingerprint  text not null check (length(fingerprint) between 1 and 200),
  dismissed_by uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint watch_dismissals_once unique (rule_id, fingerprint)
);
create index watch_dismissals_project_id_idx on public.watch_dismissals (project_id);

alter table public.watch_rules enable row level security;
alter table public.watch_dismissals enable row level security;
revoke all on table public.watch_rules, public.watch_dismissals from anon;
revoke insert, update, delete on table public.watch_rules, public.watch_dismissals from authenticated;

create policy "watch_rules: members can read"
  on public.watch_rules for select to authenticated
  using (public.is_project_member(project_id));

create policy "watch_dismissals: members can read"
  on public.watch_dismissals for select to authenticated
  using (public.is_project_member(project_id));

-- -------------------------------------------------------------------------------------------
-- Writes
-- -------------------------------------------------------------------------------------------

-- Adds a rule (p_rule null) or changes one (its author, or a project manager).
create or replace function public.save_watch_rule(
  p_project   uuid,
  p_rule      uuid,
  p_name      text,
  p_scope     jsonb,
  p_condition jsonb,
  p_enabled   boolean default true
)
returns public.watch_rules
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := public.workflow_actor('save_watch_rule');
  v_member public.project_members := public.workflow_member(p_project, 'save_watch_rule');
  v_name   text := btrim(coalesce(p_name, ''), E' \t\r\n');
  v_row    public.watch_rules;
begin
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'save_watch_rule: a name is 1-120 characters' using errcode = '22023';
  end if;
  if p_rule is null then
    if (select count(*) from public.watch_rules r where r.project_id = p_project) >= 60 then
      raise exception 'save_watch_rule: a project keeps at most 60 rules' using errcode = '54000';
    end if;
    insert into public.watch_rules (project_id, name, scope, condition, enabled, created_by)
    values (p_project, v_name, p_scope, p_condition, coalesce(p_enabled, true), v_uid)
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
     set name = v_name, scope = p_scope, condition = p_condition, enabled = coalesce(p_enabled, true), updated_at = now()
   where id = p_rule
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function public.delete_watch_rule(p_rule uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.workflow_actor('delete_watch_rule');
  v_row public.watch_rules;
begin
  select r.* into v_row from public.watch_rules r where r.id = p_rule and public.is_project_member(r.project_id);
  if not found then
    raise exception 'delete_watch_rule: rule % not found', p_rule using errcode = 'P0002';
  end if;
  if v_row.created_by is distinct from v_uid and public.member_role(v_row.project_id) is distinct from 'pm' then
    raise exception 'delete_watch_rule: only the person who made the rule or a project manager may remove it' using errcode = '42501';
  end if;
  delete from public.watch_rules where id = p_rule;
  return p_rule;
end;
$$;

-- Any member dismisses an alert for everyone; dismissing it again is harmless.
create or replace function public.dismiss_watch_alert(p_rule uuid, p_fingerprint text)
returns public.watch_dismissals
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := public.workflow_actor('dismiss_watch_alert');
  v_rule public.watch_rules;
  v_row  public.watch_dismissals;
begin
  select r.* into v_rule from public.watch_rules r where r.id = p_rule and public.is_project_member(r.project_id);
  if not found then
    raise exception 'dismiss_watch_alert: rule % not found', p_rule using errcode = 'P0002';
  end if;
  if p_fingerprint is null or length(p_fingerprint) not between 1 and 200 then
    raise exception 'dismiss_watch_alert: the fingerprint is 1-200 characters' using errcode = '22023';
  end if;
  insert into public.watch_dismissals (project_id, rule_id, fingerprint, dismissed_by)
  values (v_rule.project_id, p_rule, p_fingerprint, v_uid)
  on conflict on constraint watch_dismissals_once do nothing;
  select d.* into v_row from public.watch_dismissals d where d.rule_id = p_rule and d.fingerprint = p_fingerprint;
  return v_row;
end;
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'save_watch_rule(uuid,uuid,text,jsonb,jsonb,boolean)', 'delete_watch_rule(uuid)', 'dismiss_watch_alert(uuid,text)'
  ] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end;
$$;

create trigger watch_rules_workflow_broadcast
  after insert or update or delete on public.watch_rules
  for each row execute function public.broadcast_workflow_change();

create trigger watch_dismissals_workflow_broadcast
  after insert or update or delete on public.watch_dismissals
  for each row execute function public.broadcast_workflow_change();

-- -------------------------------------------------------------------------------------------
-- The starter rules: what the team would want watched from day one.
-- -------------------------------------------------------------------------------------------
create or replace function public.seed_watch_rules(p_project uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handover bigint := (select p.handover_task_id from public.projects p where p.id = p_project);
begin
  delete from public.watch_rules where project_id = p_project;
  insert into public.watch_rules (project_id, name, scope, condition) values
    (p_project, 'Rented equipment paid while it stands idle', '{"kind":"plan"}', '{"kind":"idle_rental"}'),
    (p_project, 'Work 10% or more over budget', '{"kind":"plan"}', '{"kind":"over_budget","percent":10}'),
    (p_project, 'A crew booked on two tasks at once', '{"kind":"plan"}', '{"kind":"crew_overbooked"}');
  if v_handover is not null then
    insert into public.watch_rules (project_id, name, scope, condition)
    values (p_project, 'The handover finishes later than planned', jsonb_build_object('kind', 'tasks', 'task_ids', jsonb_build_array(v_handover)), '{"kind":"finish_slip","days":0}');
  end if;
end;
$$;

revoke execute on function public.seed_watch_rules(uuid) from public, anon, authenticated;
grant execute on function public.seed_watch_rules(uuid) to service_role;

select public.seed_watch_rules(p.id) from public.projects p;

-- -------------------------------------------------------------------------------------------
-- reset_demo, as in 20261025010000_assistant_threads.sql, now also restoring the starter rules.
-- -------------------------------------------------------------------------------------------
create or replace function public.reset_demo(p_project uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_seed    public.demo_seeds;
  v_objects jsonb;
begin
  select d.* into v_seed from public.demo_seeds d where d.project_id = p_project;
  if not found then
    raise exception 'reset_demo: no seed stored for project % (run `pnpm db:reset` once)', p_project using errcode = 'P0002';
  end if;

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
