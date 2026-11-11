-- Remy's minutes (20261111150000_remy_minutes.sql): one pool of call time with Remy per visit to a copy, five minutes,
-- shared by everyone on the visit. A call sets aside what is left, and counts from when Remy was sent until she is seen
-- gone (or in full, once its time ran out); while she may still be on her way she isn't counted gone, and sent again
-- in that time she gets the same call. A visit with too little left gets no call; the next visit starts afresh. Only
-- the service role keeps the minutes. quota_left says how many uses of a quota are left for a copy, the day included.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create function pg_temp.p() returns uuid language sql immutable as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
create function pg_temp.room() returns text language sql immutable as $$ select 'project-00000000-0000-4000-8000-000000000001-1794400000000' $$;
-- Moves the visit's call back in time: sent `ago` before now, with `aside` set aside for it.
create function pg_temp.sent(ago interval, aside interval) returns void language sql as $$
  update public.remy_minutes set call_from = now() - ago, call_until = now() - ago + aside
   where project_id = pg_temp.p() and lease = 1794400000000;
$$;
grant execute on function pg_temp.p(), pg_temp.room(), pg_temp.sent(interval, interval) to service_role;

-- Browsers can't read or keep them ---------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-4000-8000-000000000012","role":"authenticated"}';
select throws_ok($$select public.remy_minutes_now(pg_temp.p(), 1794400000000, false)$$, '42501', null, 'a browser cannot read the minutes');
select throws_ok($$select public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000)$$, '42501', null, 'a browser cannot start a call');
select throws_ok($$select public.quota_left('ai_turn', pg_temp.p())$$, '42501', null, 'a browser cannot read the quotas');
select throws_ok($$select * from public.remy_minutes$$, '42501', null, 'a browser cannot read the table');
reset role;

set local role service_role;

-- A new visit: five minutes, no call -------------------------------------------------------------------------------
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, false) - 'now_ms',
          '{"total_ms": 300000, "used_ms": 0, "left_ms": 300000, "ends_at_ms": null}'::jsonb, 'a new visit has five minutes and no call');

-- A call sets aside all that is left -------------------------------------------------------------------------------
select is((public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ok')::boolean, true, 'a call starts');
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, false) ->> 'ends_at_ms',
          floor(extract(epoch from now() + interval '300 seconds') * 1000)::bigint::text, 'its end is when the five minutes run out');
select is((public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ends_at_ms'),
          floor(extract(epoch from now() + interval '300 seconds') * 1000)::bigint::text,
          'sent again while she may be on her way: the same call, not a second share');
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, true) ->> 'used_ms', '0', 'not counted gone while she may still be on her way');

-- A minute in, she is seen gone: a minute is counted, the rest goes back --------------------------------------------
select pg_temp.sent(interval '60 seconds', interval '300 seconds');
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, false) - 'now_ms',
          jsonb_build_object('total_ms', 300000, 'used_ms', 0, 'left_ms', 240000,
                             'ends_at_ms', floor(extract(epoch from now() + interval '240 seconds') * 1000)::bigint),
          'while the call goes on, what is left runs down to its end');
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, true) - 'now_ms',
          '{"total_ms": 300000, "used_ms": 60000, "left_ms": 240000, "ends_at_ms": null}'::jsonb,
          'seen gone a minute in: that minute is used, four are left');

-- The next call gets the four minutes; once they run out, they are all counted --------------------------------------
select is(public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ends_at_ms',
          floor(extract(epoch from now() + interval '240 seconds') * 1000)::bigint::text, 'the next call gets what is left');
select pg_temp.sent(interval '300 seconds', interval '240 seconds');
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, false) - 'now_ms',
          '{"total_ms": 300000, "used_ms": 300000, "left_ms": 0, "ends_at_ms": null}'::jsonb,
          'a call whose time ran out is counted in full, whoever looked');
select is(public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ok', 'false', 'nothing left: no call');

-- Too little left for a call ---------------------------------------------------------------------------------------
update public.remy_minutes set used_ms = 290000 where project_id = pg_temp.p() and lease = 1794400000000;
select is(public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ok', 'false', 'ten seconds left is too little for a call');
select is(public.remy_minutes_now(pg_temp.p(), 1794400000000, false) ->> 'left_ms', '10000', 'and the ten seconds stay');

-- A call started before a route saw the last one end: that one is counted until now ------------------------------
update public.remy_minutes set used_ms = 0 where project_id = pg_temp.p() and lease = 1794400000000;
select is(public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ok', 'true', 'a fresh call starts');
select pg_temp.sent(interval '90 seconds', interval '300 seconds');
select is(public.remy_minutes_start(pg_temp.p(), 1794400000000, pg_temp.room(), 15000) ->> 'ends_at_ms',
          floor(extract(epoch from now() + interval '210 seconds') * 1000)::bigint::text, 'the call before is counted, and the new one gets the rest');

-- The next visit starts afresh, and the copy's earlier visits are dropped ------------------------------------------
select is(public.remy_minutes_start(pg_temp.p(), 1794400999000, 'project-00000000-0000-4000-8000-000000000001-1794400999000', 15000) ->> 'left_ms',
          '300000', 'the next visit gets five minutes of its own');
select is((select count(*)::int from public.remy_minutes where project_id = pg_temp.p()), 1, 'the earlier visit is dropped');

-- The pool's size is a row --------------------------------------------------------------------------------------
update public.quota_limits set per_copy = 600 where kind = 'remy_second';
select is(public.remy_minutes_now(pg_temp.p(), 1794401000000, false) ->> 'total_ms', '600000', 'quota_limits sets the pool');

-- quota_left: the copy's limit and the day's ----------------------------------------------------------------------
update public.quota_limits set per_copy = 40, per_day = 250 where kind = 'ai_turn';
delete from public.quota_usage where kind = 'ai_turn' and (project_id = pg_temp.p() or day = (now() at time zone 'utc')::date);
insert into public.quota_usage (kind, project_id, used) values ('ai_turn', pg_temp.p(), 35);
select is(public.quota_left('ai_turn', pg_temp.p()), 5, 'forty a copy, thirty-five used: five left');
insert into public.quota_usage (kind, day, used) values ('ai_turn', (now() at time zone 'utc')::date, 248);
select is(public.quota_left('ai_turn', pg_temp.p()), 2, 'the day has two left: two');
select is(public.quota_left('remy_second', null), null, 'a quota with no limit for it: null');
reset role;

select * from finish();
rollback;
