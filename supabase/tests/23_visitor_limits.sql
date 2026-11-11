-- Limits per person and per network on the hosted demo (20261111040000_visitor_limits.sql). Which address counts: the
-- one Cloudflare saw, else the one the nearest proxy added, never what the client wrote, and none for a private
-- address or the service role. The gate counts each step and refuses past a limit, saying when the next one fits.
-- A sign-in claims one session, ever (re-opening it is no claim); a network starts one every 2 minutes, 5 an hour,
-- 15 a day, and holds 2 at once; the longest wait is the one told. Joins: 3 an hour per person, 10 per network.
-- Wrong codes: 20 an hour per network. Messages to Remy: 10 a minute per person, 60 an hour per network. The
-- limits are rows, changed in place. Idle anonymous sign-ins are deleted after a day, unless they hold a copy or sit
-- in an open one, and what refers to them follows. Each visitor's network is set the way PostgREST tells the
-- database, in request.headers.
begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

create temporary table t (k text primary key, v jsonb);
grant all on t to anon, authenticated, service_role;

-- Visitors 1 to 99: anonymous accounts, as Supabase Auth makes them.
create function pg_temp.visitor(n int) returns uuid language sql immutable as $$
  select ('00000000-0000-4000-8000-0000000d00' || lpad(n::text, 2, '0'))::uuid;
