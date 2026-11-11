-- Kill switches and quotas for the hosted demo.
--
--   app_flags      one switch per live service (live_ai, live_calls, live_payments): anyone can read them, the
--                  service role alone turns them on or off
--   quota_limits   how much of a costly thing one copy of the demo may use, and the whole demo in a day (UTC);
--                  null means no limit of that kind
--   quota_usage    what has been used so far: one row per kind and copy (cleared when the copy is reset) and one
--                  row per kind and day
--   use_quota      checks and counts a use in one step, for the services that pay for it (service role)

-- Switches -----------------------------------------------------------------------------------------------------

create table public.app_flags (
  key     text primary key check (key ~ '^[a-z][a-z0-9_]{0,62}$'),
  enabled boolean not null,
  note    text check (length(note) <= 500)
);

alter table public.app_flags enable row level security;
revoke all on table public.app_flags from anon, authenticated;
grant select on table public.app_flags to anon, authenticated;

create policy "app_flags: anyone can read"
  on public.app_flags for select to anon, authenticated
  using (true);

insert into public.app_flags (key, enabled, note) values
  ('live_ai', true, 'Remy, the assistant, answers with the live model.'),
  ('live_calls', true, 'Voice calls with Remy can start.'),
  ('live_payments', true, 'Payouts and invoices go to the PayPal sandbox.')
on conflict (key) do nothing;

-- Quotas -------------------------------------------------------------------------------------------------------

create table public.quota_limits (
  kind     text primary key check (kind ~ '^[a-z][a-z0-9_]{0,62}$'),
  per_copy int check (per_copy >= 0),
  per_day  int check (per_day >= 0)
);

-- A row counts either one copy's use (project_id) or the whole demo's on one day (day), never both.
create table public.quota_usage (
  kind       text not null references public.quota_limits (kind) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  day        date,
  used       int not null default 0 check (used >= 0),
  updated_at timestamptz not null default now(),
  constraint quota_usage_one_scope check ((project_id is null) <> (day is null))
);
create unique index quota_usage_per_copy on public.quota_usage (kind, project_id) where project_id is not null;
create unique index quota_usage_per_day on public.quota_usage (kind, day) where day is not null;

alter table public.quota_limits enable row level security;
alter table public.quota_usage enable row level security;
revoke all on table public.quota_limits, public.quota_usage from anon, authenticated;

insert into public.quota_limits (kind, per_copy, per_day) values
  ('ai_turn', 40, 2000),
  ('call_start', 3, 60)
on conflict (kind) do nothing;

-- use_quota: true when p_amount more of p_kind fits under both limits, and then counts it; false (counting
-- nothing) when either limit would be passed. p_project null counts toward the day alone.
create or replace function public.use_quota(p_kind text, p_project uuid, p_amount int default 1)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit public.quota_limits;
  v_day   date := (now() at time zone 'utc')::date;
  v_daily int;
  v_copy  int;
begin
  if p_amount is null or p_amount < 1 then
    raise exception 'use_quota: p_amount must be 1 or more' using errcode = '22023';
  end if;
  select l.* into v_limit from public.quota_limits l where l.kind = p_kind;
  if not found then
    raise exception 'use_quota: there is no quota called %', p_kind using errcode = '22023';
  end if;
  if p_project is not null and not exists (select 1 from public.projects p where p.id = p_project) then
    raise exception 'use_quota: there is no project %', p_project using errcode = '22023';
  end if;

  -- Both counters exist before either is locked, and the day's is always locked before the copy's, so two calls
  -- never wait on each other the opposite way round.
  insert into public.quota_usage (kind, day) values (p_kind, v_day)
  on conflict (kind, day) where day is not null do nothing;
  if p_project is not null then
    insert into public.quota_usage (kind, project_id) values (p_kind, p_project)
    on conflict (kind, project_id) where project_id is not null do nothing;
  end if;
  select u.used into v_daily from public.quota_usage u where u.kind = p_kind and u.day = v_day for update;
  if p_project is not null then
    select u.used into v_copy from public.quota_usage u where u.kind = p_kind and u.project_id = p_project for update;
  end if;

  if (v_limit.per_day is not null and v_daily::bigint + p_amount > v_limit.per_day)
     or (p_project is not null and v_limit.per_copy is not null and v_copy::bigint + p_amount > v_limit.per_copy) then
    return false;
  end if;

  update public.quota_usage set used = used + p_amount, updated_at = now() where kind = p_kind and day = v_day;
  if p_project is not null then
    update public.quota_usage set used = used + p_amount, updated_at = now() where kind = p_kind and project_id = p_project;
  end if;
  return true;
end;
$$;
revoke execute on function public.use_quota(text, uuid, int) from public, anon, authenticated;
grant execute on function public.use_quota(text, uuid, int) to service_role;
