-- The watch list becomes triggers (packages/shared/src/watch.ts). A rule now reads as a sentence:
-- when (every time the plan changes, or once a day at a time) if (a condition on a scope) then (show
-- it, or also ask the assistant for alternatives in a new conversation for the rule's author).
--   watch_rules.trigger  WatchTrigger: {"kind":"change"} | {"kind":"daily","at":"HH:MM"}
--   watch_rules.action   WatchAction:  {"kind":"alert"} | {"kind":"ask_assistant","note"?}
--   watch_runs           what the assistant service saw: a situation (rule + what it is about)
--                        appearing, and when it cleared. One open run per situation; the service
--                        writes them (service role), members read them.
-- A new condition: unstarted work starting within N days (`starts_soon`), for daily checks.
-- The starter rules are no longer seeded: a fresh plan raises nothing by itself, and the same rules
-- are offered as recipes in the app (WATCH_RECIPES).

alter table public.watch_rules
  add column trigger jsonb not null default '{"kind":"change"}'::jsonb check (
    jsonb_typeof(trigger) = 'object'
    and (trigger ->> 'kind' = 'change'
         or (trigger ->> 'kind' = 'daily' and coalesce(trigger ->> 'at', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'))
    and length(trigger::text) <= 200),
  add column action jsonb not null default '{"kind":"alert"}'::jsonb check (
    jsonb_typeof(action) = 'object'
    and action ->> 'kind' in ('alert', 'ask_assistant')
    and length(action::text) <= 1000);

alter table public.watch_rules drop constraint watch_rules_condition_check;
alter table public.watch_rules add constraint watch_rules_condition_check check (
  jsonb_typeof(condition) = 'object'
  and condition ->> 'kind' in ('finish_slip', 'start_slip', 'slack_below', 'over_budget', 'spent_ahead', 'in_window', 'starts_soon', 'idle_rental', 'crew_overbooked')
  and length(condition::text) <= 1000);

create table public.watch_runs (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects (id) on delete cascade,
  rule_id     uuid not null references public.watch_rules (id) on delete cascade,
  situation   text not null check (length(situation) between 1 and 200),
  fingerprint text not null check (length(fingerprint) between 1 and 200),
  severity    text not null check (severity in ('high', 'medium', 'low')),
  title       text not null check (length(title) <= 400),
  detail      text not null default '' check (length(detail) <= 1000),
  task_ids    bigint[] not null default '{}' check (cardinality(task_ids) <= 50),
  revision    bigint check (revision >= 0),
  thread_id   uuid references public.agent_threads (id) on delete set null,
  fired_at    timestamptz not null default now(),
  resolved_at timestamptz
);
create index watch_runs_project_idx on public.watch_runs (project_id, fired_at desc);
create unique index watch_runs_open_once on public.watch_runs (rule_id, situation) where resolved_at is null;

alter table public.watch_runs enable row level security;
revoke all on table public.watch_runs from anon;
revoke insert, update, delete on table public.watch_runs from authenticated;

create policy "watch_runs: members can read"
  on public.watch_runs for select to authenticated
  using (public.is_project_member(project_id));

create trigger watch_runs_workflow_broadcast
  after insert or update or delete on public.watch_runs
  for each row execute function public.broadcast_workflow_change();

-- save_watch_rule with the trigger and the action (the old signature goes).
drop function public.save_watch_rule(uuid, uuid, text, jsonb, jsonb, boolean);

create or replace function public.save_watch_rule(
  p_project   uuid,
  p_rule      uuid,
  p_name      text,
  p_scope     jsonb,
  p_condition jsonb,
  p_enabled   boolean default true,
  p_trigger   jsonb default '{"kind":"change"}'::jsonb,
  p_action    jsonb default '{"kind":"alert"}'::jsonb
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
  if p_rule is null then
    if (select count(*) from public.watch_rules r where r.project_id = p_project) >= 60 then
      raise exception 'save_watch_rule: a project keeps at most 60 rules' using errcode = '54000';
    end if;
    insert into public.watch_rules (project_id, name, scope, condition, trigger, action, enabled, created_by)
    values (p_project, v_name, p_scope, p_condition, v_trigger, v_action, coalesce(p_enabled, true), v_uid)
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
         enabled = coalesce(p_enabled, true), updated_at = now()
   where id = p_rule
  returning * into v_row;
  -- A changed rule starts afresh: what it saw before was about another sentence.
  update public.watch_runs set resolved_at = now() where rule_id = p_rule and resolved_at is null;
  return v_row;
end;
$$;

revoke execute on function public.save_watch_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb, jsonb) from public, anon;
grant execute on function public.save_watch_rule(uuid, uuid, text, jsonb, jsonb, boolean, jsonb, jsonb) to authenticated, service_role;

-- No starter rules: reset_demo calls this to clear a project's rules (their runs and dismissals go with them).
create or replace function public.seed_watch_rules(p_project uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.watch_rules where project_id = p_project;
$$;

revoke execute on function public.seed_watch_rules(uuid) from public, anon, authenticated;
grant execute on function public.seed_watch_rules(uuid) to service_role;

-- The starter rules seeded so far (they belong to nobody) go.
delete from public.watch_rules where created_by is null;