$$;
insert into auth.users (instance_id, id, aud, role, created_at, updated_at, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', pg_temp.visitor(n), 'authenticated', 'authenticated', now(), now(), false, true
  from generate_series(1, 89) n;

-- Who is asking, from which network.
create function pg_temp.be(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.headers(p jsonb) returns void language sql as $$
  select set_config('request.headers', p::text, true);
$$;
create function pg_temp.at(p_ip text) returns void language sql as $$
  select set_config('request.headers', case when p_ip is null then '{}' else json_build_object('cf-connecting-ip', p_ip)::text end, true);
$$;
create function pg_temp.got(k text) returns jsonb language sql stable as $$ select v from t where t.k = got.k $$;
create function pg_temp.project_of(k text) returns uuid language sql stable as $$ select (v ->> 'project_id')::uuid from t where t.k = project_of.k $$;
create function pg_temp.token_of(k text) returns text language sql stable as $$ select v ->> 'join_token' from t where t.k = token_of.k $$;
create function pg_temp.code_of(k text) returns text language sql stable as $$ select v ->> 'join_code' from t where t.k = code_of.k $$;
-- What a statement was refused with: its code, words, detail and hint; null when it went through.
create function pg_temp.refusal(p_sql text) returns jsonb language plpgsql as $$
declare
  v_code text;
  v_message text;
  v_detail text;
  v_hint text;
begin
  execute p_sql;
  return null;
exception when others then
  get stacked diagnostics v_code = returned_sqlstate, v_message = message_text, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
  return jsonb_build_object('code', v_code, 'message', v_message, 'detail', v_detail, 'hint', v_hint);
end;
$$;
-- Time passes for a network's (or a person's) recorded steps.
create function pg_temp.earlier(p_kind text, p_ip text, p_by interval) returns void language sql as $$
  update public.visitor_events set at = at - p_by where kind = p_kind and ip = p_ip::inet;
$$;
grant execute on function pg_temp.visitor(int), pg_temp.be(uuid), pg_temp.headers(jsonb), pg_temp.at(text), pg_temp.got(text),
  pg_temp.project_of(text), pg_temp.token_of(text), pg_temp.code_of(text), pg_temp.refusal(text) to anon, authenticated, service_role;

-- The local database is shared: start from a free pool and nothing counted, whatever ran before (rolled back after).
select public.free_copy(c.project_id) from public.copy_pool c where c.claimed_at is not null;
delete from public.visitor_events;
delete from public.copy_code_misses;

-- The limits, as rows ----------------------------------------------------------------------------------------------
select results_eq(
  $$select kind, user_max, user_window, ip_max, ip_window from public.visitor_limits
     where kind in ('claim_gap', 'claim_hour', 'claim_day', 'claim_held', 'join', 'code_miss', 'message') order by kind$$,
  $$values ('claim_day', null::int, null::interval, 15, interval '24 hours'), ('claim_gap', null, null, 1, interval '2 minutes'),
           ('claim_held', null, null, 2, null), ('claim_hour', null, null, 5, interval '1 hour'),
           ('code_miss', 8, interval '10 minutes', 20, interval '1 hour'), ('join', 3, interval '1 hour', 10, interval '1 hour'),
           ('message', 10, interval '1 minute', 60, interval '1 hour')$$,
  'a network starts a session every 2 minutes at most, 5 an hour, 15 a day, and holds 2; joins, wrong codes and messages per person and per network');
select results_eq($$select kind, per_copy, per_day from public.quota_limits order by kind$$,
  $$values ('ai_turn', 40, 250), ('call_join', 20, 300), ('call_start', 2, 15), ('invoice', 3, 60), ('payout', 3, 30), ('payout_minor', 6000000, 15000000)$$,
  'and the quotas: Remy''s turns (40 a visit since 20261111130000_call_allowances.sql), calls, call tokens, invoices, payouts and what they pay');

-- Whose address -------------------------------------------------------------------------------------------------------
select is(public.visitor_address('203.0.113.7'), '203.0.113.7'::inet, 'a public address counts as itself');
select is(public.visitor_address(' 203.0.113.7 '), '203.0.113.7'::inet, 'spaces aside');
select is(public.visitor_address('2001:db8:1:2:3:4:5:6'), '2001:db8:1:2::/64'::inet, 'IPv6 counts by its /64, the block one subscriber gets');
select is(public.visitor_address('::ffff:203.0.113.9'), '203.0.113.9'::inet, 'an IPv4 address written the IPv6 way counts as itself');
select is((select count(*)::int from unnest(array['10.0.0.1', '172.20.0.1', '192.168.65.1', '127.0.0.1', '100.64.0.1', '169.254.1.1', '0.0.0.0',
                                                  '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', 'nonsense', '203.0.113.7:443', '', null]) a
            where public.visitor_address(a) is not null), 0,
  'a private, local or shared address, or anything that is not an address, is none');

select pg_temp.headers('{"cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 203.0.113.7"}');
select is(public.request_ip(), '203.0.113.7'::inet, 'the address Cloudflare saw comes first');
select pg_temp.headers('{"x-forwarded-for": "198.51.100.1, 203.0.113.8"}');
select is(public.request_ip(), '203.0.113.8'::inet, 'else the one the nearest proxy added to X-Forwarded-For');
select pg_temp.headers('{"x-forwarded-for": "198.51.100.1, 192.168.65.1", "x-real-ip": "192.168.65.1"}');
select is(public.request_ip(), null, 'never the first entry, which the client writes: here the local stack''s own address, which is none');
select pg_temp.headers('{"cf-connecting-ip": "10.0.0.5", "x-forwarded-for": "10.0.0.5"}');
select is(public.request_ip(), null, 'a private address is none');
select pg_temp.headers('{"cf-connecting-ip": "not an address", "x-forwarded-for": "203.0.113.9"}');
select is(public.request_ip(), '203.0.113.9'::inet, 'a header that is not an address is passed over');
select pg_temp.headers('{}');
select is(public.request_ip(), null, 'no headers, no address');
select set_config('request.headers', '', true);
select is(public.request_ip(), null, 'nor without request.headers at all, as in a database session');
select pg_temp.at('203.0.113.7');
select set_config('request.jwt.claims', '{"role": "service_role"}', true);
select is(public.request_ip(), null, 'the service role''s address is its own server''s, no visitor''s');

-- The gate ----------------------------------------------------------------------------------------------------------
set local role service_role;
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0090', '203.0.113.50', 2, interval '1 minute', 3, interval '1 hour')$$,
  'the service role takes a step through the gate');
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0090', '203.0.113.50', 2, interval '1 minute', 3, interval '1 hour')$$,
  'a second, up to the person''s limit');
