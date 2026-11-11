-- A daily spend breaker for the hosted demo: what the paid services cost each day (UTC) is added up as it is spent, and
-- once a vendor's budget, or the day's total, is spent, the switches that let visitors spend more are turned off until
-- the next day.
--
--   spend_ledger         one row per day and vendor: what was spent, in millionths of a dollar
--   spend_limits         each vendor's daily budget, and the day's total ('total'), with the app_flags it turns off:
--                          anthropic   $5  live_ai      (Remy's turns and thread titles, recorded by the assistant service)
--                          openai      $2  live_calls   (call transcription)
--                          elevenlabs  $1  live_calls   (Remy's voice)
--                          livekit     $1  live_calls   (call minutes)
--                          total       $9  live_ai, live_calls
--                        Each budget is a row, so it can be changed in place.
--   spend_breaker_trips  the switches the breaker turned off, the day it did, and what their note said before
--   record_spend         adds a cost and answers whether the vendor may still spend today; turns the switches off when a
--                        budget is spent (service role)
--   reset_spend_breaker  at 00:05 UTC (pg_cron, where it is): turns back on only the switches the breaker turned off on an
--                        earlier day, and only while they still say so, never one a person turned off or touched since
--
-- Clients never read or write these tables. Safe to apply again: rows are added only where missing, functions replaced.

-- Tables -------------------------------------------------------------------------------------------------------

create table if not exists public.spend_ledger (
  day        date not null default (now() at time zone 'utc')::date,
  vendor     text not null check (vendor in ('anthropic', 'openai', 'elevenlabs', 'livekit')),
  usd_micro  bigint not null default 0 check (usd_micro >= 0),
  updated_at timestamptz not null default now(),
  primary key (day, vendor)
);

create table if not exists public.spend_limits (
  vendor          text primary key check (vendor in ('anthropic', 'openai', 'elevenlabs', 'livekit', 'total')),
  daily_usd_micro bigint not null check (daily_usd_micro >= 0),
  flags           text[] not null
);

create table if not exists public.spend_breaker_trips (
  flag        text primary key references public.app_flags (key) on delete cascade,
  day         date not null,
  note_before text,
  tripped_at  timestamptz not null default now()
);

alter table public.spend_ledger enable row level security;
alter table public.spend_limits enable row level security;
alter table public.spend_breaker_trips enable row level security;
revoke all on table public.spend_ledger, public.spend_limits, public.spend_breaker_trips from anon, authenticated;

insert into public.spend_limits (vendor, daily_usd_micro, flags) values
  ('anthropic',  5000000, '{live_ai}'),
  ('openai',     2000000, '{live_calls}'),
  ('elevenlabs', 1000000, '{live_calls}'),
  ('livekit',    1000000, '{live_calls}'),
  ('total',      9000000, '{live_ai,live_calls}')
on conflict (vendor) do nothing;

-- record_spend(vendor, usd_micro) -> true while the vendor may still spend today -------------------------------------

create or replace function public.record_spend(p_vendor text, p_usd_micro bigint)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day    date := (now() at time zone 'utc')::date;
  v_note   text := 'auto-off: daily budget ' || v_day::text;
  v_vendor bigint;
  v_total  bigint;
  v_limit  record;
  v_open   boolean := true;
begin
  if p_vendor is null or p_vendor not in ('anthropic', 'openai', 'elevenlabs', 'livekit') then
    raise exception 'record_spend: there is no vendor called %', p_vendor using errcode = '22023';
  end if;
  if p_usd_micro is null or p_usd_micro < 0 then
    raise exception 'record_spend: p_usd_micro must be 0 or more' using errcode = '22023';
  end if;

  insert into public.spend_ledger as l (day, vendor, usd_micro) values (v_day, p_vendor, p_usd_micro)
  on conflict (day, vendor) do update set usd_micro = l.usd_micro + excluded.usd_micro, updated_at = now()
  returning l.usd_micro into v_vendor;
  select coalesce(sum(l.usd_micro), 0) into v_total from public.spend_ledger l where l.day = v_day;

  for v_limit in
    select s.vendor, s.daily_usd_micro, s.flags from public.spend_limits s where s.vendor in (p_vendor, 'total')
  loop
    if (case when v_limit.vendor = 'total' then v_total else v_vendor end) >= v_limit.daily_usd_micro then
      v_open := false;
      -- Which switches this turns off, and what they said, so the reset turns on only those and gives the note back.
      insert into public.spend_breaker_trips as t (flag, day, note_before)
      select f.key, v_day, f.note from public.app_flags f where f.key = any (v_limit.flags) and f.enabled
      on conflict (flag) do update set day = excluded.day, tripped_at = now();
      update public.app_flags f set enabled = false, note = v_note where f.key = any (v_limit.flags) and f.enabled;
    end if;
  end loop;
  return v_open;
end;
$$;

-- reset_spend_breaker() -> how many switches it turned back on --------------------------------------------------

create or replace function public.reset_spend_breaker()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_count int;
begin
  -- A switch is turned back on when the breaker turned it off on an earlier day and it still says so: one a person
  -- turned off, or touched since, stays as they left it.
  with back_on as (
    update public.app_flags f
       set enabled = true, note = t.note_before
      from public.spend_breaker_trips t
     where t.flag = f.key
       and t.day < v_today
       and not f.enabled
       and f.note is not distinct from ('auto-off: daily budget ' || t.day::text)
    returning f.key
  )
  select count(*) into v_count from back_on;
  delete from public.spend_breaker_trips t where t.day < v_today;
  return v_count;
end;
$$;

revoke execute on function public.record_spend(text, bigint) from public, anon, authenticated;
revoke execute on function public.reset_spend_breaker() from public, anon, authenticated;
grant execute on function public.record_spend(text, bigint) to service_role;
grant execute on function public.reset_spend_breaker() to service_role;

-- The reset, at 00:05 UTC every day (pg_cron, where it is). Without it, the switches stay off until someone runs
-- `select public.reset_spend_breaker()` (or turns them on by hand) on a new day.
do $$
begin
  if to_regnamespace('cron') is null then
    raise notice 'pg_cron is not here: run select public.reset_spend_breaker() on a new day (UTC) to turn back on what the spend breaker turned off';
    return;
  end if;
  perform cron.schedule('spend-breaker-reset', '5 0 * * *', 'select public.reset_spend_breaker()');
exception when others then
  raise notice 'pg_cron could not schedule the spend breaker reset: %', sqlerrm;
end;
$$;

notify pgrst, 'reload schema';
