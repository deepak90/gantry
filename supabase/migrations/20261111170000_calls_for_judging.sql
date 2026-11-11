-- Calls with Remy for judging: 30 a day across the site, and what that takes; and whether a call could start now, so
-- the page greys its button before anyone presses it.
--
-- The site took 15 calls a day, and its spend caps were sized to match: each call books $0.25 of OpenAI, $0.10 of
-- ElevenLabs and $0.10 of LiveKit (DISPATCH_SPEND in apps/web/call-hosted.ts), so ElevenLabs' $1.50 ran out at the
-- 15th. A day of testing used all 15 (2026-11-11). For judging, 30 a day, the caps raised to match, and Remy's turns
-- with them (15 calls and the chat used 161 of 250). A session's calls are limited by its five minutes with Remy
-- (remy_minutes) and its joins, no longer by a count of starts as well, which could refuse a call with minutes left:
--
--   call_start   30 a day, none a session (was 2)
--   ai_turn      500 a day (40 a session, as before)
--   spend        OpenAI $7.50, ElevenLabs $3, LiveKit $3, Anthropic $15, $28.50 a day in all
--
--   quota_parts     what is left of a quota: the copy's and the day's, apart
--   call_readiness  what a call needs, as it stands: whether calls are on (and whether the spend breaker turned them
--                   off), the session's and the day's starts, joins and turns left, when the session last started one,
--                   and whether a call's booking still fits today's spend. The call routes decide from it, and tell
--                   the page why a call can't start before anyone presses the button (service role).

update public.quota_limits set per_copy = null, per_day = 30 where kind = 'call_start';
update public.quota_limits set per_day = 500 where kind = 'ai_turn';
update public.spend_limits set daily_usd_micro = 7500000 where vendor = 'openai';
update public.spend_limits set daily_usd_micro = 3000000 where vendor in ('elevenlabs', 'livekit');
update public.spend_limits set daily_usd_micro = 15000000 where vendor = 'anthropic';
update public.spend_limits set daily_usd_micro = 28500000 where vendor = 'total';

-- quota_parts(kind, project) -> {copy_left, day_left}: null where that limit isn't set (or there is no project).
create or replace function public.quota_parts(p_kind text, p_project uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select jsonb_build_object(
      'copy_left', case when l.per_copy is null or p_project is null then null
                        else greatest(0, l.per_copy - coalesce((select u.used from public.quota_usage u where u.kind = l.kind and u.project_id = p_project), 0)) end,
      'day_left', case when l.per_day is null then null
                       else greatest(0, l.per_day - coalesce((select u.used from public.quota_usage u where u.kind = l.kind and u.day = (now() at time zone 'utc')::date), 0)) end)
      from public.quota_limits l where l.kind = p_kind), '{"copy_left": null, "day_left": null}'::jsonb)
$$;
revoke execute on function public.quota_parts(text, uuid) from public, anon, authenticated;
grant execute on function public.quota_parts(text, uuid) to service_role;

-- call_readiness(project, booking) -> what a call needs, as it stands. `booking` is what a call books against the day's
-- spend, by vendor in millionths of a dollar ({"openai": 250000, ...}). record_spend closes a vendor once what it spent
-- reaches its budget, refusing the booking that reached it: a call fits while its booking leaves every vendor it books,
-- and the day's total, under budget.
create or replace function public.call_readiness(p_project uuid, p_booking jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_day     date := (now() at time zone 'utc')::date;
  v_booking jsonb := coalesce(p_booking, '{}'::jsonb);
  v_spent   bigint;
  v_adds    bigint;
  v_short   boolean;
begin
  select coalesce(sum(s.usd_micro), 0) into v_spent from public.spend_ledger s where s.day = v_day;
  select coalesce(sum(b.value::bigint), 0) into v_adds from jsonb_each_text(v_booking) b;
  select exists (
           select 1
             from jsonb_each_text(v_booking) b
             join public.spend_limits l on l.vendor = b.key
             left join public.spend_ledger s on s.vendor = b.key and s.day = v_day
            where coalesce(s.usd_micro, 0) + b.value::bigint >= l.daily_usd_micro)
      or exists (select 1 from public.spend_limits l where l.vendor = 'total' and v_spent + v_adds >= l.daily_usd_micro)
    into v_short;
  return jsonb_build_object(
    'calls_on', coalesce((select f.enabled from public.app_flags f where f.key = 'live_calls'), false),
    'breaker', exists (select 1 from public.spend_breaker_trips t where t.flag = 'live_calls'),
    'starts', public.quota_parts('call_start', p_project),
    'joins', public.quota_parts('call_join', p_project),
    'turns', public.quota_parts('ai_turn', p_project),
    'last_start_ms', (select floor(extract(epoch from u.updated_at) * 1000)::bigint from public.quota_usage u
                       where u.kind = 'call_start' and u.project_id = p_project and u.used > 0),
    'spend_short', v_short);
end;
$$;
revoke execute on function public.call_readiness(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.call_readiness(uuid, jsonb) to service_role;