select is(pg_temp.refusal($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0090', '203.0.113.50', 2, interval '1 minute', 3, interval '1 hour')$$),
  '{"code": "PT429", "message": "Too many tries for now. You can try again in 1 minute.", "detail": "{\"kind\": \"test_step\", \"limit\": \"user\", \"retry_after\": 60}", "hint": "rate_gate: test_step per person"}'::jsonb,
  'the third in a minute is refused (PT429), saying when the next fits, in words and in seconds');
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0091', '203.0.113.50', 2, interval '1 minute', 3, interval '1 hour')$$,
  'someone else on that network takes the network''s third');
select is(pg_temp.refusal($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0092', '203.0.113.50', 2, interval '1 minute', 3, interval '1 hour')$$) ->> 'detail',
  '{"kind": "test_step", "limit": "ip", "retry_after": 3600}', 'and a fourth on that network in the hour is refused, whoever asks');
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0092', '2001:db8:1:2::77', 2, interval '1 minute', 3, interval '1 hour')$$,
  'while another network is let through');
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0092', '192.168.65.1', 2, interval '1 minute', 1, interval '1 hour')$$,
  'a private address counts as no network: only the person''s limit holds');
select lives_ok($$select public.rate_gate('test_step', null, '192.168.65.1', 2, interval '1 minute', 1, interval '1 hour')$$,
  'with neither a person nor a network, nothing is counted');
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0093', '203.0.113.51', null, null, null, null)$$,
  'a limit left null is no limit');
reset role;
select results_eq($$select user_id, ip from public.visitor_events where kind = 'test_step' order by id$$,
  $$values ('00000000-0000-4000-8000-0000000d0090'::uuid, '203.0.113.50'::inet), ('00000000-0000-4000-8000-0000000d0090', '203.0.113.50'),
           ('00000000-0000-4000-8000-0000000d0091', '203.0.113.50'), ('00000000-0000-4000-8000-0000000d0092', '2001:db8:1:2::/64'),
           ('00000000-0000-4000-8000-0000000d0092', null), ('00000000-0000-4000-8000-0000000d0093', '203.0.113.51')$$,
  'each step let through is recorded with the person and the network, a refused one is not');
update public.visitor_events set at = at - interval '61 minutes' where kind = 'test_step';
set local role service_role;
select lives_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0090', '203.0.113.50', 2, interval '1 minute', 3, interval '1 hour')$$,
  'once the window has passed, steps fit again');
select throws_ok($$select public.rate_gate('Not a kind', null, null, 1, interval '1 minute', 1, interval '1 hour')$$, '22023', null, 'a kind must look like one');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select throws_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0001', null, null, null, null, null)$$, '42501', null,
  'a visitor cannot take steps through the gate themselves');
select throws_ok($$select public.request_ip()$$, '42501', null, 'nor ask for the address');
select throws_ok($$select * from public.visitor_events$$, '42501', null, 'nor read what was recorded');
select throws_ok($$select * from public.visitor_limits$$, '42501', null, 'nor the limits');
select throws_ok($$select * from public.copy_claims$$, '42501', null, 'nor who has had a session');
select throws_ok($$select public.claim_wait('203.0.113.7')$$, '42501', null, 'nor how long a network waits');
select throws_ok($$select public.delete_idle_visitors()$$, '42501', null, 'nor delete visitors');
set local role anon;
select throws_ok($$select public.rate_gate('test_step', '00000000-0000-4000-8000-0000000d0001', null, null, null, null, null)$$, '42501', null,
  'nor can the anon key');
reset role;

-- One session per sign-in, and a network's claims ----------------------------------------------------------------------
set local role authenticated;
select pg_temp.be(pg_temp.visitor(1));
select pg_temp.at('203.0.113.10');
insert into t select 'v1', public.claim_copy();
select ok(pg_temp.project_of('v1') is not null, 'a visitor starts a session');
select is(public.claim_copy(), pg_temp.got('v1'), 'and opens it again with the same sign-in, which is no new claim');
reset role;
select is((select count(*)::int from public.visitor_events where kind = 'claim' and ip = '203.0.113.10'), 1, 'one claim recorded for the network');
select is((select ip from public.copy_claims where user_id = pg_temp.visitor(1)), '203.0.113.10'::inet, 'and the sign-in''s one claim, with its network');

