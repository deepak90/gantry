-- Calls after the review (20261111180000_calls_hardening.sql): the spend caps fit 30 calls exactly, a session has 40
-- joins, Remy has 45 seconds to come, and LiveKit's word that she left counts the call then (remy_minutes_ended),
-- unless it is about a Remy from an earlier call.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.p() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.room() returns text language sql immutable as $$ select 'project-00000000-0000-4000-8000-000000000001-1794400000000' $$;
create function pg_temp.sent(ago interval, aside interval) returns void language sql as $$
  update public.remy_minutes set call_from = now() - ago, call_until = now() - ago + aside
   where project_id = pg_temp.p() and lease = 1794400000000;
$$;
create function pg_temp.booking() returns jsonb language sql immutable as $$ select '{"openai": 250000, "elevenlabs": 100000, "livekit": 100000}'::jsonb $$;
grant execute on function pg_temp.p(), pg_temp.room(), pg_temp.sent(interval, interval), pg_temp.booking() to service_role;

delete from public.spend_ledger where day = (now() at time zone 'utc')::date;
delete from public.spend_breaker_trips;
update public.app_flags set enabled = true where key = 'live_calls';

-- The 30th call fits; the 31st doesn't.
insert into public.spend_ledger (day, vendor, usd_micro) values
  ((now() at time zone 'utc')::date, 'openai', 29 * 250000),
  ((now() at time zone 'utc')::date, 'elevenlabs', 29 * 100000),
  ((now() at time zone 'utc')::date, 'livekit', 29 * 100000);
set local role service_role;
select is((public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'spend_short')::boolean, false, 'after 29 calls, the 30th fits');
select is(public.record_spend('elevenlabs', 100000), true, 'and record_spend takes its booking');
reset role;
update public.spend_ledger set usd_micro = 30 * 250000 where day = (now() at time zone 'utc')::date and vendor = 'openai';
update public.spend_ledger set usd_micro = 30 * 100000 where day = (now() at time zone 'utc')::date and vendor = 'livekit';
set local role service_role;
select is((public.call_readiness(pg_temp.p(), pg_temp.booking()) ->> 'spend_short')::boolean, true, 'after 30, a 31st doesn''t');
reset role;

select is((select per_copy from public.quota_limits where kind = 'call_join'), 40, 'forty joins a session');
select is(public.remy_minutes_join_grace(), interval '45 seconds', 'Remy has 45 seconds to come');

-- LiveKit's word that she left.
set local role service_role;
select public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000);
select pg_temp.sent(interval '70 seconds', interval '300 seconds');
-- About a Remy who joined well before this call: an earlier call's, nothing changes.
select is(public.remy_minutes_ended(pg_temp.p(), 1794400000000, pg_temp.room(), now() - interval '5 minutes') ->> 'used_ms', '0', 'a word about an earlier call changes nothing');
-- About another room: nothing either.
select is(public.remy_minutes_ended(pg_temp.p(), 1794400000000, 'project-other', now() - interval '60 seconds') ->> 'used_ms', '0', 'nor one about another room');
-- About this call's Remy, even within the join grace a route would wait out: counted until now.
select is(public.remy_minutes_ended(pg_temp.p(), 1794400000000, pg_temp.room(), now() - interval '65 seconds') - 'now_ms',
          '{"total_ms": 300000, "used_ms": 70000, "left_ms": 230000, "ends_at_ms": null}'::jsonb, 'her leaving counts the call: 70 seconds used');
-- A room that closed, with no word of who left.
select public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000);
select pg_temp.sent(interval '30 seconds', interval '230 seconds');
select is(public.remy_minutes_ended(pg_temp.p(), 1794400000000, pg_temp.room(), null) ->> 'used_ms', '100000', 'a closed room counts its call too');
reset role;

set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok($$select public.remy_minutes_ended(pg_temp.p(), 1794400000000, pg_temp.room(), null)$$, '42501', null, 'a browser cannot say she left');
reset role;

select * from finish();
rollback;
