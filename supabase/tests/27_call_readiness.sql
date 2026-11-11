-- Calls for judging (20261111170000_calls_for_judging.sql): 30 calls and 500 turns a day, the spend caps raised to
-- match, and what a call needs as it stands (call_readiness): the session's and the day's starts, joins and turns
-- left, when the session last started one, whether calls are on and whether the breaker turned them off, and whether
-- a call's booking still fits today's spend. Only the service role reads it.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.p() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.booking() returns jsonb language sql immutable as $$ select '{"openai": 250000, "elevenlabs": 100000, "livekit": 100000}'::jsonb $$;
grant execute on function pg_temp.p(), pg_temp.booking() to service_role;

select is((select per_day from public.quota_limits where kind = 'call_start'), 30, 'thirty calls a day');
select is((select per_copy from public.quota_limits where kind = 'call_start'), null, 'no count of starts a session: its minutes limit it');
select is((select per_day from public.quota_limits where kind = 'ai_turn'), 500, 'five hundred turns a day');
select is((select jsonb_object_agg(vendor, daily_usd_micro) from public.spend_limits),
          '{"openai": 7500000, "elevenlabs": 3000000, "livekit": 3000000, "anthropic": 15000000, "total": 28500000}'::jsonb,
          'the spend caps fit thirty calls');

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok($$select public.call_readiness(pg_temp.p(), pg_temp.booking())$$, '42501', null, 'a browser cannot read it');
reset role;

-- A quiet day: everything left, calls on.
delete from public.quota_usage where kind in ('call_start', 'call_join', 'ai_turn') and (project_id = pg_temp.p() or day = (now() at time zone 'utc')::date);
delete from public.spend_ledger where day = (now() at time zone 'utc')::date;
delete from public.spend_breaker_trips;
update public.app_flags set enabled = true where key = 'live_calls';

set local role service_role;
select is(public.call_readiness(pg_temp.p(), pg_temp.booking()),
          '{"calls_on": true, "breaker": false, "starts": {"copy_left": null, "day_left": 30}, "joins": {"copy_left": 20, "day_left": 300},
            "turns": {"copy_left": 40, "day_left": 500}, "last_start_ms": null, "spend_short": false}'::jsonb,
          'a quiet day: all of it left');
reset role;

-- The session started one, the day used most of its calls, and the session's turns run low.
insert into public.quota_usage (kind, project_id, used, updated_at) values ('call_start', pg_temp.p(), 1, now() - interval '12 minutes');
insert into public.quota_usage (kind, day, used) values ('call_start', (now() at time zone 'utc')::date, 30);
insert into public.quota_usage (kind, project_id, used) values ('ai_turn', pg_temp.p(), 37);
set local role service_role;
select is(public.call_readiness(pg_temp.p(), pg_temp.booking()) -> 'starts', '{"copy_left": null, "day_left": 0}'::jsonb, 'the day''s calls are used up');
select is(public.call_readiness(pg_temp.p(), pg_temp.booking()) -> 'turns', '{"copy_left": 3, "day_left": 500}'::jsonb, 'the session has three turns left');
select is((public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'last_start_ms')::bigint,
          floor(extract(epoch from now() - interval '12 minutes') * 1000)::bigint, 'and says when the session last started one');
reset role;

-- Spend: a call fits while its booking leaves every vendor, and the day, under budget.
insert into public.spend_ledger (day, vendor, usd_micro) values ((now() at time zone 'utc')::date, 'elevenlabs', 2900000);
set local role service_role;
select is((public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'spend_short')::boolean, true, 'ElevenLabs would reach its $3: no room for a call');
reset role;
update public.spend_ledger set usd_micro = 2899999 where day = (now() at time zone 'utc')::date and vendor = 'elevenlabs';
set local role service_role;
select is((public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'spend_short')::boolean, false, 'a millionth under: it fits');
reset role;
insert into public.spend_ledger (day, vendor, usd_micro) values ((now() at time zone 'utc')::date, 'anthropic', 25200000);
set local role service_role;
select is((public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'spend_short')::boolean, true, 'the day''s total would reach $28.50');
reset role;

-- Calls off, by the breaker or by a person.
update public.app_flags set enabled = false where key = 'live_calls';
set local role service_role;
select is(public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'calls_on', 'false', 'calls off');
select is(public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'breaker', 'false', 'by a person');
reset role;
insert into public.spend_breaker_trips (flag, day, note_before) values ('live_calls', (now() at time zone 'utc')::date, null);
set local role service_role;
select is(public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'breaker', 'true', 'or by the spend breaker');
select is(public.quota_parts('remy_second', null), '{"copy_left": null, "day_left": null}'::jsonb, 'a quota with no limit for it: nothing to count');
select is(public.quota_parts('no_such_quota', pg_temp.p()), '{"copy_left": null, "day_left": null}'::jsonb, 'nor one there is no row for');
reset role;

select * from finish();
rollback;