set local role authenticated;
select pg_temp.be(pg_temp.visitor(2));
select is(pg_temp.refusal($$select public.claim_copy()$$),
  '{"code": "PT429", "message": "A session was just started on your network. You can start a new session in 2 minutes.", "detail": "{\"count\": 1, \"reason\": \"gap\", \"retry_after\": 120}", "hint": "claim_copy: gap"}'::jsonb,
  'someone else on that network starts one only 2 minutes after: the refusal says when, in words and in seconds');
reset role;
select pg_temp.earlier('claim', '203.0.113.10', interval '75 seconds');
set local role authenticated;
select is(pg_temp.refusal($$select public.claim_copy()$$) ->> 'message', 'A session was just started on your network. You can start a new session in 45 seconds.',
  'counting down');
select is(pg_temp.refusal($$select public.claim_copy()$$) ->> 'detail', '{"count": 1, "reason": "gap", "retry_after": 45}', 'to the second');
reset role;
select pg_temp.earlier('claim', '203.0.113.10', interval '3 minutes');
set local role authenticated;
insert into t select 'v2', public.claim_copy();
select isnt(pg_temp.project_of('v2'), pg_temp.project_of('v1'), 'after the 2 minutes, a second session starts on that network');

reset role;
select pg_temp.earlier('claim', '203.0.113.10', interval '3 minutes');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(3));
select is(pg_temp.refusal($$select public.claim_copy()$$),
  '{"code": "PT429", "message": "Your network already has 2 sessions open. You can start a new one in 30 minutes, or as soon as one of them ends.", "detail": "{\"count\": 2, \"reason\": \"held\", \"retry_after\": 1800}", "hint": "claim_copy: held"}'::jsonb,
  'a third while two are open on the network waits for one to end, at the latest when its lease does');
select pg_temp.be(pg_temp.visitor(1));
select is(public.claim_copy(), pg_temp.got('v1'), 'the network''s limits never keep someone from opening the session they hold');
select pg_temp.at('198.51.100.20');
select is(public.claim_copy(), pg_temp.got('v1'), 'from any network');
select pg_temp.at('203.0.113.10');
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v1')), 'one of them is given back');
select pg_temp.be(pg_temp.visitor(3));
insert into t select 'v3', public.claim_copy();
select ok(pg_temp.project_of('v3') is not null, 'and the third starts');

select pg_temp.be(pg_temp.visitor(1));
select is(pg_temp.refusal($$select public.claim_copy()$$),
  '{"code": "PT403", "message": "You’ve already started a session from this page. Reload the page to start a new one.", "detail": "", "hint": "claim_copy: one session per sign-in"}'::jsonb,
  'the sign-in that gave its session back has had it: a new one is a new sign-in, with a fresh human check');
select pg_temp.be(pg_temp.visitor(2));
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v2')), 'so it is for someone who starts over');
select pg_temp.at('198.51.100.21');
select throws_ok($$select public.claim_copy()$$, 'PT403', null, 'from any network, once the waits are over too');
reset role;
select is((select count(*)::int from public.copy_claims where user_id in (pg_temp.visitor(1), pg_temp.visitor(2), pg_temp.visitor(3))), 3, 'one claim each');

-- An hour's and a day's claims, and the longest wait told ---------------------------------------------------------------
insert into public.visitor_events (kind, user_id, ip, at)
select 'claim', gen_random_uuid(), '203.0.113.11'::inet, now() - m * interval '10 minutes' from generate_series(1, 5) m;
set local role authenticated;
select pg_temp.be(pg_temp.visitor(4));
select pg_temp.at('203.0.113.11');
select is(pg_temp.refusal($$select public.claim_copy()$$),
  '{"code": "PT429", "message": "Your network has started 5 sessions in the last hour. You can start a new session in 10 minutes.", "detail": "{\"count\": 5, \"reason\": \"hour\", \"retry_after\": 600}", "hint": "claim_copy: hour"}'::jsonb,
  'a network that started 5 sessions in the last hour waits until the first of them is an hour old');
reset role;
insert into public.visitor_events (kind, user_id, ip, at)
select 'claim', gen_random_uuid(), '203.0.113.12'::inet, now() - m * interval '85 minutes' from generate_series(1, 15) m;
set local role authenticated;
select pg_temp.at('203.0.113.12');
select is(pg_temp.refusal($$select public.claim_copy()$$),
  '{"code": "PT429", "message": "Your network has started 15 sessions in the last 24 hours. You can start a new session in 3 hours.", "detail": "{\"count\": 15, \"reason\": \"day\", \"retry_after\": 9900}", "hint": "claim_copy: day"}'::jsonb,
  'one that started 15 in the last 24 hours, until the first of them is a day old');
reset role;
insert into public.visitor_events (kind, user_id, ip, at)
select 'claim', gen_random_uuid(), '203.0.113.13'::inet, now() - m * interval '10 minutes' - interval '10 minutes' from generate_series(1, 4) m
union all select 'claim', gen_random_uuid(), '203.0.113.13'::inet, now() - interval '30 seconds';
set local role authenticated;
select pg_temp.at('203.0.113.13');
select is(pg_temp.refusal($$select public.claim_copy()$$) ->> 'detail', '{"count": 5, "reason": "hour", "retry_after": 600}',
  'held back by the gap and the hour at once, the longer wait is the one told');
select pg_temp.at('203.0.113.14');
insert into t select 'v4', public.claim_copy();
select ok(pg_temp.project_of('v4') is not null, 'another network starts one meanwhile');
reset role;
update public.visitor_limits set ip_max = 6 where kind = 'claim_hour';
set local role authenticated;
select pg_temp.be(pg_temp.visitor(5));
select pg_temp.at('203.0.113.11');
insert into t select 'v5', public.claim_copy();
select ok(pg_temp.project_of('v5') is not null, 'a limit is a row: raised in place, it lets the next one through');
reset role;
update public.visitor_limits set ip_max = 5 where kind = 'claim_hour';
set local role authenticated;
select pg_temp.be(pg_temp.visitor(6));
select pg_temp.at(null);
insert into t select 'v6', public.claim_copy();
select pg_temp.be(pg_temp.visitor(7));
insert into t select 'v7', public.claim_copy();
select ok(pg_temp.project_of('v6') is not null and pg_temp.project_of('v7') is not null,
  'with no network known (a private address, a test), only the one claim per sign-in holds');
-- Leave four copies held (v3, v4, v5, v6, v7 are five): v6 and v7 go back.
select pg_temp.be(pg_temp.visitor(6));
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v6')), 'given back');
select pg_temp.be(pg_temp.visitor(7));
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('v7')), 'given back too');

-- Joining ------------------------------------------------------------------------------------------------------------
-- Four sessions to join, held by visitors 50 to 53 (no network known).
select pg_temp.at(null);
select pg_temp.be(pg_temp.visitor(50));
insert into t select 'k1', public.claim_copy();
select pg_temp.be(pg_temp.visitor(51));
insert into t select 'k2', public.claim_copy();
select pg_temp.be(pg_temp.visitor(52));
insert into t select 'k3', public.claim_copy();
select pg_temp.be(pg_temp.visitor(53));
insert into t select 'k4', public.claim_copy();

select pg_temp.be(pg_temp.visitor(30));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('k1')), 'someone joins a session');
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('k2')), 'a second');
select lives_ok(format($$select public.join_copy_by_code(%L)$$, pg_temp.code_of('k3')), 'a third, with its code');
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('k1')), 'opening one they are in is no new join');
select is(pg_temp.refusal(format($$select public.join_copy(%L)$$, pg_temp.token_of('k4'))),
  '{"code": "PT429", "message": "Too many sessions joined for now. You can join one again in 60 minutes.", "detail": "{\"kind\": \"join\", \"limit\": \"user\", \"retry_after\": 3600}", "hint": "rate_gate: join per person"}'::jsonb,
  'the fourth in an hour is refused, saying when');
select throws_ok(format($$select public.join_copy_by_code(%L)$$, pg_temp.code_of('k4')), 'PT429', null, 'with the code too');

-- Ten from one network in an hour, whoever they are.
do $$
declare
  n int;
  v_session text;
begin
  for n in 31..40 loop
    perform pg_temp.be(pg_temp.visitor(n));
    perform pg_temp.at('203.0.113.60');
    v_session := case when n <= 34 then 'k4' when n <= 37 then 'k1' else 'k2' end;
    perform public.join_copy(pg_temp.token_of(v_session));
  end loop;
end;
$$;
reset role;
select is((select count(*)::int from public.visitor_events where kind = 'join' and ip = '203.0.113.60'), 10, 'ten people on one network join');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(41));
select pg_temp.at('203.0.113.60');
select is(pg_temp.refusal(format($$select public.join_copy(%L)$$, pg_temp.token_of('k3'))) ->> 'detail', '{"kind": "join", "limit": "ip", "retry_after": 3600}',
  'the eleventh on that network in the hour is refused');
select pg_temp.be(pg_temp.visitor(42));
select pg_temp.at('203.0.113.61');
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('k3')),
  'a teammate in a new tab, a new sign-in on another network, joins once as ever');

-- Wrong codes from a network -------------------------------------------------------------------------------------------
reset role;
insert into public.copy_code_misses (user_id, ip, missed_at)
select pg_temp.visitor(60 + n % 3), '203.0.113.80'::inet, now() - interval '30 minutes' from generate_series(1, 19) n;
set local role authenticated;
select pg_temp.be(pg_temp.visitor(63));
select pg_temp.at('203.0.113.80');
select is(public.join_copy_by_code('000000') ->> 'error', 'no_match', 'a network takes 20 wrong codes in an hour, from whoever');
reset role;
select is((select ip from public.copy_code_misses where user_id = pg_temp.visitor(63)), '203.0.113.80'::inet, 'each kept with its network');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(64));
select is(pg_temp.refusal(format($$select public.join_copy_by_code(%L)$$, pg_temp.code_of('k3'))),
  '{"code": "PT429", "message": "Too many wrong codes from your network. Try again in 30 minutes, or ask for the invite link.", "detail": "", "hint": "join_copy_by_code: too many wrong codes from this network"}'::jsonb,
  'then every code from that network is refused, the right one too, saying when');
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('k3')), 'while the invite link still works');
select pg_temp.be(pg_temp.visitor(65));
select pg_temp.at('203.0.113.81');
select is(public.join_copy_by_code('000000') ->> 'error', 'no_match', 'and another network''s wrong code is just wrong');
reset role;
update public.copy_code_misses set missed_at = missed_at - interval '31 minutes' where ip = '203.0.113.80';
set local role authenticated;
select pg_temp.be(pg_temp.visitor(66));
select pg_temp.at('203.0.113.80');
select is(public.join_copy_by_code(pg_temp.code_of('k3')) ->> 'project_id', pg_temp.project_of('k3')::text, 'once the hour has passed, codes work again there');

-- Messages to Remy -----------------------------------------------------------------------------------------------------
select pg_temp.be(pg_temp.visitor(3));
select pg_temp.at('203.0.113.10');
do $$
begin
  for n in 1..10 loop
    perform public.post_agent_message(pg_temp.project_of('v3'), 'Question ' || n);
  end loop;
end;
$$;
select is(pg_temp.refusal(format($$select public.post_agent_message(%L, 'One more')$$, pg_temp.project_of('v3'))),
  '{"code": "PT429", "message": "Too many messages for now. You can write to Remy again in 1 minute.", "detail": "{\"kind\": \"message\", \"limit\": \"user\", \"retry_after\": 60}", "hint": "rate_gate: message per person"}'::jsonb,
  'the eleventh message in a minute is refused, saying when');
reset role;
select is((select count(*)::int from public.agent_messages where project_id = pg_temp.project_of('v3') and author_id = pg_temp.visitor(3)), 10,
  'and is not written; the ten before it are, as ever');
update public.visitor_limits set user_max = 11 where kind = 'message';
set local role authenticated;
select lives_ok(format($$select public.post_agent_message(%L, 'One more')$$, pg_temp.project_of('v3')), 'the limit is a row, changed in place');
reset role;
update public.visitor_limits set user_max = 10 where kind = 'message';
update public.visitor_events set at = at - interval '61 seconds' where kind = 'message' and user_id = pg_temp.visitor(3);
set local role authenticated;
select is((public.post_agent_message(pg_temp.project_of('v3'), 'A minute later')).text, 'A minute later', 'a minute later they write again');
reset role;
insert into public.visitor_events (kind, user_id, ip, at)
select 'message', gen_random_uuid(), '203.0.113.90'::inet, now() - interval '10 minutes' from generate_series(1, 59);
set local role authenticated;
select pg_temp.be(pg_temp.visitor(50));
select pg_temp.at('203.0.113.90');
select lives_ok(format($$select public.post_agent_message(%L, 'Is the crane booked?', 'voice')$$, pg_temp.project_of('k1')),
  'a network writes 60 messages in an hour, spoken ones too');
select is(pg_temp.refusal(format($$select public.post_agent_message(%L, 'And the hoist?')$$, pg_temp.project_of('k1'))) ->> 'detail',
  '{"kind": "message", "limit": "ip", "retry_after": 3000}', 'the 61st waits until the first of them is an hour old');
select pg_temp.be(pg_temp.visitor(41));
select throws_ok(format($$select public.post_agent_message(%L, 'Hello')$$, pg_temp.project_of('k1')), '42501', null,
  'someone not in the session is turned away before anything is counted');

-- Idle visitors ---------------------------------------------------------------------------------------------------------
-- Anonymous sign-ins long ago (the oldest come first, so the deletion below reaches these alone): one with nothing,
-- one holding a session, one sitting in it, one sitting in a session whose lease ran out (who wrote in it while it
-- was open), one holding that session, and one with a claim and a wrong code on file; one made two hours ago; and
-- an account that is not anonymous.
reset role;
update auth.users set created_at = '2000-01-01' where id in (pg_temp.visitor(80), pg_temp.visitor(81), pg_temp.visitor(82), pg_temp.visitor(83),
  pg_temp.visitor(84), pg_temp.visitor(85), pg_temp.visitor(87));
update auth.users set created_at = now() - interval '2 hours' where id = pg_temp.visitor(86);
update auth.users set is_anonymous = false where id = pg_temp.visitor(87);
set local role authenticated;
select pg_temp.at(null);
select pg_temp.be(pg_temp.visitor(81));
insert into t select 'z1', public.claim_copy();
select pg_temp.be(pg_temp.visitor(82));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('z1')), 'someone sits in a session');
select pg_temp.be(pg_temp.visitor(84));
insert into t select 'z2', public.claim_copy();
select pg_temp.be(pg_temp.visitor(83));
select lives_ok(format($$select public.join_copy(%L)$$, pg_temp.token_of('z2')), 'someone sits in another');
select lives_ok(format($$select public.post_agent_message(%L, 'Before we go')$$, pg_temp.project_of('z2')), 'and writes in it');
select pg_temp.be(pg_temp.visitor(85));
select is(public.join_copy_by_code('000000') ->> 'error', 'no_match', 'someone else gets a code wrong');
reset role;
insert into public.copy_claims (user_id) values (pg_temp.visitor(85));
update public.copy_pool set claimed_at = now() - interval '40 minutes', lease_until = now() - interval '1 minute' where project_id = pg_temp.project_of('z2');

select is(public.delete_idle_visitors(3), 3, 'three idle visitors are deleted');
select results_eq(
  format($$select n, exists (select 1 from auth.users u where u.id = pg_temp.visitor(n)) from unnest(array[80, 81, 82, 83, 84, 85, 86, 87]) n order by n$$),
  $$values (80, false), (81, true), (82, true), (83, false), (84, true), (85, false), (86, true), (87, true)$$,
  'one with nothing, one in a session whose lease ran out, one with only a claim; not the holders, not someone in an open session, not a young one, not an account');
select is((select count(*)::int from public.copy_seats where user_id in (pg_temp.visitor(83), pg_temp.visitor(85)))
        + (select count(*)::int from public.project_members where user_id in (pg_temp.visitor(83), pg_temp.visitor(85)))
        + (select count(*)::int from public.profiles where user_id in (pg_temp.visitor(83), pg_temp.visitor(85)))
        + (select count(*)::int from public.copy_claims where user_id in (pg_temp.visitor(83), pg_temp.visitor(85)))
        + (select count(*)::int from public.copy_code_misses where user_id in (pg_temp.visitor(83), pg_temp.visitor(85))), 0,
  'their seats, memberships, profiles, claims and wrong codes go with them');
select is((select count(*)::int from public.agent_messages where project_id = pg_temp.project_of('z2') and author_id is null and text = 'Before we go'), 1,
  'what they wrote stays, without them, until the session is reset');
select ok((select holder = pg_temp.visitor(84) and join_token is not null from public.copy_pool where project_id = pg_temp.project_of('z2')),
  'the session whose lease ran out is still its holder''s');
set local role service_role;
select is(public.sweep_copies(), 1, 'until the sweep resets it, as ever');
reset role;
select ok((select holder is null and claimed_at is null from public.copy_pool where project_id = pg_temp.project_of('z2'))
          and not exists (select 1 from public.agent_messages where project_id = pg_temp.project_of('z2')), 'free and clean');
select is(public.delete_idle_visitors(3), 1, 'its holder, idle now, goes at the next run');

-- Every session in use ------------------------------------------------------------------------------------------------
-- The rest of the pool goes to visitors 70 on (claimed as each of them; the test's own role looks at the pool).
select pg_temp.at(null);
do $$
declare
  n int := 70;
begin
  while exists (select 1 from public.copy_pool where claimed_at is null) loop
    perform pg_temp.be(pg_temp.visitor(n));
    insert into t select 'full' || n, public.claim_copy();
    n := n + 1;
  end loop;
end;
$$;
set local role authenticated;
select pg_temp.be(pg_temp.visitor(79));
select pg_temp.at('203.0.113.70');
select throws_ok($$select public.claim_copy()$$, '53000', 'Every session is in use right now. Please try again in a few minutes.', 'a full pool says so');
reset role;
select ok(not exists (select 1 from public.copy_claims where user_id = pg_temp.visitor(79))
          and not exists (select 1 from public.visitor_events where kind = 'claim' and ip = '203.0.113.70'),
  'and counts nothing: no claim used up, nothing against the network');
set local role authenticated;
select pg_temp.be(pg_temp.visitor(70));
select pg_temp.at(null);
select lives_ok(format($$select public.release_copy(%L)$$, pg_temp.project_of('full70')), 'a session is given back');
select pg_temp.be(pg_temp.visitor(79));
select pg_temp.at('203.0.113.70');
select is(public.claim_copy() ->> 'project_id', pg_temp.project_of('full70')::text, 'and the visitor who was turned away starts one');

-- The clean-up's schedule ------------------------------------------------------------------------------------------------
reset role;
create function pg_temp.job(p_name text) returns text language plpgsql as $$
begin
  if to_regclass('cron.job') is null then
    return 'no pg_cron here';
  end if;
  return (select schedule || ' ' || command from cron.job where jobname = p_name);
end;
$$;
select ok(pg_temp.job('clear-visitor-events') in ('17 * * * * delete from public.visitor_events where at < now() - interval ''2 days''', 'no pg_cron here'),
  'pg_cron clears visitor events after 2 days, every hour, where it is');
select ok(pg_temp.job('clear-code-misses') in ('*/10 * * * * delete from public.copy_code_misses where missed_at <= now() - interval ''1 hour''', 'no pg_cron here'),
  'wrong codes after the network''s hour');
select ok(pg_temp.job('delete-idle-visitors') in ('37 * * * * select public.delete_idle_visitors()', 'no pg_cron here'), 'and idle visitors every hour');
insert into public.visitor_events (kind, user_id, at) values ('claim', gen_random_uuid(), now() - interval '49 hours');
delete from public.visitor_events where at < now() - interval '2 days';
select ok(not exists (select 1 from public.visitor_events where at < now() - interval '2 days')
          and exists (select 1 from public.visitor_events where kind = 'claim' and ip = '203.0.113.12'),
  'the clean-up takes what is over 2 days old and leaves the day''s claims');

select * from finish();
rollback;
